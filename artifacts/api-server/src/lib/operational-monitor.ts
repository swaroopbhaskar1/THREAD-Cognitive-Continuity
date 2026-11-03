import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool } from "@workspace/db";
import { transaction } from "./execution";
import { consumeLimit } from "./limits";
import { logger } from "./logger";
import { signalCount, workerLastSeen } from "./operational-signals";
import { DeliveryError, mailConfigured, sendOperationalMail, type AlertPayload, type AlertTransport } from "./operational-mail";

export type Snapshot = {
  queueAgeSeconds: number; expiredLeases: number; retries: number; fallbacks: number;
  budgetExhaustions: number; missingCommits: number; workerAgeSeconds: number;
  databaseWrites: number; serverErrors: number; sseFailures: number; clientSseFailures: number;
  commitFailures: number; workerFailures: number;
};
const loadedAt = Date.now();
export const RULES = {
  QUEUE_DELAY: ["warning", 120, "queueAgeSeconds"],
  EXPIRED_LEASE: ["warning", 1, "expiredLeases"],
  AI_RETRY_SPIKE: ["warning", 5, "retries"],
  AI_FALLBACK_SPIKE: ["warning", 3, "fallbacks"],
  AI_BUDGET_EXHAUSTED: ["warning", 1, "budgetExhaustions"],
  COMMIT_ACK_MISSING: ["critical", 1, "missingCommits"],
  WORKER_HEARTBEAT_STALE: ["critical", 90, "workerAgeSeconds"],
  DATABASE_WRITE_FAILURE: ["critical", 3, "databaseWrites"],
  SERVER_ERROR_SPIKE: ["critical", 3, "serverErrors"],
  SSE_SERVER_FAILURE: ["warning", 3, "sseFailures"],
  SSE_CLIENT_REPORTED_FAILURE: ["warning", 1, "clientSseFailures"],
  COMMIT_ACK_FAILURE: ["critical", 1, "commitFailures"],
  WORKER_ERROR_SPIKE: ["warning", 3, "workerFailures"],
} as const;
export type Condition = { code: string; severity: string; observed: number; threshold: number };
export function evaluate(snapshot: Snapshot): Condition[] {
  return Object.entries(RULES).flatMap(([code, [severity, threshold, field]]) =>
    snapshot[field] >= threshold ? [{ code, severity, observed: snapshot[field], threshold }] : []);
}

export async function collectSnapshot(queue: string): Promise<Snapshot> {
  const r = await pool.query(`SELECT
    COALESCE(MAX(EXTRACT(EPOCH FROM now()-created_at)) FILTER(WHERE status IN ('queued','retry_wait')),0)::float AS age,
    COUNT(*) FILTER(WHERE status='running' AND lease_until<now())::int AS expired,
    COUNT(*) FILTER(WHERE status='fallback' AND updated_at>now()-interval '5 minutes')::int AS fallbacks,
    COUNT(*) FILTER(WHERE last_error='AI_BUDGET_EXHAUSTED' AND updated_at>now()-interval '5 minutes')::int AS budgets
    FROM ai_jobs WHERE queue=$1`, [queue]);
  const e = await pool.query(`SELECT
    COUNT(*) FILTER(WHERE e.name='ai.retry.scheduled' AND e.created_at>now()-interval '5 minutes')::int AS retries
    FROM execution_events e JOIN ai_jobs j ON j.workflow_id=e.workflow_id WHERE j.queue=$1`, [queue]);
  const m = await pool.query(`SELECT COUNT(*)::int AS missing FROM execution_events b
    WHERE b.name='execution.batch.persisted' AND b.created_at<now()-interval '30 seconds'
    AND b.created_at>now()-interval '1 day' AND NOT EXISTS(
      SELECT 1 FROM execution_events a WHERE a.workflow_id=b.workflow_id
      AND a.name='transaction.commit.confirmed' AND a.sequence>b.sequence)`);
  const now = Date.now(), seen = workerLastSeen();
  return {
    queueAgeSeconds: Math.max(0, Number(r.rows[0].age)), expiredLeases: r.rows[0].expired,
    fallbacks: r.rows[0].fallbacks, budgetExhaustions: r.rows[0].budgets, retries: e.rows[0].retries,
    missingCommits: m.rows[0].missing, workerAgeSeconds: (now - (seen || loadedAt)) / 1000,
    databaseWrites: signalCount("database_write_failure"), serverErrors: signalCount("server_error"),
    sseFailures: signalCount("sse_failure"), clientSseFailures: signalCount("client_sse_failure"),
    commitFailures: signalCount("commit_ack_failure"), workerFailures: signalCount("worker_failure"),
  };
}

// Only static, aggregate rule data enters email payloads. No owner IDs, notes or error strings.
export async function reconcileAlerts(scope: string, conditions: Condition[], observations: Record<string, number> = {}) {
  await transaction(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operations:${scope}`]);
    const open = (await c.query("SELECT * FROM operational_alerts WHERE scope=$1 AND resolved_at IS NULL FOR UPDATE", [scope])).rows;
    const environment = process.env.NODE_ENV === "production" ? "production" : "development";
    const queue = async (alertId: string, condition: Omit<Condition, "observed"> & { observed: number | null }, state: AlertPayload["state"]) => {
      const payload: AlertPayload = { ...condition, state, observedAt: new Date().toISOString(), environment };
      await c.query("INSERT INTO operational_deliveries(alert_id,payload) VALUES($1,$2)", [alertId, JSON.stringify(payload)]);
      logger.warn({ code: condition.code, state, severity: condition.severity }, "Operational incident transition; see durable alert outbox");
    };
    for (const condition of conditions) {
      const prior = open.find(a => a.code === condition.code);
      if (prior) await c.query("UPDATE operational_alerts SET observed=$2,last_seen_at=now() WHERE id=$1", [prior.id, condition.observed]);
      else {
        const alert = (await c.query(`INSERT INTO operational_alerts(scope,code,severity,observed,threshold)
          VALUES($1,$2,$3,$4,$5) RETURNING id`, [scope, condition.code, condition.severity, condition.observed, condition.threshold])).rows[0];
        await queue(alert.id, condition, "triggered");
      }
    }
    for (const prior of open.filter(a => !conditions.some(c => c.code === a.code))) {
      await c.query("UPDATE operational_alerts SET resolved_at=now(),last_seen_at=now() WHERE id=$1", [prior.id]);
      await queue(prior.id, { code: prior.code, severity: prior.severity, observed: observations[prior.code] ?? null, threshold: prior.threshold }, "recovered");
    }
  });
}

export async function deliverOne(scope: string, transport?: AlertTransport): Promise<boolean> {
  const claim = await transaction(async c => {
    const r = await c.query(`SELECT d.* FROM operational_deliveries d JOIN operational_alerts a ON a.id=d.alert_id
      WHERE a.scope=$1 AND ((d.state IN ('pending','blocked') AND d.available_at<=now())
      OR (d.state='sending' AND d.lease_until<now())) ORDER BY d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`, [scope]);
    const row = r.rows[0]; if (!row) return null;
    if (row.attempts >= 5) {
      await c.query("UPDATE operational_deliveries SET state='failed',last_error='DELIVERY_ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE id=$1", [row.id]);
      return null;
    }
    if (!transport && !mailConfigured()) {
      await c.query("UPDATE operational_deliveries SET state='blocked',last_error='DESTINATION_UNCONFIGURED',available_at=now()+interval '1 minute' WHERE id=$1", [row.id]);
      return null;
    }
    // Test transports must never spend the real notification allowance.
    const budget = await consumeLimit(c, transport ? "operations-email-test" : "operations-email", transport ? scope : "global", 50, 86400);
    if (!budget.allowed) {
      await c.query("UPDATE operational_deliveries SET state='blocked',last_error='EMAIL_BUDGET_EXHAUSTED',available_at=now()+($2*interval '1 second') WHERE id=$1", [row.id, budget.retryAfter]);
      return null;
    }
    const token = randomUUID();
    await c.query("UPDATE operational_deliveries SET state='sending',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1", [row.id, token]);
    return { ...row, token, attempts: row.attempts + 1 };
  });
  if (!claim) return false;
  const started = performance.now();
  try {
    const receipt = await (transport ?? sendOperationalMail)(claim.id, claim.payload);
    await pool.query(`UPDATE operational_deliveries SET state='provider_accepted',provider_id=$3,accepted_at=now(),
      duration_ms=$4,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
    [claim.id, claim.token, receipt.providerId, performance.now() - started]);
  } catch (error) {
    const safe = error instanceof DeliveryError ? error : new DeliveryError("EMAIL_TRANSPORT_INTERRUPTED", true);
    await pool.query(`UPDATE operational_deliveries SET state=$3,last_error=$4,duration_ms=$5,
      available_at=now()+($6*interval '1 second'),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
    [claim.id, claim.token, safe.retryable && claim.attempts < 5 ? "pending" : "failed", safe.code, performance.now() - started, Math.min(300, 15 * 2 ** (claim.attempts - 1))]);
  }
  return true;
}

export function startOperationalMonitor() {
  if (process.env.THREAD_MONITOR_ENABLED !== "true") return () => {};
  let busy = false, stopped = false, consecutiveFailures = 0, outageSent = false;
  const scope = process.env.THREAD_AI_QUEUE ?? "continuity";
  const stable = new Map<string, number>();
  const tick = async () => {
    if (busy || stopped) return; busy = true;
    try {
      const snapshot = await collectSnapshot(scope);
      consecutiveFailures = 0; outageSent = false;
      const active = evaluate(snapshot);
      // Two observations suppress transient spikes. Worker startup has 90 seconds' grace.
      const codes = new Set(active.map(c => c.code));
      for (const [code] of stable) if (!codes.has(code)) stable.delete(code);
      for (const code of codes) stable.set(code, (stable.get(code) ?? 0) + 1);
      await reconcileAlerts(scope, active.filter(c => (stable.get(c.code) ?? 0) >= 2),
        Object.fromEntries(Object.entries(RULES).map(([code, [, , field]]) => [code, snapshot[field]])));
      for (let n = 0; n < 5 && !stopped; n++) if (!await deliverOne(scope)) break;
    } catch {
      consecutiveFailures++;
      logger.error({ code: "OPERATIONAL_MONITOR_UNAVAILABLE", consecutiveFailures }, "Monitoring cannot query or persist; external uptime monitoring is still required");
      // DB outage cannot use a DB outbox. Best-effort, one bounded send per outage/process.
      // Not durable across a dead process; never call this a complete availability guarantee.
      if (consecutiveFailures >= 2 && !outageSent && mailConfigured()) {
        outageSent = true;
        const started = performance.now();
        try {
          const receipt = await sendOperationalMail(randomUUID(), {
            code: "MONITOR_DATABASE_PATH_UNAVAILABLE", severity: "critical", state: "triggered",
            observed: consecutiveFailures, threshold: 2, observedAt: new Date().toISOString(),
            environment: process.env.NODE_ENV === "production" ? "production" : "development",
          });
          logger.warn({ providerId: receipt.providerId, measuredMs: performance.now() - started }, "Out-of-band notification accepted; database receipt unavailable, inbox delivery unverified");
        } catch { logger.error("Out-of-band notification failed; no delivery is claimed"); }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 15000);
  const startup = setTimeout(() => { void tick(); }, 90000);
  return () => { stopped = true; clearInterval(timer); clearTimeout(startup); };
}
