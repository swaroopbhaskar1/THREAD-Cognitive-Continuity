import type { DraftFields } from "./thread";

export const REPLACED_FIELDS = [
  { key: "understanding", label: "Understanding" },
  { key: "questions", label: "Questions / uncertainties" },
  { key: "reasoning", label: "Reasoning" },
  { key: "nextAction", label: "Next action" },
] as const;

export type ReplacementSnapshot = {
  before: DraftFields;
  after: DraftFields;
  baseVersion: number;
  checkpointId: string;
  createdAt: string;
};

export function equalDraft(a: DraftFields, b: DraftFields) {
  return a.notes === b.notes && REPLACED_FIELDS.every(({ key }) => a[key] === b[key]);
}

export function fieldsFromCheckpoint(current: DraftFields, checkpoint: Omit<DraftFields, "notes">): DraftFields {
  return {
    notes: current.notes,
    understanding: checkpoint.understanding,
    questions: checkpoint.questions,
    reasoning: checkpoint.reasoning,
    nextAction: checkpoint.nextAction,
  };
}

/** Only the exact before/after version pair is safe to undo, including lost responses. */
export function undoDisposition(snapshot: ReplacementSnapshot, local: DraftFields, server: DraftFields, serverVersion: number) {
  const priorIsLocal = equalDraft(local, snapshot.before);
  if (priorIsLocal && equalDraft(server, snapshot.before) && serverVersion === snapshot.baseVersion + 2) return "already-undone";
  if (!priorIsLocal && !equalDraft(local, snapshot.after)) return "changed";
  if (serverVersion === snapshot.baseVersion && equalDraft(server, snapshot.before)) return "local-only";
  if (serverVersion === snapshot.baseVersion + 1 && equalDraft(server, snapshot.after)) return "write";
  return "conflict";
}

const key = (owner: string, mission: string) => `thread:v1:${owner}:replacement:${mission}`;
const validFields = (v: unknown): v is DraftFields => !!v && typeof v === "object" &&
  ["notes", ...REPLACED_FIELDS.map(f => f.key)].every(k => typeof (v as Record<string, unknown>)[k] === "string");

export function readReplacement(owner: string, mission: string): ReplacementSnapshot | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(owner, mission)) || "null");
    return v && validFields(v.before) && validFields(v.after) && Number.isSafeInteger(v.baseVersion) &&
      v.baseVersion >= 0 && typeof v.checkpointId === "string" && typeof v.createdAt === "string" ? v : null;
  } catch { return null; }
}

export function writeReplacement(owner: string, mission: string, value: ReplacementSnapshot | null) {
  try {
    if (value) {
      // Never replace the only copy of earlier, potentially uncheckpointed thinking.
      // Even an unreadable existing record must be retained, not overwritten.
      if (localStorage.getItem(key(owner, mission)) !== null) return false;
      localStorage.setItem(key(owner, mission), JSON.stringify(value));
    }
    else localStorage.removeItem(key(owner, mission));
    return true;
  } catch { return false; }
}
