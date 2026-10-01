#!/usr/bin/env python3
"""Layer-1 canary: do the classifiers discriminate easy vs hard prompts?

Fixed probe set (ported from jev-router's live-routing.mjs idea), run against
BOTH engines (jev-latest + typellm-latest) with the same two bool questions
the router battery uses. PASS = easy prompts verdict low-effort-sufficient,
hard prompts not. Exit 1 on discrimination failure.
"""
import json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(__file__))
PROBES = [
    ("easy", "Fix the typo 'recieve' in README.md."),
    ("easy", "Add a log line at the start of parse_mbox_file in src/parser.py."),
    ("easy", "Rename the local variable `data` to `rows` inside load_csv."),
    ("easy", "Bump the package version to 2.1.0 in package.json."),
    ("hard", "Users intermittently get logged out after deploy — find the race condition."),
    ("hard", "Migrate this monorepo from webpack to vite without breaking CI."),
    ("hard", "Redesign the storage layer to shard by tenant without downtime."),
    ("hard", "This recursive parser blows the stack on deeply nested input — rework it iteratively with tests."),
]
EFFORT_Q = {
    "type": "noul",
    "instructions": "Could this task be completed correctly with MINIMAL reasoning effort — a mechanical change with an obvious, well-defined solution and no subtle interactions?",
    "criteria": {"true": "Yes — mechanical/obvious; minimal reasoning suffices.",
                 "false": "No — it needs substantial reasoning (debugging, design, cross-file effects)."},
}

def post(url, key, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "{}")

def jev_verdict(prompt, key):
    body = {"model": "jev-latest", "state": {"request": prompt}, "questions": {"q": EFFORT_Q}}
    r = post("https://api.typesafe.ai/v1/systemone", key, body)
    a = (r.get("result") or r.get("answers") or {}).get("q", {})
    return float(a.get("probability", a.get("noul", 0)))

def typellm_verdict(prompt, key):
    body = {"context": prompt, "questions": {"q": {
        "type": "boolean",
        "instructions": EFFORT_Q["instructions"],
        "return_probabilities": True}}}
    r = post("https://api.typellm.ai/v1/generate", key, body)
    a = (r.get("result") or {}).get("q", {})
    if isinstance(a, dict):
        p = (a.get("probabilities") or {}).get("true")
        return float(p) if p is not None else (1.0 if a.get("value") else 0.0)
    return 1.0 if a else 0.0

def main():
    tkey = open(os.path.expanduser("~/.config/pi-codemap/typellm.key")).read().strip()
    jkey = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not jkey:
        print("TYPESAFE_API_KEY missing — jev column skipped"); 
    rows, fails = [], 0
    for kind, prompt in PROBES:
        row = {"kind": kind, "prompt": prompt[:44]}
        if jkey:
            row["jev_p"] = round(jev_verdict(prompt, jkey), 3)
        row["typellm_p"] = round(typellm_verdict(prompt, tkey), 3)
        rows.append(row)
        for eng in ("jev_p", "typellm_p"):
            if eng in row:
                low = row[eng] >= 0.5
                if (kind == "easy") != low: fails += 1
        print(row)
    print(f"\ndiscrimination failures: {fails}/{len(PROBES)*sum(1 for r in rows for e in ('jev_p','typellm_p') if e in r)}")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
