#!/usr/bin/env python3
"""Layer 2b: verifier recall / false-positive eval for routed-edit verification.

Harvests real (prompt, applied-diff) pairs from bench raw transcripts, builds
mutated variants (dropped hunk, unrelated hunk, wrong identifier), and runs
the routed-edit verifier on both engines.

- FALSE POSITIVES = verifier fires on good diffs (want ~0)
- RECALL          = verifier fires on mutated diffs (want ~all)

Usage: python3 bench/verifier_eval.py [N_PAIRS]
Requires TYPESAFE_API_KEY (jev) and ~/.config/pi-codemap/typellm.key (typellm).
"""
import json, os, sys, glob, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 4
FIRE = 0.7

def post(url, key, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode() or "{}")

def verify(prompt, diff, engine, tkey, jkey):
    ctx = f"{prompt[:1600]}\n\nApplied diff:\n{diff[:2400]}"
    if engine == "typellm":
        r = post("https://api.typellm.ai/v1/generate", tkey, {"context": ctx, "questions": {
            "incomplete": {"type": "boolean", "instructions": "Does the diff FAIL to accomplish what the user requested?", "return_probabilities": True},
            "unrelated": {"type": "boolean", "instructions": "Does the diff touch code unrelated to the request?", "return_probabilities": True},
            "dropped": {"type": "boolean", "instructions": "Does the diff drop or break existing behavior that the request did not ask to change?", "return_probabilities": True},
            "why": {"type": "string", "depends_on": ["incomplete", "unrelated", "dropped"], "instructions": "If any signal above fired, one sentence on the main problem and what to re-check. Otherwise exactly 'ok'."}}})
        res = r.get("result", {})
        def p(k):
            a = res.get(k, 0)
            if isinstance(a, bool): return 1.0 if a else 0.0
            if isinstance(a, dict):
                pr = a.get("probabilities") or {}
                if "true" in pr: return float(pr["true"])
                return 1.0 if a.get("value") else 0.0
            return 0.0
        sig = {"incomplete": p("incomplete"), "unrelated": p("unrelated"), "dropped": p("dropped")}
        return sig, str(res.get("why", ""))
    qs = {f"q{i}": {"type": "noul", "instructions": ins} for i, ins in enumerate([
        "Does the diff FAIL to accomplish what the user requested?",
        "Does the diff touch code unrelated to the request?",
        "Does the diff drop or break existing behavior that the request did not ask to change?"])}
    r = post("https://api.typesafe.ai/v1/systemone", jkey, {"model": "jev-latest", "state": {"context": ctx}, "questions": qs})
    a = r.get("result") or r.get("answers") or {}
    def p(k): return float((a.get(k) or {}).get("probability", (a.get(k) or {}).get("noul", 0)))
    return {"incomplete": p("q0"), "unrelated": p("q1"), "dropped": p("q2")}, ""

def mutate(diff, mode):
    lines = [l for l in diff.split("\n") if l.strip()]
    if mode == "dropped" and len(lines) > 1:
        return "\n".join(lines[: max(1, len(lines) // 2)])
    if mode == "unrelated":
        return diff + "\n- (nothing)\n+ // TODO: remove this temporary debug hack"
    if mode == "wrong":
        out = diff.replace("main", "mnain").replace("config", "confg")
        return out if out != diff else diff + "\n+ const broken = ;"
    return diff

EMPRYO = os.path.expanduser("~/Documents/vibe/Empryo")

def file_window(path, ops, width=50):
    """Apply the ops in-memory and return the post-edit window around them."""
    full = os.path.join(EMPRYO, path)
    if not os.path.exists(full): return ""
    content = open(full, encoding="utf-8", errors="replace").read()
    pos = content.find(ops[0].get("oldText", "\x00"))
    if pos == -1: return ""
    for op in ops:
        old, new = op.get("oldText", ""), op.get("newText", "")
        i = content.find(old)
        if i != -1: content = content[:i] + new + content[i + len(old):]
    start = content.count("\n", 0, max(pos - 200, 0))
    lines = content.split("\n")
    lo = max(0, start - width); hi = min(len(lines), start + width)
    return "\n".join(lines[lo:hi])

def harvest(n):
    pairs = []
    files = sorted(glob.glob(os.path.join(ROOT, "bench/.work/raw/*.jsonl")), key=os.path.getmtime, reverse=True)
    for f in files:
        base = os.path.basename(f)
        if not any(t in base for t in ("cp-edit-v12", "emp-span-v12", "emp-split-v12")): continue
        if not base.endswith(("-0.jsonl", "-1.jsonl")): continue
        events = [json.loads(l) for l in open(f) if l.strip()]
        prompt = ""
        for e in events:
            if e.get("type") == "message_start" and (e.get("message") or {}).get("role") == "user":
                c = e["message"].get("content")
                prompt = c if isinstance(c, str) else json.dumps(c)[:500]
                break
        for e in events:
            if e.get("type") == "tool_execution_start" and e.get("toolName") == "edit":
                a = e.get("args") or {}
                ops = a.get("edits") or []
                if ops and prompt and a.get("path"):
                    diff = "\n".join(f"- {op.get('oldText','')[:600]}\n+ {op.get('newText','')[:600]}" for op in ops)
                    window = file_window(a["path"], ops)
                    if window:
                        pairs.append((prompt, diff, base, window))
        if len(pairs) >= n: break
    return pairs[:n]

def main():
    tkey_p = os.path.expanduser("~/.config/pi-codemap/typellm.key")
    tkey = open(tkey_p).read().strip() if os.path.exists(tkey_p) else ""
    jkey = os.environ.get("TYPESAFE_API_KEY", "").strip()
    engines = [e for e, k in (("typellm", tkey), ("jev", jkey)) if k]
    if not engines:
        print("no engine credentials"); sys.exit(2)
    good = harvest(N)
    print(f"harvested {len(good)} real diffs; engines: {engines}")
    fp = {e: [0, 0] for e in engines}
    recall = {e: [0, 0] for e in engines}
    for prompt, diff, src, window in good:
        for label, d in (("good", diff), ("drop", mutate(diff, "dropped")), ("unrel", mutate(diff, "unrelated")), ("wrong", mutate(diff, "wrong"))):
            for eng in engines:
                try:
                    sig, why = verify(prompt + "\n\nResulting file (post-edit, excerpt):\n" + window, d, eng, tkey, jkey)
                except Exception as ex:
                    print(f"[{src[-20:]}] {label:5s} {eng:7s} ERROR {str(ex)[:80]}"); continue
                fired = any(v >= FIRE for v in sig.values())
                tgt = fp if label == "good" else recall
                tgt[eng][0] += 1 if fired else 0
                tgt[eng][1] += 1
                print(f"[{src[-20:]:20s}] {label:5s} {eng:7s} fired={str(fired):5s} {sig} {why[:60] if fired else ''}")
    print("\nFALSE POSITIVES (fired on good diffs, want 0):", {k: f"{v[0]}/{v[1]}" for k, v in fp.items() if v[1]})
    print("RECALL (fired on mutated, want all):        ", {k: f"{v[0]}/{v[1]}" for k, v in recall.items() if v[1]})

if __name__ == "__main__":
    main()
