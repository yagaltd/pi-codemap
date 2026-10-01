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

## Jev add-ons (optional)

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

Commands: `/codemap:status` — map size, snapshot budget, watcher, Jev wiring.

## Variants

`index.ts` is the shipped extension (map + tools + guarded `edit` + Jev).
`bench/configs/*.ts` hold the A/B variants the benchmark compares against
(v1 = map+tools, v2 = +`codemap_edit_symbol`, v11 = +Jev, v12 = +edit guard).

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

## Codemode: evaluated, not adopted

pi >= 0.99 ships a `codemode` tool - the model writes JavaScript in a QuickJS sandbox and calls other tools from the script. We tested whether scripted edits beat direct tool calls for multi-file work (branch `codemode`, merged for its bench assets only).

Setup: `v12-cm` config enables codemode (`-e builtin:codemode --tools read,bash,edit,write,codemode`); tasks `emp-multifile` (2 files) and `emp-manyfile` (8 files) with the `multi_file_edit` validator (porcelain-based, catches untracked scratch files); `codemode_calls` recorded per run.

Results (8-file decider, warm cache):

| task | config | result | in | out | tools | turns |
|---|---|---|---|---|---|---|
| emp-manyfile | v12 | PASS | 1,126 | 779 | 2 | 3 |
| emp-manyfile-cm | v12-cm (steered) | PASS | 12,070 | 11,797 | 29 | **2** |

Findings:

1. **Unsteered, the model never uses codemode** - 0 script calls; it prefers direct tool calls even when codemode is available.
2. **Steered, it works and the guards hold** - 11 `edit_guard applied` events across scripted edits (parse-safety + symbol containment enforced on every nested call).
3. **But it costs ~10x more tokens** - script authoring (and trial-and-error) dominates the actual edit work.
4. The real competitor was never "N edit calls" - it is **one bash loop**: the plain config solved all 8 files with 2 tool calls.

**Decision:** codemode is not integrated. The guarded `edit` plus plain tool calls (or a bash loop) is cheaper, is what the model prefers, and is already constraint-enforced. Revisit only if a workload appears where 1 round-trip is worth ~10x tokens - or for Jev-in-script experiments (`models.classify()` inside a codemode script), which remain untested.

## TypeLLM (optional second provider)

[TypeLLM](https://typellm.ai) is Jev-style type-safe generation on ordinary
LLMs, plus what Jev cannot do: free-text answers, number/integer types,
per-field thinking (with reasoning traces), image input and `depends_on`
decision graphs. Not wired into the extension yet — this ships the credential
plumbing so pi-codemap gets its own identity:

- setup: run `/codemap:login-typellm` inside pi — masked input, saves to
  `~/.config/pi-codemap/typellm.key` (chmod 600)
- status: `/codemap:status` shows `typellm wired/off`
- verify (from a clone): `npx tsx ext/typellm.ts verify` — one live call
  proving string/number/boolean/enum answers

Key chain is **file first, `TYPELLM_API_KEY` env last** (inverted from
mailbox-parser on purpose: a global env key must not silently override the
per-project identity). The Rust sibling lives in code-parser at
`~/.config/code-parser/typellm.key` (`code-map typellm setup|verify`).


## Bench

```bash
cd bench
python3 harness/t3_agent.py --suite edit --config v12 --repeat 3
```

Suites: `agent` (single tasks), `session` (3 questions per session), `edit` (precise-edit contract). See [`bench/README.md`](bench/README.md).

## License

MIT
