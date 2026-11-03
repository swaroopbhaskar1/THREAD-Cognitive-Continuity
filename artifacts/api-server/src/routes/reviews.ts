import { Router } from "express";
import * as schemas from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { route, send, idOf, uuid } from "./thread";
import { Execution, transaction, idempotent, requireMission, type Client } from "../lib/execution";
import { HttpError } from "../lib/continuity";
import { attemptColumns, reviewColumns, reviewDetail, requireReview, ensureReview, nextReview } from "../lib/retrieval";
import { eventColumns } from "../lib/records";

const router = Router();
const queryId = (value: unknown, name = "cursor") => {
  if (value === undefined) return null;
  if (typeof value !== "string" || !uuid.test(value)) throw new HttpError(400, "INVALID_ID", `Invalid ${name}.`);
  return value;
};

router.get("/reviews", route("reviews.read", async (req, res, owner) => {
  const mission = queryId(req.query.missionId, "mission");
  const cursor = queryId(req.query.cursor);
  if (mission && !(await pool.query("SELECT id FROM missions WHERE id=$1 AND owner=$2", [mission, owner])).rows[0]) throw new HttpError(404, "NOT_FOUND", "Mission not found.");
  const after = cursor ? (await pool.query("SELECT due_at::text AS due_at,id FROM review_schedules WHERE id=$1 AND owner=$2 AND ($3::uuid IS NULL OR mission_id=$3)", [cursor, owner, mission])).rows[0] : null;
  if (cursor && !after) throw new HttpError(400, "INVALID_CURSOR", "Review cursor is no longer available.");
  const now = new Date().toISOString();
  const rows = (await pool.query(`SELECT ${reviewColumns} FROM review_schedules r JOIN missions m ON m.id=r.mission_id
    WHERE r.owner=$1 AND ($2::uuid IS NULL OR r.mission_id=$2)
      AND ($3::timestamptz IS NULL OR (r.due_at,r.id)>($3::timestamptz,$4::uuid))
    ORDER BY r.due_at,r.id LIMIT 51`, [owner, mission, after?.due_at ?? null, after?.id ?? null])).rows;
  const counts = (await pool.query(`SELECT
    COUNT(*) FILTER (WHERE due_at<=$3)::int AS overdue,
    COUNT(*) FILTER (WHERE due_at>$3)::int AS upcoming,
    (SELECT COUNT(*)::int FROM recall_attempts a JOIN review_schedules s ON s.id=a.review_id WHERE s.owner=$1 AND ($2::uuid IS NULL OR s.mission_id=$2) AND a.answered_at IS NOT NULL) AS answered,
    (SELECT COUNT(*)::int FROM recall_attempts a JOIN review_schedules s ON s.id=a.review_id WHERE s.owner=$1 AND ($2::uuid IS NULL OR s.mission_id=$2) AND a.rated_at IS NOT NULL) AS rated
    FROM review_schedules WHERE owner=$1 AND ($2::uuid IS NULL OR mission_id=$2)`, [owner, mission, now])).rows[0];
  send(res, schemas.ListReviewsResponse, { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null, serverNow: now, counts });
}));

router.post("/checkpoints/:id/review", route("review.enroll", async (req, res, owner) => {
  const checkpointId = idOf(req);
  const input = schemas.EnsureCheckpointReviewBody.parse(req.body);
  const result = await transaction(c => idempotent(c, owner, `review.enroll:${checkpointId}`, input.requestKey, input, async () => {
    const cp = (await c.query("SELECT cp.mission_id FROM checkpoints cp JOIN missions m ON m.id=cp.mission_id WHERE cp.id=$1 AND m.owner=$2", [checkpointId, owner])).rows[0];
    if (!cp) throw new HttpError(404, "NOT_FOUND", "Checkpoint not found.");
    await requireMission(c, owner, cp.mission_id);
    return ensureReview(c, owner, checkpointId, cp.mission_id);
  }));
  send(res, schemas.EnsureCheckpointReviewResponse, result);
}));
router.get("/reviews/:id", route("review.read", async (req, res, owner) => {
  const result = await transaction(c => reviewDetail(c, owner, idOf(req)));
  send(res, schemas.GetReviewResponse, result);
}));
router.post("/reviews/:id/start", route("review.start", async (req, res, owner) => {
  const id = idOf(req);
  const input = schemas.StartReviewBody.parse(req.body);
  const result = await transaction(c => idempotent(c, owner, `review.start:${id}`, input.requestKey, input, async () => {
    const review = await requireReview(c, owner, id);
    const x = new Execution(owner, "review.start", review.mission_id);
    await x.begin(c);
    const existing = (await c.query("SELECT id FROM recall_attempts WHERE review_id=$1 AND schedule_version=$2", [id, review.version])).rows[0];
    if (!existing) {
      const snapshot = await x.span("review.question.frozen", "database", "Read immutable learning reference and optionally validated AI question. Reference stays server-side until an answer commits.", async () => {
        const cp = (await c.query("SELECT * FROM checkpoints WHERE id=$1", [review.checkpoint_id])).rows[0];
        const ai = (await c.query("SELECT result FROM ai_jobs WHERE checkpoint_id=$1 AND status='succeeded' AND source='ai'", [review.checkpoint_id])).rows[0]?.result;
        return { question: ai?.retrievalQuestion.text ?? cp.recall_question, source: ai ? "ai" : "fallback",
          reference: { understanding: cp.understanding, questions: cp.questions, reasoning: cp.reasoning, notes: cp.notes, nextAction: cp.next_action, aiSummary: ai?.summary.text ?? null } };
      });
      await x.span("review.attempt.started", "database", "One frozen attempt per schedule version. No reference or earlier answer is returned before submission.", () =>
        c.query("INSERT INTO recall_attempts(review_id,schedule_version,question,question_source,reference,workflow_id) VALUES($1,$2,$3,$4,$5,$6)", [id, review.version, snapshot.question, snapshot.source, JSON.stringify(snapshot.reference), x.id]));
    } else {
      await x.span("review.attempt.reused", "server", "Existing attempt reused, including an answered-but-unrated attempt after refresh. No duplicate attempt.", async () => {});
    }
    await x.flush(c);
    return reviewDetail(c, owner, id);
  }));
  send(res, schemas.StartReviewResponse, result);
}));

async function ownedAttempt(c: Client, owner: string, id: string) {
  const initial = (await c.query("SELECT a.review_id FROM recall_attempts a JOIN review_schedules r ON r.id=a.review_id WHERE a.id=$1 AND r.owner=$2", [id, owner])).rows[0];
  if (!initial) throw new HttpError(404, "NOT_FOUND", "Recall attempt not found.");
  // Consistent lock order for answer, rating and concurrent review starts.
  const review = await requireReview(c, owner, initial.review_id);
  const attempt = (await c.query("SELECT * FROM recall_attempts WHERE id=$1 FOR UPDATE", [id])).rows[0];
  return { review, attempt };
}
router.post("/recall-attempts/:id/answer", route("review.answer", async (req, res, owner) => {
  const id = idOf(req);
  const input = schemas.SubmitRecallAnswerBody.parse(req.body);
  if (!input.answer.trim()) throw new HttpError(400, "ANSWER_REQUIRED", "Write what you remember before revealing the reference.");
  const result = await transaction(c => idempotent(c, owner, `review.answer:${id}`, input.requestKey, input, async () => {
    const { review, attempt } = await ownedAttempt(c, owner, id);
    if (attempt.answered_at && attempt.answer !== input.answer) throw new HttpError(409, "ANSWER_IMMUTABLE", "This answer is already recorded. It cannot be replaced.");
    if (!attempt.answered_at && review.version !== attempt.schedule_version) throw new HttpError(409, "REVIEW_CHANGED", "This review has advanced. Your text remains on this device; reload the review.");
    const x = new Execution(owner, "review.answer", review.mission_id);
    await x.begin(c);
    await x.span("review.answer.persisted", "database", "Answer committed before reference reveal. Answer text stays private and is not included in execution details.", () =>
      c.query("UPDATE recall_attempts SET answer=COALESCE(answer,$2),answered_at=COALESCE(answered_at,clock_timestamp()) WHERE id=$1", [id, input.answer]));
    await x.flush(c);
    return reviewDetail(c, owner, review.id, id);
  }));
  send(res, schemas.SubmitRecallAnswerResponse, result);
}));
router.post("/recall-attempts/:id/rating", route("review.rate", async (req, res, owner) => {
  const id = idOf(req);
  const input = schemas.RateRecallAttemptBody.parse(req.body);
  const result = await transaction(c => idempotent(c, owner, `review.rate:${id}`, input.requestKey, input, async () => {
    const { review, attempt } = await ownedAttempt(c, owner, id);
    if (!attempt.answered_at) throw new HttpError(409, "ANSWER_FIRST", "Submit your recall answer before assessing difficulty.");
    if (attempt.rated_at) {
      if (attempt.difficulty !== input.difficulty) throw new HttpError(409, "RATING_IMMUTABLE", "Your original difficulty is already recorded.");
      return reviewDetail(c, owner, review.id, id);
    }
    if (review.version !== attempt.schedule_version) throw new HttpError(409, "REVIEW_CHANGED", "Review changed in another session; refresh without discarding your recorded answer.");
    const x = new Execution(owner, "review.rate", review.mission_id);
    await x.begin(c);
    const now = (await c.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    const next = await x.span("review.schedule.computed", "server", `Transparent thread-spacing-v1 calculation from self-assessed ${input.difficulty}; not a correctness or mastery score.`, async () =>
      nextReview({ intervalMinutes: review.interval_minutes, repetitions: review.repetitions, lapses: review.lapses, ease: review.ease }, input.difficulty, now));
    await x.span("review.rating.persisted", "database", "Immutable self-rating and next interval saved atomically. Duplicate retries cannot advance the schedule twice.", async () => {
      await c.query(`UPDATE recall_attempts SET difficulty=$2,rated_at=$3,next_due_at=$4,interval_minutes=$5 WHERE id=$1`,
        [id, input.difficulty, now, next.dueAt, next.intervalMinutes]);
      await c.query(`UPDATE review_schedules SET due_at=$2,interval_minutes=$3,repetitions=$4,lapses=$5,ease=$6,version=version+1,last_reviewed_at=$7 WHERE id=$1`,
        [review.id, next.dueAt, next.intervalMinutes, next.repetitions, next.lapses, next.ease, now]);
    });
    await x.flush(c);
    return reviewDetail(c, owner, review.id, id);
  }));
  send(res, schemas.RateRecallAttemptResponse, result);
}));

router.get("/recall-history", route("review.history", async (req, res, owner) => {
  const id = queryId(req.query.reviewId, "review");
  if (!id) throw new HttpError(400, "REVIEW_REQUIRED", "Choose a review.");
  const cursor = queryId(req.query.cursor);
  if (!(await pool.query("SELECT id FROM review_schedules WHERE id=$1 AND owner=$2", [id, owner])).rows[0]) throw new HttpError(404, "NOT_FOUND", "Review not found.");
  const before = cursor ? (await pool.query("SELECT started_at::text AS started_at,id FROM recall_attempts WHERE id=$1 AND review_id=$2", [cursor, id])).rows[0] : null;
  if (cursor && !before) throw new HttpError(400, "INVALID_CURSOR", "Recall history cursor not available.");
  const rows = (await pool.query(`SELECT ${attemptColumns} FROM recall_attempts a WHERE a.review_id=$1
    AND ($2::timestamptz IS NULL OR (a.started_at,a.id)<($2::timestamptz,$3::uuid)) ORDER BY a.started_at DESC,a.id DESC LIMIT 51`,
    [id, before?.started_at ?? null, before?.id ?? null])).rows;
  send(res, schemas.ListRecallAttemptsResponse, { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null });
}));

router.get("/execution/history", route("execution.history", async (req, res, owner) => {
  const cursor = queryId(req.query.cursor);
  const before = cursor ? (await pool.query("SELECT e.created_at::text AS created_at,e.workflow_id,e.sequence FROM execution_events e JOIN workflows w ON w.id=e.workflow_id WHERE e.id=$1 AND w.owner=$2", [cursor, owner])).rows[0] : null;
  if (cursor && !before) throw new HttpError(400, "INVALID_CURSOR", "Execution history cursor not available.");
  const rows = (await pool.query(`SELECT e.id,e.workflow_id AS "workflowId",e.sequence,e.name,e.component,e.outcome,e.duration_ms AS "durationMs",
    e.created_at AS "createdAt",e.details,e.attempt,e.fallback,e.source_component AS "sourceComponent",e.destination_component AS "destinationComponent",
    w.operation FROM execution_events e JOIN workflows w ON w.id=e.workflow_id WHERE w.owner=$1
    AND ($2::timestamptz IS NULL OR (e.created_at,e.workflow_id,e.sequence)<($2::timestamptz,$3::uuid,$4::int))
    ORDER BY e.created_at DESC,e.workflow_id DESC,e.sequence DESC LIMIT 51`, [owner, before?.created_at ?? null, before?.workflow_id ?? null, before?.sequence ?? null])).rows;
  send(res, schemas.GetExecutionHistoryResponse, { items: rows.slice(0, 50).map(({ operation, ...event }) => ({ event, operation })), nextCursor: rows.length > 50 ? rows[49].id : null });
}));

export default router;
