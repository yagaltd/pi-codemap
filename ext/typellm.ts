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
