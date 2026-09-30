#!/usr/bin/env python3
"""T2 — edit-by-name mechanics on real codebases (deterministic, no LLM).

Implements the v2 candidate algorithm exactly as the extension will:
  1. FIND via the map is allowed to be stale —
  2. LOCATE by re-parsing the ONE file fresh (`code-parser parse --json`)
  3. match symbols by name; 0 or >1 matches => refuse, never guess
  4. SPLICE [start_byte, end_byte) with the replacement
  5. VALIDATE: reparses clean, marker present, outside-region bytes
     untouched; identity mode must reproduce the file byte-for-byte.

The `stale` mode proves the safety property: the file is mutated *after*
a map is built, and the fresh-parse edit must still land correctly —
the failure mode map-range editing would corrupt.

Run: python3 bench/harness/t2_edit.py [--verbose]
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

VERBOSE = "--verbose" in sys.argv
TMP = os.path.join(C.WORK, "t2")


def fresh_parse(abs_path):
    r = C.run(["code-parser", "parse", abs_path, "--json"])
    if r.returncode != 0:
        raise RuntimeError(f"parse failed for {abs_path}: {r.stderr[-500:]}")
    return json.loads(r.stdout)


def find_symbols(ir, name):
    out = []
    for s in ir.get("symbols", []):
        if name in (s.get("local_key"), s.get("name")) or name == s.get("qualified_name"):
            out.append(s)
    return out


def splice(original: bytes, start: int, end: int, replacement: bytes) -> bytes:
    return original[:start] + replacement + original[end:]


def error_count(ir):
    return sum(1 for d in ir.get("diagnostics", []) if d.get("severity") == "Error")


def run_case(t):
    repo = t["repo"]
    root_dir = C.REPOS[repo]["root"]  # absolute fs root of the repo (not subroot)
    src = os.path.join(root_dir, t["file"])
    mode = t["mode"]

    os.makedirs(TMP, exist_ok=True)
    # Keep the source extension: language detection is extension-based.
    ext = os.path.splitext(src)[1]
    tmp = os.path.join(TMP, f"{t['id']}{ext}")
    # ALL splicing is byte-domain: IR offsets are tree-sitter BYTE offsets;
    # str indexing is char-domain — a file with multi-byte UTF-8 before the
    # span corrupts the splice (bit the first harness draft on CognitiveOS's
    # box-drawing dividers). The v2 extension must do the same (Node
    # Buffers, never UTF-16 strings).
    original = open(src, "rb").read()
    open(tmp, "wb").write(original)

    result = {"id": t["id"], "mode": mode, "symbol": t["symbol"], "expect_matches": t["expect_matches"], "expect_refuse": bool(t.get("expect_refuse"))}

    if mode == "stale":
        # Build a map first (may be stale), then mutate the file, then edit.
        map_path = C.ensure_map(repo)
        shifted = ("\n".join(t["prepend_lines"]) + "\n").encode("utf-8") + original
        open(tmp, "wb").write(shifted)

    ir = fresh_parse(tmp)
    matches = find_symbols(ir, t["symbol"])
    result["matches"] = len(matches)

    if len(matches) != t["expect_matches"]:
        result["outcome"] = "locate_mismatch"
        result["refused"] = len(matches) != 1
        return result

    if t.get("expect_refuse") and len(matches) == 1:
        result["outcome"] = "should_have_refused"
        result["refused"] = False
        return result
    if len(matches) != 1:
        result["outcome"] = "refused_ambiguity_or_missing"
        result["refused"] = True
        return result

    sym = matches[0]
    start, end = sym["start_byte"], sym["end_byte"]
    current = open(tmp, "rb").read()  # re-read: stale mode shifted everything
    span_text = current[start:end]

    if mode == "identity":
        replacement = span_text
    else:  # marker / stale / explicit replace
        marker = t.get("new_body_marker") or "bench-t2 marker"
        comment = "//" if t["file"].endswith(".rs") else "//"
        replacement = f"{comment} {marker}\n".encode("utf-8") + span_text

    edited = splice(current, start, end, replacement)
    open(tmp, "wb").write(edited)

    # Validate.
    ir2 = fresh_parse(tmp)
    edited_text = edited.decode("utf-8", errors="replace")
    checks = {
        "reparses_clean": error_count(ir2) <= error_count(ir),
        "marker_present": (t.get("expect_contains") or t.get("new_body_marker") or "") in edited_text
                          if mode != "identity" else True,
        "outside_intact": edited[:start] == current[:start] and edited[start + len(replacement):] == current[end:],
        "identity_exact": (edited == original) if mode == "identity" else None,
    }
    checks = {k: v for k, v in checks.items() if v is not None}
    result.update(checks)
    result["outcome"] = "pass" if all(checks.values()) else "fail"
    result["refused"] = False
    return result


def main():
    tasks = C.load_tasks("t2_edit.jsonl")
    rows = [run_case(t) for t in tasks]
    os.makedirs(C.RESULTS, exist_ok=True)

    n = len(rows)
    summary = {
        "cases": n,
        "locate_exact": sum(1 for r in rows if r["matches"] == r["expect_matches"]),
        "refusals_correct": sum(1 for r in rows if r["expect_refuse"] and r.get("refused")),
        "no_wrong_splice": sum(1 for r in rows if (not r["expect_refuse"]) == (r["outcome"] == "pass")),
        "splice_pass": sum(1 for r in rows if r["outcome"] == "pass"),
        "outside_intact_all": all(r.get("outside_intact", True) for r in rows),
    }
    out = {"tier": "t2", "summary": summary, "rows": rows}
    path = os.path.join(C.RESULTS, "t2_edit.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)

    print("T2 edit-by-name mechanics — locate (fresh parse) + splice + validate")
    for r in rows:
        flag = "ok " if r["outcome"] == "pass" or (r.get("refused") and r.get("expect_refuse")) else "!! "
        print(f" {flag}{r['id']:<18} matches={r['matches']}/{r['expect_matches']} outcome={r['outcome']}")
        if VERBOSE and r["outcome"] == "pass":
            print(f"     {json.dumps({k: r.get(k) for k in ('reparses_clean','marker_present','outside_intact','identity_exact')})}")
    print(f"\nsummary: {json.dumps(summary)}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
