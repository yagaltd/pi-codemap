/**
 * Self-check for ext/jev.ts pure logic. Run: npx tsx ext/jev.selfcheck.ts
 * (No network: systemOne/routeFirstPrompt/gateShortlist are excluded —
 * their failure mode is fail-open and covered by the bench.)
 */
import assert from "node:assert/strict";
import { classifySpan, gateTriggered, isTrivialPrompt, redactSend, subQueryTerms } from "./jev.ts";
import { typellmAnswers, typellmQuestions } from "./typellm.ts";

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

// span classification: inside / spanning / free
const SYMS = [{ name: "a", start_line: 10, end_line: 20 }, { name: "b", start_line: 25, end_line: 30 }];
assert.deepEqual(classifySpan(SYMS, 12, 18), { kind: "inside", sym: SYMS[0] });
assert.deepEqual(classifySpan(SYMS, 18, 27).kind, "spanning", "crosses a and b");
assert.deepEqual(classifySpan(SYMS, 20, 26).kind, "spanning", "end of a + start of b");
assert.deepEqual(classifySpan(SYMS, 1, 5).kind, "free", "above all symbols");
assert.deepEqual(classifySpan(SYMS, 21, 24).kind, "free", "gap between symbols");
assert.deepEqual(classifySpan([], 1, 9).kind, "free");

// TypeLLM provider mapping (pure parts)
const tq = typellmQuestions({ a: { type: "bool", instructions: "Is it?", criteria: { true: "yes-ish", false: "no-ish" } }, b: { type: "bool", instructions: "Plain?" } });
assert.deepEqual(tq.a, { type: "boolean", instructions: "Is it? Answer true: yes-ish Answer false: no-ish", return_probabilities: true });
assert.deepEqual(tq.b, { type: "boolean", instructions: "Plain?", return_probabilities: true });
const ta = typellmAnswers({ result: { p: { value: true, probabilities: { true: 0.87, false: 0.13 } }, q: false, r: { value: false }, junk: "not a verdict" } });
assert.equal(ta.p.probability, 0.87, "probabilities shape");
assert.equal(ta.q.probability, 0, "plain false");
assert.equal(ta.r.probability, 0, "value-only false");
assert.ok(!("junk" in ta), "non-boolean skipped");

console.log("jev.selfcheck: all assertions passed");
