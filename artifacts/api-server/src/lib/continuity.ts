import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const strategies: Record<string, string> = {
  lost_context: "Read your saved understanding, then explain the main idea in your own words before taking your next step.",
  overwhelmed: "Focus on only your saved next action. Work on the smallest part for two minutes; leave everything else for later.",
  uncertain: "Start with the concrete next action below. Write one sentence about what you expect to learn, then try it.",
  ready: "Continue with your saved next action. Capture any new reasoning as you work.",
};

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fallbackQuestion(understanding: string, subject: string): string {
  return understanding.trim()
    ? `Without looking at your notes, explain your current understanding of ${subject || "this mission"}. What reasoning supports it?`
    : `What do you remember about ${subject || "this mission"}, and what question were you trying to answer?`;
}

export async function unavailableProvider(induced: boolean): Promise<never> {
  // An adapter boundary, not a real external request. No artificial latency.
  throw new HttpError(503, induced ? "DEMO_PROVIDER_FAILURE" : "AI_NOT_CONFIGURED",
    induced ? "Induced provider-adapter failure; no external request was sent." : "AI is not connected in Phases 1–2; no external request was sent.");
}
