/**
 * pi-codemap v1.1 — Jev (TypeSafe) add-ons, both FAIL-OPEN:
 *
 *  1. Router (session start): decide whether the map section is injected at
 *     all. Default = inject. A hard-trivial prompt skips for free (regex);
 *     anything else gets ONE noul judgment on the first message. Skip only
 *     when Jev is confident it is NOT a codebase-navigation task (p < 0.25).
 *     Decided once per session — the provider cache makes a mid-session
 *     flip expensive, and a wrong "no" is recovered by codemap_search,
 *     which stays registered either way.
 *
 *  2. Search gate (per codemap_search): fires ONLY on doubtful shortlists
 *     (weak top score, or a near-tie at the top). Confident searches make
 *     zero API calls. On fire, one systemOne call re-judges each candidate's
 *     relevance (noul battery, one call); results are re-ranked by
 *     relevance. Never returns fewer than 3 hits.
 *
 *  Hygiene: everything sent to TypeSafe passes redactSend() first; each
 *  decision is appended to .codemap-jev.log when CODEMAP_JEV_LOG=1 so the
 *  bench can verify router/gate behavior from artifacts, not guesses.
 */
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 8000;

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

type NoulAnswers = Record<string, number>;

import { keySituation } from "./credentials.ts";

/** One systemOne call. Returns {model, answers} or null on ANY failure
 * (missing key, timeout, bad response) — every caller fails open. */
export async function systemOne(
	state: unknown,
	questions: Record<string, { type: "noul"; instructions: string; criteria?: { true: string; false: string } }>,
): Promise<{ model: string; answers: NoulAnswers } | null> {
	const key = keySituation().key;
	if (!key) return null;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(TYPESAFE_URL, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({ model: process.env.CODEMAP_JEV_MODEL || "jev-latest", state, questions }),
			signal: ctrl.signal,
		});
		if (!res.ok) return null;
		const d = (await res.json()) as { model?: string; answers?: Record<string, { type: string; noul?: number }> };
		if (!d.answers) return null;
		const answers: NoulAnswers = {};
		for (const [name, a] of Object.entries(d.answers)) {
			if (a?.type === "noul" && typeof a.noul === "number") answers[name] = a.noul;
		}
		return { model: String(d.model ?? "?"), answers };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
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
	const r = await systemOne(redactSend(prompt), {
		codebase_task: {
			type: "noul",
			instructions:
				"Answering this user message will likely require knowing the repository's structure — its files, modules, or symbols (navigating, locating, or explaining code organization).",
			criteria: {
				true: "Yes — code structure/navigation knowledge is needed.",
				false: "No — answerable from git history, docs, general knowledge, or one trivial command.",
			},
		},
	});
	if (!r) {
		log?.({ event: "router", decision: "unavailable" });
		return "unavailable";
	}
	const p = r.answers.codebase_task ?? 1;
	const decision: RouterDecision = p < 0.25 ? "skip" : "code";
	log?.({ event: "router", decision, p, model: r.model });
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
	const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
	cands.forEach((c, i) => {
		questions[`c${i}`] = {
			type: "noul",
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
