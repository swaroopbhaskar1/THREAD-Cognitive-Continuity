// Pure, dependency-free model for the How It Works execution view.
// Everything here derives from persisted records only. Nothing is summed,
// reordered, inferred or fabricated. Kept free of imports so it can be tested
// with `node --experimental-strip-types`.

export type ExecEvent = {
  id: string; workflowId: string; sequence: number; name: string; component: string;
  sourceComponent: string; destinationComponent: string; outcome: string; durationMs: number;
  createdAt: string; details: string; attempt: number; fallback: boolean;
};
export type Wf = { id: string; operation: string; status: string; createdAt: string; durationMs: number; missionId: string | null };

export const BASE_PACE_MS = 1100;
/** A dispatch intent without its external-call receipt does not prove "no call". */
export function aiReceiptUnknown(events: readonly { name: string }[]) {
  return !events.some(e => e.name === "ai.external_call") &&
    events.some(e => e.name === "ai.call.dispatch_intent" || e.name === "ai.worker.interrupted");
}
export const SPEEDS = [0.5, 1, 2, 4] as const;
/** Display pacing per replay step. Never touches recorded durations. */
export const paceMs = (speed: number) => Math.round(BASE_PACE_MS / (speed > 0 ? speed : 1));

/** Reads, list views and telemetry: preserved in history, never the default run. */
export const LOW_SIGNAL_OPS = new Set([
  "activity.summary", "mission.open", "missions.list", "missions.read", "execution.events", "execution.history",
  "intelligence.read", "review.read", "reviews.read", "review.history", "resumption.first_action", "workflow.read",
]);
export const isMeaningfulOp = (op: string) => !LOW_SIGNAL_OPS.has(op);

/** Latest meaningful workflow (by recorded createdAt), else the latest of any kind, else null. */
export function pickDefaultWorkflow(list: readonly Wf[] | undefined): string | null {
  if (!list || !list.length) return null;
  const byNewest = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (byNewest.find((w) => isMeaningfulOp(w.operation)) ?? byNewest[0]).id;
}

const OP_TITLES: Record<string, string> = {
  "checkpoint.create": "Checkpoint saved", "draft.save": "Draft autosaved", "mission.create": "Mission created",
  "mission.resume": "Mission resumed", "ai.enhance": "AI enhancement", "intelligence.request": "AI enhancement requested",
  "review.enroll": "Review scheduled", "review.start": "Recall review started", "review.answer": "Recall answer saved",
  "review.rate": "Recall rated", "review.schedule": "Review schedule updated", "resumption.first_action": "First action after resuming",
  "activity.summary": "Activity counts read", "mission.open": "Mission opened", "missions.list": "Missions listed",
  "missions.read": "Missions read", "execution.events": "Execution events read", "execution.history": "Execution history read",
  "intelligence.read": "AI status read", "review.read": "Review read", "reviews.read": "Reviews read", "review.history": "Review history read",
};
export const opTitle = (op: string) => OP_TITLES[op] ?? op;

export type Tone = "ok" | "fallback" | "fail" | "pending" | "unknown";
/** Authoritative workflow status (as persisted) to plain language. Unknown stays unknown. */
export function statusInfo(status: string | undefined, operation?: string): { label: string; tone: Tone } {
  if (status === undefined || status === null || status === "") return { label: "Status unknown", tone: "unknown" };
  switch (status) {
    case "success": return { label: operation === "ai.enhance" ? "AI enhancement ready" : operation === "checkpoint.create" ? "Checkpoint saved" : "Completed", tone: "ok" };
    case "saved": return { label: operation === "checkpoint.create" ? "Checkpoint saved" : "Saved", tone: "ok" };
    case "fallback": return operation === "checkpoint.create"
      ? { label: "Checkpoint saved · AI status is separate", tone: "ok" }
      : { label: "Saved without AI", tone: "fallback" };
    case "failure": return { label: operation === "ai.enhance" ? "Result unavailable" : "Failed", tone: "fail" };
    case "retry_wait": return { label: "Waiting to retry", tone: "pending" };
    case "queued": return { label: "Waiting in queue", tone: "pending" };
    case "running": return { label: "Running at last record", tone: "pending" };
    case "calling_provider": return { label: "Calling AI at last record", tone: "pending" };
    default: return { label: `Status unknown (${status})`, tone: "unknown" };
  }
}

export function outcomeTone(outcome: string, fallback = false): Tone {
  const v = outcome.toLowerCase();
  if (/fail|error|unavailable|reject|interrupt|timeout|denied/.test(v)) return "fail";
  if (fallback || /fallback|skip|discard/.test(v)) return "fallback";
  if (/retry|wait|queue|pending/.test(v)) return "pending";
  if (/success|ok|saved|persisted|reused|replayed|confirmed/.test(v)) return "ok";
  return "unknown";
}

const INSTRUMENTATION = new Set(["execution.batch.persisted", "transaction.commit.confirmed", "request.receipt", "request.receipt.persisted"]);
export const isCommitAck = (e: Pick<ExecEvent, "name">) => e.name === "transaction.commit.confirmed";
/** Failures, retries and interruptions are never folded into instrumentation. */
export function isProblem(e: Pick<ExecEvent, "name" | "outcome" | "fallback">) {
  return outcomeTone(e.outcome) === "fail" || /failed|retry|interrupted|rejected|stale|failure_injection/.test(e.name);
}
export const isInstrumentation = (e: Pick<ExecEvent, "name" | "outcome" | "fallback">) => INSTRUMENTATION.has(e.name) && !isProblem(e);

const STEP_LABELS: Record<string, string> = {
  "workflow.started": "Request received", "request.rejected": "Request rejected", "request.idempotency.replayed": "Duplicate request answered from receipt",
  "ai.job.queued": "Queue job", "ai.job.claimed": "Claim work", "ai.budget.reserved": "Reserve AI budget", "ai.call.dispatch_intent": "Record call intent",
  "ai.external_call": "Call AI", "ai.response.validated": "Validate result", "ai.enhancement.persisted": "Persist enhancement",
  "ai.fallback.persisted": "Persist labeled fallback", "ai.attempt.failed": "AI attempt failed", "ai.retry.scheduled": "Retry scheduled",
  "ai.stale_result.discarded": "Discard stale result", "ai.worker.interrupted": "Worker interrupted", "ai.failure_injection": "Injected failure (test)",
  "checkpoint.persisted": "Persist checkpoint", "draft.persisted": "Persist draft", "mission.persisted": "Persist mission",
  "context.restored": "Restore saved context", "resumption.persisted": "Persist resumption", "first_action.recorded": "Record first action",
  "review.schedule.created": "Create review schedule", "review.schedule.computed": "Compute next review", "review.question.frozen": "Freeze recall question",
  "review.attempt.started": "Start recall attempt", "review.attempt.reused": "Reuse recall attempt", "review.answer.persisted": "Persist answer",
  "review.rating.persisted": "Persist rating", "activity.counted": "Count activity", "execution.batch.persisted": "Write event batch",
  "transaction.commit.confirmed": "COMMIT acknowledged", "request.receipt": "Idempotency receipt", "request.receipt.persisted": "Persist idempotency receipt",
};
export const stepLabel = (name: string) => STEP_LABELS[name] ?? name;
export const isKnownEvent = (name: string) => name in STEP_LABELS;

export const sortBySequence = <T extends { sequence: number }>(events: readonly T[]) => [...events].sort((a, b) => a.sequence - b.sequence);

/** Story item: either one meaningful event, or a run of consecutive successful instrumentation.
 *  `indices` point into the sequence-sorted original list; every index appears exactly once, in order. */
export type StoryItem = { kind: "step" | "instrumentation"; indices: number[] };
export function buildStory(sorted: readonly ExecEvent[]): StoryItem[] {
  const out: StoryItem[] = [];
  sorted.forEach((e, i) => {
    const kind = isInstrumentation(e) ? "instrumentation" : "step";
    const last = out[out.length - 1];
    if (kind === "instrumentation" && last?.kind === "instrumentation") last.indices.push(i);
    else out.push({ kind, indices: [i] });
  });
  return out;
}
export const storyIndexOf = (story: readonly StoryItem[], eventIndex: number) => story.findIndex((s) => s.indices.includes(eventIndex));

/** Numeric inputs exactly as written in recorded details, e.g. "199 note characters". */
export function recordedInputs(events: readonly ExecEvent[]): string[] {
  const found: string[] = [];
  const re = /\b(\d[\d,]*)\s+((?:[a-z]+\s){0,2}?(?:characters|chars|fields|questions|words|items|checkpoints))\b/gi;
  for (const e of events) {
    if (isInstrumentation(e)) continue;
    for (const m of e.details.matchAll(re)) {
      const s = `${m[1]} ${m[2]}`;
      if (!found.includes(s)) found.push(s);
    }
  }
  return found.slice(0, 6);
}

/** Whether a real external AI call event exists in this workflow. */
export const aiWasCalled = (events: readonly ExecEvent[]) => events.some((e) => e.name === "ai.external_call");

export type ReplayState = "idle" | "playing" | "paused" | "done";
export function replayState(cursor: number, playing: boolean, total: number): ReplayState {
  if (cursor < 0) return "idle";
  if (playing) return "playing";
  return cursor >= total - 1 ? "done" : "paused";
}
/** Replay cursor position of an event: never an execution outcome. */
export function cursorPosition(i: number, cursor: number): "replayed" | "current" | "upcoming" | "record" {
  if (cursor < 0) return "record";
  return i < cursor ? "replayed" : i === cursor ? "current" : "upcoming";
}
/** Display replay position without mistaking the final selected frame for active playback. */
export function replayGroupLabel(positions: readonly ReturnType<typeof cursorPosition>[], state: ReplayState) {
  if (!positions.length || state === "idle") return null;
  if (positions.includes("current")) return state === "playing" ? "replaying" : state === "done" ? "replayed" : "replay paused";
  if (positions.every(p => p === "replayed")) return "replayed";
  if (positions.every(p => p === "upcoming")) return "not yet replayed";
  return null;
}
export const stepForward = (cursor: number, total: number) => (total ? Math.min(cursor + 1, total - 1) : -1);

export function readWorkflowParam(search: string): string | null {
  const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("workflow");
  return v && v.trim() ? v : null;
}
