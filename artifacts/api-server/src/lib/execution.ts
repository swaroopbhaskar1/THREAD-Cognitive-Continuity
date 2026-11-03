import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool, type PoolClient } from "@workspace/db";
import { HttpError, requestHash } from "./continuity";
import { logger } from "./logger";
import { noteSignal } from "./operational-signals";

export type Client = PoolClient;
type Flow = { source: string; destination: string };
type Event = { name: string; component: string; outcome: string; durationMs: number; details: string; fallback?: boolean; createdAt: string; attempt?: number; flow?: Flow };
const transactionWorkflows = new WeakMap<Client, Map<string, { owner: string; attempt: number }>>();

export class Execution {
  id = randomUUID();
  started = performance.now();
  events: Event[] = [];
  attempt = 1;
  durationBaseMs = 0;
  constructor(public owner: string, public operation: string, public missionId: string | null) {}
  async span<T>(name: string, component: string, details: string, action: () => Promise<T>, fallback = false, flow: Flow = { source: "server", destination: component }): Promise<T> {
    const start = performance.now();
    try {
      const value = await action();
      this.events.push({ name, component, details, outcome: "success", durationMs: performance.now() - start, fallback, createdAt: new Date().toISOString(), flow });
      return value;
    } catch (error) {
      this.events.push({ name, component, details: error instanceof HttpError ? error.message : `${details}; operation failed`, outcome: "failure", durationMs: performance.now() - start, fallback, createdAt: new Date().toISOString(), flow });
      throw error;
    }
  }
  async begin(c: Client) {
    await this.span("workflow.started", "server", "Server registered an authenticated browser API operation. No client/network latency is inferred.",
      () => c.query("INSERT INTO workflows(id,owner,mission_id,operation) VALUES($1,$2,$3,$4)", [this.id, this.owner, this.missionId, this.operation]), false, { source: "browser", destination: "server" });
  }
  async flush(c: Client, status = "success") {
    const persistenceStarted = performance.now();
    transactionWorkflows.get(c)?.set(this.id, { owner: this.owner, attempt: this.attempt });
    await c.query("SELECT id FROM workflows WHERE id=$1 FOR UPDATE", [this.id]);
    const result = await c.query("SELECT COALESCE(MAX(sequence),0)::int AS seq FROM execution_events WHERE workflow_id=$1", [this.id]);
    let seq = result.rows[0].seq as number;
    for (const e of this.events) {
      await c.query(`INSERT INTO execution_events(workflow_id,sequence,name,component,outcome,duration_ms,details,fallback,created_at,attempt,source_component,destination_component)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [this.id, ++seq, e.name, e.component, e.outcome, e.durationMs, e.details, e.fallback ?? false, e.createdAt, e.attempt ?? this.attempt, e.flow?.source ?? "server", e.flow?.destination ?? e.component]);
    }
    this.events = [];
    await c.query("UPDATE workflows SET status=$2,duration_ms=$3 WHERE id=$1", [this.id, status, this.durationBaseMs + performance.now() - this.started]);
    // Lock before allocating the sequence and hold through commit. Without this,
    // a later cursor could commit before an earlier one and be skipped on reconnect.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`thread-stream:${this.owner}`]);
    await c.query("INSERT INTO execution_updates(owner,workflow_id) VALUES($1,$2)", [this.owner, this.id]);
    // PostgreSQL sends NOTIFY only after COMMIT; it is a wake-up, never the source of truth.
    await c.query("SELECT pg_notify('thread_execution', $1)", [this.owner]);
    const measuredMs = performance.now() - persistenceStarted;
    await c.query(`INSERT INTO execution_events(workflow_id,sequence,name,component,outcome,duration_ms,details,attempt,source_component,destination_component)
      VALUES($1,$2,'execution.batch.persisted','database','success',$3,$4,$5,'server','database')`,
    [this.id, ++seq, measuredMs, "Measured event-batch, workflow, and SSE-outbox database writes before COMMIT; excludes this final monitor row. Telemetry does not recursively measure itself.", this.attempt]);
  }
}

async function persistCommitAcknowledgment(c: Client, workflows: Map<string, { owner: string; attempt: number }>, measuredMs: number, at: string) {
  if (!workflows.size) return;
  try {
    await c.query("BEGIN");
    for (const [id, { owner, attempt }] of [...workflows].sort(([a], [b]) => a.localeCompare(b))) {
      await c.query("SELECT id FROM workflows WHERE id=$1 FOR UPDATE", [id]);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`thread-stream:${owner}`]);
      await c.query(`INSERT INTO execution_events(workflow_id,sequence,name,component,outcome,duration_ms,details,attempt,created_at,source_component,destination_component)
        SELECT $1,COALESCE(MAX(sequence),0)+1,'transaction.commit.confirmed','database','success',$2,$3,$4,$5,'server','database'
        FROM execution_events WHERE workflow_id=$1`, [id, measuredMs,
        "Actual PostgreSQL COMMIT round-trip acknowledgment. May be shared by workflows committed together; do not sum shared commit timings. Separate from measured processing totals. Telemetry's own commit is not recursively instrumented.", attempt, at]);
      await c.query("INSERT INTO execution_updates(owner,workflow_id) VALUES($1,$2)", [owner, id]);
      await c.query("SELECT pg_notify('thread_execution',$1)", [owner]);
    }
    await c.query("COMMIT");
  } catch {
    noteSignal("commit_ack_failure");
    await c.query("ROLLBACK").catch(() => {});
    logger.warn("Business transaction committed; its separate commit acknowledgment could not be persisted");
  }
}

export async function transaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const connectionError = () => { logger.error("Checked-out database connection interrupted; transaction recovery is required"); };
  c.on("error", connectionError);
  const workflows = new Map<string, { owner: string; attempt: number }>();
  transactionWorkflows.set(c, workflows);
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    const commitStarted = performance.now();
    await c.query("COMMIT");
    const commitMs = performance.now() - commitStarted;
    transactionWorkflows.delete(c);
    await persistCommitAcknowledgment(c, workflows, commitMs, new Date().toISOString());
    return value;
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    if (/^[0-9A-Z]{5}$/.test(code) || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(code)) noteSignal("database_write_failure");
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    transactionWorkflows.delete(c);
    c.off("error", connectionError);
    c.release();
  }
}

export async function idempotent<T>(c: Client, owner: string, operation: string, key: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  // Serializes duplicate in-flight requests across server instances, not only in memory.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${owner}:${operation}:${key}`]);
  const hash = requestHash(input);
  const prior = await c.query("SELECT hash,response FROM request_records WHERE owner=$1 AND operation=$2 AND key=$3", [owner, operation, key]);
  if (prior.rows[0]) {
    if (prior.rows[0].hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This request key was already used with different content.");
    const attempt = await c.query("UPDATE request_records SET attempt_count=attempt_count+1 WHERE owner=$1 AND operation=$2 AND key=$3 RETURNING attempt_count", [owner, operation, key]);
    const replay = new Execution(owner, `${operation.split(":")[0]}.retry`, null);
    await replay.begin(c);
    replay.events.push({
      name: "request.idempotency.replayed", component: "database", outcome: "success",
      durationMs: performance.now() - start, details: "Existing committed response returned after advisory lock and lookup; no duplicate learning record created.",
      createdAt: new Date().toISOString(), attempt: attempt.rows[0].attempt_count,
    });
    await replay.flush(c);
    return prior.rows[0].response as T;
  }
  const value = await fn();
  const latest = [...(transactionWorkflows.get(c)?.entries() ?? [])].at(-1);
  if (latest) {
    // The business workflow already holds its event/owner locks. The receipt
    // shares its transaction and durable outbox notification.
    const receiptStarted = performance.now();
    await c.query("INSERT INTO request_records(owner,operation,key,hash,response) VALUES($1,$2,$3,$4,$5)", [owner, operation, key, hash, JSON.stringify(value)]);
    const receiptMs = performance.now() - receiptStarted;
    await c.query(`INSERT INTO execution_events(workflow_id,sequence,name,component,outcome,duration_ms,details,attempt,source_component,destination_component)
      SELECT $1,COALESCE(MAX(sequence),0)+1,'request.receipt.persisted','database','success',$2,$3,$4,'server','database'
      FROM execution_events WHERE workflow_id=$1`, [latest[0], receiptMs,
      "Actual database write of the idempotent response receipt, atomic with learning changes. Payload and request key are kept private.", latest[1].attempt]);
    await c.query("UPDATE workflows SET duration_ms=duration_ms+$2 WHERE id=$1", [latest[0], receiptMs]);
  } else {
    const x = new Execution(owner, "request.receipt", null);
    await x.begin(c);
    await x.span("request.receipt.persisted", "database", "Recorded an idempotent response for an already-existing result; no learning content changed.", () =>
      c.query("INSERT INTO request_records(owner,operation,key,hash,response) VALUES($1,$2,$3,$4,$5)", [owner, operation, key, hash, JSON.stringify(value)]));
    await x.flush(c);
  }
  return value;
}

export async function requireMission(c: Client, owner: string, id: string) {
  const result = await c.query("SELECT * FROM missions WHERE id=$1 AND owner=$2 FOR UPDATE", [id, owner]);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Mission not found.");
  return result.rows[0];
}

export async function recordFailure(owner: string, operation: string, error: unknown, elapsedMs: number) {
  const x = new Execution(owner, operation, null);
  await transaction(async c => {
    await x.begin(c);
    x.events.push({
      name: "request.rejected", component: "server", outcome: "failure",
      durationMs: elapsedMs, createdAt: new Date().toISOString(),
      details: `Measured authenticated request processing time before failure. Code: ${error instanceof HttpError ? error.code : "VALIDATION_OR_SERVER_ERROR"}. Rolled-back operations are not reported as persisted successes.`,
    });
    await x.flush(c, "failure");
  });
}
