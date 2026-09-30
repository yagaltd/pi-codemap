"""Shared config for the pi-codemap benchmark harness. Zero dependencies."""
import json
import os
import subprocess
import sys

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(BENCH, ".cache")
WORK = os.path.join(BENCH, ".work")
RESULTS = os.path.join(BENCH, "results")
TASKS = os.path.join(BENCH, "tasks")

# Frozen at authoring time. A drift here means re-validating gold.
REPOS = {
    "code-parser": {
        "root": "/home/aurel/Documents/current/code-parser",
        "subroot": "",
        "langs": "rust",
        "sha": "68f2303",
    },
    "empryo": {
        "root": "/home/aurel/Documents/vibe/Empryo",
        "subroot": "",
        "langs": "typescript,javascript",
        "sha": "669ff91",
    },
    "cognitiveos": {
        "root": "/home/aurel/Documents/current/CognitiveOS",
        "subroot": "v3",
        "langs": "rust",
        "sha": "f7c6f58c3",
    },
}


def repo_root(name, absolute=False):
    """Map corpus root: subroot applies when the repo parses a subdirectory
    (CognitiveOS parses v3/ so paths in the map are v3-relative... they are
    actually relative to the subroot itself)."""
    cfg = REPOS[name]
    root = os.path.join(cfg["root"], cfg["subroot"]) if cfg["subroot"] else cfg["root"]
    return os.path.abspath(root)


def load_tasks(name):
    path = os.path.join(TASKS, name)
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def run(cmd, cwd=None, timeout=300, stdin=None):
    """Run a command, return CompletedProcess; raise on timeout."""
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, input=stdin
    )


def ensure_map(repo_name):
    """Build (once) the code-map JSONL for a repo. Returns the map path."""
    os.makedirs(CACHE, exist_ok=True)
    map_path = os.path.join(CACHE, f"{repo_name}.jsonl")
    if os.path.exists(map_path):
        return map_path
    root = repo_root(repo_name)
    r = run(["code-map", "refresh", root, "-o", map_path,
             "--languages", REPOS[repo_name]["langs"]], timeout=600)
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:], file=sys.stderr)
        raise RuntimeError(f"refresh failed for {repo_name}")
    return map_path


def search_map(map_path, query, n=30):
    """Engine ranking: code-map search, deduped to file order (first
    mention wins — mirrors how an agent reads a file once)."""
    r = run(["code-map", "search", "-m", map_path, query, "-n", str(n), "--json"])
    if r.returncode != 0:
        return []
    try:
        results = json.loads(r.stdout).get("results", [])
    except json.JSONDecodeError:
        return []
    seen, files = set(), []
    for hit in results:
        p = hit.get("path", "")
        if p and p not in seen:
            seen.add(p)
            files.append(p)
    return files


def grep_baseline(map_path, repo_root_path, query, k=10):
    """Keyword floor: term-frequency ranking over raw source (grep-style)."""
    terms = [t.lower() for t in _tokenize(query)]
    scored = []
    with open(map_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                path = json.loads(line)["path"]
            except json.JSONDecodeError:
                continue
            try:
                with open(os.path.join(repo_root_path, path), errors="replace") as src:
                    hay = src.read().lower()
            except OSError:
                continue
            score = sum(hay.count(t) for t in terms)
            scored.append((score, path))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [p for s, p in scored[:k] if s > 0]


def _tokenize(text):
    out, cur = [], []
    for ch in text.lower():
        if ch.isalnum() or ch == "_":
            cur.append(ch)
        else:
            if cur:
                out.append("".join(cur))
                cur = []
    if cur:
        out.append("".join(cur))
    return out


def recall_at_k(gold, ranked, k):
    top = set(ranked[:k])
    return len([g for g in gold if g in top]) / len(gold)


def mrr_at_k(gold, ranked, k):
    for i, p in enumerate(ranked[:k]):
        if p in gold:
            return 1.0 / (i + 1)
    return 0.0


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0
