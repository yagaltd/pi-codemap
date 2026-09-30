/**
 * pi-codemap — code-parser/code-map integration for pi.
 *
 * Shared core for v1 (snapshot + search + locate) and v2 (+ edit-by-name).
 *
 * Architecture (matches the frozen-prefix contract):
 *  - session_start: build the map (code-map refresh, hash-cache fast) and
 *    spawn `code-parser watch --emit jsonl` as a child. The watcher is a
 *    *change signal*: on every batch_end we mark the map dirty; the next
 *    agent run refreshes (cheap, hash-cached) and re-renders the snapshot.
 *  - before_agent_start: append the FROZEN snapshot to the system prompt.
 *    Byte-identical across requests while held (no clock, no drift) so the
 *    provider prompt cache keeps hitting. Re-render happens only after the
 *    idle TTL expired AND the map changed — a cache-safe boundary.
 *  - tools: codemap_search (per-query precision over the map) and
 *    codemap_locate (symbol -> file + FRESH range via single-file reparse —
 *    map ranges may be a moment stale; locate never trusts them for edits).
 *
 * Per-query cards are NOT auto-injected into the user turn in v1: the
 * dynamic zone is the agent calling codemap_search (one round-trip, same
 * token effect, no message-transform risk).
 */
import { spawn, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gateShortlist, gateTriggered, routeFirstPrompt, subQueryTerms, systemOne, type GateCandidate } from "./jev.ts";
import { keySituation, storeApiKey } from "./credentials.ts";
import { promptForApiKey } from "./key-prompt.ts";

const SNAPSHOT_BUDGET = 2500;
const IDLE_TTL_MS = 5 * 60 * 1000;
const MAPS_DIR = path.join(os.tmpdir(), "pi-codemap");
/** Repos above this file count skip the watcher (refresh-only mode). */
const MAX_WATCH_FILES = 5000;

interface State {
	cwd: string;
	enabled: boolean;
	reason?: string;
	mapPath: string;
	watcher?: ReturnType<typeof spawn>;
	mapDirty: boolean;
	/** Frozen snapshot content — byte-identical while held. */
	snapshot: string;
	snapshotMeta: { files: number; omitted: number; estTokens: number };
	lastServedMs: number;
	filesIndexed: number;
	/** v1.1 router: decided once per session (first agent start). */
	jevRouterDecided?: boolean;
	jevRouterSkipped?: boolean;
}

function sh(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): {
	ok: boolean;
	stdout: string;
	stderr: string;
} {
	try {
		const stdout = execFileSync(cmd, args, {
			cwd: opts.cwd,
			timeout: opts.timeout ?? 60_000,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: stdout ?? "", stderr: "" };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "failed" };
	}
}

function has(bin: string): boolean {
	try {
		execFileSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// ── lifecycle ─────────────────────────────────────────────────────────────

function init(st: State, ctx: ExtensionContext): void {
	st.cwd = ctx.cwd;
	if (!has("code-parser") || !has("code-map")) {
		st.enabled = false;
		st.reason = "install: cargo install --git https://github.com/yagaltd/code-parser code-parser-cli --features all && cargo install --path crates/code-map --features all";
		return;
	}
	fs.mkdirSync(MAPS_DIR, { recursive: true });
	const key = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 16);
	st.mapPath = path.join(MAPS_DIR, `map-${key}.jsonl`);

	const r = sh("code-map", ["refresh", ctx.cwd, "-o", st.mapPath, "--languages", "rust,typescript,javascript,python"], { timeout: 300_000 });
	if (!r.ok) {
		st.enabled = false;
		st.reason = `refresh failed: ${r.stderr.slice(0, 200)}`;
		return;
	}
	st.filesIndexed = countLines(st.mapPath);
	renderSnapshot(st);
	st.enabled = true; // BUGFIX: was never set — snapshot injection silently no-oped in all prior runs (tools still worked, so the bench never caught it)

	// Watcher = change signal. Killed on session_shutdown; failure degrades
	// to refresh-on-expiry (correct, just less fresh).
	if (st.filesIndexed <= MAX_WATCH_FILES) {
		try {
			const w = spawn("code-parser", ["watch", ctx.cwd, "--emit", "jsonl"], {
				stdio: ["ignore", "pipe", "ignore"],
				detached: false,
			});
			let buf = "";
			w.stdout.on("data", (chunk: Buffer) => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line.includes('"batch_end"')) st.mapDirty = true;
				}
			});
			w.on("error", () => undefined);
			st.watcher = w;
		} catch {
			/* degrade silently */
		}
	}
}

function shutdown(st: State): void {
	if (st.watcher) {
		try {
			st.watcher.kill("SIGTERM");
		} catch {
			/* idempotent */
		}
		st.watcher = undefined;
	}
}

function countLines(p: string): number {
	try {
		return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function renderSnapshot(st: State): void {
	const r = sh("code-map", ["snapshot", "-m", st.mapPath, "-b", String(SNAPSHOT_BUDGET), "--json"]);
	if (!r.ok) return;
	try {
		const d = JSON.parse(r.stdout);
		st.snapshot = String(d.content ?? "");
		st.snapshotMeta = { files: d.files ?? 0, omitted: d.omitted ?? 0, estTokens: d.est_tokens ?? 0 };
	} catch {
		/* keep old snapshot */
	}
}

function ensureFresh(st: State, nowMs: number): void {
	const idleExpired = nowMs - st.lastServedMs >= IDLE_TTL_MS;
	if (idleExpired && st.mapDirty) {
		const r = sh("code-map", ["refresh", st.cwd, "-o", st.mapPath, "--languages", "rust,typescript,javascript,python"], { timeout: 300_000 });
		if (r.ok) {
			st.filesIndexed = countLines(st.mapPath);
			st.mapDirty = false;
		}
		renderSnapshot(st);
	}
	st.lastServedMs = nowMs;
}

// ── map queries (tools) ───────────────────────────────────────────────────

interface SearchHit {
	path: string;
	line: number;
	kind: string;
	name: string;
	score: number;
	tokens_est: number;
	card?: string;
}

export function runSearch(st: State, query: string, limit: number): SearchHit[] {
	const r = sh("code-map", ["search", "-m", st.mapPath, query, "-n", String(limit), "--json"]);
	if (!r.ok) return [];
	try {
		return (JSON.parse(r.stdout).results ?? []) as SearchHit[];
	} catch {
		return [];
	}
}

interface Sym {
	local_key: string;
	name: string;
	qualified_name: string;
	kind: string;
	start_line: number;
	end_line: number;
	start_byte: number;
	end_byte: number;
	signature: string | null;
	docstring: string | null;
}

export interface LocateResult {
	file: string;
	matches: Sym[];
	sources: string[];
	error?: string;
}

/**
 * Locate by FRESH single-file reparse — the edit-by-name safety property:
 * map ranges may be a moment stale; byte ranges for splicing always come
 * from a parse of the file as it exists right now.
 */
export function locateFresh(st: State, symbol: string, fileHint?: string): LocateResult {
	let file = fileHint;
	if (!file) {
		const hits = runSearch(st, symbol, 5);
		if (hits.length === 0) return { file: "", matches: [], sources: [], error: `no map hits for '${symbol}'` };
		file = hits[0].path;
	}
	const abs = path.isAbsolute(file) ? file : path.join(st.cwd, file);
	if (!fs.existsSync(abs)) return { file, matches: [], sources: [], error: `file not found: ${file}` };
	const r = sh("code-parser", ["parse", abs, "--json"], { timeout: 30_000 });
	if (!r.ok) return { file, matches: [], sources: [], error: `parse failed: ${r.stderr.slice(0, 200)}` };
	const ir = JSON.parse(r.stdout);
	const matches: Sym[] = (ir.symbols ?? []).filter(
		(s: Sym) => s.name === symbol || s.local_key === symbol || s.qualified_name === symbol,
	);
	// BYTE-domain read: IR offsets are tree-sitter byte offsets. Never slice
	// a JS string by them (UTF-16) — splice on Buffers (T2 lesson).
	const buf = fs.readFileSync(abs);
	const sources = matches.map((s) => buf.subarray(s.start_byte, s.end_byte).toString("utf8").slice(0, 4000));
	return { file, matches, sources };
}

/** v2 edit-by-name: fresh-parse locate + Buffer splice + reparse validate. */
export function editSymbol(
	st: State,
	symbol: string,
	newText: string,
	fileHint?: string,
): { ok: boolean; detail: string } {
	const loc = locateFresh(st, symbol, fileHint);
	if (loc.error) return { ok: false, detail: loc.error };
	if (loc.matches.length === 0)
		return { ok: false, detail: `no symbol '${symbol}' in ${loc.file} — refuse (never guess)` };
	if (loc.matches.length > 1)
		return {
			ok: false,
			detail: `'${symbol}' is ambiguous (${loc.matches.length} matches in ${loc.file}):\n` +
				loc.matches.map((m) => `  ${m.qualified_name} L${m.start_line}-${m.end_line}`).join("\n") +
				`\nre-run with a qualified name or edit manually`,
		};
	const s = loc.matches[0];
	const abs = path.isAbsolute(loc.file) ? loc.file : path.join(st.cwd, loc.file);
	const before = fs.readFileSync(abs); // Buffer
	const replacement = Buffer.from(newText, "utf8");
	const edited = Buffer.concat([before.subarray(0, s.start_byte), replacement, before.subarray(s.end_byte)]);
	const errsBefore = (JSON.parse(sh("code-parser", ["parse", abs, "--json"]).stdout).diagnostics ?? []).filter(
		(d: { severity: string }) => d.severity === "Error",
	).length;
	fs.writeFileSync(abs, edited);
	const after = sh("code-parser", ["parse", abs, "--json"]);
	if (!after.ok) {
		fs.writeFileSync(abs, before); // roll back on unparseable result
		return { ok: false, detail: "edited file failed to parse — rolled back" };
	}
	const errsAfter = (JSON.parse(after.stdout).diagnostics ?? []).filter((d: { severity: string }) => d.severity === "Error").length;
	if (errsAfter > errsBefore) {
		fs.writeFileSync(abs, before);
		return { ok: false, detail: `edit introduced ${errsAfter - errsBefore} parse error(s) — rolled back` };
	}
	return {
		ok: true,
		detail: `replaced ${s.qualified_name} (${edited.length - before.length >= 0 ? "+" : ""}${edited.length - before.length} bytes) in ${loc.file} L${s.start_line}-${s.end_line}; reparses clean`,
	};
}

// ── extension factory ─────────────────────────────────────────────────────

export interface CodemapOptions {
	editTool?: boolean;
	/** v1.1: Jev router (map injection) + low-confidence search gate. */
	jev?: boolean;
}

export function createCodemapExtension(pi: ExtensionAPI, opts: CodemapOptions): void {
	let onboardedKeyMissing = false;
	/** Failed-search rescue results, cached per query for this session. */
	const rescueCache = new Map<string, SearchHit[]>();

	const st: State = {
		cwd: "",
		enabled: false,
		mapPath: "",
		mapDirty: false,
		snapshot: "",
		snapshotMeta: { files: 0, omitted: 0, estTokens: 0 },
		lastServedMs: 0,
		filesIndexed: 0,
	};

	function jevLog(e: Record<string, unknown>): void {
		if (process.env.CODEMAP_JEV_LOG) {
			try {
				fs.appendFileSync(path.join(st.cwd, ".codemap-jev.log"), JSON.stringify(e) + "\n");
			} catch {
				/* logging never breaks the request path */
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		init(st, ctx);
		if (st.enabled && ctx.hasUI) {
			ctx.ui.setStatus("codemap", `map ${st.filesIndexed}f · snap ${st.snapshotMeta.estTokens}tok`);
		} else if (!st.enabled && ctx.hasUI) {
			ctx.ui.setStatus("codemap", `codemap off (${(st.reason ?? "").slice(0, 40)})`);
		}
		// Onboarding (pi-typesafe pattern): say it once, never force a modal.
		if (opts.jev && st.enabled && ctx.hasUI && !onboardedKeyMissing && keySituation().source === "missing") {
			onboardedKeyMissing = true;
			ctx.ui.notify(
				"pi-codemap: Jev router/gate are inactive — no API key. Run /codemap:login to save one (also read from TYPESAFE_API_KEY or /typesafe login). Everything else works without it.",
				"warning",
			);
		}
	});

	pi.registerCommand("codemap:login", {
		description: "Save a TypeSafe API key for the Jev router/gate (owner-only file)",
		handler: async (_args, ctx) => {
			const sit = keySituation();
			if (sit.source === "environment") {
				if (ctx.hasUI) ctx.ui.notify("TYPESAFE_API_KEY is set in the environment and takes precedence over a stored key. Unset it before using /codemap:login.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				console.log("codemap:login needs an interactive UI; set TYPESAFE_API_KEY instead.");
				return;
			}
			const raw = await promptForApiKey(ctx);
			if (raw === undefined) {
				ctx.ui.notify("Login cancelled; nothing was saved.", "info");
				return;
			}
			let key: string;
			try {
				key = storeApiKey(raw);
			} catch (e) {
				ctx.ui.notify(String((e as Error).message ?? e), "error");
				return;
			}
			// Verify with one tiny judgment before claiming success.
			const probe = await systemOne("login probe", { ok: { type: "noul", instructions: "Reply to this probe.", criteria: { true: "ok", false: "not ok" } } });
			if (probe) {
				ctx.ui.notify(`Key verified (model ${probe.model}) and saved to ${key} with owner-only permissions.`, "info");
			} else {
				ctx.ui.notify(`Key saved to ${key}, but the verification call failed — check the key at console.typesafe.ai.`, "warning");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!st.enabled || !st.snapshot) return;
		// v1.1 router: decide ONCE per session whether this session gets the
		// map at all. Default inject; skip only on confident non-code. The
		// decision is cached — a mid-session injection would re-pay the
		// provider cache write at the worst moment.
		if (opts.jev && !st.jevRouterDecided) {
			st.jevRouterDecided = true;
			const d = await routeFirstPrompt(event.prompt, jevLog);
			st.jevRouterSkipped = d === "skip";
		}
		if (opts.jev && st.jevRouterSkipped) return;
		ensureFresh(st, Date.now());
		// Structured section mutation — NOT a systemPrompt override. Overriding
		// the rendered text forces providers down the full-transcript path and
		// torched ~15k uncached tokens/request in the bench; a named section
		// appends a transcript delta and keeps the prefix cache-stable.
		event.systemPromptOptions.sections["codemap"] =
			`Code map of this repository (auto-generated pre-scan, ${st.snapshotMeta.files} files, ~${st.snapshotMeta.estTokens} tokens; may be a moment stale).\n\n${st.snapshot}\nThis map is a starting point, NOT ground truth: before answering "where is X" or editing, verify the exact code by reading the file or codemap_locate — do not answer from the map alone.\nUse codemap_search for precise per-query lookup and codemap_locate to resolve a symbol to its exact current range before editing.`;
	});

	pi.registerTool({
		name: "codemap_search",
		label: "Code map search",
		description:
			"Search the indexed code map of this repository (IDF + fuzzy over files, symbols, docstrings, imports). Use for 'where is X implemented' questions before reading files; much cheaper than grepping.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural-language or identifier query" },
				limit: { type: "number", description: "Max results (default 10)" },
			},
			required: ["query"],
		} as never,
		execute: async (_id, params) => {
			const q = String((params as { query: string }).query);
			const limit = Math.min(30, Math.max(1, Number((params as { limit?: number }).limit ?? 10)));
			const hits = runSearch(st, q, limit);
			// v1.1 gate: only doubtful shortlists pay a Jev call. Confident
			// searches return untouched. Re-rank by judged relevance; never
			// return fewer than 3 hits (gate failure = original order).
			let gated: typeof hits = [];
			let gateAllDoubted = false;
			if (opts.jev && gateTriggered(hits.map((h) => h.score))) {
				try {
				const cands: GateCandidate[] = hits.slice(0, 8).map((h) => ({ name: h.name, path: h.path, kind: h.kind, score: h.score }));
				const rel = await gateShortlist(q, cands, jevLog);
				if (rel) {
					gated = hits
						.slice(0, cands.length)
						.map((h, i) => ({ hit: h, p: rel[i] }))
						.sort((a, b) => b.p - a.p || b.hit.score - a.hit.score)
						.map((x) => ({ ...x.hit, score: x.hit.score, jev: x.p }));
					if (gated.every((g) => (g.jev ?? 0) < 0.5)) {
						gateAllDoubted = true;
						gated = hits.slice(0, 3); // all doubted — keep engine order, top 3
					}
				}
				} catch (e) {
					jevLog({ event: "gate", decision: "unavailable", error: String(e).slice(0, 120) });
				}
			}
			let shown = gated.length > 0 ? gated : hits;
			// v1.1 rescue: failed search (no hits, or gate fired and ALL candidates
			// doubted). Local sub-query expansion, then one Jev relevance battery
			// over the merged candidates. Fail-open to the original result.
			if (opts.jev && !rescueCache.has(q) && (hits.length === 0 || (gateAllDoubted && shown.length > 0))) {
				try {
					const terms = subQueryTerms(q);
					const merged = new Map<string, (typeof hits)[number]>();
					for (const t of terms) {
						for (const h of runSearch(st, t, 5)) {
							const k = `${h.path}:${h.name}`;
							if (!merged.has(k) || merged.get(k)!.score < h.score) merged.set(k, h);
						}
					}
					const cands = [...merged.values()].slice(0, 8).map((h) => ({ name: h.name, path: h.path, kind: h.kind, score: h.score }));
					const rel = cands.length > 0 ? await gateShortlist(q, cands, jevLog) : null;
					if (rel) {
						const rescued = [...merged.values()]
							.slice(0, cands.length)
							.map((h, i) => ({ hit: h, p: rel[i] }))
							.filter((x) => x.p >= 0.5)
							.sort((a, b) => b.p - a.p || b.hit.score - a.hit.score)
							.slice(0, limit)
							.map((x) => ({ ...x.hit, jev: x.p }));
						jevLog({ event: "rescue", decision: rescued.length > 0 ? "fired" : "empty", terms, kept: rescued.length });
						if (rescued.length > 0) {
							shown = rescued;
							rescueCache.set(q, rescued); // agents retry failed queries — pay once per session
						}
					}
				} catch (e) {
					jevLog({ event: "rescue", decision: "unavailable", error: String(e).slice(0, 120) });
				}
			}
			const content =
				shown.length === 0
					? `no map hits for '${q}'`
					: shown
							.map((h) => {
								const mark = (h as { jev?: number }).jev !== undefined ? ` [jev:${(h as { jev: number }).jev.toFixed(2)}]` : "";
								return `${h.score.toFixed(3)}${mark} ${h.path}:${h.line} ${h.kind} ${h.name} (~${h.tokens_est}tok)`;
							})
							.join("\n");
			return { content, details: { hits: shown } };
		},
	});

	pi.registerTool({
		name: "codemap_locate",
		label: "Locate symbol",
		description:
			"Resolve a symbol name to its exact CURRENT range: re-parses the file fresh (map ranges may be a moment stale). Returns file, lines, byte range, signature, and the symbol's source text. Refuses on 0 or >1 matches (lists candidates).",
		parameters: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "Symbol name (or qualified name)" },
				file: { type: "string", description: "Optional file hint (path)" },
			},
			required: ["symbol"],
		} as never,
		execute: async (_id, params) => {
			const p = params as { symbol: string; file?: string };
			const loc = locateFresh(st, p.symbol, p.file);
			if (loc.error) return { content: `refused: ${loc.error}`, details: loc };
			if (loc.matches.length === 0)
				return { content: `no symbol '${p.symbol}' in ${loc.file}`, details: loc };
			const head = loc.matches
				.map(
					(m, i) =>
						`${m.qualified_name} — ${loc.file} L${m.start_line}-${m.end_line} bytes ${m.start_byte}..${m.end_byte} ${m.kind}${m.signature ? ` ${m.signature}` : ""}`,
				)
				.join("\n");
			const src =
				loc.matches.length === 1
					? `\n\n--- source (${loc.file}) ---\n${loc.sources[0]}`
					: `\n(ambiguous — ${loc.matches.length} matches; pass a qualified name)`;
			return { content: head + src, details: { file: loc.file, matches: loc.matches.length } };
		},
	});

	if (opts.editTool) {
		pi.registerTool({
			name: "codemap_edit_symbol",
			label: "Edit symbol by name",
			description:
				"Replace a NAMED symbol's full definition with new text. Locates by fresh reparse (exact byte range), splices, validates the file still parses, rolls back on failure. Refuses ambiguous/missing names. For anonymous blocks, partial-line edits, or non-code files use the built-in editor instead.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Symbol name (or qualified name); must match exactly one definition" },
					file: { type: "string", description: "Optional file hint (path)" },
					new_text: { type: "string", description: "Full replacement source for the symbol" },
				},
				required: ["symbol", "new_text"],
			} as never,
			execute: async (_id, params) => {
				const p = params as { symbol: string; file?: string; new_text: string };
				const r = editSymbol(st, p.symbol, p.new_text, p.file);
				st.mapDirty = true; // our own edit changed the repo
				return { content: r.ok ? `ok: ${r.detail}` : `refused: ${r.detail}`, details: r };
			},
		});
	}

	pi.registerCommand("codemap:status", {
		description: "Show code-map state (files, snapshot, watcher)",
		handler: async (_args, ctx) => {
			const line = st.enabled
				? `enabled — map ${st.mapPath} (${st.filesIndexed} files) · snapshot ${st.snapshotMeta.estTokens}tok ${st.snapshotMeta.files}f/${st.snapshotMeta.omitted}omitted · watcher ${st.watcher ? `pid ${st.watcher.pid}` : "off"} · dirty ${st.mapDirty} · key ${keySituation().source}`
				: `disabled — ${st.reason}`;
			if (ctx.hasUI) ctx.ui.notify(line, "info");
			else console.log(line);
		},
	});

	pi.on("session_shutdown", () => shutdown(st));
}
