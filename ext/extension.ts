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
import { classifySpan, gateShortlist, gateTriggered, hasClassifier, resetClassifyFn, routeFirstPrompt, setClassifyFn, subQueryTerms, systemOne, type GateCandidate } from "./jev.ts";
import { defaultKeyFile, loadKey, typellmAvailable, typellmBatchRisk, typellmClassifyFn, typellmSpanGuidance, writeKeyFile } from "./typellm.ts";
import { promptForApiKey } from "./typellm-ui.ts";


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

// ── lifecycle ─────────────────────────────────────────────────────────

/** Load-probe: independent of st/opts — proves this extension instance loaded. */
/** Factory-scoped wiring, reachable from module-scope init(). */
let moduleWireClassifier: ((ctx: ExtensionContext) => void) | null = null;

function typellmMasked(key: string): string {
	const k = key.trim();
	return k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "***";
}

function jevLogProbe(cwd: string, e: Record<string, unknown>): void {
	if (process.env.CODEMAP_JEV_LOG) {
		try {
			fs.appendFileSync(path.join(cwd, ".codemap-jev.log"), JSON.stringify(e) + "\n");
		} catch {
			/* ignore */
		}
	}
}

function init(st: State, ctx: ExtensionContext): void {
	st.cwd = ctx.cwd;
	jevLogProbe(ctx.cwd, { event: "ext_loaded", cwd: ctx.cwd });
	moduleWireClassifier?.(ctx);
	if (!has("code-parser") || !has("code-map")) {
		st.enabled = false;
		st.reason = "install: cargo install --git https://github.com/yagaltd/code-parser code-parser-cli --features all && cargo install --path crates/code-map --features all";
		return;
	}
	fs.mkdirSync(MAPS_DIR, { recursive: true });
	st.mapPath = path.join(MAPS_DIR, `map-${crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 16)}.jsonl`);

	const r = sh("code-map", ["refresh", ctx.cwd, "-o", st.mapPath, "--languages", "rust,typescript,javascript,python"], { timeout: 300_000 });
	if (!r.ok) {
		st.enabled = false;
		st.reason = `refresh failed: ${r.stderr.slice(0, 200)}`;
		return;
	}
	st.filesIndexed = countLines(st.mapPath);
	renderSnapshot(st);
	st.enabled = true;
	jevLogProbe(st.cwd, { event: "init_done", files: st.filesIndexed });
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

// ── v12: guarded edit override ──────────────────────────────────────────

interface EditOp {
	oldText: string;
	newText: string;
}

interface GuardPlanStep {
	start: number;
	end: number;
	newText: string;
	symName?: string;
	symStart?: number;
	symEnd?: number;
	newStartLine: number;
	newEndLine: number;
}

function countLinesStr(s: string): number {
	return s.length === 0 ? 0 : s.split("\n").length;
}

function lineOfIndex(s: string, index: number): number {
	let line = 0;
	for (let i = 0; i < index; i++) if (s.charCodeAt(i) === 10) line++;
	return line;
}

function parseErrorsOf(absPath: string, suffix: string, content: string): number | null {
	const tmp = path.join(os.tmpdir(), `cm-guard-${crypto.randomBytes(6).toString("hex")}${suffix}`);
	try {
		fs.writeFileSync(tmp, content);
		const r = sh("code-parser", ["parse", tmp, "--json"], { timeout: 30_000 });
		if (!r.ok) return null;
		const d = JSON.parse(r.stdout);
		return (d.diagnostics ?? []).filter((x: { severity: string }) => x.severity === "Error").length;
	} catch {
		return null;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* tmp cleanup best-effort */
		}
	}
}

/**
 * v12 guarded edit: native oldText/newText semantics (exact, unique,
 * matched against the ORIGINAL content, non-overlapping) plus two guards,
 * validate-then-write so a refused call never touches the file:
 *  1. parse-safety — the edited file must not gain parse errors;
 *  2. symbol containment — when an edit lands inside one symbol, the
 *     replacement must stay within that symbol's original range (+-3 lines
 *     for doc-comment attachment).
 */
export async function runGuardedEdit(
	st: State,
	path_: string,
	edits: EditOp[],
	jevLog: (e: Record<string, unknown>) => void,
	dag = false,
): Promise<{ ok: boolean; detail: string; spanned?: string[]; spanOld?: string; spanNew?: string }> {
	const abs = path.isAbsolute(path_) ? path_ : path.join(st.cwd, path_);
	if (!fs.existsSync(abs)) return { ok: false, detail: `file not found: ${path_}` };
	const original = fs.readFileSync(abs, "utf8");
	const suffix = path.extname(abs);
	const errorsBefore = parseErrorsOf(abs, suffix, original);

	// Locate every edit in the ORIGINAL content; reject 0 / >1 occurrences.
	const spans: { start: number; end: number; newText: string; op: EditOp }[] = [];
	for (const op of edits) {
		const first = original.indexOf(op.oldText);
		if (first === -1) return { ok: false, detail: `oldText not found in ${path_}: ${JSON.stringify(op.oldText.slice(0, 60))}` };
		const second = original.indexOf(op.oldText, first + 1);
		if (second !== -1) return { ok: false, detail: `Found ${original.split(op.oldText).length - 1} occurrences in ${path_}. oldText must be unique — provide more context.` };
		spans.push({ start: first, end: first + op.oldText.length, newText: op.newText, op });
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		if (spans[i].start < spans[i - 1].end)
			return { ok: false, detail: "edits[] overlap — merge them into one edit" };
	}

	// Parse once for symbol containment.
	let symbols: { name: string; start_line: number; end_line: number }[] = [];
	try {
		const r = sh("code-parser", ["parse", abs, "--json"], { timeout: 30_000 });
		if (r.ok) symbols = JSON.parse(r.stdout).symbols ?? [];
	} catch {
		/* no symbols → containment checks skip */
	}

	// Plan: containment + new-line accounting (all before any write).
	const plan: GuardPlanStep[] = [];
	let deltaLines = 0;
	for (const s of spans) {
		const oldStartLine = lineOfIndex(original, s.start);
		const oldEndLine = oldStartLine + countLinesStr(s.op.oldText) - 1;
		const newStartLine = oldStartLine + deltaLines;
		const newEndLine = newStartLine + countLinesStr(s.newText) - 1;
		deltaLines += countLinesStr(s.newText) - countLinesStr(s.op.oldText);
		const cls = classifySpan(symbols, oldStartLine + 1, oldEndLine + 1);
		if (cls.kind === "inside") {
			const innermost = cls.sym;
			const lo = innermost.start_line - 3;
			const hi = innermost.end_line + 3;
			if (newStartLine + 1 < lo || newEndLine + 1 > hi) {
				jevLog({ event: "edit_guard", decision: "refused_range", file: path_, symbol: innermost.name, range: [newStartLine + 1, newEndLine + 1], allowed: [lo, hi] });
				return { ok: false, detail: `edit escapes symbol '${innermost.name}' (L${innermost.start_line}-${innermost.end_line}): replacement spans L${newStartLine + 1}-${newEndLine + 1}, allowed L${lo}-${hi}. Narrow the edit or use write for whole-file changes.` };
			}
			plan.push({ start: s.start, end: s.end, newText: s.newText, symName: innermost.name, symStart: innermost.start_line, symEnd: innermost.end_line, newStartLine, newEndLine });
		} else if (cls.kind === "spanning") {
			jevLog({ event: "edit_guard", decision: "refused_span", file: path_, symbols: cls.syms, span: [oldStartLine + 1, oldEndLine + 1] });
			return { ok: false, detail: `edit spans symbol boundaries (${cls.syms.join(", ")}). Split it into one edit per symbol, or use write for a whole-file restructure.`, spanned: cls.syms, spanOld: s.op.oldText, spanNew: s.op.newText };
		} else {
			plan.push({ start: s.start, end: s.end, newText: s.newText, newStartLine, newEndLine });
		}
	}

	// TypeLLM-only batch pre-flight: multi-symbol bundles get one depends_on
	// risk call (scope → risk ∷scope → why). Fails open to apply-as-usual.
	const touched = [...new Set(plan.map((pp) => pp.symName).filter((v): v is string => !!v))];
	if (dag && touched.length >= 2) {
		const t0 = Date.now();
		const risk = await typellmBatchRisk({ file: path_, symbolsTouched: touched, ops: plan.length });
		jevLog({ event: "batch_risk", ...(risk ?? { failed: true }), ops: plan.length, symbols: touched, ms: Date.now() - t0 });
		if (risk && risk.risk >= (Number(process.env.CODEMAP_DAG_REFUSE) || 0.75)) {
			return { ok: false, detail: `bundled edit refused by pre-flight risk ${risk.risk} (scope: ${risk.scope}): ${risk.why} Split into separate edit calls, one symbol each.` };
		}
	}

	// Apply on the string (last→first keeps indices valid).
	let updated = original;
	for (let i = plan.length - 1; i >= 0; i--) {
		const p = plan[i];
		updated = updated.slice(0, p.start) + p.newText + updated.slice(p.end);
	}

	// Parse-safety on the RESULT before writing.
	if (errorsBefore !== null) {
		const errorsAfter = parseErrorsOf(abs, suffix, updated);
		if (errorsAfter !== null && errorsAfter > errorsBefore) {
			jevLog({ event: "edit_guard", decision: "refused_parse", file: path_, errorsBefore, errorsAfter });
			return { ok: false, detail: `edit introduces ${errorsAfter - errorsBefore} parse error(s) — nothing was written. Fix the oldText/newText and retry.` };
		}
	}

	fs.writeFileSync(abs, updated);
	const syms = plan.filter((p) => p.symName).map((p) => `${p.symName} L${p.symStart}-${p.symEnd}`);
	jevLog({ event: "edit_guard", decision: "applied", file: path_, edits: plan.length, symbols: syms });
	const where = syms.length > 0 ? ` inside ${syms.join(", ")}` : "";
	return { ok: true, detail: `Applied ${plan.length} edit(s) to ${path_}${where} (now L${plan[0].newStartLine + 1}-${plan[plan.length - 1].newEndLine + 1}); parses clean` };
}

// ── extension factory ─────────────────────────────────────────────────────

export interface CodemapOptions {
	editTool?: boolean;
	/** v1.1: Jev router (map injection) + low-confidence search gate. */
	jev?: boolean;
	/** v12: register `edit` — native oldText/newText semantics plus
	 * validate-then-write guards (parse-safety + symbol-range containment). */
	editOverride?: boolean;
}

export function createCodemapExtension(pi: ExtensionAPI, opts: CodemapOptions): void {
	type MinimalRegistry = {
		classify(model: unknown, ctx: { state: unknown; questions: unknown }): Promise<unknown>;
		getModelOfType(type: string, provider: string, id: string): unknown;
		getAvailableOfType(type: string): Promise<readonly unknown[]>;
	};
	let classifierWired = false;
	let activeBackend: "jev" | "typellm" | null = null;
	let choiceSource: "env" | "saved" | null = null;
	let availJev = false;
	let availTypellm = false;
	let onboardedKeyMissing = false;
	let onboardedChoose = false;
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

	/** Classifier backend — the USER chooses: CODEMAP_CLASSIFIER env override,
	 * else the persisted /codemap:classifier choice, else (unset) the single
	 * usable provider, or Jev + a one-time choose notice when both are usable.
	 * First context wins; idempotent. */
	function wireClassifier(ctx: ExtensionContext | undefined): void {
		if (classifierWired || !ctx) return;
		const envChoice = envClassifier();
		const saved = savedClassifier();
		choiceSource = envChoice ? "env" : saved ? "saved" : null;
		const choice = envChoice ?? saved;
		const reg = (ctx as unknown as { modelRegistry?: MinimalRegistry }).modelRegistry;
		availJev = !!(reg && typeof reg.classify === "function");
		availTypellm = typellmAvailable();
		const backend: "jev" | "typellm" | null =
			choice === "typellm" ? (availTypellm ? "typellm" : null)
			: choice === "jev" ? (availJev ? "jev" : null)
			: availJev !== availTypellm ? (availJev ? "jev" : "typellm")
			: availJev ? "jev" : null;
		if (!backend) return;
		classifierWired = true;
		activeBackend = backend;
		if (backend === "typellm") {
			const fn = typellmClassifyFn();
			if (fn) setClassifyFn(fn as never);
			moduleWireClassifier = wireClassifier;
			return;
		}
		setClassifyFn(async (state, questions) => {
			let model = reg.getModelOfType("classifier", "typesafe", "jev-latest");
			if (!model) {
				const avail = await reg.getAvailableOfType("classifier");
				model = avail[0];
			}
			if (!model) throw new Error("no classifier model with usable credentials");
			return reg.classify(model, { state, questions }) as Promise<never> as never;
		});
		moduleWireClassifier = wireClassifier;
	}

	function classifierFile(): string {
		return path.join(os.homedir(), ".config", "pi-codemap", "classifier");
	}

	function savedClassifier(): "jev" | "typellm" | null {
		try {
			const v = fs.readFileSync(classifierFile(), "utf8").trim().toLowerCase();
			return v === "jev" || v === "typellm" ? v : null;
		} catch {
			return null;
		}
	}

	function setSavedClassifier(v: "jev" | "typellm"): void {
		const p = classifierFile();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, v + "\n");
	}

	function envClassifier(): "jev" | "typellm" | null {
		const v = (process.env.CODEMAP_CLASSIFIER ?? "").trim().toLowerCase();
		return v === "jev" || v === "typellm" ? v : null;
	}

	function jevLog(e: Record<string, unknown>): void {
		if (process.env.CODEMAP_JEV_LOG) {
			try {
				fs.appendFileSync(path.join(st.cwd, ".codemap-jev.log"), JSON.stringify(e) + "\n");
			} catch {
				/* logging never breaks the request path */
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		init(st, ctx);
		if (st.enabled && ctx.hasUI) {
			ctx.ui.setStatus("codemap", `map ${st.filesIndexed}f · snap ${st.snapshotMeta.estTokens}tok`);
		} else if (!st.enabled && ctx.hasUI) {
			ctx.ui.setStatus("codemap", `codemap off (${(st.reason ?? "").slice(0, 40)})`);
		}
		// Onboarding (pi-typesafe pattern): say it once, never force a modal.
		if (opts.jev && st.enabled && ctx.hasUI && !onboardedKeyMissing) {
			onboardedKeyMissing = true;
			const reg = (ctx as unknown as { modelRegistry?: { getAvailableOfType(t: string): Promise<readonly unknown[]> } }).modelRegistry;
			let available = hasClassifier();
			if (!available && reg) {
				try {
					available = (await reg.getAvailableOfType("classifier")).length > 0;
				} catch {
					/* treat as unavailable */
				}
			}
			if (!available && !typellmAvailable()) {
				ctx.ui.notify(
					"pi-codemap: classifier idle — no Jev credentials and no TypeLLM key. Set TYPESAFE_API_KEY (or /login with a Jev provider), run /codemap:login-typellm, or set CODEMAP_CLASSIFIER=jev|typellm. Everything else works without it.",
					"warning",
				);
			} else if (available && typellmAvailable() && !envClassifier() && !savedClassifier() && !onboardedChoose) {
				onboardedChoose = true;
				ctx.ui.notify(
					"pi-codemap: both classifiers available (Jev + TypeLLM) — pick one with /codemap:classifier jev|typellm (persisted). Until you choose, Jev serves.",
					"info",
				);
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		wireClassifier(ctx);
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

	if (opts.editOverride) {
		pi.registerTool({
			name: "edit",
			label: "Edit (codemap-guarded)",
			description:
				"Make precise file edits with exact text replacement, including multiple disjoint edits in one call. " +
				"Edits are validated before anything is written: the result must still parse, and when an edit lands inside a code symbol " +
				"the replacement must stay within that symbol's range — an escaping edit is refused with the file untouched.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
					edits: {
						type: "array",
						description: "One or more targeted replacements, matched against the original file (not incrementally). No overlapping edits.",
						items: {
							type: "object",
							properties: {
								oldText: { type: "string", description: "Exact text for one targeted replacement; must be unique in the file" },
								newText: { type: "string", description: "Replacement text for this targeted edit" },
							},
							required: ["oldText", "newText"],
						},
					},
				},
				required: ["path", "edits"],
			} as never,
			execute: async (_id, params) => {
				jevLog({ event: "edit_called" });
				try {
				const p = params as { path: string; edits: EditOp[] };
				if (!Array.isArray(p.edits) || p.edits.length === 0)
					return { content: "refused: edits[] must contain at least one {oldText, newText}" };
				const dag = activeBackend === "typellm" && process.env.CODEMAP_DAG !== "off";
				const r = await runGuardedEdit(st, p.path, p.edits, jevLog, dag);
				let detail = r.ok ? r.detail : `refused: ${r.detail}`;
				if (!r.ok && dag && r.spanned) {
					const g = await typellmSpanGuidance({ file: p.path, symbols: r.spanned, oldText: r.spanOld ?? "", newText: r.spanNew ?? "" });
					jevLog({ event: "dag_guidance", ok: !!g, kind: g?.kind ?? null });
					if (g) detail += ` Why: ${g.reason} Suggested split: ${g.split}`;
				}
				st.mapDirty = true;
				return { content: detail };
				} catch (e) {
					jevLog({ event: "edit_guard", decision: "crashed", error: String(e).slice(0, 160) });
					return { content: `refused: codemap edit guard crashed (${String(e).slice(0, 80)}) — use bash for this edit and report it` };
				}
			},
		});
	}

	pi.registerCommand("codemap:login-typellm", {
		description: "Store the TypeLLM API key (typellm.ai) for pi-codemap",
		handler: async (_args, ctx) => {
			const key = await promptForApiKey(ctx);
			if (!key || !key.trim()) {
				const msg = "cancelled — no key entered";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}
			const msg = (() => {
				try {
					writeKeyFile(defaultKeyFile(), key);
					return `key written to ${defaultKeyFile()} (${typellmMasked(key)}, chmod 600) — see /codemap:status`;
				} catch (e) {
					return `failed to write key: ${String(e).slice(0, 120)}`;
				}
			})();
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});

	pi.registerCommand("codemap:classifier", {
		description: "Choose the classifier: jev | typellm (persisted). No args = show current.",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			const cmdCtx = ctx as unknown as { hasUI: boolean; ui: { notify(msg: string, level?: "info" | "warning" | "error"): void } };
			const say = (msg: string) => (cmdCtx.hasUI ? cmdCtx.ui.notify(msg, "info") : console.log(msg));
			if (arg === "jev" || arg === "typellm") {
				setSavedClassifier(arg);
				resetClassifyFn();
				classifierWired = false;
				activeBackend = null;
				wireClassifier(ctx as unknown as ExtensionContext);
				const eff = envClassifier() && envClassifier() !== arg ? ` (note: CODEMAP_CLASSIFIER=${envClassifier()} overrides for this run)` : "";
				say(`classifier choice saved: ${arg} — active now: ${activeBackend ?? "none (chosen provider unavailable)"}${eff}`);
			} else if (arg === "clear") {
				try { fs.rmSync(classifierFile()); } catch { /* already gone */ }
				say("classifier choice cleared — unset semantics apply (single provider, else jev + choose notice)");
			} else {
				say(`classifier: active=${activeBackend ?? "none"} choice=${choiceSource ?? "unset"} (env=${envClassifier() ?? "-"}, saved=${savedClassifier() ?? "-"}, jev=${availJev ? "ok" : "missing"}, typellm=${availTypellm ? "ok" : "missing"}) — set with: /codemap:classifier jev|typellm`);
			}
		},
	});

	pi.registerCommand("codemap:status", {
		description: "Show code-map state (files, snapshot, watcher)",
		handler: async (_args, ctx) => {
			wireClassifier(ctx as unknown as ExtensionContext);
			const choiceLabel = choiceSource ?? "unset";
			const line = st.enabled
				? `enabled — map ${st.mapPath} (${st.filesIndexed} files) · snapshot ${st.snapshotMeta.estTokens}tok ${st.snapshotMeta.files}f/${st.snapshotMeta.omitted}omitted · watcher ${st.watcher ? `pid ${st.watcher.pid}` : "off"} · dirty ${st.mapDirty} · classifier ${activeBackend ?? "none"} (choice: ${choiceLabel}; jev ${availJev ? "ok" : "missing"}, typellm ${availTypellm ? "ok" : "missing"})`
				: `disabled — ${st.reason}`;
			if (ctx.hasUI) ctx.ui.notify(line, "info");
			else console.log(line);
		},
	});

	pi.on("session_shutdown", () => shutdown(st));
}
