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

## Bench

```bash
cd bench
python3 harness/t3_agent.py --suite edit --config v12 --repeat 3
```

Suites: `agent` (single tasks), `session` (3 questions per session), `edit` (precise-edit contract). See [`bench/README.md`](bench/README.md).

## License

MIT
