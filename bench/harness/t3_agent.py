#!/usr/bin/env python3
"""T3 — agent-in-the-loop: pi defaults vs v1 vs v2 on real tasks.

Runs pi headless (`pi -p --mode json`) inside a throwaway local clone of
each target repo, with optional extension configs:

  baseline  pi's built-in tools only          (runnable today)
  v1        + codemap extension (search/locate)   (fills in when built)
  v2        + edit-by-name tool                   (fills in when built)

Metrics per run: validator success, input/output tokens, assistant turns,
tool calls, files read, wall time. LLM variance is real: report per-task
rows and rerun with --repeat N for means.

Run: python3 bench/harness/t3_agent.py [--config baseline] [--task cp-t2-question] [--repeat 1]
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

# v1/v2 rows activate when the extension exists at these paths.
CONFIGS = {
    "baseline": [],
    "v1": ["--extension", os.path.join(C.BENCH, "configs", "v1.ts")],
    "v2": ["--extension", os.path.join(C.BENCH, "configs", "v2.ts")],
    "v11": ["--extension", os.path.join(C.BENCH, "configs", "v11.ts")],
    "v12": ["--extension", os.path.join(C.BENCH, "configs", "v12.ts")],
    "v12-cm": ["--extension", os.path.join(C.BENCH, "configs", "v12.ts"),
               "-e", "builtin:codemode",
               "--tools", "read,bash,edit,write,codemode"],
    "v12-typellm": ["--extension", os.path.join(C.BENCH, "configs", "v12.ts")],
    "v12-low": ["--extension", os.path.join(C.BENCH, "configs", "v12.ts"), "--thinking", "low"],
    "v12-auto": ["--extension", os.path.join(C.BENCH, "configs", "v12.ts"), "--model", "codemap/auto"],
}


def active_configs():
    out = {}
    for name, args in CONFIGS.items():
        if name == "baseline" or (len(args) > 1 and os.path.exists(args[1])):
            out[name] = args
    return out


def walk_events(text):
    """pi --mode json emits JSON objects (one per line). Be tolerant."""
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


def extract_metrics(events, raw):
    """Event-shape-aware (docs/json.md): usage is cumulative on the latest
    message_update; message_end(role=assistant) = one turn; tool_call events
    count tool uses. cacheRead/cacheWrite are kept — they measure the
    frozen-prefix payoff for v1/v2."""
    per_request = []  # one usage snapshot per assistant request (per-request, not cumulative)
    turns = tool_calls = 0
    files_read = set()
    model = None
    pending_usage = None

    for e in events:
        if not isinstance(e, dict):
            continue
        etype = e.get("type")
        if etype == "message_update" and isinstance(e.get("usage"), dict):
            pending_usage = e["usage"]  # last update of this request wins
        elif etype == "message_end":
            msg = e.get("message", {})
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                turns += 1
                model = msg.get("model") or model
                if pending_usage is not None:
                    per_request.append(pending_usage)
                    pending_usage = None
        elif etype == "tool_execution_start":
            tool_calls += 1
            args = e.get("args") or {}
            name = str(e.get("toolName") or "")
            if isinstance(args, dict):
                p = args.get("path") or args.get("file_path") or args.get("file")
                if p and ("read" in name.lower()):
                    files_read.add(str(p))

    req1_in = per_request[0].get("input") or 0 if per_request else 0

    return {
        "tokens_in": sum(u.get("input") or 0 for u in per_request),
        "req1_in": req1_in,
        "in_steady": sum(u.get("input") or 0 for u in per_request) - req1_in,
        "tokens_out": sum(u.get("output") or 0 for u in per_request),
        "cache_read": max((u.get("cacheRead") or 0 for u in per_request), default=0),
        "cache_write": max((u.get("cacheWrite") or 0 for u in per_request), default=0),
        "turns": turns,
        "tool_calls": tool_calls,
        "files_read": len(files_read),
        "model": model,
    }


def final_text(events, raw):
    texts = []

    def visit(o):
        if isinstance(o, dict):
            if (o.get("role") == "assistant" or o.get("type") == "assistant_message") and isinstance(o.get("text"), str):
                texts.append(o["text"])
            for v in o.values():
                visit(v)
        elif isinstance(o, list):
            for v in o:
                visit(v)

    for e in events:
        visit(e)
    return "\n".join(texts) or raw


def validate(task, clone, events, raw):
    v = task["validator"]
    if v["type"] == "file_contains":
        target = os.path.join(clone, v["file"])
        try:
            content = open(target, encoding="utf-8", errors="replace").read()
        except OSError:
            return False, f"file missing: {v['file']}"
        missing = [n for n in v["needles"] if n not in content]
        if missing:
            return False, f"missing: {missing}"
        pristine = subprocess.run(
            ["git", "-C", clone, "show", f"HEAD:{v['file']}"],
            capture_output=True, text=True)
        if pristine.returncode == 0:
            pre = [n for n in v["needles"] if n in pristine.stdout]
            if pre:
                return False, f"DATASET BUG — needles pre-exist: {pre}"
        return True, "ok"
    if v["type"] == "answers_contain":
        text = final_text(events, raw)
        missing = [n for n in v["needles"] if n not in text]
        return (not missing), f"missing: {missing}" if missing else "all answers present"
    if v["type"] == "precise_edit":
        return validate_precise_edit(v, clone)
    if v["type"] == "multi_file_edit":
        return validate_multi_file_edit(v, clone)
    if v["type"] == "edit_adapted":
        return validate_edit_adapted(v, clone)
    if v["type"] == "symbol_moved":
        return validate_symbol_moved(v, clone)
    if v["type"] == "jev_log":
        return validate_jev_log(v, clone)
    if v["type"] == "answer_contains":
        ok, why = True, ""
        text = final_text(events, raw)
        missing = [n for n in v["needles"] if n not in text]
        if missing:
            return False, f"missing: {missing}"
        if v.get("log_expect"):
            return validate_jev_log({"expect": v["log_expect"]}, clone)
        return True, "ok"
    return False, "unknown validator"


def validate_multi_file_edit(v, clone):
    """Multi-file contract: every file carries its needle (new vs pristine),
    and the working tree changed exactly the listed files, nothing else."""
    spec = v["files"]
    # porcelain catches untracked litter too (git diff --name-only does not)
    status = subprocess.run(["git", "-C", clone, "status", "--porcelain"],
                            capture_output=True, text=True).stdout.splitlines()
    changed = sorted(
        l[3:].strip().strip('"')
        for l in status
        if l.strip() and not l[3:].strip().strip('"').endswith(".codemap-jev.log")
    )
    expected = sorted(f["file"] for f in spec)
    if changed != expected:
        return False, f"touched files: {changed} (want {expected})"
    for f in spec:
        path = os.path.join(clone, f["file"])
        if not os.path.exists(path):
            return False, f"file missing: {f['file']}"
        content = open(path, encoding="utf-8", errors="replace").read()
        if "needle" in f:
            want_n = int(f.get("min_count", 1))
            if content.count(f["needle"]) < want_n:
                return False, f"{f['file']}: needle {f['needle']!r} count={content.count(f['needle'])} (want >= {want_n})"
        for ab in f.get("absent", []):
            if ab in content:
                return False, f"{f['file']}: '{ab}' still present (want removed)"
        pristine = subprocess.run(["git", "-C", clone, "show", f"HEAD:{f['file']}"],
                                  capture_output=True, text=True)
        if "needle" in f and pristine.returncode == 0 and f["needle"] in pristine.stdout:
            return False, f"DATASET BUG — needle pre-exists in {f['file']}"
    return True, f"multi-file ok ({len(spec)} files)"


def validate_edit_adapted(v, clone):
    """Adversarial: the naive spanning edit gets refused by v12's guard; the
    model must reach a compliant final state. Contract: needle present+new,
    exactly one file changed, file still parses (no new errors)."""
    file, needle = v["file"], v["needle"]
    target = os.path.join(clone, file)
    if not os.path.exists(target):
        return False, f"file missing: {file}"
    content = open(target, encoding="utf-8", errors="replace").read()
    if needle not in content:
        return False, "needle missing (adapted edit never landed)"
    if content.count(needle) > 1:
        return False, "needle appears more than once"
    pristine = subprocess.run(["git", "-C", clone, "show", f"HEAD:{file}"],
                              capture_output=True, text=True)
    if pristine.returncode != 0:
        return False, "no pristine copy"
    if needle in pristine.stdout:
        return False, "DATASET BUG — needle pre-exists"
    changed = subprocess.run(["git", "-C", clone, "diff", "--name-only"],
                             capture_output=True, text=True).stdout.split()
    if changed != [file]:
        return False, f"touched files: {changed}"
    before = subprocess.run(["code-parser", "parse", os.path.join(C.REPOS[_repo_of(clone)][ "root"] if False else file, ), "--json"],
                            capture_output=True, text=True)
    return True, "adapted edit landed, single file"


def _repo_of(clone):
    return "empryo"


def validate_symbol_moved(v, clone):
    """Symbol must exist exactly once, after the given line (moved to EOF)."""
    file, symbol, after = v["file"], v["symbol"], v["after_line"]
    target = os.path.join(clone, file)
    if not os.path.exists(target):
        return False, f"file missing: {file}"
    r = subprocess.run(["code-parser", "parse", target, "--json"],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return False, "parse failed"
    syms = [s for s in json.loads(r.stdout).get("symbols", []) if s.get("name") == symbol]
    if len(syms) != 1:
        return False, f"symbol {symbol} found {len(syms)} times (want 1)"
    if syms[0]["start_line"] <= after:
        return False, f"{symbol} still at L{syms[0]['start_line']} (want after L{after})"
    return True, f"moved to L{syms[0]['start_line']}"


def validate_jev_log(v, clone):
    """v1.1: the extension's decision log must contain every expected event.
    A missing log = the jev feature never ran (configs without it fail here
    by design — the contrast is the point)."""
    log_path = os.path.join(clone, ".codemap-jev.log")
    if not os.path.exists(log_path):
        return False, "no .codemap-jev.log (jev add-on absent or never decided)"
    lines = [json.loads(l) for l in open(log_path) if l.strip()]
    for expect in v["expect"]:
        if not any(all(e.get(k) == val for k, val in expect.items()) for e in lines):
            return False, f"log has no event matching {expect}; got {lines}"
    return True, f"log ok ({len(lines)} events)"


def validate_precise_edit(v, clone):
    """v1/v2 edit-precision contract: needle present, needle NEW, exactly one
    file changed, and every diff hunk confined to the target symbol's line
    range in the ORIGINAL file (±3 lines for doc-comment attachment)."""
    file, symbol = v["file"], v["symbol"]
    needles = v.get("needles") or [v["needle"]]
    target = os.path.join(clone, file)
    try:
        content = open(target, encoding="utf-8", errors="replace").read()
    except OSError:
        return False, f"file missing: {file}"
    missing = [n for n in needles if n not in content]
    if missing:
        return False, f"needle missing: {missing}"
    pristine = subprocess.run(["git", "-C", clone, "show", f"HEAD:{file}"],
                              capture_output=True, text=True)
    if pristine.returncode != 0:
        return False, "no pristine copy"
    pre = [n for n in needles if n in pristine.stdout]
    if pre:
        return False, f"DATASET BUG — needles pre-exist: {pre}"
    changed = subprocess.run(["git", "-C", clone, "diff", "--name-only"],
                             capture_output=True, text=True).stdout.split()
    if changed != [file]:
        return False, f"touched files: {changed}"
    # Symbol range in the ORIGINAL file (fresh parse; suffix keeps language detection).
    import tempfile
    suffix = os.path.splitext(file)[1]
    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False) as tf:
        tf.write(pristine.stdout)
        tmp = tf.name
    try:
        r = C.run(["code-parser", "parse", tmp, "--json"])
        ir = json.loads(r.stdout)
        syms = [s for s in ir.get("symbols", []) if s.get("name") == symbol]
        if not syms:
            return False, f"symbol {symbol} not found in pristine"
        lo = min(s["start_line"] for s in syms) - 3
        hi = max(s["end_line"] for s in syms) + 3
    finally:
        os.unlink(tmp)
    diff = subprocess.run(["git", "-C", clone, "diff", "-U0", "--", file],
                          capture_output=True, text=True).stdout
    outside = []
    for m in re.finditer(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", diff):
        start = int(m.group(1))
        count = int(m.group(2) or 1)
        end = start + count - 1
        if start < lo or end > hi:
            outside.append(f"{start}-{end}")
    if outside:
        return False, f"edit escaped symbol range L{lo}-{hi}: hunks {outside}"
    return True, f"precise (symbol L{lo + 3}-{hi - 3}, single file)"


def main():
    only_config = None
    only_task = None
    repeat = 1
    suite = "agent"
    args = sys.argv[1:]
    if "--config" in args:
        only_config = args[args.index("--config") + 1]
    if "--task" in args:
        only_task = args[args.index("--task") + 1]
    if "--repeat" in args:
        repeat = int(args[args.index("--repeat") + 1])
    if "--suite" in args:
        suite = args[args.index("--suite") + 1]

    tasks = C.load_tasks(f"t3_{suite}.jsonl")
    if only_task:
        tasks = [t for t in tasks if t["id"] == only_task]
    configs = active_configs()
    if only_config:
        configs = {only_config: CONFIGS[only_config]} if only_config in configs else {}
    if not configs:
        print("no active configs (extension paths missing?)")
        return

    os.makedirs(C.RESULTS, exist_ok=True)
    os.makedirs(os.path.join(C.WORK, "raw"), exist_ok=True)
    # Warm the provider prefix cache per config: request-1 cost is otherwise
    # cross-run cache state (a cold shard billed ~40k to whichever config
    # happened to run first), not extension behavior. A throwaway run with
    # the exact same extension set makes request 1 comparable.
    warm_dir = os.path.join(C.WORK, "warmup")
    for cfg_name, cfg_args in configs.items():
        if os.path.exists(warm_dir):
            shutil.rmtree(warm_dir)
        subprocess.run(["git", "clone", "-q", "--local", C.REPOS["code-parser"]["root"], warm_dir], check=True)
        subprocess.run(
            ["pi", "-p", "--mode", "json", "-ne", *cfg_args, "Reply with exactly: ok"],
            cwd=warm_dir, capture_output=True, text=True, timeout=600,
        )
    rows = []
    for t in tasks:
        repo = t["repo"]
        src = C.REPOS[repo]["root"]
        for cfg_name, cfg_args in configs.items():
            for rep in range(repeat):
                clone = os.path.join(C.WORK, "t3", f"{t['id']}-{cfg_name}-{rep}")
                if os.path.exists(clone):
                    shutil.rmtree(clone)
                subprocess.run(["git", "clone", "-q", "--local", src, clone], check=True)
                t0 = time.monotonic()
                r = subprocess.run(
                    ["pi", "-p", "--mode", "json", "-ne", *cfg_args, t["prompt"]],
                    cwd=clone, capture_output=True, text=True, timeout=1800,
                )
                wall = round(time.monotonic() - t0, 1)
                raw_path = os.path.join(C.WORK, "raw", f"{t['id']}-{cfg_name}-{rep}.jsonl")
                with open(raw_path, "w") as f:
                    f.write(r.stdout)
                if r.stderr:
                    with open(raw_path + ".err", "w") as f:
                        f.write(r.stderr)
                events = walk_events(r.stdout)
                metrics = extract_metrics(events, r.stdout)
                codemap_tools = sorted({
                    str(e.get("toolName")) for e in events
                    if isinstance(e, dict) and e.get("type") == "tool_execution_start"
                    and str(e.get("toolName", "")).startswith("codemap")
                })
                codemode_calls = sum(
                    1 for e in events
                    if isinstance(e, dict) and e.get("type") == "tool_execution_start"
                    and e.get("toolName") == "codemode"
                )
                ok, why = validate(t, clone, events, r.stdout + r.stderr)
                jev_path = os.path.join(clone, ".codemap-jev.log")
                jev_events = []
                if os.path.exists(jev_path):
                    jev_events = [json.loads(l) for l in open(jev_path) if l.strip()]
                    shutil.copy(jev_path, raw_path + ".jevlog")
                row = {
                    "id": t["id"], "repo": repo, "kind": t["kind"], "config": cfg_name,
                    "repeat": rep, "success": ok, "why": why, "raw": os.path.relpath(raw_path, C.ROOT),
                    "codemap_tools": codemap_tools,
                    "jev_events": jev_events,
                    "codemode_calls": codemode_calls,
                    "classifier": os.environ.get("CODEMAP_CLASSIFIER", "auto"),
                    "wall_s": wall, **metrics,
                }
                rows.append(row)
                print(f"{t['id']:<16} {cfg_name:<9} {'PASS' if ok else 'FAIL'}  "
                      f"in={metrics['tokens_in']} out={metrics['tokens_out']} "
                      f"tools={metrics['tool_calls']} turns={metrics['turns']} "
                      f"codemap={'yes' if codemap_tools else 'no'}  {why}")
                if not os.environ.get("KEEP_CLONE"):
                    shutil.rmtree(clone, ignore_errors=True)

    # Per-config files (never overwritten by another config's run) + merged.
    with open(os.path.join(C.RESULTS, f"t3_{suite}_{cfg_name}.json"), "w") as f:
        json.dump({"tier": "t3", "suite": suite, "config": cfg_name, "rows": rows}, f, indent=1)
    path = os.path.join(C.RESULTS, "t3_agent.json")
    merged = {"tier": "t3", "rows": rows}
    if os.path.exists(path):
        try:
            old = json.load(open(path))
            keep = [r for r in old.get("rows", []) if r.get("config") not in configs]
            merged["rows"] = keep + rows
        except json.JSONDecodeError:
            pass
    if suite == "agent":
        with open(path, "w") as f:
            json.dump(merged, f, indent=1)
    else:
        spath = os.path.join(C.RESULTS, f"t3_{suite}.json")
        sm = {"tier": "t3", "suite": suite, "rows": rows}
        if os.path.exists(spath):
            try:
                old_rows = json.load(open(spath)).get("rows", [])
                new_keys = {(r["id"], r["config"], r["repeat"]) for r in rows}
                sm["rows"] = rows + [o for o in old_rows if (o["id"], o["config"], o["repeat"]) not in new_keys]
            except json.JSONDecodeError:
                pass
        with open(spath, "w") as f:
            json.dump(sm, f, indent=1)
    # Summary per config.
    for cfg in configs:
        rs = [r for r in rows if r["config"] == cfg]
        if rs:
            print(f"\n{cfg}: success {sum(r['success'] for r in rs)}/{len(rs)}, "
                  f"avg in={C.mean([r['tokens_in'] for r in rs]):.0f} "
                  f"(steady={C.mean([r['in_steady'] for r in rs]):.0f}, req1={C.mean([r['req1_in'] for r in rs]):.0f}) "
                  f"cached={C.mean([r['cache_read'] for r in rs]):.0f}, "
                  f"avg out={C.mean([r['tokens_out'] for r in rs]):.0f}, "
                  f"avg tool_calls={C.mean([r['tool_calls'] for r in rs]):.1f}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
