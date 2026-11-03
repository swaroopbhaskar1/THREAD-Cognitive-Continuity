import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import router from "../src/routes/thread";
import { createAIWorker, nextAIJobDelay, startAIWorker } from "../src/lib/ai-jobs";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail(`Timed out: ${label}`);
}

test("Demand worker with real PostgreSQL and committed checkpoint routes", async t => {
  const owner = `demand-${randomUUID()}`;
  const app = express();
  app.use(pinoHttp({ enabled: false })); app.use(express.json()); app.use("/api", router);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api`;
  const api = async (path: string, data?: unknown) => {
    const response = await fetch(base + path, {
      method: data ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-test-owner": owner },
      body: data ? JSON.stringify(data) : undefined,
    });
    assert.ok(response.ok, `HTTP ${response.status} ${path}`);
    return response.json();
  };
  let missionId: string;
  const content = {
    notes: "A LEFT JOIN keeps every row on the left, using NULL for unmatched rows on the right.",
    understanding: "Filtering the right table in WHERE can remove unmatched rows from a LEFT JOIN.",
    questions: "Where should a right-side filter go?", reasoning: "Compare ON and WHERE filters.",
    nextAction: "Compare two LEFT JOIN examples with the right-side filter in ON versus WHERE.",
    simulateFailure: true,
  };
  const make = async () => {
    const mission = await api(`/missions/${missionId}`);
    const body = { ...content, version: mission.draft.version, requestKey: randomUUID() };
    const cp = await api(`/missions/${missionId}/checkpoints`, body);
    return { cp, body, job: await api(`/checkpoints/${cp.id}/intelligence`) };
  };
  const state = async (id: string) => (await pool.query("SELECT * FROM ai_jobs WHERE id=$1", [id])).rows[0];
  try {
    missionId = (await api("/missions", {
      title: "CONTROLLED idle-worker test", subject: "SQL", goal: "Compare LEFT JOIN filters", requestKey: randomUUID(),
    })).id;
    await t.test("checkpoint commit and duplicate retry wake an idle worker without duplicate jobs", async () => {
      const stop = startAIWorker();
      try {
        const { cp, body, job } = await make();
        const duplicate = await api(`/missions/${missionId}/checkpoints`, body);
        assert.equal(duplicate.id, cp.id);
        await until(async () => (await state(job.jobId)).status === "fallback", "three scheduled injection attempts");
        const final = await state(job.jobId);
        assert.equal(final.attempts, 3);
        const count = await pool.query("SELECT COUNT(*)::int AS n FROM ai_jobs WHERE checkpoint_id=$1", [cp.id]);
        assert.equal(count.rows[0].n, 1);
        const external = await pool.query("SELECT COUNT(*)::int AS n FROM execution_events WHERE workflow_id=$1 AND name='ai.external_call'", [job.workflowId]);
        assert.equal(external.rows[0].n, 0);
        assert.equal((await api(`/missions/${missionId}`)).checkpoints.find((row: any) => row.id === cp.id).notes, content.notes);
      } finally { stop(); }
    });
    await t.test("future lease wakes at expiry, recovers interruption and becomes completely idle", async () => {
      const { job } = await make();
      await pool.query(`UPDATE ai_jobs SET status='running',attempts=1,lease_token=$2,
        lease_until=now()+interval '200 milliseconds' WHERE id=$1`, [job.jobId, randomUUID()]);
      const delay = await nextAIJobDelay({ jobId: job.jobId });
      assert.ok(delay !== null && delay > 0 && delay <= 200);
      const worker = createAIWorker({ jobId: job.jobId, retryBaseMs: 5 });
      worker.start();
      try {
        await sleep(35);
        assert.equal((await state(job.jobId)).attempts, 1);
        await until(async () => (await state(job.jobId)).status === "fallback", "lease timer recovery");
        await until(async () => !worker.snapshot().busy, "worker idle");
        assert.equal(worker.snapshot().nextWakeInMs, null);
        let acquisitions = 0;
        const acquired = () => { acquisitions++; };
        pool.on("acquire", acquired);
        try { await sleep(250); assert.equal(acquisitions, 0); }
        finally { pool.off("acquire", acquired); }
        const events = await pool.query("SELECT name FROM execution_events WHERE workflow_id=$1", [job.workflowId]);
        assert.ok(events.rows.some(row => row.name === "ai.worker.interrupted"));
      } finally { worker.stop(); }
    });
    await t.test("actual SIGKILL during retry wait rebuilds a future timer in a new process", async () => {
      const { job } = await make();
      const spawnWorker = () => spawn(process.execPath, ["/tmp/thread-demand-recovery-child.cjs", job.jobId],
        { env: process.env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      const first = spawnWorker();
      const firstExit = once(first, "exit");
      try {
        const [message] = await once(first, "message", { signal: AbortSignal.timeout(5000) });
        assert.equal(message.kind, "deadline"); assert.ok(message.delay > 0);
        first.kill("SIGKILL"); await firstExit;
        assert.equal((await state(job.jobId)).status, "retry_wait");
        const second = spawnWorker();
        const secondExit = once(second, "exit");
        try {
          const [message] = await once(second, "message", { signal: AbortSignal.timeout(5000) });
          assert.equal(message.kind, "deadline");
          const [code] = await secondExit;
          assert.equal(code, 0);
          assert.equal((await state(job.jobId)).status, "fallback");
          assert.equal((await state(job.jobId)).attempts, 3);
        } finally { second.kill("SIGKILL"); }
      } finally { first.kill("SIGKILL"); }
    });
  } finally {
    await pool.query("DELETE FROM request_records WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM execution_updates WHERE owner=$1", [owner]);
    await pool.query("DELETE FROM execution_events WHERE workflow_id IN(SELECT id FROM workflows WHERE owner=$1)", [owner]);
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
