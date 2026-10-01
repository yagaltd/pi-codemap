/**
 * pi-codemap v12.1 — Jev (TypeSafe) add-ons over pi's classifier-model registry.
 *
 * Transport lives in pi (v0.99+): extensions call ctx.modelRegistry.classify()
 * with provider-neutral bool/score/choice questions — pi owns auth
 * (TYPESAFE_API_KEY, /login resellers), model resolution, and usage accounting.
 * This module keeps only our judgment logic + policy. Everything FAILS OPEN:
 * missing registry or key = null = callers keep default behavior.
 *
 *  1. Router (session start): decide whether the map section is injected at
 *     all. Default = inject. A hard-trivial prompt skips for free (regex);
 *     anything else gets ONE bool judgment on the first message. Skip only
 *     when Jev is confident it is NOT a codebase-navigation task (p < 0.25).
 *     Decided once per session — the provider cache makes a mid-session
 *     flip expensive, and a wrong "no" is recovered by codemap_search,
 *     which stays registered either way.
 *
 *  2. Search gate (per codemap_search): fires ONLY on doubtful shortlists
 *     (weak top score, or a near-tie at the top). Confident searches make
 *     zero API calls. On fire, one classify call re-judges each candidate's
 *     relevance; results are re-ranked by relevance. Never returns fewer
 *     than 3 hits.
 *
 *  Hygiene: everything sent to the classifier passes redactSend() first;
 *  each decision is appended to .codemap-jev.log when CODEMAP_JEV_LOG=1 so
 *  the bench can verify router/gate behavior from artifacts, not guesses.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClassifierResult } from "@earendil-works/pi-coding-agent";

export type ClassifyFn = (
	state: unknown,
	questions: Record<string, { type: "bool"; instructions: string; criteria?: { true: string; false: string } }>,
) => Promise<ClassifierResult>;

let classifyFn: ClassifyFn | null = null;

/** Called by the extension factory once a context exposes modelRegistry. */
export function setClassifyFn(fn: ClassifyFn): void {
	classifyFn = fn;
}

export function hasClassifier(): boolean {
	return classifyFn !== null;
}

/** Clear the backend so wireClassifier can re-wire after a choice change. */
export function resetClassifyFn(): void {
	classifyFn = null;
}

/** Free-skip patterns: high-precision trivial commands. Everything else that
 * looks non-code still goes through Jev — the regex only catches the obvious. */
const TRIVIAL_RE =
	/^(?:run\s+(?:the\s+)?(?:tests?|test suite|build|lint|fmt|format)\b|git\s+(?:status|log|diff|branch|stash)\b|(?:commit|push|pull)\s+(?:this|these|all|now|please)\b)/i;
const TRIVIAL_MAX_LEN = 240;

export function isTrivialPrompt(prompt: string): boolean {
	return prompt.length <= TRIVIAL_MAX_LEN && TRIVIAL_RE.test(prompt);
}

/** Gate trigger: weak top score, or a near-tie at the top. Env-tunable —
 * the raw score scale is engine-specific, so the bench tunes these. */
export function gateTriggered(
	scores: number[],
	topMax = Number(process.env.CODEMAP_GATE_TOP ?? 0.5),
	gapMin = Number(process.env.CODEMAP_GATE_GAP ?? 0.05),
): boolean {
	if (scores.length < 2) return false;
	const [top, second] = scores;
	return top < topMax || top - second < gapMin;
}

/** Defense in depth before anything leaves the machine. */
export function redactSend(s: string): string {
	return s
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED-KEY]")
		.replace(/\b(?:sk|pk)[-][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-JWT]")
		.replace(/((?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[:=]\s*)"?[^"\n]{8,}"?/gi, '$1"[REDACTED]"');
}

type BoolQuestion = { type: "bool"; instructions: string; criteria?: { true: string; false: string } };

type NoulAnswers = Record<string, number>;

/** One classify call through pi's registry. Returns {model, answers} or null
 * on ANY failure (no registry wiring, auth, bad response) — every caller
 * fails open. pi translates bool questions to the provider wire format. */
export async function systemOne(
	state: unknown,
	questions: Record<string, BoolQuestion>,
): Promise<{ model: string; answers: NoulAnswers } | null> {
	if (!classifyFn) return null;
	try {
		const r = await classifyFn(redactSend(JSON.stringify(state)), questions);
		if (!r?.answers) return null;
		const answers: NoulAnswers = {};
		for (const [name, a] of Object.entries(r.answers)) {
			const p = (a as { probability?: number; noul?: number }).probability ?? (a as { noul?: number }).noul;
			if (typeof p === "number") answers[name] = p;
		}
		if (Object.keys(answers).length === 0) return null;
		return { model: String(r.model ?? "?"), answers };
	} catch {
		return null;
	}
}

// ── routing (log-only Phase 1): effort/model-tier verdicts ───────────────

export interface RoutingTiers { [label: string]: { model: string; profile: string } }

/** Human-curated tier ladder (~/.config/pi-codemap/models.json). Absent file
 * = routing data collection runs without the tier question. Never acted on
 * in this phase — verdicts are logged for calibration only. */
export function loadRoutingTiers(): RoutingTiers | null {
	const p = join(homedir(), ".config", "pi-codemap", "models.json");
	if (!existsSync(p)) return null;
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as RoutingTiers;
		const labels = Object.keys(parsed);
		if (labels.length === 0) return null;
		for (const k of labels)
			if (typeof parsed[k]?.model !== "string" || typeof parsed[k]?.profile !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

export interface RouteInput {
	/** Verdict: could this task succeed at minimal reasoning effort? */
	effortOk: boolean | null;
	/** Verdict: would a cheaper configured tier suffice? */
	cheaperOk: boolean | null;
	/** Configured tier labels, cheapest first. */
	tiers: string[] | null;
	/** Model/thinking the user (or default) already runs. */
	current: string;
	/** User explicitly chose model/thinking — routing never overrides. */
	userOverride: boolean;
}

export interface RouteDecision {
	thinking: "low" | "high" | null;
	tier: string | null;
	reason: string;
}

/** Pure policy, ported from the studied routers' guards: user override wins;
 * unknown verdicts change nothing (fail-open); tier selection steps UP when
 * the chosen tier is unavailable; never acts without configured tiers. */
export function routeDecision(input: RouteInput): RouteDecision {
	if (input.userOverride) return { thinking: null, tier: null, reason: "user override — no routing" };
	if (input.effortOk === null) return { thinking: null, tier: null, reason: "no effort verdict" };
	const thinking = input.effortOk ? "low" : "high";
	if (input.cheaperOk === null || !input.tiers || input.tiers.length === 0)
		return { thinking, tier: null, reason: "effort verdict applied; no tiers configured" };
	if (input.cheaperOk) return { thinking, tier: input.tiers[0], reason: "cheaper tier suffices" };
	// Full tier needed: stay on the current tier ONLY if it is a configured
	// label; otherwise change nothing (we do not fabricate tiers).
	const cur = input.tiers.includes(input.current) ? input.current : null;
	return {
		thinking,
		tier: cur,
		reason: cur ? "full tier needed" : "full tier needed (current not a configured tier)",
	};
}

// ── router ────────────────────────────────────────────────────────────────

export type RouterDecision = "code" | "skip" | "unavailable";

/** Decide once per session. skip only on high-precision trivial or a
 * confident Jev "no"; everything else (including Jev failure) = code. */
export async function routeFirstPrompt(
	prompt: string,
	log?: (e: Record<string, unknown>) => void,
): Promise<RouterDecision> {
	if (isTrivialPrompt(prompt)) {
		log?.({ event: "router", decision: "skip", how: "trivial-regex" });
		return "skip";
	}
	const tiers = loadRoutingTiers();
	const questions: Record<string, BoolQuestion> = {
		codebase_task: {
			type: "bool",
			instructions:
				"Answering this user message will likely require knowing the repository's structure — its files, modules, or symbols (navigating, locating, or explaining code organization).",
			criteria: {
				true: "Yes — code structure/navigation knowledge is needed.",
				false: "No — answerable from git history, docs, general knowledge, or one trivial command.",
			},
		},
		low_effort_sufficient: {
			type: "bool",
			instructions:
				"Could this task be completed correctly with MINIMAL reasoning effort — a mechanical change with an obvious, well-defined solution and no subtle interactions?",
			criteria: {
				true: "Yes — mechanical/obvious; minimal reasoning suffices.",
				false: "No — it needs substantial reasoning (debugging, design, cross-file effects).",
			},
		},
	};
	if (tiers) {
		questions.cheaper_model_sufficient = {
			type: "bool",
			instructions: `Would a cheaper, less capable model complete this task correctly? Cheaper tiers available: ${Object.keys(tiers).join(", ")}.`,
			criteria: {
				true: "Yes — the cheap tier suffices for a correct result.",
				false: "No — this needs the full-capability model.",
			},
		};
	}
	const r = await systemOne(redactSend(prompt), questions);
	if (!r) {
		log?.({ event: "router", decision: "unavailable" });
		return "unavailable";
	}
	const p = r.answers.codebase_task ?? 1;
	const decision: RouterDecision = p < 0.25 ? "skip" : "code";
	// Phase 1 (log-only): routing verdicts recorded for calibration. NOTHING
	// here changes the model or thinking level — see routeDecision().
	log?.({
		event: "router",
		decision,
		p,
		model: r.model,
		effort_ok: r.answers.low_effort_sufficient,
		cheaper_ok: r.answers.cheaper_model_sufficient,
		tiers: tiers ? Object.keys(tiers) : null,
	});
	return decision;
}

/** Content words of a query for local sub-query expansion (rescue pass).
 * Stopwords stripped; words < 4 chars dropped; max 4 terms. */
const STOPWORDS = new Set([
	"where", "what", "which", "how", "does", "this", "that", "with", "from",
	"used", "uses", "using", "built", "builds", "build", "need", "needs",
	"find", "show", "give", "into", "onto", "about", "file", "files",
]);

export function subQueryTerms(query: string): string[] {
	return [...new Set(
		query.toLowerCase().replace(/[^a-z0-9_\s-]/g, " ").split(/\s+/),
	)].filter((w) => w.length >= 4 && !STOPWORDS.has(w)).slice(0, 4);
}

/** Classify an edit's line span (1-based, inclusive) against the file's symbols:
 *  inside one symbol → containment check; overlapping any symbol without being
 *  contained → boundary-spanning (refused); touching no symbol → free. */
export function classifySpan(
	symbols: { name: string; start_line: number; end_line: number }[],
	startLine: number,
	endLine: number,
): { kind: "inside"; sym: { name: string; start_line: number; end_line: number } } | { kind: "spanning"; syms: string[] } | { kind: "free" } {
	const overlapping = symbols.filter((sym) => startLine <= sym.end_line && endLine >= sym.start_line);
	const inside = overlapping.find((sym) => startLine >= sym.start_line && endLine <= sym.end_line);
	if (inside) return { kind: "inside", sym: inside };
	if (overlapping.length > 0) return { kind: "spanning", syms: overlapping.map((s) => s.name) };
	return { kind: "free" };
}

/** Per-turn effort verdict (routing Phase 1, log-only): one bool on every
 * user turn after the first. Returns the logged fields or null on failure. */
export async function routeTurnVerdict(
	prompt: string,
	log?: (e: Record<string, unknown>) => void,
): Promise<Record<string, unknown> | null> {
	const r = await systemOne(redactSend(prompt), {
		low_effort_sufficient: {
			type: "bool",
			instructions:
				"Could this task be completed correctly with MINIMAL reasoning effort — a mechanical change with an obvious, well-defined solution and no subtle interactions?",
			criteria: {
				true: "Yes — mechanical/obvious; minimal reasoning suffices.",
				false: "No — it needs substantial reasoning (debugging, design, cross-file effects).",
			},
		},
	});
	if (!r) {
		log?.({ event: "router_turn", decision: "unavailable" });
		return null;
	}
	const out = { decision: "logged", effort_ok: r.answers.low_effort_sufficient, model: r.model };
	return out;
}

// ── search gate ───────────────────────────────────────────────────────────

export interface GateCandidate {
	name: string;
	path: string;
	kind: string;
	score: number;
}

/** Re-rank a doubtful shortlist. Returns relevance per candidate (same
 * order as input) or null on failure (caller keeps original order). */
export async function gateShortlist(
	query: string,
	cands: GateCandidate[],
	log?: (e: Record<string, unknown>) => void,
): Promise<number[] | null> {
const questions: Record<string, BoolQuestion> = {};
	cands.forEach((c, i) => {
		questions[`c${i}`] = {
			type: "bool",
			instructions: `Query: ${JSON.stringify(redactSend(query))}\nCandidate: ${redactSend(JSON.stringify(c))}\nIs this candidate a relevant hit for the query?`,
			criteria: {
				true: "Yes — this symbol/file is what the query is looking for.",
				false: "No — unrelated to what the query asks for.",
			},
		};
	});
	const r = await systemOne(redactSend(JSON.stringify({ query, candidates: cands })), questions);
	if (!r) {
		log?.({ event: "gate", decision: "unavailable" });
		return null;
	}
	log?.({ event: "gate", decision: "fired", p: cands.map((_, i) => r.answers[`c${i}`] ?? 0), model: r.model });
	return cands.map((_, i) => r.answers[`c${i}`] ?? 0);
}
