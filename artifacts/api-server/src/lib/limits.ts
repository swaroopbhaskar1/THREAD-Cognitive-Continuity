import { createHash } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";

export async function consumeLimit(c: Pick<PoolClient, "query">, bucket: string, identity: string, maximum: number, seconds: number) {
  const key = createHash("sha256").update(`${bucket}:${identity}`).digest("hex");
  // DB clock, one atomic statement, no read/modify/write race. Expired buckets
  // reset on use; unused expired rows are housekeeping, not correctness.
  const r = await c.query(`INSERT INTO rate_limits(key,count,expires_at)
    VALUES($1,1,clock_timestamp()+($2*interval '1 second'))
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN rate_limits.expires_at<=clock_timestamp() THEN 1 ELSE rate_limits.count+1 END,
      expires_at=CASE WHEN rate_limits.expires_at<=clock_timestamp() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END
    RETURNING count, GREATEST(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::int AS retry_after`, [key, seconds]);
  return { allowed: r.rows[0].count <= maximum, retryAfter: Number(r.rows[0].retry_after) };
}

export async function reserveAICall(owner: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Same lock order on every process. Rejected calls consume no budget.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('thread-ai-budget',0))");
    const global = await consumeLimit(c, "ai-global", "all", 600, 86400);
    const user = await consumeLimit(c, "ai-owner", owner, 60, 86400);
    if (!global.allowed || !user.allowed) {
      await c.query("ROLLBACK");
      return false;
    }
    await c.query("COMMIT");
    return true;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally { c.release(); }
}
