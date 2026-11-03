import { Execution, type Client } from "./execution";
import { HttpError } from "./continuity";

export const ALGORITHM = "thread-spacing-v1";
type SpacingState = { intervalMinutes: number; repetitions: number; lapses: number; ease: number };
export type Difficulty = "again" | "hard" | "good" | "easy";
export function nextReview(state: SpacingState, difficulty: Difficulty, now: Date) {
  if (!["again", "hard", "good", "easy"].includes(difficulty) || !Number.isFinite(now.getTime()) ||
      !Number.isFinite(state.intervalMinutes) || state.intervalMinutes < 0 ||
      !Number.isFinite(state.ease) || state.ease < 1.3 || state.ease > 3 ||
      !Number.isInteger(state.repetitions) || state.repetitions < 0 || !Number.isInteger(state.lapses) || state.lapses < 0) throw new Error("Invalid spacing state");
  let days: number;
  let ease = state.ease;
  let repetitions = state.repetitions + 1;
  let lapses = state.lapses;
  if (difficulty === "again") { days = 10 / 1440; ease -= 0.2; repetitions = 0; lapses++; }
  else if (difficulty === "hard") { days = Math.max(1, Math.round(state.intervalMinutes / 1440 * 1.2)); ease -= 0.15; }
  else if (difficulty === "good") { days = state.repetitions === 0 ? 1 : state.repetitions === 1 ? 3 : Math.max(1, Math.round(state.intervalMinutes / 1440 * ease)); }
  else { days = state.repetitions === 0 ? 4 : Math.max(4, Math.round(state.intervalMinutes / 1440 * ease * 1.3)); ease += 0.15; }
  const intervalMinutes = Math.min(365 * 1440, Math.round(days * 1440));
  return { intervalMinutes, repetitions, lapses, ease: Math.round(Math.min(3, Math.max(1.3, ease)) * 100) / 100,
    dueAt: new Date(now.getTime() + intervalMinutes * 60000).toISOString(), algorithmVersion: ALGORITHM };
}
export const reviewColumns = `r.id,r.mission_id AS "missionId",m.title AS "missionTitle",r.checkpoint_id AS "checkpointId",
  (SELECT cp.created_at FROM checkpoints cp WHERE cp.id=r.checkpoint_id) AS "checkpointCreatedAt",
  (SELECT cp.next_action FROM checkpoints cp WHERE cp.id=r.checkpoint_id) AS "checkpointNextAction",
  r.due_at AS "dueAt",r.interval_minutes AS "intervalMinutes",r.repetitions,r.lapses,r.ease,r.version,
  r.last_reviewed_at AS "lastReviewedAt",r.algorithm_version AS "algorithmVersion",
  (SELECT COUNT(*)::int FROM recall_attempts a WHERE a.review_id=r.id AND a.answered_at IS NOT NULL) AS "answeredCount",
  (SELECT COUNT(*)::int FROM recall_attempts a WHERE a.review_id=r.id AND a.rated_at IS NOT NULL) AS "ratedCount"`;
export const attemptColumns = `a.id,a.review_id AS "reviewId",a.schedule_version AS "scheduleVersion",a.question,
  a.question_source AS "questionSource",a.answer,a.difficulty,
  CASE WHEN a.answered_at IS NOT NULL THEN a.reference ELSE NULL END AS reference,
  a.started_at AS "startedAt",a.answered_at AS "answeredAt",a.rated_at AS "ratedAt",a.next_due_at AS "nextDueAt",
  a.interval_minutes AS "intervalMinutes",a.algorithm_version AS "algorithmVersion",a.workflow_id AS "workflowId"`;
export async function requireReview(c: Client, owner: string, id: string) {
  const row = (await c.query("SELECT * FROM review_schedules WHERE id=$1 AND owner=$2 FOR UPDATE", [id, owner])).rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Review not found.");
  return row;
}
export async function reviewDetail(c: Client, owner: string, id: string, attemptId?: string) {
  const schedule = (await c.query(`SELECT ${reviewColumns} FROM review_schedules r JOIN missions m ON m.id=r.mission_id WHERE r.id=$1 AND r.owner=$2`, [id, owner])).rows[0];
  if (!schedule) throw new HttpError(404, "NOT_FOUND", "Review not found.");
  const session = (await c.query(`SELECT ${attemptColumns} FROM recall_attempts a WHERE a.review_id=$1 ${attemptId ? "AND a.id=$2" : ""}
    ORDER BY a.schedule_version DESC LIMIT 1`, attemptId ? [id, attemptId] : [id])).rows[0] ?? null;
  return { schedule, session, serverNow: new Date().toISOString() };
}
export async function ensureReview(c: Client, owner: string, checkpointId: string, missionId: string) {
  const existing = (await c.query("SELECT id FROM review_schedules WHERE checkpoint_id=$1 AND owner=$2", [checkpointId, owner])).rows[0];
  if (existing) return (await reviewDetail(c, owner, existing.id)).schedule;
  const x = new Execution(owner, "review.schedule", missionId);
  await x.begin(c);
  const row = await x.span("review.schedule.created", "database", "One review per immutable checkpoint. Initial due time is 24 hours from scheduling; no inferred mastery.", () =>
    c.query("INSERT INTO review_schedules(checkpoint_id,mission_id,owner,due_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day') RETURNING id", [checkpointId, missionId, owner]));
  await x.flush(c);
  return (await reviewDetail(c, owner, row.rows[0].id)).schedule;
}
