/** Per-user local persistence for recall drafts and frozen (unconfirmed) review mutations. */
export type FrozenAnswer = { requestKey: string; answer: string; frozenAt: string };
export type FrozenRating = { requestKey: string; difficulty: "again" | "hard" | "good" | "easy"; frozenAt: string };
export type FrozenKey = { requestKey: string; frozenAt: string };

const k = (userId: string, kind: string, id: string) => `thread:v1:${userId}:review:${kind}:${id}`;

export function readLocal<T>(userId: string, kind: string, id: string): T | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(k(userId, kind, id));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export function writeLocal<T>(userId: string, kind: string, id: string, value: T | null): boolean {
  if (!userId) return false;
  try {
    if (value === null) localStorage.removeItem(k(userId, kind, id));
    else localStorage.setItem(k(userId, kind, id), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const MIN = 1;
export const DAY = 1440;
const CAP = 365 * DAY;

/** Client-side preview of thread-spacing-v1. The server result is authoritative. */
export function previewInterval(d: "again" | "hard" | "good" | "easy", s: { intervalMinutes: number; repetitions: number; ease: number }): number {
  const prev = Math.max(0, s.intervalMinutes);
  let next: number;
  if (d === "again") next = 10;
  else if (d === "hard") next = Math.max(DAY, Math.round((prev * 1.2) / DAY) * DAY);
  else if (d === "good") next = s.repetitions === 0 ? DAY : s.repetitions === 1 ? 3 * DAY : Math.max(1, Math.round((prev / DAY) * s.ease)) * DAY;
  else next = s.repetitions === 0 ? 4 * DAY : Math.max(4, Math.round((prev / DAY) * s.ease * 1.3)) * DAY;
  return Math.min(CAP, Math.round(next));
}

export function fmtInterval(min: number | null | undefined): string {
  if (min === null || min === undefined) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < DAY) return `${(min / 60).toFixed(1)} h`;
  const d = min / DAY;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? "" : "s"}`;
}

export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z").replace("Z", " UTC");
}

export function relDue(dueAt: string, serverNow: string): { label: string; overdue: boolean } {
  const diff = new Date(dueAt).getTime() - new Date(serverNow).getTime();
  const overdue = diff <= 0;
  const m = Math.abs(diff) / 60000;
  const txt = m < 60 ? `${Math.round(m)} min` : m < DAY ? `${(m / 60).toFixed(1)} h` : `${(m / DAY).toFixed(1)} d`;
  return { label: overdue ? `due ${txt} ago` : `in ${txt}`, overdue };
}
