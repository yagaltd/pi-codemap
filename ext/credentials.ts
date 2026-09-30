/**
 * TypeSafe credential handling for pi-codemap — same contract as pi-typesafe:
 * env TYPESAFE_API_KEY wins, then our store, then (interoperability) the key
 * saved by /typesafe login. Never throws to callers; never echoes the value.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type KeySource = "environment" | "stored" | "typesafe-shared" | "missing";

function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	const base = configured
		? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
		: join(homedir(), ".pi", "agent");
	return base;
}

function readStore(path: string): string | undefined {
	try {
		if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) return undefined; // refuse world-readable
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const key = parsed && typeof parsed === "object" ? (parsed as { apiKey?: unknown }).apiKey : undefined;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** env → ~/.pi/agent/pi-codemap/auth.json → ~/.pi/agent/pi-typesafe/auth.json */
export function keySituation(): { source: KeySource; key?: string } {
	const env = process.env.TYPESAFE_API_KEY?.trim();
	if (env) return { source: "environment", key: env };
	const own = readStore(join(agentDir(), "pi-codemap", "auth.json"));
	if (own) return { source: "stored", key: own };
	const shared = readStore(join(agentDir(), "pi-typesafe", "auth.json"));
	if (shared) return { source: "typesafe-shared", key: shared };
	return { source: "missing" };
}

export function normalizeApiKey(value: unknown): string {
	const key = typeof value === "string" ? value.trim() : "";
	if (key.length < 16 || key.length > 512 || /\s/.test(key) || /[^\x21-\x7e]/.test(key)) {
		throw new Error("That does not look like a TypeSafe API key. Copy the complete key and try again; nothing was saved.");
	}
	return key;
}

/** Atomic owner-only write; returns the path. */
export function storeApiKey(value: unknown): string {
	const key = normalizeApiKey(value);
	const path = join(agentDir(), "pi-codemap", "auth.json");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600, flag: "w" });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	rmSync(temporary, { force: true });
	return path;
}
