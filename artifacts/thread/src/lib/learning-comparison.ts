import type { DraftFields } from "./thread";

export const LEARNING_FIELDS: { key: keyof DraftFields; label: string }[] = [
  { key: "nextAction", label: "Where you planned to pick up" },
  { key: "understanding", label: "What made sense" },
  { key: "questions", label: "What you were unsure about" },
  { key: "reasoning", label: "Reasoning" },
  { key: "notes", label: "Working notes" },
];

/** Compare exact originals without trimming, rewriting, scoring or mutating them. */
export function compareLearningFields(checkpoint: Readonly<DraftFields>, current: Readonly<DraftFields>) {
  return LEARNING_FIELDS.map(field => {
    const then = checkpoint[field.key];
    const now = current[field.key];
    const state = !then && !now ? "empty" : then === now ? "same" : !now ? "removed" : !then ? "added" : "changed";
    return { ...field, then, now, state };
  });
}
