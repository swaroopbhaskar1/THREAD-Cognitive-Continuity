import test from "node:test";
import assert from "node:assert/strict";
import { compareLearningFields } from "./learning-comparison.ts";
import { aiOutcome, fallbackKind, uniqueIntelligenceEvidence } from "./intelligence-status.ts";

const empty = { nextAction: "", understanding: "", questions: "", reasoning: "", notes: "" };
test("comparison includes all five empty fields explicitly", () => {
  const rows = compareLearningFields(empty, empty);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.state === "empty" && row.then === "" && row.now === ""));
});
test("comparison identifies identical, new, removed and changed original words", () => {
  const then = { ...empty, nextAction: "Trace abba", understanding: "Window", questions: "Why backward?", notes: "Old" };
  const now = { ...empty, nextAction: "Trace abba", understanding: "Window stays distinct", questions: "", reasoning: "Track pointers", notes: "New" };
  const states = Object.fromEntries(compareLearningFields(then, now).map(row => [row.key, row.state]));
  assert.deepEqual(states, { nextAction: "same", understanding: "changed", questions: "removed", reasoning: "added", notes: "changed" });
  assert.ok(!Object.values(states).includes("resolved"));
});
test("comparison preserves indentation, trailing spaces, blank lines and whitespace-only differences", () => {
  const then = { ...empty, notes: "  line\n\nnext  " };
  const now = { ...empty, notes: "line\n\nnext" };
  const row = compareLearningFields(then, now).find(row => row.key === "notes");
  assert.equal(row.state, "changed");
  assert.equal(row.then, then.notes);
  assert.equal(row.now, now.notes);
  assert.equal(compareLearningFields(empty, { ...empty, notes: " " }).find(row => row.key === "notes").state, "added");
});
test("comparison is read-only and uses the supplied live draft, not a saved snapshot", () => {
  const checkpoint = Object.freeze({ ...empty, nextAction: "Saved step" });
  const current = Object.freeze({ ...empty, nextAction: "New unsaved step" });
  const row = compareLearningFields(checkpoint, current).find(row => row.key === "nextAction");
  assert.equal(row.now, "New unsaved step");
  assert.equal(checkpoint.nextAction, "Saved step");
  assert.equal(current.nextAction, "New unsaved step");
});
test("only a recorded sparse fallback is classified as no-call sparse AI", () => {
  assert.equal(aiOutcome({ status: "fallback", lastError: "INSUFFICIENT_CONTENT", source: "fallback", result: {} }), "sparse");
  assert.equal(aiOutcome({ status: "retry_wait", lastError: "INSUFFICIENT_CONTENT" }), "pending");
  assert.equal(aiOutcome({ status: "not_requested", lastError: "INSUFFICIENT_CONTENT" }), "not_requested");
});
test("successful AI requires both a result and AI provenance", () => {
  assert.equal(aiOutcome({ status: "succeeded", source: "ai", result: { summary: {} } }), "ready");
  assert.equal(aiOutcome({ status: "succeeded", source: "fallback", result: {} }), "empty");
  assert.equal(aiOutcome({ status: "succeeded", source: "ai", result: null }), "empty");
  assert.equal(aiOutcome({ status: "fallback", source: "fallback", result: {} }), "fallback");
});
test("pending, unknown and interrupted states never masquerade as ready", () => {
  for (const status of ["queued", "running", "calling_provider", "retry_wait"])
    assert.equal(aiOutcome({ status, source: "ai", result: {} }), "pending");
  for (const status of ["interrupted", "unrecognized", ""])
    assert.equal(aiOutcome({ status, source: "ai", result: {} }), "unknown");
});
test("every actual content-validation code is distinguished from provider failure", () => {
  for (const lastError of ["INVALID_SCHEMA", "INVALID_JSON", "UNGROUNDED_EVIDENCE", "OFF_TOPIC_CONTENT", "UNSAFE_CONTENT", "NOT_A_QUESTION", "ACTION_NOT_CONCRETE", "INVALID_PROVIDER_ENVELOPE", "RESPONSE_TOO_LARGE", "EMPTY_RESPONSE", "INCOMPLETE_RESPONSE"])
    assert.equal(fallbackKind({ status: "fallback", lastError }), "AI output was rejected by validation");
});
test("interrupted and locally injected attempts never claim a known provider failure", () => {
  assert.match(fallbackKind({ status: "fallback", lastError: "INTERRUPTED_ATTEMPTS_EXHAUSTED" }), /external outcome may be unknown/);
  assert.match(fallbackKind({ status: "fallback", lastError: "INJECTED_PROVIDER_FAILURE" }), /not a provider failure/);
});
test("timeouts, HTTP/network failure, refusal and admission limits have honest labels", () => {
  assert.match(fallbackKind({ status: "fallback", lastError: "PROVIDER_TIMEOUT" }), /timed out/);
  for (const lastError of ["HTTP_400", "HTTP_429", "HTTP_503", "PROVIDER_NETWORK_ERROR"])
    assert.match(fallbackKind({ status: "fallback", lastError }), /could not complete/);
  assert.match(fallbackKind({ status: "fallback", lastError: "PROVIDER_REFUSAL" }), /declined/);
  assert.match(fallbackKind({ status: "fallback", lastError: "AI_BUDGET_EXHAUSTED" }), /usage limit/);
});
test("a capped attempt count alone is not evidence that an external provider failed", () => {
  assert.equal(fallbackKind({ status: "fallback", attempts: 3, maxAttempts: 3, lastError: "UNKNOWN" }), "AI enhancement is unavailable");
});

test("repeated exact AI citations render once with all their output associations", () => {
  const cite = { field: "questions", quote: "  Why left?\nKeep spaces." };
  const result = {
    retrievalQuestion: { evidence: [cite, cite] },
    summary: { evidence: [cite] },
    nextAction: { evidence: [{ field: "reasoning", quote: "Left stays 2" }, cite] },
  };
  const before = structuredClone(result);
  assert.deepEqual(uniqueIntelligenceEvidence(result), [
    { ...cite, usedBy: ["Question", "Return cue", "Alternative action"] },
    { field: "reasoning", quote: "Left stays 2", usedBy: ["Alternative action"] },
  ]);
  assert.deepEqual(result, before);
});
test("the same quote from different source fields remains distinct evidence", () => {
  const quote = "A repeated phrase";
  const rows = uniqueIntelligenceEvidence({
    summary: { evidence: [{ field: "notes", quote }] },
    retrievalQuestion: { evidence: [{ field: "questions", quote }] },
    nextAction: { evidence: [] },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.field), ["questions", "notes"]);
});
