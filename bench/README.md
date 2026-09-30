# pi-codemap benchmark

Measures what `code-parser`/`code-map` actually buy an agent — **before**
the extension exists, so v1/v2 land against numbers, not vibes. Three
tiers, all on real local codebases frozen at recorded SHAs:

| Repo | Language | SHA |
|---|---|---|
| code-parser (dogfood) | Rust | 68f2303 |
| Empryo | TypeScript | 669ff91 |
| CognitiveOS v3 | Rust | f7c6f58c3 |

## T1 — retrieval layer (deterministic, no LLM)

The v1 core: `code-map search` + snapshot on foreign repos.
24 agent-style queries with gold files (8 per repo). File-level
Recall@5/@10 + MRR@10 vs a grep term-frequency baseline.

```bash
python3 bench/harness/t1_retrieval.py --verbose
```

## T2 — edit-by-name mechanics (deterministic, no LLM)

The v2 core, implemented exactly as the extension will:
find via map → **locate by fresh single-file parse** (never map ranges) →
refuse on 0 or >1 name matches → splice `[start_byte, end_byte)` →
validate (reparses clean, marker present, outside bytes intact).

Modes: `identity` (splice must reproduce the file byte-for-byte),
`marker` (comment prepended to the symbol), `negative` (must refuse),
`stale` (file mutated *after* map build — fresh-parse must survive what
map-range editing would corrupt). Includes the real-world ambiguity case
(`with_debounce` exists twice in watcher.rs text: real + cfg'd-out stub).

```bash
python3 bench/harness/t2_edit.py --verbose
```

## T3 — agent in the loop (pi defaults vs v1 vs v2)

Runs `pi -p --mode json` in throwaway local clones with per-config
extension flags; scores validator success + cost
(tokens in/out, turns, tool calls, files read).

```bash
python3 bench/harness/t3_agent.py --config baseline          # today
python3 bench/harness/t3_agent.py --config v1 --repeat 3     # when v1 lands
python3 bench/harness/t3_agent.py --config v2 --repeat 3     # when v2 lands
```

v1/v2 rows activate automatically when the extension dirs exist
(`pi-codemap-v1/`, `pi-codemap-v2/` beside this repo).

## Methodology notes

- Deterministic tiers run in CI-ish seconds; T3 carries LLM variance —
  use `--repeat N` and compare means, one config change at a time.
- Gold is part of the dataset: if code moves, update gold with it
  (the harness fails loudly on stale gold paths).
- The grep baseline in T1 is the honesty floor: a retrieval layer that
  ties keyword search has no reason to exist.
- Results land in `bench/results/*.json`; keep the latest committed.
