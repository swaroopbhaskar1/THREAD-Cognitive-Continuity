type RecordedIntelligence = {
  status: string;
  lastError?: string | null;
  source?: string;
  result?: unknown;
};

type CitedPiece = { evidence: readonly { field: string; quote: string }[] };
/** Render a repeated citation once, retaining every output it supports. */
export function uniqueIntelligenceEvidence(result: Record<"summary" | "retrievalQuestion" | "nextAction", CitedPiece>) {
  const rows = new Map<string, { field: string; quote: string; usedBy: string[] }>();
  for (const [key, label] of [
    ["retrievalQuestion", "Question"], ["summary", "Return cue"], ["nextAction", "Alternative action"],
  ] as const) {
    for (const evidence of result[key].evidence) {
      const id = JSON.stringify([evidence.field, evidence.quote]);
      let row = rows.get(id);
      if (!row) { row = { ...evidence, usedBy: [] }; rows.set(id, row); }
      if (!row.usedBy.includes(label)) row.usedBy.push(label);
    }
  }
  return [...rows.values()];
}

/** A saved-content fallback is never presented as a successful AI response. */
export function aiOutcome(job: RecordedIntelligence) {
  if (job.status === "fallback" && job.lastError === "INSUFFICIENT_CONTENT") return "sparse";
  if (["queued", "running", "calling_provider", "retry_wait"].includes(job.status)) return "pending";
  if (job.status === "succeeded") return job.result && job.source === "ai" ? "ready" : "empty";
  if (job.status === "fallback") return "fallback";
  if (job.status === "not_requested") return "not_requested";
  return "unknown";
}

const VALIDATION_ERRORS = new Set([
  "INVALID_SCHEMA", "INVALID_JSON", "UNGROUNDED_EVIDENCE", "OFF_TOPIC_CONTENT",
  "UNSAFE_CONTENT", "NOT_A_QUESTION", "ACTION_NOT_CONCRETE",
  "INVALID_PROVIDER_ENVELOPE", "RESPONSE_TOO_LARGE", "EMPTY_RESPONSE", "INCOMPLETE_RESPONSE",
]);

/** Exact backend codes, not a guessed provider outage based on an attempt count. */
export function fallbackKind(job: RecordedIntelligence) {
  const error = job.lastError ?? "";
  if (VALIDATION_ERRORS.has(error)) return "AI output was rejected by validation";
  if (error === "INJECTED_PROVIDER_FAILURE") return "Locally injected failure, not a provider failure";
  if (error === "INTERRUPTED_ATTEMPTS_EXHAUSTED") return "AI processing was interrupted; the external outcome may be unknown";
  if (error === "AI_BUDGET_EXHAUSTED") return "AI usage limit reached";
  if (error === "PROVIDER_TIMEOUT") return "The AI request timed out";
  if (error === "PROVIDER_REFUSAL") return "The AI provider declined the request";
  if (/^HTTP_\d{3}$/.test(error) || error === "PROVIDER_NETWORK_ERROR") return "The AI request could not complete";
  if (error === "PROVIDER_NOT_CONFIGURED") return "AI is temporarily unavailable";
  return "AI enhancement is unavailable";
}

export function intelligenceStatus(status: string | undefined) {
  switch (status) {
    case "queued": return "AI enhancement: Waiting";
    case "running": case "calling_provider": return "AI enhancement: Generating";
    case "retry_wait": return "AI enhancement: Retrying";
    case "succeeded": return "AI enhancement: Ready";
    case "fallback": return "Saved without AI";
    case "not_requested": return "AI enhancement not requested";
    case "failed": return "Enhancement unavailable";
    default: return "AI status unknown";
  }
}

export function fallbackExplanation(lastError: string | null | undefined, attempts: number, maxAttempts: number) {
  if (lastError?.includes("INSUFFICIENT_CONTENT")) return "Your checkpoint is saved. Add a sentence about what you understand or what is unclear, then save another checkpoint for an AI enhancement. This was a local content check, not an external AI call.";
  if (attempts >= maxAttempts && maxAttempts > 0) return "Your checkpoint is saved without AI. The job reached its attempt limit; technical details show what happened in each attempt.";
  return "Your checkpoint is saved without AI. Enhancement was unavailable or a response was rejected; your original work is unchanged.";
}
