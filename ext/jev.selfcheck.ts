/**
 * Self-check for ext/jev.ts pure logic. Run: npx tsx ext/jev.selfcheck.ts
 * (No network: systemOne/routeFirstPrompt/gateShortlist are excluded —
 * their failure mode is fail-open and covered by the bench.)
 */
import assert from "node:assert/strict";
import { gateTriggered, isTrivialPrompt, redactSend, subQueryTerms } from "./jev.ts";

// TRIVIAL_RE: high-precision only — these skip for free
assert.equal(isTrivialPrompt("run the tests"), true);
assert.equal(isTrivialPrompt("git status"), true);
assert.equal(isTrivialPrompt("git log --oneline -3"), true);
assert.equal(isTrivialPrompt("mentioning git log mid-sentence should not skip"), false);
assert.equal(isTrivialPrompt("commit these changes now"), true);
// …and these must NOT skip (code questions, long prompts)
assert.equal(isTrivialPrompt("What are the three most recent commit subjects in this repository?"), false);
assert.equal(isTrivialPrompt("where is the watcher implemented?"), false);
assert.equal(isTrivialPrompt("git ".padEnd(300, "x")), false, "length cap");

// gate trigger: weak top, or near-tie; never on 0-1 hits
assert.equal(gateTriggered([]), false);
assert.equal(gateTriggered([0.9]), false);
assert.equal(gateTriggered([0.9, 0.4]), false, "confident");
assert.equal(gateTriggered([0.4, 0.2]), true, "weak top");
assert.equal(gateTriggered([0.81, 0.79]), true, "near-tie");

// redact: the shapes we must never send
assert.ok(redactSend("token: supersecretvalue99").includes("[REDACTED]"));
assert.ok(!redactSend("token: supersecretvalue99").includes("supersecretvalue99"));
assert.ok(redactSend("sk-abcdefghij0123456789").includes("[REDACTED]"));
assert.ok(redactSend("ghp_abcdefghijklmnopqrst").includes("[REDACTED]"));
assert.ok(redactSend("AKIAIOSFODNN7EXAMPLE").includes("[REDACTED]"));
// ordinary code must pass through untouched
assert.equal(redactSend("const score = hits[0].score;"), "const score = hits[0].score;");

// sub-query expansion for the rescue pass
assert.deepEqual(subQueryTerms("Where is the genome — the persistent repository knowledge index — built?"), ["genome", "persistent", "repository", "knowledge"]);
assert.deepEqual(subQueryTerms("the of and to"), [], "stopwords/short words only");

console.log("jev.selfcheck: all assertions passed");
