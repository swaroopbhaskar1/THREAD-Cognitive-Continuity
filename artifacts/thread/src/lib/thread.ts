import { useCallback, useRef, useState } from "react";

export function newKey(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${rand}`;
}

/** A request key that stays stable across retries and rotates only on success. */
export function useRequestKey(prefix: string) {
  const [key, setKey] = useState(() => newKey(prefix));
  const keyRef = useRef(key);
  keyRef.current = key;
  const rotate = useCallback(() => setKey(newKey(prefix)), [prefix]);
  return { key, keyRef, rotate };
}

export function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const e = (data as { error?: unknown; message?: unknown }).error ?? (data as { message?: unknown }).message;
      if (typeof e === "string" && e.trim()) return e;
    }
    if (typeof data === "string" && data.trim() && data.length < 300) return data;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export type DraftFields = {
  notes: string;
  understanding: string;
  questions: string;
  reasoning: string;
  nextAction: string;
};

export const EMPTY_FIELDS: DraftFields = {
  notes: "",
  understanding: "",
  questions: "",
  reasoning: "",
  nextAction: "",
};

export function sameFields(a: DraftFields, b: DraftFields) {
  return (
    a.notes === b.notes &&
    a.understanding === b.understanding &&
    a.questions === b.questions &&
    a.reasoning === b.reasoning &&
    a.nextAction === b.nextAction
  );
}

export type LocalRecovery = {
  fields: DraftFields;
  baseVersion: number;
  updatedAt: string;
};

const storageKey = (userId: string, missionId: string) =>
  `thread:v1:${userId}:draft:${missionId}`;

export function readRecovery(userId: string, missionId: string): LocalRecovery | null {
  try {
    const raw = localStorage.getItem(storageKey(userId, missionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalRecovery;
    if (!parsed || typeof parsed !== "object" || !parsed.fields) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRecovery(userId: string, missionId: string, rec: LocalRecovery): boolean {
  try {
    localStorage.setItem(storageKey(userId, missionId), JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

export type PendingCheckpoint = {
  requestKey: string;
  payload: DraftFields & { version: number; requestKey: string; simulateFailure: boolean };
  frozenAt: string;
};
const pendingKey = (userId: string, missionId: string) => `thread:v1:${userId}:pendingCheckpoint:${missionId}`;
export function readPendingCheckpoint(userId: string, missionId: string): PendingCheckpoint | null {
  try {
    const raw = localStorage.getItem(pendingKey(userId, missionId));
    return raw ? (JSON.parse(raw) as PendingCheckpoint) : null;
  } catch {
    return null;
  }
}
export function writePendingCheckpoint(userId: string, missionId: string, p: PendingCheckpoint | null): boolean {
  try {
    if (p) localStorage.setItem(pendingKey(userId, missionId), JSON.stringify(p));
    else localStorage.removeItem(pendingKey(userId, missionId));
    return true;
  } catch {
    return false;
  }
}

export function clearRecovery(userId: string, missionId: string) {
  try {
    localStorage.removeItem(storageKey(userId, missionId));
  } catch {
    /* ignore */
  }
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms.toFixed(3)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export const OBSTACLES = [
  { value: "lost_context", label: "I lost the context", hint: "Remind me where I was." },
  { value: "overwhelmed", label: "It feels like too much", hint: "Make it smaller." },
  { value: "uncertain", label: "I'm unsure what's right", hint: "Show me my reasoning." },
  { value: "ready", label: "I'm ready to go", hint: "Just the next step." },
] as const;
