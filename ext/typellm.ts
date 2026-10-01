/**
 * TypeLLM provider (typellm.ai) — TS port of mailbox-parser cli/src/typellm.rs.
 *
 * One endpoint does the work: POST {base}/v1/generate, Bearer key,
 * {context, questions} in → {result, thinking, usage} out.
 *
 * Key chain (file FIRST so two projects on one machine keep separate keys):
 *   1. ~/.config/pi-codemap/typellm.key  (chmod 600)
 *   2. TYPELLM_API_KEY env               (last resort)
 *
 * CLI:
 *   npx tsx ext/typellm.ts setup    # paste or pipe the key (tl-sk-…)
 *   npx tsx ext/typellm.ts verify   # one tiny call proving key + typed answers
 *   npx tsx ext/typellm.ts verify --key-file PATH
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

export const HOSTED_URL = "https://api.typellm.ai";

export function defaultKeyFile(): string {
	return join(homedir(), ".config", "pi-codemap", "typellm.key");
}

/** File first (per-project separation), env last. */
export function loadKey(explicit?: string): string {
	const tried: string[] = [];
	for (const p of explicit ? [explicit, defaultKeyFile()] : [defaultKeyFile()]) {
		tried.push(p);
		if (existsSync(p)) {
			const k = readFileSync(p, "utf8").trim();
			if (k) return k;
		}
	}
	const env = process.env.TYPELLM_API_KEY?.trim();
	if (env) return env;
	throw new Error(
		`no TypeLLM API key: run \`npx tsx ext/typellm.ts setup\`, write it to ${defaultKeyFile()} (chmod 600), or set TYPELLM_API_KEY`,
	);
}

export function writeKeyFile(path: string, key: string): void {
	const k = key.trim();
	if (!k) throw new Error("empty API key");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, k);
	chmodSync(path, 0o600);
}

export async function postGenerate(
	baseUrl: string,
	key: string,
	body: { context: string; questions: Record<string, unknown> },
): Promise<{ result: Record<string, unknown>; thinking: Record<string, string>; usage: { input_tokens: number; thinking_tokens: number } }> {
	const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/generate`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	let json: (typeof resp) extends never ? never : any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// fall through to error handling
	}
	if (!resp.ok) {
		const type = json?.error?.type ?? "error";
		const msg = json?.error?.message ?? text.slice(0, 300);
		throw new Error(`TypeLLM API error (HTTP ${resp.status}): ${type} — ${msg}`);
	}
	if (!json) throw new Error("TypeLLM API returned non-JSON");
	return json;
}

/** Same battery as mailbox-parser's `typellm verify`: string + number + boolean + enum. */
export async function verify(explicitKeyFile?: string): Promise<void> {
	const key = loadKey(explicitKeyFile);
	const resp = await postGenerate(HOSTED_URL, key, {
		context: "Receipt from Cafe Aurora\nFlat white £3.20\nTotal: £12.40\nPaid by card.",
		questions: {
			merchant: { type: "string", instructions: "Return only the merchant name." },
			total: { type: "number", instructions: "Extract the total amount as a number." },
			currency_gbp: { type: "boolean", instructions: "Is the currency GBP?" },
			kind: {
				type: "string",
				enum: ["receipt", "invoice", "quote"],
				instructions: "What kind of document is this?",
			},
		},
	});
	console.log(JSON.stringify({ result: resp.result, thinking: resp.thinking, usage: resp.usage }, null, 2));
}

async function readStdinAll(): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk.toString());
	return chunks.join("");
}

function masked(key: string): string {
	return key.length >= 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "***";
}

export async function setup(explicitKeyFile?: string): Promise<void> {
	const path = explicitKeyFile ?? defaultKeyFile();
	let key: string;
	if (process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		key = await new Promise<string>((resolve) =>
			rl.question(`Paste the TypeLLM API key (piped input works too: echo $KEY | npx tsx ext/typellm.ts setup): `, resolve),
		);
		rl.close();
	} else {
		key = (await readStdinAll()).split("\n")[0] ?? "";
	}
	writeKeyFile(path, key);
	console.error(`key written to ${path} (${masked(key.trim())}, chmod 600); per-run overrides: --key-file, TYPELLM_API_KEY`);
}

function flagValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("typellm.ts");
if (isMain) {
	const cmd = process.argv[2];
	const keyFile = flagValue("--key-file");
	(cmd === "setup" ? setup(keyFile) : cmd === "verify" ? verify(keyFile) : Promise.reject(new Error("usage: typellm.ts setup|verify [--key-file PATH]")))
		.then(() => process.exit(0))
		.catch((e: Error) => {
			console.error(String(e.message ?? e));
			process.exit(1);
		});
}

// ── DAG gate (depends_on chains — TypeLLM-only capability) ────────────────

import { redactSend } from "./jev.ts";

/** Question chain for a boundary-span refusal: kind (enum root) →
 * reason ∷kind, split ∷[kind, reason]. Pure — asserted in selfcheck. */
export function spanGuidanceQuestions(): Record<string, unknown> {
	return {
		kind: {
			type: "string",
			enum: ["mechanical", "coherent_pair", "unrelated_mix", "unclear"],
			instructions: "Classify this boundary-spanning edit: mechanical (rename/reformat across symbols), coherent_pair (two symbols changed for one logical purpose), unrelated_mix (unrelated changes bundled), unclear.",
		},
		reason: {
			type: "string",
			depends_on: ["kind"],
			instructions: "One sentence for the editing agent: why this span must be split into per-symbol edits (each edit must parse inside one symbol).",
		},
		split: {
			type: "string",
			depends_on: ["kind", "reason"],
			instructions: "Concrete recovery: how to split this into 2+ edit calls that each stay inside one symbol. Name the symbols and the order. Max 2 sentences.",
		},
	};
}

/** Question chain for multi-symbol bundles: scope (enum root) →
 * risk ∷scope (number) → why ∷[scope, risk]. Pure — asserted in selfcheck. */
export function batchRiskQuestions(): Record<string, unknown> {
	return {
		scope: {
			type: "string",
			enum: ["single_symbol", "coherent_multi", "cross_cutting"],
			instructions: "single_symbol: all replacements serve one symbol's change. coherent_multi: several symbols changed for one logical purpose. cross_cutting: broad or unrelated changes bundled.",
		},
		risk: {
			type: "number",
			enum: [0.0, 0.25, 0.5, 0.75, 1.0],
			depends_on: ["scope"],
			instructions: "Probability this bundled edit breaks compilation or mixes unrelated concerns.",
		},
		why: {
			type: "string",
			depends_on: ["scope", "risk"],
			instructions: "If risk >= 0.75: one sentence on the main hazard. Otherwise: exactly 'ok'.",
		},
	};
}

export interface SpanGuidance { kind: string; reason: string; split: string }

/** One depends_on call replacing the bare span refusal. Null on ANY failure —
 * callers fail open to the plain refusal text. */
export async function typellmSpanGuidance(opts: {
	file: string;
	symbols: string[];
	oldText: string;
	newText: string;
}): Promise<SpanGuidance | null> {
	try {
		const context = redactSend(
			`File: ${opts.file}. The refused edit touches these symbols: ${opts.symbols.join(", ")}.\nOLD: ${opts.oldText.slice(0, 400)}\nNEW: ${opts.newText.slice(0, 400)}`,
		);
		const resp = await postGenerate(HOSTED_URL, loadKey(), { context, questions: spanGuidanceQuestions() });
		const r = resp.result ?? {};
		const kind = typeof r.kind === "string" ? r.kind : null;
		const reason = typeof r.reason === "string" ? r.reason : null;
		const split = typeof r.split === "string" ? r.split : null;
		return kind && reason && split ? { kind, reason, split } : null;
	} catch {
		return null;
	}
}

export interface BatchRisk { scope: string; risk: number; why: string }

/** One depends_on call scoring a multi-symbol bundle: scope → risk ∷scope →
 * why ∷[scope, risk]. Null on ANY failure — the edit then applies as usual. */
export async function typellmBatchRisk(opts: {
	file: string;
	symbolsTouched: string[];
	ops: number;
}): Promise<BatchRisk | null> {
	try {
		const context = redactSend(
			`File: ${opts.file}. One edit call bundles ${opts.ops} replacement(s) touching these symbols: ${opts.symbolsTouched.join(", ") || "(none — free lines)"}.`,
		);
		const resp = await postGenerate(HOSTED_URL, loadKey(), { context, questions: batchRiskQuestions() });
		const r = resp.result ?? {};
		const scope = typeof r.scope === "string" ? r.scope : null;
		const risk = typeof r.risk === "number" ? r.risk : null;
		const why = typeof r.why === "string" ? r.why : null;
		return scope && risk !== null && why !== null ? { scope, risk, why } : null;
	} catch {
		return null;
	}
}

// ── classifier backend (parity with the Jev bool battery) ─────────────────

export interface BoolQuestion {
	type: "bool";
	instructions: string;
	criteria?: { true: string; false: string };
}

export interface ClassifierAnswer {
	probability: number;
}

export interface ClassifierLike {
	model?: string;
	answers: Record<string, ClassifierAnswer>;
}

/** System One bool battery → TypeLLM schema (independent fields run in
 * parallel server-side; probabilities via return_probabilities). */
export function typellmQuestions(questions: Record<string, BoolQuestion>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, q] of Object.entries(questions)) {
		let instructions = q.instructions;
		if (q.criteria) instructions += ` Answer true: ${q.criteria.true} Answer false: ${q.criteria.false}`;
		out[name] = { type: "boolean", instructions, return_probabilities: true };
	}
	return out;
}

/** TypeLLM result → {name: P(yes)}. Handles {value, probabilities} (the
 * return_probabilities shape) and plain booleans; skips anything else. */
export function typellmAnswers(resp: { result?: Record<string, unknown> }): Record<string, ClassifierAnswer> {
	const out: Record<string, ClassifierAnswer> = {};
	for (const [name, a] of Object.entries(resp.result ?? {})) {
		if (typeof a === "boolean") {
			out[name] = { probability: a ? 1 : 0 };
		} else if (a && typeof a === "object") {
			const probs = (a as { probabilities?: Record<string, number> }).probabilities;
			const p = probs?.["true"] ?? probs?.["false"];
			if (typeof p === "number") {
				out[name] = { probability: probs?.["true"] !== undefined ? probs["true"] : 1 - probs!["false"] };
			} else if (typeof (a as { value?: boolean }).value === "boolean") {
				out[name] = { probability: (a as { value: boolean }).value ? 1 : 0 };
			}
		}
	}
	return out;
}

/** ClassifyFn-compatible backend over the TypeLLM API — null when no key.
 * systemOne redacts the state before we see it; same fail-open contract
 * (throw → systemOne returns null). */
export function typellmClassifyFn(): ((state: unknown, questions: Record<string, BoolQuestion>) => Promise<ClassifierLike>) | null {
	if (!typellmAvailable()) return null;
	return async (state, questions) => {
		const resp = await postGenerate(HOSTED_URL, loadKey(), {
			context: typeof state === "string" ? state : JSON.stringify(state),
			questions: typellmQuestions(questions),
		});
		return { model: String(resp.model ?? "typellm-latest"), answers: typellmAnswers(resp) };
	};
}

/** Key present (file-first, env last)? */
export function typellmAvailable(): boolean {
	try {
		loadKey();
		return true;
	} catch {
		return false;
	}
}

// ── routed-edit verifier (DAG: fire signal + why in one call) ─────────────

export interface VerifyResult { fired: boolean; why: string; signals: Record<string, number> }

/** TypeLLM verifier for a routed (low-effort) edit: three independent
 * P(wrong) roots; why ∷roots only explains when something fired. One call. */
export async function typellmVerifyEdit(opts: {
	request: string;
	diff: string;
}): Promise<VerifyResult | null> {
	try {
		const context = redactSend(`User request:\n${opts.request.slice(0, 800)}\n\nApplied diff:\n${opts.diff.slice(0, 2400)}`);
		const resp = await postGenerate(HOSTED_URL, loadKey(), {
			context,
			questions: {
				incomplete: {
					type: "boolean",
					instructions: "Does the diff FAIL to accomplish what the user requested?",
					return_probabilities: true,
				},
				unrelated: {
					type: "boolean",
					instructions: "Does the diff touch code unrelated to the request?",
					return_probabilities: true,
				},
				dropped: {
					type: "boolean",
					instructions: "Does the diff drop or break existing behavior that the request did not ask to change?",
					return_probabilities: true,
				},
				why: {
					type: "string",
					depends_on: ["incomplete", "unrelated", "dropped"],
					instructions: "If any signal above fired, one sentence on the main problem and what to re-check. Otherwise exactly 'ok'.",
				},
			},
		});
		const r = resp.result ?? {};
		const p = (k: string): number => {
			const a = r[k];
			if (typeof a === "boolean") return a ? 1 : 0;
			if (a && typeof a === "object") {
				const pr = (a as { probabilities?: Record<string, number> }).probabilities;
				if (pr && typeof pr["true"] === "number") return pr["true"];
				if (typeof (a as { value?: boolean }).value === "boolean") return (a as { value: boolean }).value ? 1 : 0;
			}
			return 0;
		};
		const signals = { incomplete: p("incomplete"), unrelated: p("unrelated"), dropped: p("dropped") };
		const fired = Object.values(signals).some((v) => v >= 0.7);
		const why = typeof r.why === "string" ? r.why : "ok";
		return { fired, why, signals };
	} catch {
		return null;
	}
}
