import test from "node:test";
import assert from "node:assert/strict";
import { equalDraft, fieldsFromCheckpoint, undoDisposition, readReplacement, writeReplacement } from "./checkpoint-replacement.ts";
import { intelligenceStatus, fallbackExplanation } from "./intelligence-status.ts";

const before = { notes: "New working notes\n  indentation", understanding: "New populated thinking", questions: "New question", reasoning: "New reasoning", nextAction: "New step" };
const checkpoint = { notes: "Old notes", understanding: "", questions: "", reasoning: "Older reasoning", nextAction: "Older step" };
const after = fieldsFromCheckpoint(before, checkpoint);
const snapshot = { before, after, baseVersion: 7, checkpointId: "checkpoint-a", createdAt: "2026-11-03T00:00:00.000Z" };

test("replacement explicitly clears older empty fields but preserves all working notes", () => {
  assert.equal(after.understanding, "");
  assert.equal(after.questions, "");
  assert.equal(after.reasoning, "Older reasoning");
  assert.equal(after.notes, before.notes);
  assert.equal(before.understanding, "New populated thinking");
});
test("preview/cancel is pure and identical fields need no replacement", () => {
  const copy = structuredClone(before);
  fieldsFromCheckpoint(before, checkpoint);
  assert.deepEqual(before, copy);
  assert(equalDraft(before, fieldsFromCheckpoint(before, before)));
});
test("undo a confirmed replacement is allowed only at its exact saved version", () => {
  assert.equal(undoDisposition(snapshot, after, after, 8), "write");
});
test("lost successful response can be reconciled from the exact persisted fields and version", () => {
  const restored = JSON.parse(JSON.stringify(snapshot));
  assert.equal(undoDisposition(restored, after, after, 8), "write");
});
test("interrupted request that never committed permits local-only undo", () => {
  assert.equal(undoDisposition(snapshot, after, before, 7), "local-only");
});
test("undo retries preserve intent after either a lost or an interrupted undo response", () => {
  assert.equal(undoDisposition(snapshot, before, after, 8), "write");
  assert.equal(undoDisposition(snapshot, before, before, 9), "already-undone");
  assert.equal(undoDisposition(snapshot, before, before, 10), "conflict");
});
test("later local edits cannot be overwritten, including later notes", () => {
  for (const key of Object.keys(after)) assert.equal(undoDisposition(snapshot, { ...after, [key]: "Later edit" }, after, 8), "changed");
});
test("same-content concurrent writes and different-content concurrent writes both block undo", () => {
  assert.equal(undoDisposition(snapshot, after, after, 9), "conflict");
  assert.equal(undoDisposition(snapshot, after, { ...after, nextAction: "Other tab" }, 8), "conflict");
  assert.equal(undoDisposition(snapshot, after, before, 6), "conflict");
});
test("recovery snapshot survives a reload and is scoped to owner and mission", () => {
  const items = new Map();
  globalThis.localStorage = { getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: k => items.delete(k) };
  assert(writeReplacement("owner-a", "mission-a", snapshot));
  assert.deepEqual(readReplacement("owner-a", "mission-a"), snapshot);
  assert.equal(readReplacement("owner-b", "mission-a"), null);
  assert.equal(readReplacement("owner-a", "mission-b"), null);
  assert(writeReplacement("owner-a", "mission-a", null));
  assert.equal(readReplacement("owner-a", "mission-a"), null);
});
test("unavailable storage is explicit and malformed recovery is ignored", () => {
  globalThis.localStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(writeReplacement("a", "b", snapshot), false);
  assert.equal(readReplacement("a", "b"), null);
  globalThis.localStorage = { getItem: () => '{"baseVersion":7,"before":{},"after":{}}' };
  assert.equal(readReplacement("a", "b"), null);
});
test("consecutive replacements cannot overwrite the original backup; refresh and Undo retain the first draft", () => {
  const items = new Map();
  globalThis.localStorage = { getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: k => items.delete(k) };
  let server = { fields: structuredClone(before), version: 7 };
  assert(writeReplacement("owner", "mission", snapshot));
  server = { fields: structuredClone(after), version: 8 };
  const second = {
    before: structuredClone(after),
    after: fieldsFromCheckpoint(after, { ...checkpoint, nextAction: "Checkpoint C" }),
    baseVersion: 8, checkpointId: "checkpoint-c", createdAt: "2026-11-03T00:01:00.000Z",
  };
  const originalStoredBytes = [...items.values()][0];
  assert.equal(writeReplacement("owner", "mission", second), false);
  assert.equal([...items.values()][0], originalStoredBytes);
  const afterRefresh = readReplacement("owner", "mission");
  assert.deepEqual(afterRefresh, snapshot);
  // A second attempt after remount/refresh must also be refused.
  assert.equal(writeReplacement("owner", "mission", second), false);
  assert.equal(undoDisposition(afterRefresh, server.fields, server.fields, server.version), "write");
  server = { fields: structuredClone(afterRefresh.before), version: server.version + 1 };
  assert.deepEqual(server.fields, before);
  assert.equal(server.fields.notes, "New working notes\n  indentation");
  assert(writeReplacement("owner", "mission", null));
  assert.equal(readReplacement("owner", "mission"), null);
  // Only resolving the original recovery permits a later replacement.
  assert(writeReplacement("owner", "mission", { ...second, before: server.fields, baseVersion: server.version }));
});
test("an unreadable existing recovery copy is not silently overwritten", () => {
  let raw = '{"unreadable":"existing recovery"}';
  globalThis.localStorage = { getItem: () => raw, setItem: (_k, value) => { raw = value; } };
  assert.equal(readReplacement("owner", "mission"), null);
  assert.equal(writeReplacement("owner", "mission", snapshot), false);
  assert.equal(raw, '{"unreadable":"existing recovery"}');
});
test("AI labels are based on job state, never immutable checkpoint fallback provenance", () => {
  assert.equal(intelligenceStatus("succeeded"), "AI enhancement: Ready");
  assert.equal(intelligenceStatus("fallback"), "Saved without AI");
  assert.equal(intelligenceStatus("retry_wait"), "AI enhancement: Retrying");
  assert.equal(intelligenceStatus("new_unknown_status"), "AI status unknown");
  assert.equal(intelligenceStatus(undefined), "AI status unknown");
});
test("one nonretryable sparse rejection does not claim retries or a provider call", () => {
  const text = fallbackExplanation("INSUFFICIENT_CONTENT", 1, 3);
  assert(text.includes("local content check, not an external AI call"));
  assert(!text.includes("attempt limit"));
  assert(!text.includes("exhausted"));
  assert(fallbackExplanation("AI_TIMEOUT", 3, 3).includes("attempt limit"));
  assert(!fallbackExplanation("INVALID_RESPONSE", 1, 3).includes("attempt limit"));
});
