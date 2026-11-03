import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import express from "express";
import { pool } from "@workspace/db";
import router from "../src/routes";
import { transaction } from "../src/lib/execution";
import { evaluate, reconcileAlerts, deliverOne, type Snapshot } from "../src/lib/operational-monitor";
import { DeliveryError } from "../src/lib/operational-mail";

test("Challenge launch changes: interruption recovery and bounded optional notifications", async t => {
  const scope = `launch-${randomUUID()}`, owner = `launch-${randomUUID()}`;
  const app = express(); app.use(express.json()); app.use("/api", router);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = { "content-type": "application/json", "x-test-owner": owner };
  try {
    await t.test("alert thresholds are explicit policy, not invented cognitive measurements", () => {
      const zero: Snapshot = { queueAgeSeconds: 0, expiredLeases: 0, retries: 0, fallbacks: 0, budgetExhaustions: 0,
        missingCommits: 0, workerAgeSeconds: 0, databaseWrites: 0, serverErrors: 0, sseFailures: 0, clientSseFailures: 0, commitFailures: 0, workerFailures: 0 };
      assert.deepEqual(evaluate(zero), []);
      assert.deepEqual(evaluate({ ...zero, workerAgeSeconds: 90 }).map(x => x.code), ["WORKER_HEARTBEAT_STALE"]);
      assert.deepEqual(evaluate({ ...zero, queueAgeSeconds: 119 }), []);
    });
    await t.test("incident deduplication, measured dispatch and recovery preserve honest receipt states", async () => {
      const condition = { code: "CONTROLLED_TEST", severity: "test", observed: 1, threshold: 1 };
      await reconcileAlerts(scope, [condition]); await reconcileAlerts(scope, [condition]);
      const count = await pool.query("SELECT COUNT(*)::int AS n FROM operational_alerts WHERE scope=$1", [scope]);
      assert.equal(count.rows[0].n, 1);
      let calls = 0;
      await deliverOne(scope, async (_id, payload) => {
        calls++; assert.equal(payload.code, condition.code);
        assert.deepEqual(Object.keys(payload).sort(), ["code", "environment", "observed", "observedAt", "severity", "state", "threshold"]);
        return { providerId: "TEST_FIXTURE_NOT_REAL_EMAIL" };
      });
      assert.equal(calls, 1); assert.equal(await deliverOne(scope, async () => { throw new Error("unexpected"); }), false);
      const receipt = (await pool.query("SELECT d.* FROM operational_deliveries d JOIN operational_alerts a ON a.id=d.alert_id WHERE a.scope=$1", [scope])).rows[0];
      assert.equal(receipt.state, "provider_accepted"); assert.ok(receipt.duration_ms >= 0);
      await reconcileAlerts(scope, []);
      const recovery = (await pool.query("SELECT d.payload FROM operational_deliveries d JOIN operational_alerts a ON a.id=d.alert_id WHERE a.scope=$1 ORDER BY d.created_at DESC LIMIT 1", [scope])).rows[0].payload;
      assert.equal(recovery.state, "recovered"); assert.equal(recovery.observed, null); // Unknown is not fabricated zero.
    });
    await t.test("notification retries stop after five attempts and restart fencing prevents stale completion", async () => {
      let calls = 0;
      for (let n = 0; n < 5; n++) {
        await pool.query("UPDATE operational_deliveries SET available_at=now() WHERE alert_id IN (SELECT id FROM operational_alerts WHERE scope=$1) AND state='pending'", [scope]);
        await deliverOne(scope, async () => { calls++; throw new DeliveryError("TEST_TIMEOUT", true); });
      }
      assert.equal(calls, 5);
      assert.equal(await deliverOne(scope, async () => { calls++; return { providerId: "not-called" }; }), false);
      await reconcileAlerts(scope, [{ code: "LEASE_TEST", severity: "test", observed: 1, threshold: 1 }]);
      await deliverOne(scope, async id => {
        await pool.query("UPDATE operational_deliveries SET lease_token=$2 WHERE id=$1", [id, randomUUID()]);
        return { providerId: "STALE_TEST_RESULT" };
      });
      const lease = (await pool.query(`SELECT d.* FROM operational_deliveries d JOIN operational_alerts a ON a.id=d.alert_id
        WHERE a.scope=$1 AND a.code='LEASE_TEST'`, [scope])).rows[0];
      assert.equal(lease.state, "sending"); assert.equal(lease.provider_id, null);
      await pool.query("UPDATE operational_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.id]);
      await deliverOne(scope, async () => ({ providerId: "RECOVERED_TEST_FIXTURE" }));
      assert.equal((await pool.query("SELECT state,attempts FROM operational_deliveries WHERE id=$1", [lease.id])).rows[0].attempts, 2);
    });
    await t.test("connection-signal endpoint requires authentication and validates bounded input", async () => {
      assert.equal((await fetch(base + "/operations/client-signal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
      assert.equal((await fetch(base + "/operations/client-signal", { method: "POST", headers, body: JSON.stringify({ kind: "sse_reconnect_failed", consecutiveFailures: 2 }) })).status, 400);
      for (let i = 0; i < 2; i++) assert.equal((await fetch(base + "/operations/client-signal", { method: "POST", headers, body: JSON.stringify({ kind: "sse_reconnect_failed", consecutiveFailures: 3 }) })).status, 202);
    });
    for (const phase of ["before_commit", "after_commit"]) {
      await t.test(`actual SIGKILL ${phase}: identical checkpoint request safely recovers`, async () => {
        const mission = randomUUID(), key = randomUUID();
        await pool.query("INSERT INTO missions(id,owner,title,subject,goal) VALUES($1,$2,$3,'Test subject','Test recovery')", [mission, owner, `TEST ONLY ${phase}`]);
        await pool.query("INSERT INTO drafts(mission_id) VALUES($1)", [mission]);
        const body = { requestKey: key, version: 0, notes: "TEST ONLY original notes", understanding: "Original understanding",
          questions: "Which input is missing?", reasoning: "Compare the original inputs.", nextAction: "Compare two inputs.", simulateFailure: false };
        const child = fork("/tmp/thread-checkpoint-recovery-child.cjs", [], {
          env: { ...process.env, NODE_ENV: "production", CHECKPOINT_STOP_PHASE: phase }, stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let interrupted: Promise<Response> | undefined;
        try {
          const ready = await Promise.race([once(child, "message"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Child startup timeout")), 5000).unref())]);
          const port = (ready[0] as any).port; assert.ok(port);
          const stopped = once(child, "message");
          interrupted = fetch(`http://127.0.0.1:${port}/api/missions/${mission}/checkpoints`, { method: "POST", headers, body: JSON.stringify(body) });
          void interrupted.catch(() => {});
          await Promise.race([stopped, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Checkpoint interception timeout")), 5000).unref())]);
          const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; await interrupted.catch(() => {});
          const before = await pool.query("SELECT COUNT(*)::int AS n FROM checkpoints WHERE mission_id=$1", [mission]);
          assert.equal(before.rows[0].n, phase === "before_commit" ? 0 : 1);
          const response = await fetch(`${base}/missions/${mission}/checkpoints`, { method: "POST", headers, body: JSON.stringify(body) });
          assert.equal(response.status, 201); const checkpoint: any = await response.json();
          const result = (await pool.query("SELECT notes,workflow_id FROM checkpoints WHERE mission_id=$1", [mission])).rows;
          assert.equal(result.length, 1); assert.equal(result[0].notes, body.notes);
          assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM ai_jobs WHERE checkpoint_id=$1", [checkpoint.id])).rows[0].n, 1);
          const events = (await pool.query("SELECT name FROM execution_events WHERE workflow_id=$1", [result[0].workflow_id])).rows.map(r => r.name);
          assert.ok(events.includes("checkpoint.persisted"));
          // SIGKILL after the real COMMIT but before its separate acknowledgment
          // must NOT invent a confirmation for the original workflow.
          if (phase === "after_commit") assert.ok(!events.includes("transaction.commit.confirmed"));
        } finally { child.kill("SIGKILL"); }
      });
    }
    await t.test("terminating this test's checked-out database connection rolls back and reconnects", async () => {
      const mission = randomUUID();
      await pool.query("INSERT INTO missions(id,owner,title,subject,goal) VALUES($1,$2,'TEST ONLY database interruption','Test subject','Test recovery')", [mission, owner]);
      await pool.query("INSERT INTO drafts(mission_id,notes) VALUES($1,'ORIGINAL TEST NOTES')", [mission]);
      await assert.rejects(transaction(async c => {
        await c.query("UPDATE drafts SET notes='UNCOMMITTED TEST CHANGE' WHERE mission_id=$1", [mission]);
        const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await pool.query("SELECT pg_terminate_backend($1)", [pid]);
        await new Promise(r => setTimeout(r, 20));
        await c.query("SELECT 1");
      }));
      assert.equal((await pool.query("SELECT notes FROM drafts WHERE mission_id=$1", [mission])).rows[0].notes, "ORIGINAL TEST NOTES");
      await transaction(c => c.query("UPDATE drafts SET version=version+1 WHERE mission_id=$1", [mission]));
      assert.equal((await pool.query("SELECT version FROM drafts WHERE mission_id=$1", [mission])).rows[0].version, 1);
    });
  } finally {
    await pool.query("DELETE FROM rate_limits WHERE key=ANY($1::text[])", [[
      `operations-email-test:${scope}`, `client-sse-signal:${owner}`,
    ].map(k => createHash("sha256").update(k).digest("hex"))]);
    await pool.query("DELETE FROM operational_alerts WHERE scope=$1", [scope]);
    await pool.query("DELETE FROM request_records WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM execution_updates WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM execution_events WHERE workflow_id IN (SELECT id FROM workflows WHERE owner=$1)", [owner]);
    await pool.query("DELETE FROM ai_jobs WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM recall_attempts WHERE review_id IN(SELECT id FROM review_schedules WHERE owner=$1)", [owner]);
    await pool.query("DELETE FROM review_schedules WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM checkpoints WHERE mission_id IN(SELECT id FROM missions WHERE owner=$1)", [owner]);
    await pool.query("DELETE FROM workflows WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM drafts WHERE mission_id IN(SELECT id FROM missions WHERE owner=$1)", [owner]);
    await pool.query("DELETE FROM missions WHERE owner=$1", [owner]);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
