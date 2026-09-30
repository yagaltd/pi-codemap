#!/usr/bin/env python3
"""T1 — retrieval layer on real codebases (deterministic, no LLM, no pi).

Measures the v1 retrieval core — code-map search + snapshot — the same way
E2 measures code-parser's own repo, but across three real target repos
(Rust x2, TypeScript) with foreign vocabulary. Greep baseline included:
the engine has no reason to exist if keyword search ties it.

Run: python3 bench/harness/t1_retrieval.py [--verbose]
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

VERBOSE = "--verbose" in sys.argv


def main():
    tasks = C.load_tasks("t1_retrieval.jsonl")
    os.makedirs(C.RESULTS, exist_ok=True)
    maps = {r: C.ensure_map(r) for r in C.REPOS}

    # Snapshot facts (informational): does each repo fit the default budget?
    snap_facts = {}
    for repo, map_path in maps.items():
        r = C.run(["code-map", "snapshot", "-m", map_path, "--json"])
        d = json.loads(r.stdout)
        snap_facts[repo] = {k: d[k] for k in ("est_tokens", "files", "omitted", "budget")}

    rows = []
    for t in tasks:
        repo = t["repo"]
        gold, query = t["gold"], t["query"]
        root = C.repo_root(repo)
        eng = C.search_map(maps[repo], query, n=30)[:10]
        base = C.grep_baseline(maps[repo], root, query, k=10)
        row = {
            "id": t["id"], "repo": repo, "query": query,
            "eng_rank": _rank(gold, eng), "base_rank": _rank(gold, base),
            "eng_r5": C.recall_at_k(gold, eng, 5),
            "eng_r10": C.recall_at_k(gold, eng, 10),
            "eng_mrr": C.mrr_at_k(gold, eng, 10),
            "base_r5": C.recall_at_k(gold, base, 5),
            "base_r10": C.recall_at_k(gold, base, 10),
            "base_mrr": C.mrr_at_k(gold, base, 10),
        }
        rows.append(row)
        if VERBOSE:
            print(f"{t['id']:<10} eng={row['eng_rank']:<6} grep={row['base_rank']:<6} {query[:50]}")

    def agg(rs):
        return {
            "n": len(rs),
            "eng_r5": round(C.mean([r["eng_r5"] for r in rs]), 3),
            "eng_r10": round(C.mean([r["eng_r10"] for r in rs]), 3),
            "eng_mrr": round(C.mean([r["eng_mrr"] for r in rs]), 3),
            "base_r5": round(C.mean([r["base_r5"] for r in rs]), 3),
            "base_r10": round(C.mean([r["base_r10"] for r in rs]), 3),
            "base_mrr": round(C.mean([r["base_mrr"] for r in rs]), 3),
        }

    summary = {"overall": agg(rows)}
    for repo in C.REPOS:
        summary[repo] = agg([r for r in rows if r["repo"] == repo])

    out = {"tier": "t1", "snapshots": snap_facts, "summary": summary, "rows": rows}
    path = os.path.join(C.RESULTS, "t1_retrieval.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)

    print("T1 retrieval — engine vs grep baseline (file-level Recall@5/@10, MRR@10)")
    print(f"{'':<14}{'n':>3}{'eng R@5':>9}{'R@10':>7}{'MRR':>7}{'grep R@5':>10}{'R@10':>7}{'MRR':>7}")
    for name in ("overall", *C.REPOS):
        s = summary[name]
        print(f"{name:<14}{s['n']:>3}{s['eng_r5']:>9.3f}{s['eng_r10']:>7.3f}{s['eng_mrr']:>7.3f}"
              f"{s['base_r5']:>10.3f}{s['base_r10']:>7.3f}{s['base_mrr']:>7.3f}")
    print("\nsnapshot budget fit:", json.dumps(snap_facts))
    print(f"\nwrote {path}")


def _rank(gold, ranked):
    for i, p in enumerate(ranked):
        if p in gold:
            return f"#{i+1}"
    return "miss"


if __name__ == "__main__":
    main()
