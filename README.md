# pi-codemap

A [pi](https://pi.dev) extension that gives the agent a **pre-built code map** of the repository, precise **map search / symbol locate** tools, a **guarded `edit` tool** (parse-safety + symbol containment), and optional **Jev** (TypeSafe) judgments that decide when the map is worth loading and when search results are trustworthy.

Benchmarks live in [`bench/`](bench/README.md): retrieval quality (T1), edit mechanics (T2), agent-in-loop token/success comparisons (T3) across baseline / v1 / v2 / v11 / v12 configs.

## Install

```bash
pi install git:github.com/yagaltd/pi-codemap
```

Requires the [code-parser](https://github.com/yagaltd/code-parser) binaries:

```bash
cargo install --git https://github.com/yagaltd/code-parser code-parser-cli --features all
cargo install --git https://github.com/yagaltd/code-parser code-map --features all
```

## What it does

On session start the extension builds a map (`code-map refresh`), renders a **frozen snapshot** (token-budgeted) into the system prompt, and spawns a **watcher** so the map is marked dirty on edits (re-served on idle expiry).

Tools registered:

| tool | purpose |
|---|---|
| `codemap_search` | per-query precision search over the map (IDF + fuzzy + learned lexicon) |
| `codemap_locate` | resolve a symbol name to its exact current line/byte range (fresh parse) |
| `edit` (v12) | replaces the built-in editor: same `oldText`/`newText` semantics, plus validate-then-write guards |

The `edit` guards — every refusal leaves the file untouched:

1. **parse-safety** — the edited file must not gain parse errors (checked on a temp copy)
2. **symbol containment** — an edit inside a symbol must stay within its range ±3 lines
3. **boundary-span refusal** — edits crossing symbol boundaries are refused (split them)

## Jev — classifier #1

With a TypeSafe credential available to pi (pi ≥ 0.99 classifier registry — `TYPESAFE_API_KEY` env, or `/login` with any Jev provider: OpenRouter, Cloudflare, Vercel, opencode):

- **Router** — one judgment on the session's first message: is this a codebase task? Non-code sessions skip the map entirely (saves the injection cost). Trivial prompts skip via a free regex, no API call.
- **Gate** — `codemap_search` re-ranks its shortlist through one Jev relevance battery, but *only* when results look doubtful (weak top score or near-ties). Confident searches cost nothing.
- **Rescue** — failed searches (empty, or all candidates doubted) get a local sub-query expansion pass, Jev-filtered.

Everything **fails open**: no key, timeout, or API error → default behavior, never a crash.

## Configuration

Extension options (set in the entry file):

```ts
createCodemapExtension(pi, {
	editTool: false,     // legacy separate codemap_edit_symbol tool (v2 era)
	jev: true,           // router + gate + rescue
	editOverride: true,  // replace the built-in `edit` with the guarded version
});
```

Environment variables:

| var | default | purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | — | TypeSafe credential (or pi `/login`) |
| `CODEMAP_JEV_LOG` | off | append every Jev decision to `.codemap-jev.log` in the repo |
| `CODEMAP_GATE_TOP` | `0.5` | gate fires when the top score is below this |
| `CODEMAP_GATE_GAP` | `0.05` | …or when top−second is below this |
| `CODEMAP_CLASSIFIER` | — | per-run classifier override: `jev` or `typellm` (see Choosing between them) |
| `CODEMAP_DAG` | `on` | TypeLLM-only DAG gate (span guidance + batch pre-flight); `off` disables |
| `CODEMAP_DAG_REFUSE` | `0.75` | batch pre-flight refuses bundles scoring at or above this |

Commands: `/codemap:status` — map size, snapshot budget, watcher, classifier wiring. `/codemap:login-typellm` — store the TypeLLM key. `/codemap:classifier` — choose jev or typellm.

## Variants

`index.ts` is the shipped extension (map + tools + guarded `edit` + Jev).
`bench/configs/*.ts` hold the A/B variants the benchmark compares against
(v1 = map+tools, v2 = +`codemap_edit_symbol`, v11 = +Jev, v12 = +edit guard, v12-cm = +codemode for the codemode bench, v12-typellm = v12 labeled for CODEMAP_CLASSIFIER=typellm runs).

## Codemode: evaluated, not adopted

pi ≥ 0.99 ships a `codemode` tool — the model writes JavaScript in a QuickJS sandbox and calls other tools from the script. We tested whether scripted edits beat direct tool calls for multi-file work (branch `codemode`, merged for its bench assets only).

Setup: `v12-cm` config enables codemode (`-e builtin:codemode --tools read,bash,edit,write,codemode`); tasks `emp-multifile` (2 files), `emp-manyfile` (8 files) with `multi_file_edit` validator (porcelain-based, catches untracked scratch files); `codemode_calls` recorded per run.

Results (8-file decider, warm cache):

| task | config | result | in | out | tools | turns |
|---|---|---|---|---|---|---|
| emp-manyfile | v12 | PASS | 1,126 | 779 | 2 | 3 |
| emp-manyfile-cm | v12-cm (steered) | PASS | 12,070 | 11,797 | 29 | **2** |

Findings:

1. **Unsteered, the model never uses codemode** — 0 script calls; it prefers direct tool calls even when codemode is available.
2. **Steered, it works and the guards hold** — 11 `edit_guard applied` events across scripted edits (parse-safety + symbol containment enforced on every nested call).
3. **But it costs ~10× more tokens** — script authoring (and trial-and-error) dominates the actual edit work.
4. The real competitor was never "N edit calls" — it's **one bash loop**: the plain config solved all 8 files with 2 tool calls.

**Decision:** codemode is not integrated. The guarded `edit` plus plain tool calls (or a bash loop) is cheaper, preferred by the model, and already constraint-enforced. Revisit only if a workload appears where 1 round-trip is worth ~10× tokens — or for Jev-in-script experiments (`models.classify()` inside a codemode script), which remain untested.

## TypeLLM — classifier #2

[TypeLLM](https://typellm.ai) is Jev-style type-safe generation on ordinary
LLMs (SGLang constrained decoding). It serves the **same bool battery**
(router / gate / rescue) through `api.typellm.ai` — benched at parity (see
below) — **plus** what Jev structurally cannot do, and which this extension
wires as the **DAG gate**:

- **Span-refusal guidance** — when the guard refuses a boundary-spanning
  edit, one `depends_on` call (`kind` → `reason` ∷kind → `split`
  ∷[kind, reason]) appends an agent-facing why and a concrete per-symbol
  split suggestion to the refusal, so the agent recovers on its next turn.
  Hardened A/B (4 reps/cell, Oct 2025): spanning-refusal recovery 6.5 vs
  jev 7.5 mean turns; emp-split 7.0 vs 7.5; pass 7/8 vs 8/8 (one flake per
  side across the campaign). The honest read: mechanisms are reliable
  (`dag_guidance` ok on every fire), the recovery delta is ~1 turn and
  within noise at this n — the value is the **quality of the refusal**
  (reason + actionable split), not a proven speedup.
- **Batch pre-flight** — a bundled edit touching 2+ symbols gets one
  number-typed call (`scope` → `risk` ∷scope → `why`); risk ≥
  `CODEMAP_DAG_REFUSE` (default 0.75) refuses before anything is written,
  else the score is logged and the edit applies. Benched live: 0.5 →
  allowed. `CODEMAP_DAG=off` disables both.

Free text, numbers, per-field thinking with traces, image input, and
`depends_on` decision graphs are the primitives; Jev offers none of them.

Setup: `/codemap:login-typellm` inside pi — masked input, saves to
`~/.config/pi-codemap/typellm.key` (chmod 600). Key chain is **file first,
`TYPELLM_API_KEY` env last** (inverted from mailbox-parser on purpose: a
global env key must not silently override the per-project identity). The
Rust sibling lives in code-parser at `~/.config/code-parser/typellm.key`
(`code-map typellm setup|verify`). Verify with one live call from a clone:
`npx tsx ext/typellm.ts verify`.

Bench verdict (edit suite, 2 reps × 3 tasks, post-fix re-run): **parity** —
typellm 6/6 pass vs jev 6/6; near-identical tokens/turns (typellm slightly
fewer output tokens on the hard task: 2,084 vs 2,468). Earlier verdicts
from before the content-contract fix are superseded — see Bench.

## Choosing between them

You pick the classifier — nothing is silently chosen for you:

```
/codemap:classifier jev       # or typellm — persisted, applies immediately
/codemap:classifier           # show active backend, choice source, availability
/codemap:classifier clear     # back to unset
```

Resolution order: `CODEMAP_CLASSIFIER` env (per-run override) → the
persisted choice → unset. Unset semantics: if only one provider is usable,
it serves; if **both** are usable, Jev serves and you get a **one-time
notice** telling you to pick. A chosen provider that is unavailable means
the classifier idles (visible in `/codemap:status`) — it never silently
falls back to the other one.

The choice is also a feature switch: the **DAG gate is TypeLLM-only** —
choosing `typellm` turns on span-refusal guidance and batch pre-flight;
choosing `jev` keeps the plain refusal text. Parity on the shared battery
means the choice costs nothing measurable on router/gate/rescue.

## Bench

**Note on data from before Oct 2025 (fix `cbbe6c4`):** extension tools used to
return string content, which crashed pi's result dispatch *after* execution —
the model never saw tool output (100% isError on codemap_search/locate, ~31%
on edit). Tasks still passed via the system-prompt map + read/bash + blind
retry, so pass/fail columns remained meaningful but tool-level numbers did
not. All current numbers come from post-fix runs.

Post-fix trio (pi alone vs codemap+jev vs codemap+typellm, 2 reps × 3 tasks):

| task | config | pass | in | out | tools | turns | wall |
|---|---|---|---|---|---|---|---|
| cp-edit (trivial) | baseline | 2/2 | 1,001 | 313 | 3.5 | 4.5 | 12s |
| cp-edit | v12 (jev) | 2/2 | 2,570 | 308 | 2.5 | 3.5 | 19s |
| cp-edit | v12-typellm | 2/2 | 2,557 | 286 | 2.5 | 3.5 | 24s |
| emp-span (hard) | baseline | **1/2** | 28,463 | 4,074 | 4.5 | 4.5 | 71s |
| emp-span | v12 | 2/2 | 25,324 | 2,468 | 7.0 | 7.0 | 65s |
| emp-span | v12-typellm | 2/2 | 24,973 | 2,084 | 7.0 | 7.0 | 56s |
| emp-split (recovery) | baseline | 2/2 | 20,734 | 570 | 4.0 | 4.5 | 18s |
| emp-split | v12 | 2/2 | 24,537 | 670 | 3.0 | 4.0 | 26s |
| emp-split | v12-typellm | 2/2 | 25,350 | 1,324 | 4.0 | 5.0 | 40s |

Reading: on hard big-file tasks codemap prevents the thrash loop (baseline
failed one run burning +65% output tokens; codemap 2/2 with −40/−49% output
tokens). On trivial tasks the map snapshot costs ~1.5k input and a few
seconds. Tool error rates post-fix: 0 hard errors across all 76 calls in
all three configs.

## Bench

```bash
cd bench
python3 harness/t3_agent.py --suite edit --config v12 --repeat 3
```

Suites: `agent` (single tasks), `session` (3 questions per session), `edit` (precise-edit contract). See [`bench/README.md`](bench/README.md).

## License

MIT
