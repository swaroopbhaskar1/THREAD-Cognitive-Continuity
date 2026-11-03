// Run: node --experimental-strip-types --test artifacts/thread/src/lib/execution-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "./execution-model.ts";

const ev = (seq, name, extra = {}) => ({ id: `e${seq}`, workflowId: "w", sequence: seq, name, component: "server", sourceComponent: "server",
  destinationComponent: "database", outcome: "success", durationMs: seq * 1.5, createdAt: "2025-01-01T00:00:00Z", details: "", attempt: 1, fallback: false, ...extra });

test("default skips activity.summary and mission.open", () => {
  const list = [
    { id: "a", operation: "activity.summary", status: "success", createdAt: "2025-01-03", durationMs: 1, missionId: null },
    { id: "b", operation: "mission.open", status: "success", createdAt: "2025-01-02", durationMs: 1, missionId: null },
    { id: "c", operation: "checkpoint.create", status: "success", createdAt: "2025-01-01", durationMs: 1, missionId: null },
  ];
  assert.equal(m.pickDefaultWorkflow(list), "c");
  assert.equal(m.pickDefaultWorkflow(list.slice(0, 2)), "a");
  assert.equal(m.pickDefaultWorkflow([]), null);
});

test("story preserves every event exactly once in sequence; failures never collapsed", () => {
  const sorted = m.sortBySequence([ev(3, "execution.batch.persisted"), ev(1, "workflow.started"), ev(2, "ai.external_call"),
    ev(4, "transaction.commit.confirmed"), ev(5, "transaction.commit.confirmed", { outcome: "failure" }), ev(6, "weird.unknown")]);
  const story = m.buildStory(sorted);
  assert.deepEqual(story.flatMap((s) => s.indices), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(story.map((s) => s.kind), ["step", "step", "instrumentation", "step", "step"]);
  assert.equal(m.stepLabel("weird.unknown"), "weird.unknown");
  assert.equal(m.isKnownEvent("weird.unknown"), false);
});

test("replay pacing is display-only and step moves one event", () => {
  assert.equal(m.paceMs(4), 275);
  assert.equal(m.paceMs(1), 1100);
  assert.equal(m.stepForward(-1, 3), 0);
  assert.equal(m.stepForward(2, 3), 2);
  assert.equal(m.stepForward(-1, 0), -1);
  assert.equal(m.replayState(1, false, 3), "paused");
  assert.equal(m.replayState(2, false, 3), "done");
  assert.equal(m.cursorPosition(0, -1), "record");
  assert.equal(m.cursorPosition(2, 1), "upcoming");
});

test("status labels never invent outcomes", () => {
  assert.equal(m.statusInfo(undefined).tone, "unknown");
  assert.equal(m.statusInfo("fallback", "ai.enhance").label, "Saved without AI");
  assert.equal(m.statusInfo("zzz").label, "Status unknown (zzz)");
  assert.equal(m.statusInfo("retry_wait").label, "Waiting to retry");
  assert.equal(m.statusInfo("saved", "checkpoint.create").label, "Checkpoint saved");
  assert(!m.statusInfo("fallback", "checkpoint.create").label.includes("without AI"));
});

test("replay groups stop saying replaying when playback pauses or finishes", () => {
  assert.equal(m.replayGroupLabel(["replayed", "current"], "playing"), "replaying");
  assert.equal(m.replayGroupLabel(["replayed", "current"], "paused"), "replay paused");
  assert.equal(m.replayGroupLabel(["replayed", "current"], "done"), "replayed");
  assert.equal(m.replayGroupLabel(["replayed"], "done"), "replayed");
  assert.equal(m.replayGroupLabel(["upcoming"], "playing"), "not yet replayed");
  assert.equal(m.replayGroupLabel([], "done"), null);
  assert.equal(m.replayGroupLabel(["record"], "idle"), null);
});
test("an interrupted dispatch stays unknown rather than falsely claiming no external call", () => {
  assert.equal(m.aiReceiptUnknown([ev(1, "ai.call.dispatch_intent")]), true);
  assert.equal(m.aiReceiptUnknown([ev(1, "ai.worker.interrupted")]), true);
  assert.equal(m.aiReceiptUnknown([ev(1, "ai.call.dispatch_intent"), ev(2, "ai.external_call")]), false);
  assert.equal(m.aiReceiptUnknown([ev(1, "ai.fallback.persisted")]), false);
});

test("recorded inputs come only from details text; AI call detection", () => {
  const evs = [ev(1, "checkpoint.persisted", { details: "Stored 199 note characters and 4 fields" })];
  assert.deepEqual(m.recordedInputs(evs), ["199 note characters", "4 fields"]);
  assert.deepEqual(m.recordedInputs([ev(1, "ai.job.queued", { details: "At most 3 attempts" })]), []);
  assert.equal(m.aiWasCalled(evs), false);
  assert.equal(m.aiWasCalled([ev(1, "ai.external_call")]), true);
  assert.equal(m.readWorkflowParam("?workflow=abc"), "abc");
  assert.equal(m.readWorkflowParam(""), null);
});
