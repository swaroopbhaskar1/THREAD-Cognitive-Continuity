import { Router, type Request, type Response } from "express";
import { performance } from "node:perf_hooks";
import { getAuth } from "@clerk/express";
import * as schemas from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { Execution, transaction, idempotent, requireMission, recordFailure } from "../lib/execution";
import { HttpError, fallbackQuestion, strategies } from "../lib/continuity";
import { missionColumns, draftColumns, checkpointColumns, workflowColumns, eventColumns, resumptionColumns } from "../lib/records";
import { streamExecution } from "../lib/event-stream";
import { enqueueIntelligence, jobColumns, wakeAIWorker } from "../lib/ai-jobs";
import { ensureReview } from "../lib/retrieval";

const router = Router();
router.get("/events/stream", (req, res) => {
  const owner = getAuth(req).userId;
  if (!owner) { res.status(401).json({ error: "Sign in to view execution events.", code: "UNAUTHORIZED" }); return; }
  streamExecution(req, res, owner);
});
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const idOf = (req: Request) => {
  const id = String(req.params.id ?? "");
  if (!uuid.test(id)) throw new HttpError(400, "INVALID_ID", "Invalid identifier.");
  return id;
};
type Parser = { parse: (value: unknown) => unknown };
export function send(res: Response, schema: Parser, data: unknown, status = 200) {
  // pg returns timestamptz as Date objects; validate their actual JSON wire representation.
  const wire = JSON.parse(JSON.stringify(data));
  let parsed;
  try { parsed = schema.parse(wire); }
  catch { throw new HttpError(500, "RESPONSE_CONTRACT_FAILED", "The operation completed but its response could not be verified. Retry using the same request key."); }
  res.status(status).json(parsed);
}
export function route(operation: string, handler: (req: Request, res: Response, owner: string) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    const owner = getAuth(req).userId;
    if (!owner) { res.status(401).json({ error: "Sign in to access your learning space.", code: "UNAUTHORIZED" }); return; }
    const started = performance.now();
    try {
      if (req.method !== "GET" && req.headers.origin) {
        const allowedHost = (req.headers["x-forwarded-host"] || req.headers.host)?.toString().split(",")[0]?.trim();
        if (new URL(req.headers.origin).host !== allowedHost) throw new HttpError(403, "ORIGIN_REJECTED", "Request origin was not allowed.");
      }
      await handler(req, res, owner);
    } catch (err) {
      const invalid = err && typeof err === "object" && "issues" in err;
      const status = err instanceof HttpError ? err.status : invalid ? 400 : 500;
      const code = err instanceof HttpError ? err.code : invalid ? "VALIDATION_FAILED" : "SERVER_ERROR";
      req.log.error({ code, operation }, "Workflow failed");
      // This cannot persist during an outage of the event database itself.
      await recordFailure(owner, operation, err, performance.now() - started).catch(() => req.log.error("Execution record unavailable"));
      res.status(status).json({ error: err instanceof HttpError ? err.message : invalid ? "Please check the submitted fields." : "Unable to save right now. Your local edits should be retained. Please retry.", code });
    }
  };
}

router.get("/missions", route("missions.list", async (_req, res, owner) => {
  const x = new Execution(owner, "missions.list", null);
  const data = await transaction(async c => {
    await x.begin(c);
    const r = await x.span("missions.read", "database", "Read owner-scoped missions and checkpoint counts; measured server-side database round trip.", () => c.query(`SELECT ${missionColumns} FROM missions m WHERE m.owner=$1 ORDER BY m.updated_at DESC`, [owner]));
    await x.flush(c);
    return r.rows;
  });
  send(res, schemas.ListMissionsResponse, data);
}));

router.post("/missions", route("mission.create", async (req, res, owner) => {
  const data = schemas.CreateMissionBody.parse(req.body);
  if (!data.title.trim()) throw new HttpError(400, "TITLE_REQUIRED", "Give your mission a title.");
  const result = await transaction(c => idempotent(c, owner, "mission.create", data.requestKey, data, async () => {
    const x = new Execution(owner, "mission.create", null);
    await x.begin(c);
    const r = await x.span("mission.persisted", "database", "Inserted mission and empty draft atomically; original content is not logged.", async () => {
      const inserted = await c.query("INSERT INTO missions(owner,title,subject,goal) VALUES($1,$2,$3,$4) RETURNING id", [owner, data.title.trim(), data.subject, data.goal]);
      const id = inserted.rows[0].id as string;
      await c.query("INSERT INTO drafts(mission_id) VALUES($1)", [id]);
      await c.query("UPDATE workflows SET mission_id=$2 WHERE id=$1", [x.id, id]);
      return (await c.query(`SELECT ${missionColumns} FROM missions m WHERE id=$1`, [id])).rows[0];
    });
    await x.flush(c);
    return r;
  }));
  send(res, schemas.CreateMissionResponse, result, 201);
}));

router.get("/missions/:id", route("mission.open", async (req, res, owner) => {
  const id = idOf(req);
  const x = new Execution(owner, "mission.open", id);
  const result = await transaction(async c => {
    await requireMission(c, owner, id);
    await x.begin(c);
    const data = await x.span("context.restored", "database", "Read mission, current draft, and immutable checkpoints. This is restoration, not a cognitive-performance measurement.", async () => ({
      mission: (await c.query(`SELECT ${missionColumns} FROM missions m WHERE id=$1`, [id])).rows[0],
      draft: (await c.query(`SELECT ${draftColumns} FROM drafts WHERE mission_id=$1`, [id])).rows[0],
      checkpoints: (await c.query(`SELECT ${checkpointColumns},
        COALESCE((SELECT j.status FROM ai_jobs j WHERE j.checkpoint_id=checkpoints.id),'not_requested') AS "enhancementStatus"
        FROM checkpoints WHERE mission_id=$1 ORDER BY created_at DESC`, [id])).rows,
    }));
    await x.flush(c);
    return data;
  });
  send(res, schemas.GetMissionResponse, result);
}));

router.put("/missions/:id/draft", route("draft.save", async (req, res, owner) => {
  const id = idOf(req);
  const data = schemas.SaveDraftBody.parse(req.body);
  const x = new Execution(owner, "draft.save", id);
  const result = await transaction(async c => {
    await requireMission(c, owner, id);
    await x.begin(c);
    const r = await x.span("draft.persisted", "database", `Version-checked draft write; ${data.notes.length} note characters. Timings exclude commit and event persistence.`, async () => {
      const update = await c.query(`UPDATE drafts SET notes=$2,understanding=$3,questions=$4,reasoning=$5,next_action=$6,
        version=version+1,saved_at=now() WHERE mission_id=$1 AND version=$7 RETURNING ${draftColumns}`,
      [id, data.notes, data.understanding, data.questions, data.reasoning, data.nextAction, data.version]);
      if (!update.rows[0]) {
        // A lost response can safely be retried if the exact content is already persisted.
        const current = (await c.query(`SELECT ${draftColumns} FROM drafts WHERE mission_id=$1`, [id])).rows[0];
        if (current && current.version === data.version + 1 &&
          ["notes", "understanding", "questions", "reasoning", "nextAction"].every(key => current[key] === data[key as keyof typeof data])) return current;
        throw new HttpError(409, "DRAFT_CONFLICT", "A newer draft exists. Keep your local copy before reloading the server version.");
      }
      await c.query("UPDATE missions SET updated_at=now() WHERE id=$1", [id]);
      return update.rows[0];
    });
    await x.flush(c);
    return r;
  });
  send(res, schemas.SaveDraftResponse, result);
}));

router.post("/missions/:id/checkpoints", route("checkpoint.create", async (req, res, owner) => {
  const id = idOf(req);
  const data = schemas.CreateCheckpointBody.parse(req.body);
  if (!data.nextAction.trim()) throw new HttpError(400, "NEXT_ACTION_REQUIRED", "Save one concrete next action so you can return to it.");
  const x = new Execution(owner, "checkpoint.create", id);
  // Snapshot, fallback, and idempotency response all commit BEFORE any adapter processing.
  const result = await transaction(c => idempotent(c, owner, `checkpoint.create:${id}`, data.requestKey, data, async () => {
    const mission = await requireMission(c, owner, id);
    await x.begin(c);
    const cp = await x.span("checkpoint.persisted", "database", `Immutable original notes, understanding, questions, reasoning, and next action. ${data.notes.length} note characters.`, async () => {
      const draft = (await c.query("SELECT version FROM drafts WHERE mission_id=$1", [id])).rows[0];
      if (draft.version !== data.version) throw new HttpError(409, "DRAFT_CONFLICT", "Draft version changed. Save your draft before creating a checkpoint.");
      await c.query(`UPDATE drafts SET notes=$2,understanding=$3,questions=$4,reasoning=$5,next_action=$6,version=version+1,saved_at=now() WHERE mission_id=$1`,
        [id, data.notes, data.understanding, data.questions, data.reasoning, data.nextAction.trim()]);
      const inserted = await c.query(`INSERT INTO checkpoints(mission_id,workflow_id,notes,understanding,questions,reasoning,next_action,recall_question)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${checkpointColumns}`, [
        id, x.id, data.notes, data.understanding, data.questions, data.reasoning, data.nextAction.trim(), fallbackQuestion(data.understanding, mission.subject),
      ]);
      await c.query("UPDATE missions SET updated_at=now() WHERE id=$1", [id]);
      return inserted.rows[0];
    }, true);
    await enqueueIntelligence(c, owner, cp.id, id, data.simulateFailure);
    await ensureReview(c, owner, cp.id, id);
    await x.flush(c, "saved");
    return cp;
  }));
  wakeAIWorker();
  send(res, schemas.CreateCheckpointResponse, result, 201);
}));

router.get("/checkpoints/:id/intelligence", route("intelligence.read", async (req, res, owner) => {
  const id = idOf(req);
  const cp = (await pool.query("SELECT cp.id FROM checkpoints cp JOIN missions m ON m.id=cp.mission_id WHERE cp.id=$1 AND m.owner=$2", [id, owner])).rows[0];
  if (!cp) throw new HttpError(404, "NOT_FOUND", "Checkpoint not found.");
  const job = (await pool.query(`SELECT ${jobColumns} FROM ai_jobs WHERE checkpoint_id=$1 AND owner=$2`, [id, owner])).rows[0];
  // Deliberately no execution event for observability reads; no recursive stream.
  send(res, schemas.GetCheckpointIntelligenceResponse, job ?? {
    jobId: null, checkpointId: id, workflowId: null, status: "not_requested", attempts: 0, maxAttempts: 3,
    nextAttemptAt: null, failureInjection: false, lastError: null, result: null, source: "fallback", updatedAt: null,
  });
}));
router.post("/checkpoints/:id/intelligence", route("intelligence.request", async (req, res, owner) => {
  const id = idOf(req);
  const body = schemas.RequestCheckpointIntelligenceBody.parse(req.body);
  const job = await transaction(async c => {
    const cp = (await c.query("SELECT cp.mission_id FROM checkpoints cp JOIN missions m ON m.id=cp.mission_id WHERE cp.id=$1 AND m.owner=$2", [id, owner])).rows[0];
    if (!cp) throw new HttpError(404, "NOT_FOUND", "Checkpoint not found.");
    await requireMission(c, owner, cp.mission_id);
    return enqueueIntelligence(c, owner, id, cp.mission_id, body.simulateFailure);
  });
  wakeAIWorker();
  send(res, schemas.RequestCheckpointIntelligenceResponse, job, 200);
}));

router.post("/missions/:id/resumptions", route("mission.resume", async (req, res, owner) => {
  const id = idOf(req);
  const data = schemas.StartResumptionBody.parse(req.body);
  const result = await transaction(c => idempotent(c, owner, `mission.resume:${id}`, data.requestKey, data, async () => {
    await requireMission(c, owner, id);
    const cp = (await c.query("SELECT id FROM checkpoints WHERE mission_id=$1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
    if (!cp) throw new HttpError(409, "NO_CHECKPOINT", "Create a checkpoint before resuming.");
    const x = new Execution(owner, "mission.resume", id);
    await x.begin(c);
    const r = await x.span("resumption.persisted", "database", `Resumption attempt saved; obstacle=${data.obstacle}; recall answer kept private.`, () => c.query(
      `INSERT INTO resumptions(mission_id,checkpoint_id,obstacle,recall_answer,strategy) VALUES($1,$2,$3,$4,$5) RETURNING ${resumptionColumns}`,
      [id, cp.id, data.obstacle, data.recallAnswer, strategies[data.obstacle]]));
    await x.flush(c);
    return r.rows[0];
  }));
  send(res, schemas.StartResumptionResponse, result, 201);
}));

router.post("/resumptions/:id/action", route("resumption.first_action", async (req, res, owner) => {
  const id = idOf(req);
  const result = await transaction(async c => {
    const row = (await c.query(`SELECT r.mission_id FROM resumptions r JOIN missions m ON m.id=r.mission_id WHERE r.id=$1 AND m.owner=$2 FOR UPDATE OF r`, [id, owner])).rows[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Resumption not found.");
    const x = new Execution(owner, "resumption.first_action", row.mission_id);
    await x.begin(c);
    const r = await x.span("first_action.recorded", "database", "Server elapsed wall-clock time from resumption to client-reported first editor input; includes network/idle time, not a cognitive-performance measure.", () => c.query(
      `UPDATE resumptions SET first_action_ms=COALESCE(first_action_ms,GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-started_at))*1000)) WHERE id=$1 RETURNING ${resumptionColumns}`, [id]));
    await x.flush(c);
    return r.rows[0];
  });
  send(res, schemas.RecordMeaningfulActionResponse, result);
}));

router.get("/workflows/:id", route("workflow.read", async (req, res, owner) => {
  const row = (await pool.query(`SELECT ${workflowColumns} FROM workflows WHERE id=$1 AND owner=$2`, [idOf(req), owner])).rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Workflow not found.");
  send(res, schemas.GetWorkflowResponse, row);
}));

router.get("/summary", route("activity.summary", async (_req, res, owner) => {
  const x = new Execution(owner, "activity.summary", null);
  const data = await transaction(async c => {
    await x.begin(c);
    const result = await x.span("activity.counted", "database", "Owner-scoped learning counts, not mastery estimates.", async () => {
      const counts = (await c.query(`SELECT
        (SELECT COUNT(*)::int FROM missions WHERE owner=$1) AS missions,
        (SELECT COUNT(*)::int FROM checkpoints cp JOIN missions m ON m.id=cp.mission_id WHERE m.owner=$1) AS checkpoints,
        (SELECT COUNT(*)::int FROM resumptions r JOIN missions m ON m.id=r.mission_id WHERE m.owner=$1) AS resumptions`, [owner])).rows[0];
      const recent = await c.query(`SELECT ${workflowColumns} FROM workflows WHERE owner=$1 AND operation NOT IN ('activity.summary','missions.list','mission.open') ORDER BY created_at DESC LIMIT 6`, [owner]);
      return { ...counts, recentActivity: recent.rows };
    });
    await x.flush(c);
    return result;
  });
  send(res, schemas.GetSummaryResponse, data);
}));

// Observability reads deliberately do not create more workflows; otherwise live polling observes itself indefinitely.
router.get("/workflows", route("execution.history", async (_req, res, owner) => {
  const r = await pool.query(`SELECT ${workflowColumns} FROM workflows WHERE owner=$1 ORDER BY created_at DESC LIMIT 100`, [owner]);
  send(res, schemas.ListWorkflowsResponse, r.rows);
}));
router.get("/workflows/:id/events", route("execution.events", async (req, res, owner) => {
  const id = idOf(req);
  const exists = await pool.query("SELECT id FROM workflows WHERE id=$1 AND owner=$2", [id, owner]);
  if (!exists.rows[0]) throw new HttpError(404, "NOT_FOUND", "Workflow not found.");
  const r = await pool.query(`SELECT ${eventColumns} FROM execution_events WHERE workflow_id=$1 ORDER BY sequence`, [id]);
  send(res, schemas.GetWorkflowEventsResponse, r.rows);
}));

export default router;
