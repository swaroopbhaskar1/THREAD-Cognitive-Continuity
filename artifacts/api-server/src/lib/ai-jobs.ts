import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool } from "@workspace/db";
import { reserveAICall } from "./limits";
import { Execution, transaction, type Client } from "./execution";
import { AIError, deterministicResult, fields, requestIntelligence, validateIntelligence, type LearningContent, type ProviderOptions } from "./ai-content";
import { logger } from "./logger";
import { noteSignal, workerHeartbeat } from "./operational-signals";
import { createDemandWorker } from "./demand-worker";

export const jobColumns = `id AS "jobId",checkpoint_id AS "checkpointId",workflow_id AS "workflowId",status,
  attempts,max_attempts AS "maxAttempts",available_at AS "nextAttemptAt",failure_injection AS "failureInjection",
  last_error AS "lastError",result,source,updated_at AS "updatedAt"`;

export async function enqueueIntelligence(c: Client, owner: string, checkpointId: string, missionId: string, injection: boolean) {
  // Caller holds the mission lock. The unique checkpoint constraint is the final safety net.
  const existing = await c.query(`SELECT ${jobColumns} FROM ai_jobs WHERE checkpoint_id=$1`, [checkpointId]);
  if (existing.rows[0]) return existing.rows[0];
  const x = new Execution(owner, "ai.enhance", missionId);
  await x.begin(c);
  const job = await x.span("ai.job.queued", "database", "Durable enhancement job queued in the checkpoint transaction. Originals remain immutable. Up to 3 attempts; external-call timeout 20 seconds.", async () =>
    (await c.query(`INSERT INTO ai_jobs(checkpoint_id,owner,workflow_id,failure_injection,queue) VALUES($1,$2,$3,$4,$5) RETURNING ${jobColumns}`, [checkpointId, owner, x.id, injection, process.env.THREAD_AI_QUEUE ?? "continuity"])).rows[0]);
  await x.flush(c, "queued");
  return job;
}
export type WorkerOptions = {
  jobId?: string;
  leaseMs?: number;
  retryBaseMs?: number;
  providerOptions?: ProviderOptions;
  provider?: (source: LearningContent) => Promise<unknown>;
};
async function claim(options: WorkerOptions) {
  return transaction(async c => {
    const row = (await c.query(`SELECT * FROM ai_jobs WHERE
      queue=$2 AND ($1::uuid IS NULL OR id=$1) AND (
        (status IN ('queued','retry_wait') AND available_at<=now()) OR
        (status='running' AND lease_until<now()))
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [options.jobId ?? null, process.env.THREAD_AI_QUEUE ?? "continuity"])).rows[0];
    if (!row) return null;
    const cp = (await c.query("SELECT * FROM checkpoints WHERE id=$1", [row.checkpoint_id])).rows[0];
    const x = new Execution(row.owner, "ai.enhance", cp.mission_id);
    x.id = row.workflow_id;
    x.durationBaseMs = Number((await c.query("SELECT duration_ms FROM workflows WHERE id=$1", [x.id])).rows[0].duration_ms);
    x.attempt = Math.min(row.attempts + 1, row.max_attempts);
    if (row.status === "running") {
      await x.span("ai.worker.interrupted", "server", "Expired worker lease recovered. Prior dispatch may have reached the provider; its outcome and unfinished duration are unknown. Original checkpoint is safe; remote calls are at-least-once.", async () => {});
    }
    const token = randomUUID();
    const updated = await x.span("ai.job.claimed", "database", "Claimed due job using row lock and unique lease token; stale workers cannot finalize results.", () =>
      c.query(`UPDATE ai_jobs SET status='running',attempts=LEAST(attempts+1,max_attempts),lease_token=$2,
        lease_until=now()+($3*interval '1 millisecond'),updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, token, options.leaseMs ?? 45000]));
    await x.flush(c, "running");
    return { job: updated.rows[0], cp, x, exhausted: row.attempts >= row.max_attempts };
  });
}

export async function runOneAIJob(options: WorkerOptions = {}): Promise<boolean> {
  const claimed = await claim(options);
  if (!claimed) return false;
  const { job, cp, x } = claimed;
  const source: LearningContent = { notes: cp.notes, understanding: cp.understanding, questions: cp.questions, reasoning: cp.reasoning, nextAction: cp.next_action };
  let result: ReturnType<typeof deterministicResult> | null = null;
  let failure: AIError | null = null;
  if (claimed.exhausted) failure = new AIError("INTERRUPTED_ATTEMPTS_EXHAUSTED", false);
  else {
    try {
      if (job.failure_injection) {
        await x.span("ai.failure_injection", "ai", "FAILURE INJECTION: deliberate local provider-adapter rejection. No external request sent; not a provider failure.", async () => { throw new AIError("INJECTED_PROVIDER_FAILURE"); });
      } else {
        if (fields.map(f => source[f]).join("").trim().length < 30) throw new AIError("INSUFFICIENT_CONTENT", false);
        if (!options.provider && !options.providerOptions?.baseURL && (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY)) throw new AIError("PROVIDER_NOT_CONFIGURED", false);
        await x.span("ai.budget.reserved", "database", "Durable shared admission: at most 60 reserved provider calls per owner and 600 globally per fixed 24-hour window. Retries consume budget; local failure injection does not. A reservation is not proof of an external call.", async () => {
          if (!await reserveAICall(job.owner)) throw new AIError("AI_BUDGET_EXHAUSTED", false);
        });
        await x.span("ai.call.dispatch_intent", "ai", "Persisted dispatch intent for a real server-side OpenAI gpt-5.4-mini call via Replit AI Integrations. A completion/failure event confirms the measured result; interruption leaves receipt unknown.", async () => {});
        await transaction(async c => {
          const live = await c.query("SELECT id FROM ai_jobs WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE", [job.id, job.lease_token]);
          if (!live.rows[0]) throw new AIError("LEASE_LOST", false);
          await x.flush(c, "calling_provider");
        });
        const raw = await x.span("ai.external_call", "ai", "Actual external request wall time, including network and response body. No implicit SDK retries. Provider payload is not logged.", () =>
          options.provider ? options.provider(source) : requestIntelligence(source, options.providerOptions));
        result = await x.span("ai.response.validated", "server", "Strict schema, exact source citations, topic overlap, retrieval-question and concrete-action checks passed. Grounding checks are not proof of factual correctness.", async () => validateIntelligence(raw, source), false, { source: "ai", destination: "server" });
      }
    } catch (err) { failure = err instanceof AIError ? err : new AIError("WORKER_ERROR"); }
  }
  await transaction(async c => {
    const locked = (await c.query("SELECT * FROM ai_jobs WHERE id=$1 FOR UPDATE", [job.id])).rows[0];
    if (!locked) return;
    if (locked.lease_token !== job.lease_token || locked.status !== "running") {
      await x.span("ai.stale_result.discarded", "server", "Lease ownership changed. Late call outcomes are recorded but cannot replace the recovered worker's result.", async () => {});
      const current = (await c.query("SELECT status,duration_ms FROM workflows WHERE id=$1", [x.id])).rows[0];
      x.durationBaseMs = current.duration_ms;
      await x.flush(c, current.status);
      return;
    }
    if (result) {
      await x.span("ai.enhancement.persisted", "database", "Validated enhancement stored separately; no UPDATE to checkpoint originals or working draft.", () =>
        c.query("UPDATE ai_jobs SET status='succeeded',source='ai',result=$2,last_error=NULL,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1",
          [job.id, JSON.stringify(result)]));
      await x.flush(c, "success");
    } else {
      const error = failure ?? new AIError("NO_RESULT");
      // Error codes only; never persist source content or raw provider bodies in events.
      await x.span("ai.attempt.failed", "server", `Attempt ${job.attempts}/${job.max_attempts}; code=${error.code}. Original work unchanged.`, async () => {});
      x.events[x.events.length - 1].outcome = "failure";
      if (error.retryable && job.attempts < job.max_attempts) {
        const delay = (options.retryBaseMs ?? 2000) * 2 ** (job.attempts - 1);
        await x.span("ai.retry.scheduled", "database", `Retry due after ${delay} ms of scheduling backoff; this is NOT provider execution time.`, () =>
          c.query("UPDATE ai_jobs SET status='retry_wait',last_error=$2,available_at=now()+($3*interval '1 millisecond'),lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1", [job.id, error.code, delay]));
        await x.flush(c, "retry_wait");
      } else {
        const fallback = deterministicResult(source, cp.recall_question);
        await x.span("ai.fallback.persisted", "database", `Explicit deterministic fallback after ${job.attempts} claimed attempt(s); code=${error.code}. Extracted saved understanding and original next action, not fabricated AI.`, () =>
          c.query("UPDATE ai_jobs SET status='fallback',source='fallback',result=$2,last_error=$3,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1", [job.id, JSON.stringify(fallback), error.code]), true);
        await x.flush(c, "fallback");
      }
    }
  });
  return true;
}

export async function nextAIJobDelay(options: WorkerOptions = {}): Promise<number | null> {
  // Use the database clock, not Node's clock, for durable deadlines.
  // PostgreSQL GREATEST ignores NULL: without the explicit empty-set guard,
  // MIN on no jobs would become zero and accidentally arm an endless timer.
  const result = await pool.query(`SELECT CASE WHEN COUNT(*)=0 THEN NULL ELSE
    GREATEST(0,EXTRACT(EPOCH FROM (MIN(CASE WHEN status='running' THEN lease_until ELSE available_at END)-now()))*1000)::float END AS delay
    FROM ai_jobs WHERE queue=$1 AND ($2::uuid IS NULL OR id=$2)
      AND status IN ('queued','retry_wait','running')`,
  [process.env.THREAD_AI_QUEUE ?? "continuity", options.jobId ?? null]);
  return result.rows[0].delay === null ? null : Number(result.rows[0].delay);
}

export function createAIWorker(options: WorkerOptions = {}) {
  return createDemandWorker({
    runOne: async () => {
      workerHeartbeat();
      return runOneAIJob(options);
    },
    nextDelay: () => nextAIJobDelay(options),
    onIdle: () => logger.info("AI worker idle; no queue timer or recurring database queries"),
    onError: () => {
      noteSignal("worker_failure");
      logger.error("AI worker database path failed; bounded reconnect backoff scheduled, durable jobs retained");
    },
  });
}

let activeWorker: ReturnType<typeof createAIWorker> | undefined;
// Only after a successful business COMMIT. A process death before this signal
// is recovered by startup reconciliation; one VM is the only producer.
export function wakeAIWorker() { activeWorker?.wake(); }

export function startAIWorker() {
  if (activeWorker) throw new Error("AI_WORKER_ALREADY_STARTED");
  const worker = createAIWorker();
  activeWorker = worker;
  worker.start();
  return () => {
    worker.stop();
    if (activeWorker === worker) activeWorker = undefined;
  };
}
