import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import router from "../src/routes/thread";
import reviewRouter from "../src/routes/reviews";
import { reviewChecks } from "./reviews.test";
import "./production-readiness.test";
import "./launch-reliability.test";
import "./demand-worker.test";
import "./demand-integration.test";
import "./production-connection.test";
import { fallbackQuestion, requestHash, strategies, unavailableProvider } from "../src/lib/continuity";
import { transaction } from "../src/lib/execution";
import { validCursor } from "../src/lib/event-stream";
import { runOneAIJob } from "../src/lib/ai-jobs";
import { AIError, validateIntelligence } from "../src/lib/ai-content";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

test("deterministic continuity primitives", async t => {
  await t.test("retrieval fallback supports both populated and empty understanding", () => {
    assert.match(fallbackQuestion("Limits describe approach", "Calculus"), /Calculus/);
    assert.match(fallbackQuestion("", ""), /What do you remember/);
    assert.equal(fallbackQuestion("x", "Math"), fallbackQuestion("x", "Math"));
  });
  await t.test("all four obstacles have a restarting strategy", () => {
    for (const key of ["lost_context", "overwhelmed", "uncertain", "ready"]) assert.ok(strategies[key]!.length > 40);
  });
  await t.test("stable content hashes distinguish altered requests", () => {
    assert.equal(requestHash({ notes: "a" }), requestHash({ notes: "a" }));
    assert.notEqual(requestHash({ notes: "a" }), requestHash({ notes: "b" }));
  });
  await t.test("unavailable and induced adapters fail explicitly without network calls", async () => {
    await assert.rejects(unavailableProvider(false), /AI is not connected/);
    await assert.rejects(unavailableProvider(true), /Induced provider-adapter failure/);
  });
  await t.test("SSE cursors reject malformed, negative, and overflowing values", () => {
    assert.ok(validCursor("0"));
    assert.ok(validCursor("9223372036854775807"));
    for (const value of ["-1", "abc", "01", "9223372036854775808", {}, undefined]) assert.equal(validCursor(value), false);
  });
});

test("PostgreSQL-backed route integration (Clerk identity adapter mocked only in test bundle)", async t => {
  const owner = `integration-${randomUUID()}`;
  const other = `integration-${randomUUID()}`;
  const app = express();
  app.use(pinoHttp({ enabled: false }));
  app.use(express.json());
  app.use("/api", router);
  app.use("/api", reviewRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}/api`;
  async function api(path: string, method = "GET", data?: unknown, identity: string | null = owner) {
    const r = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(identity ? { "x-test-owner": identity } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  }
  let missionId = "";
  let cp: Record<string, any> = {};
  let original: Record<string, any> = {};
  let checkpointRequest: Record<string, any> = {};
  try {
    await t.test("unauthenticated access is rejected", async () => {
      assert.equal((await api("/missions", "GET", undefined, null)).status, 401);
    });
    await t.test("mission creation is persistent and idempotent", async () => {
      const data = { title: "Integration: Limits", subject: "Calculus", goal: "Understand limits", requestKey: randomUUID() };
      const first = await api("/missions", "POST", data);
      assert.equal(first.status, 201);
      missionId = first.body.id;
      assert.ok(missionId);
      const second = await api("/missions", "POST", data);
      assert.equal(second.body.id, missionId);
      const persisted = await pool.query("SELECT title FROM missions WHERE id=$1 AND owner=$2", [missionId, owner]);
      assert.equal(persisted.rows[0].title, data.title);
    });
    await t.test("draft save persists all thinking fields and a lost-response retry is safe", async () => {
      original = { notes: "A limit describes approach, not necessarily the value at a point.", understanding: "Nearby values determine the limit.", questions: "Can a limit exist without f(a)?", reasoning: "Compare punctured neighborhoods.", nextAction: "Evaluate lim x→2 (x²−4)/(x−2) by factoring.", version: 0 };
      const saved = await api(`/missions/${missionId}/draft`, "PUT", original);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.version, 1);
      assert.equal(saved.body.reasoning, original.reasoning);
      const retry = await api(`/missions/${missionId}/draft`, "PUT", original);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.version, 1);
    });
    await t.test("conflicting edits return 409 without overwriting the server draft", async () => {
      const conflict = await api(`/missions/${missionId}/draft`, "PUT", { ...original, notes: "Conflicting tab", version: 0 });
      assert.equal(conflict.status, 409);
      const current = await api(`/missions/${missionId}`);
      assert.equal(current.body.draft.notes, original.notes);
    });
    await t.test("checkpoint commits original work and a durable failure-injection job atomically", async () => {
      checkpointRequest = { ...original, version: 1, requestKey: randomUUID(), simulateFailure: true };
      const result = await api(`/missions/${missionId}/checkpoints`, "POST", checkpointRequest);
      assert.equal(result.status, 201);
      cp = result.body;
      assert.equal(cp.source, "fallback");
      assert.equal(cp.nextAction, original.nextAction);
      const persisted = (await pool.query("SELECT notes,reasoning FROM checkpoints WHERE id=$1", [cp.id])).rows[0];
      assert.equal(persisted.notes, original.notes);
      assert.equal(persisted.reasoning, original.reasoning);
      const events = await api(`/workflows/${cp.workflowId}/events`);
      assert.ok(events.body.some((e: any) => e.name === "checkpoint.persisted"));
      const job = await api(`/checkpoints/${cp.id}/intelligence`);
      assert.equal(job.body.status, "queued");
      assert.equal(job.body.failureInjection, true);
      assert.ok(events.body.some((e: any) => e.name === "checkpoint.persisted" && e.fallback));
      const eventsBeforeProcessing = await api(`/workflows/${job.body.workflowId}/events`);
      assert.ok(eventsBeforeProcessing.body.some((e: any) => e.name === "ai.job.queued"));
      assert.ok(!eventsBeforeProcessing.body.some((e: any) => e.name === "ai.external_call"));
    });
    await t.test("concurrent duplicate checkpoint requests return the same immutable record", async () => {
      const retries = await Promise.all([api(`/missions/${missionId}/checkpoints`, "POST", checkpointRequest), api(`/missions/${missionId}/checkpoints`, "POST", checkpointRequest)]);
      assert.ok(retries.every(r => r.status === 201 && r.body.id === cp.id));
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM checkpoints WHERE mission_id=$1", [missionId])).rows[0].n, 1);
      const attempts = await pool.query(`SELECT e.attempt FROM execution_events e JOIN workflows w ON w.id=e.workflow_id
        WHERE w.owner=$1 AND w.operation='checkpoint.create.retry' AND e.name='request.idempotency.replayed' ORDER BY e.attempt`, [owner]);
      assert.deepEqual(attempts.rows.map(r => r.attempt), [2, 3]);
    });
    await t.test("reused keys with changed content fail", async () => {
      assert.equal((await api(`/missions/${missionId}/checkpoints`, "POST", { ...checkpointRequest, notes: "Changed content" })).status, 409);
    });
    await t.test("fresh workspace requests restore saved progress and a concrete next action", async () => {
      for (let i = 0; i < 2; i++) {
        const result = await api(`/missions/${missionId}`);
        assert.equal(result.status, 200);
        assert.equal(result.body.draft.notes, original.notes);
        assert.equal(result.body.checkpoints[0].nextAction, original.nextAction);
        assert.equal(result.body.checkpoints[0].questions, original.questions);
      }
    });
    await t.test("resume persists recall and obstacle, and first-action time is recorded once", async () => {
      const input = { obstacle: "uncertain", recallAnswer: "I remember approach, not point value.", requestKey: randomUUID() };
      const resumed = await api(`/missions/${missionId}/resumptions`, "POST", input);
      assert.equal(resumed.status, 201);
      assert.equal(resumed.body.strategy, strategies.uncertain);
      assert.equal((await api(`/missions/${missionId}/resumptions`, "POST", input)).body.id, resumed.body.id);
      const action = await api(`/resumptions/${resumed.body.id}/action`, "POST");
      assert.equal(action.status, 200);
      assert.ok(action.body.firstActionMs >= 0);
      const again = await api(`/resumptions/${resumed.body.id}/action`, "POST");
      assert.equal(action.body.firstActionMs, again.body.firstActionMs);
    });
    await t.test("execution history uses real persisted durations and excludes private content", async subtest => {
      const result = await api(`/workflows/${cp.workflowId}/events`);
      assert.equal(result.status, 200);
      assert.ok(result.body.length >= 2);
      assert.ok(result.body.every((e: any) => Number.isFinite(e.durationMs) && e.durationMs >= 0));
      assert.ok(result.body.some((e: any) => e.component === "database" && e.durationMs > 0));
      assert.ok(result.body.every((e: any, i: number) => e.sequence === i + 1));
      assert.ok(!JSON.stringify(result.body).includes(original.notes));
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM execution_events WHERE workflow_id=$1", [cp.workflowId])).rows[0].n, result.body.length);
      subtest.diagnostic(`Persisted checkpoint execution evidence: ${JSON.stringify(result.body.map((e: any) => ({ sequence: e.sequence, operation: e.name, outcome: e.outcome, measuredMs: e.durationMs, fallback: e.fallback })))}`);
    });
    await t.test("checkpoint updates are rejected by PostgreSQL", async () => {
      await assert.rejects(pool.query("UPDATE checkpoints SET notes='overwrite' WHERE id=$1", [cp.id]), /immutable/);
    });
    await t.test("normal AI processing is queued without changing original work", async () => {
      const current = await api(`/missions/${missionId}`);
      const result = await api(`/missions/${missionId}/checkpoints`, "POST", {
        ...original, version: current.body.draft.version, requestKey: randomUUID(), simulateFailure: false,
      });
      assert.equal(result.status, 201);
      assert.equal(result.body.notes, original.notes);
      assert.equal(result.body.source, "fallback");
      const events = await api(`/workflows/${result.body.workflowId}/events`);
      assert.ok(events.body.some((e: any) => e.name === "checkpoint.persisted"));
      const job = await api(`/checkpoints/${result.body.id}/intelligence`);
      assert.equal(job.body.status, "queued");
      assert.equal(job.body.failureInjection, false);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM checkpoints WHERE mission_id=$1", [missionId])).rows[0].n, 2);
    });
    await t.test("owner isolation covers missions and execution records", async () => {
      assert.equal((await api(`/missions/${missionId}`, "GET", undefined, other)).status, 404);
      assert.equal((await api(`/workflows/${cp.workflowId}/events`, "GET", undefined, other)).status, 404);
      assert.deepEqual((await api("/missions", "GET", undefined, other)).body, []);
    });
    await t.test("transaction rollback does not leave partial missions", async () => {
      const id = randomUUID();
      await assert.rejects(transaction(async c => {
        await c.query("INSERT INTO missions(id,owner,title,subject,goal) VALUES($1,$2,'rollback','','')", [id, owner]);
        throw new Error("Forced transaction error");
      }));
      assert.equal((await pool.query("SELECT id FROM missions WHERE id=$1", [id])).rowCount, 0);
    });
    await t.test("summary is computed from persisted learning records", async () => {
      const summary = await api("/summary");
      assert.equal(summary.status, 200);
      assert.equal(summary.body.missions, 1);
      assert.equal(summary.body.checkpoints, 2);
      assert.equal(summary.body.resumptions, 1);
    });
    await t.test("SSE authentication and malformed cursors are rejected before streaming", async () => {
      assert.equal((await api("/events/stream", "GET", undefined, null)).status, 401);
      assert.equal((await api("/events/stream?after=-1")).status, 400);
      assert.equal((await api("/events/stream?after=9223372036854775808")).status, 400);
    });
    await t.test("SSE streams committed updates and reconnects with historical backfill", async () => {
      const latest = async () => (await pool.query("SELECT COALESCE(MAX(id),0)::text cursor FROM execution_updates WHERE owner=$1", [owner])).rows[0].cursor as string;
      const start = await latest();
      const connect = async (cursor: string, lastEventId?: string) => {
        const response = await fetch(`${base}/events/stream?after=${cursor}`, {
          headers: { "x-test-owner": owner, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type")!, /text\/event-stream/);
        const reader = response.body!.getReader();
        let buffer = "";
        const decoder = new TextDecoder();
        return {
          reader,
          next: async () => {
            while (true) {
              const end = buffer.indexOf("\n\n");
              if (end >= 0) {
                const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                const data = frame.split("\n").find(line => line.startsWith("data: "));
                if (data) return JSON.parse(data.slice(6));
                continue;
              }
              const part = await reader.read();
              assert.equal(part.done, false, "stream ended before execution frame");
              buffer += decoder.decode(part.value, { stream: true });
            }
          },
        };
      };
      const stream = await connect(start);
      // Read current state first; this itself produces an authentic context.restored workflow.
      const current = await api(`/missions/${missionId}`);
      const frame = await stream.next();
      assert.ok(BigInt(frame.cursor) > BigInt(start));
      assert.equal(frame.workflow.operation, "mission.open");
      const persisted = await api(`/workflows/${frame.workflow.id}/events`);
      frame.events.forEach((event: any) => assert.deepEqual(event, persisted.body.find((e: any) => e.id === event.id)));
      await stream.reader.cancel();
      const saved = await api(`/missions/${missionId}/draft`, "PUT", {
        ...original, version: current.body.draft.version, notes: `${original.notes} SSE backfill test`,
      });
      assert.equal(saved.status, 200);
      const reconnected = await connect("0", frame.cursor);
      let missed = await reconnected.next();
      while (missed.workflow.operation !== "draft.save") missed = await reconnected.next();
      assert.ok(BigInt(missed.cursor) > BigInt(frame.cursor));
      assert.equal(missed.workflow.operation, "draft.save");
      assert.equal(missed.events.some((e: any) => e.name === "draft.persisted"), true);
      const outbox = await pool.query("SELECT workflow_id FROM execution_updates WHERE id=$1 AND owner=$2", [missed.cursor, owner]);
      assert.equal(outbox.rows[0].workflow_id, missed.workflow.id);
      await reconnected.reader.cancel();
    });
    await t.test("durable SSE cursors cannot reveal another owner's workflows", async () => {
      const rows = await pool.query(`SELECT u.id,u.owner,w.owner workflow_owner FROM execution_updates u
        JOIN workflows w ON w.id=u.workflow_id WHERE u.owner=ANY($1)`, [[owner, other]]);
      assert.ok(rows.rows.length > 0);
      assert.ok(rows.rows.every(row => row.owner === row.workflow_owner));
      const response = await fetch(`${base}/events/stream?after=0`, {
        headers: { "x-test-owner": other }, signal: AbortSignal.timeout(10000),
      });
      const reader = response.body!.getReader();
      let received = "";
      while (!received.includes("data: ")) {
        const part = await reader.read();
        assert.equal(part.done, false);
        received += new TextDecoder().decode(part.value);
      }
      const data = JSON.parse(received.split("\n").find(l => l.startsWith("data: "))!.slice(6));
      const workflow = await pool.query("SELECT owner FROM workflows WHERE id=$1", [data.workflow.id]);
      assert.equal(workflow.rows[0].owner, other);
      assert.notEqual(data.workflow.missionId, missionId);
      await reader.cancel();
    });
    const fixture = {
      summary: { text: "Nearby values determine the limit, comparing punctured neighborhoods rather than the point value.", evidence: [{ field: "understanding", quote: original.understanding }] },
      retrievalQuestion: { text: "How do nearby values determine the limit when the point value is missing?", evidence: [{ field: "understanding", quote: original.understanding }] },
      nextAction: { text: "Compare punctured neighborhoods to explain how nearby values determine the limit.", evidence: [{ field: "reasoning", quote: original.reasoning }] },
    };
    const newJob = async () => {
      const current = await api(`/missions/${missionId}`);
      const cp = await api(`/missions/${missionId}/checkpoints`, "POST", { ...original, version: current.body.draft.version, requestKey: randomUUID(), simulateFailure: false });
      assert.equal(cp.status, 201);
      return (await api(`/checkpoints/${cp.body.id}/intelligence`)).body;
    };
    const jobState = async (job: any) => (await api(`/checkpoints/${job.checkpointId}/intelligence`)).body;
    const eventNames = async (job: any) => (await api(`/workflows/${job.workflowId}/events`)).body.map((e: any) => e.name);
    const fixtureServer = async (handler: Parameters<typeof createServer>[0]) => {
      const server = createServer(handler);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      return { server, baseURL: `http://127.0.0.1:${address.port}`, close: async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      } };
    };
    const envelope = () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(fixture) } }] });
    await t.test("AI strict schemas and content checks reject extra keys, false evidence, off-topic text, unsafe links, and vague actions", () => {
      assert.deepEqual(validateIntelligence(fixture, original), fixture);
      for (const changed of [
        { ...fixture, extra: true },
        { ...fixture, summary: { ...fixture.summary, evidence: [{ field: "notes", quote: "not in the saved material" }] } },
        { ...fixture, summary: { ...fixture.summary, text: "Bananas and rockets have nothing to explain here." } },
        { ...fixture, nextAction: { ...fixture.nextAction, text: "Compare nearby limit values at https://example.com" } },
        { ...fixture, nextAction: { ...fixture.nextAction, text: "Keep learning nearby values determine the limit." } },
        { ...fixture, retrievalQuestion: { ...fixture.retrievalQuestion, text: "Nearby values determine the limit and point value." } },
      ]) assert.throws(() => validateIntelligence(changed, original), AIError);
    });
    await t.test("duplicate job requests return the same unique durable job and are owner-scoped", async () => {
      const job = await newJob();
      const results = await Promise.all([1, 2, 3].map(() => api(`/checkpoints/${job.checkpointId}/intelligence`, "POST", { simulateFailure: true })));
      assert.ok(results.every(r => r.status === 200 && r.body.jobId === job.jobId && !r.body.failureInjection));
      assert.equal((await api(`/checkpoints/${job.checkpointId}/intelligence`, "GET", undefined, other)).status, 404);
      assert.equal((await api(`/checkpoints/${job.checkpointId}/intelligence`, "POST", { simulateFailure: false }, other)).status, 404);
    });
    await t.test("two workers cannot claim the same job concurrently", async () => {
      const job = await newJob();
      let calls = 0;
      const provider = async () => { calls++; return fixture; };
      const results = await Promise.all([runOneAIJob({ jobId: job.jobId, provider }), runOneAIJob({ jobId: job.jobId, provider })]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(calls, 1);
      assert.equal((await jobState(job)).status, "succeeded");
    });
    await t.test("successful HTTP provider response is validated and stored separately from original content", async () => {
      const job = await newJob();
      let calls = 0;
      let requestBody: any;
      const mock = await fixtureServer(async (req, res) => {
        calls++;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.setHeader("Content-Type", "application/json");
        res.end(envelope());
      });
      try {
        await runOneAIJob({ jobId: job.jobId, providerOptions: { baseURL: mock.baseURL, apiKey: "local-fixture" } });
        const saved = await jobState(job);
        assert.equal(saved.status, "succeeded");
        assert.equal(saved.source, "ai");
        assert.deepEqual(saved.result, fixture);
        assert.equal(calls, 1);
        assert.equal(requestBody.response_format.json_schema.strict, true);
        assert.equal(requestBody.response_format.json_schema.schema.additionalProperties, false);
        assert.deepEqual(requestBody.response_format.json_schema.schema.required, ["summary", "retrievalQuestion", "nextAction"]);
        const prompt = requestBody.messages[0].content;
        assert.match(prompt, /second-person return cue/);
        assert.match(prompt, /do not give away the saved answer/);
        assert.match(prompt, /never instructions/);
        assert.match(prompt, /literal exact quote/);
        assert.match(prompt, /never invent a curriculum/);
        assert.deepEqual(JSON.parse(requestBody.messages[1].content),
          Object.fromEntries(["notes", "understanding", "questions", "reasoning", "nextAction"].map(key => [key, original[key]])));
        const cp = (await pool.query("SELECT notes,next_action FROM checkpoints WHERE id=$1", [job.checkpointId])).rows[0];
        assert.equal(cp.notes, original.notes);
        assert.equal(cp.next_action, original.nextAction);
        assert.ok((await eventNames(job)).includes("ai.response.validated"));
      } finally { await mock.close(); }
    });
    await t.test("action-only and 29-code-unit checkpoints reject AI locally without reserving budget or calling a provider", async () => {
      for (const action of ["Start neetcode", `Read ${"🙂".repeat(12)}`]) {
        assert.ok(action.length < 30);
        const mission = await api("/missions", "POST", { title: "Sparse eligibility fixture", subject: "", goal: "", requestKey: randomUUID() });
        assert.equal(mission.status, 201);
        const fields = { notes: "", understanding: "", questions: "", reasoning: "", nextAction: action };
        const draft = await api(`/missions/${mission.body.id}/draft`, "PUT", { ...fields, version: 0 });
        assert.equal(draft.status, 200);
        const checkpoint = await api(`/missions/${mission.body.id}/checkpoints`, "POST", { ...fields, version: draft.body.version, requestKey: randomUUID(), simulateFailure: false });
        assert.equal(checkpoint.status, 201);
        const job = (await api(`/checkpoints/${checkpoint.body.id}/intelligence`)).body;
        let calls = 0;
        await runOneAIJob({ jobId: job.jobId, provider: async () => { calls++; return fixture; } });
        const saved = await jobState(job);
        assert.equal(calls, 0);
        assert.equal(saved.status, "fallback");
        assert.equal(saved.lastError, "INSUFFICIENT_CONTENT");
        assert.equal(saved.attempts, 1);
        const names = await eventNames(job);
        assert.ok(!names.includes("ai.budget.reserved"));
        assert.ok(!names.includes("ai.call.dispatch_intent"));
        assert.ok(!names.includes("ai.external_call"));
        const current = await api(`/missions/${mission.body.id}`);
        assert.equal(current.body.draft.nextAction, action);
        assert.equal(current.body.checkpoints[0].nextAction, action);
      }
    });
    await t.test("invalid JSON and invalid schemas exhaust bounded retries with explicit fallback", async () => {
      const job = await newJob();
      let calls = 0;
      const mock = await fixtureServer((_req, res) => {
        calls++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: calls === 1 ? "{broken" : '{"madeUp":true}' } }] }));
      });
      try {
        for (let n = 0; n < 3; n++) await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0, providerOptions: { baseURL: mock.baseURL, apiKey: "local-fixture" } });
        const saved = await jobState(job);
        assert.equal(saved.status, "fallback");
        assert.equal(saved.lastError, "INVALID_SCHEMA");
        assert.equal(saved.attempts, 3);
        assert.equal(saved.result.nextAction.text, original.nextAction);
        assert.equal(await runOneAIJob({ jobId: job.jobId }), false);
        assert.equal(calls, 3);
        assert.equal((await eventNames(job)).filter((n: string) => n === "ai.retry.scheduled").length, 2);
      } finally { await mock.close(); }
    });
    await t.test("real HTTP timeouts abort stalled requests and persist measured failure durations", async () => {
      const job = await newJob();
      const mock = await fixtureServer(() => { /* deliberately never reply: real timeout, not a fake elapsed value */ });
      try {
        for (let n = 0; n < 3; n++) await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0, providerOptions: { baseURL: mock.baseURL, apiKey: "local-fixture", timeoutMs: 35 } });
        assert.equal((await jobState(job)).lastError, "PROVIDER_TIMEOUT");
        assert.equal((await jobState(job)).status, "fallback");
        const events = (await api(`/workflows/${job.workflowId}/events`)).body.filter((e: any) => e.name === "ai.external_call");
        assert.equal(events.length, 3);
        assert.ok(events.every((e: any) => e.outcome === "failure" && e.durationMs >= 25));
      } finally { await mock.close(); }
    });
    await t.test("429 retries are bounded; non-retryable 400 errors use fallback immediately", async () => {
      for (const status of [429, 400]) {
        const job = await newJob();
        let calls = 0;
        const mock = await fixtureServer((_req, res) => { calls++; res.writeHead(status); res.end("not logged"); });
        try {
          for (let n = 0; n < 3; n++) await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0, providerOptions: { baseURL: mock.baseURL, apiKey: "local-fixture" } });
          const saved = await jobState(job);
          assert.equal(saved.status, "fallback");
          assert.equal(saved.attempts, status === 400 ? 1 : 3);
          assert.equal(calls, saved.attempts);
        } finally { await mock.close(); }
      }
    });
    await t.test("clearly labeled failure injection sends no external request and falls back after three attempts", async () => {
      const job = (await api(`/checkpoints/${cp.id}/intelligence`)).body;
      let calls = 0;
      for (let n = 0; n < 3; n++) await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0, provider: async () => { calls++; return fixture; } });
      const saved = await jobState(job);
      assert.equal(saved.failureInjection, true);
      assert.equal(saved.status, "fallback");
      assert.equal(calls, 0);
      const names = await eventNames(job);
      assert.equal(names.filter((n: string) => n === "ai.failure_injection").length, 3);
      assert.equal(names.includes("ai.external_call"), false);
    });
    await t.test("a transient provider failure can retry successfully without changing the job or checkpoint", async () => {
      const job = await newJob();
      let calls = 0;
      const provider = async () => { if (++calls === 1) throw new AIError("HTTP_503"); return fixture; };
      await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0, provider });
      assert.equal((await jobState(job)).status, "retry_wait");
      await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0, provider });
      const saved = await jobState(job);
      assert.equal(saved.status, "succeeded");
      assert.equal(saved.attempts, 2);
      assert.equal(saved.jobId, job.jobId);
    });
    await t.test("interrupted last attempt reaches fallback without making an unbounded fourth call", async () => {
      const job = await newJob();
      await pool.query("UPDATE ai_jobs SET status='running',attempts=3,lease_until=now()-interval '1 second',lease_token=$2 WHERE id=$1", [job.jobId, randomUUID()]);
      let calls = 0;
      await runOneAIJob({ jobId: job.jobId, provider: async () => { calls++; return fixture; } });
      const saved = await jobState(job);
      assert.equal(saved.status, "fallback");
      assert.equal(saved.attempts, 3);
      assert.equal(saved.lastError, "INTERRUPTED_ATTEMPTS_EXHAUSTED");
      assert.equal(calls, 0);
    });
    await t.test("stale workers cannot overwrite a recovered worker's validated result", async () => {
      const job = await newJob();
      let release!: () => void;
      let dispatched!: () => void;
      const started = new Promise<void>(r => { dispatched = r; });
      const pending = new Promise<void>(r => { release = r; });
      const first = runOneAIJob({ jobId: job.jobId, provider: async () => { dispatched(); await pending; throw new AIError("OLD_WORKER_ERROR"); } });
      await started;
      await pool.query("UPDATE ai_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.jobId]);
      await runOneAIJob({ jobId: job.jobId, provider: async () => fixture });
      release();
      await first;
      assert.equal((await jobState(job)).status, "succeeded");
      assert.equal((await jobState(job)).attempts, 2);
      assert.ok((await eventNames(job)).includes("ai.stale_result.discarded"));
    });
    await t.test("killed worker process recovers after restart from its durable expired lease", async () => {
      const job = await newJob();
      let receipt!: () => void;
      const sent = new Promise<void>(r => { receipt = r; });
      let calls = 0;
      const mock = await fixtureServer((_req, res) => {
        calls++;
        if (calls === 1) receipt();
        else { res.setHeader("Content-Type", "application/json"); res.end(envelope()); }
      });
      const child = () => spawn(process.execPath, ["/tmp/thread-ai-recovery-child.cjs", job.jobId, mock.baseURL], { env: process.env, stdio: "inherit" });
      try {
        const first = child();
        await Promise.race([sent, new Promise((_, reject) => setTimeout(() => reject(new Error("child never dispatched")), 10000).unref())]);
        const exited = new Promise<void>(resolve => first.once("exit", () => resolve()));
        first.kill("SIGKILL");
        await exited;
        assert.equal((await jobState(job)).status, "running");
        await new Promise(resolve => setTimeout(resolve, 550)); // actual lease expiry, excluded from recorded execution time
        const second = child();
        const code = await new Promise<number | null>(resolve => second.once("exit", resolve));
        assert.equal(code, 0);
        const saved = await jobState(job);
        assert.equal(saved.status, "succeeded");
        assert.equal(saved.attempts, 2);
        assert.equal(calls, 2);
        assert.ok((await eventNames(job)).includes("ai.worker.interrupted"));
      } finally { await mock.close(); }
    });
    await t.test("live managed provider request returns grounded intelligence", { skip: process.env.THREAD_LIVE_AI_TEST !== "1" }, async sub => {
      const job = await newJob();
      for (let n = 0; n < 3; n++) {
        await runOneAIJob({ jobId: job.jobId, retryBaseMs: 0 });
        if ((await jobState(job)).status !== "retry_wait") break;
      }
      const saved = await jobState(job);
      assert.equal(saved.status, "succeeded", `Live provider outcome: ${saved.status}/${saved.lastError}`);
      assert.equal(saved.source, "ai");
      validateIntelligence(saved.result, original);
      const events = (await api(`/workflows/${job.workflowId}/events`)).body;
      sub.diagnostic(`REAL managed provider evidence: ${JSON.stringify(events.map((e: any) => ({ name: e.name, attempt: e.attempt, outcome: e.outcome, measuredMs: e.durationMs })))}`);
    });
    await t.test("AI budget exhaustion persists an explicit fallback without dispatching or changing originals", async () => {
      const job = await newJob();
      const key = createHash("sha256").update(`ai-owner:${owner}`).digest("hex");
      const previous = (await pool.query("SELECT count,expires_at FROM rate_limits WHERE key=$1", [key])).rows[0];
      await pool.query(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,60,now()+interval '1 day')
        ON CONFLICT(key) DO UPDATE SET count=60,expires_at=EXCLUDED.expires_at`, [key]);
      let calls = 0;
      try {
        await runOneAIJob({ jobId: job.jobId, provider: async () => { calls++; return fixture; } });
        const saved = await jobState(job);
        assert.equal(saved.status, "fallback"); assert.equal(saved.source, "fallback");
        assert.equal(saved.lastError, "AI_BUDGET_EXHAUSTED"); assert.equal(calls, 0);
        const names = await eventNames(job);
        assert.ok(names.includes("ai.budget.reserved") && names.includes("ai.fallback.persisted"));
        assert.ok(!names.includes("ai.external_call") && !names.includes("ai.call.dispatch_intent"));
        const snapshot = (await pool.query("SELECT understanding,notes,next_action FROM checkpoints WHERE id=$1", [job.checkpointId])).rows[0];
        assert.equal(snapshot.understanding, original.understanding);
        assert.equal(snapshot.notes, original.notes); assert.equal(snapshot.next_action, original.nextAction);
      } finally {
        if (previous) await pool.query("UPDATE rate_limits SET count=$2,expires_at=$3 WHERE key=$1", [key, previous.count, previous.expires_at]);
        else await pool.query("DELETE FROM rate_limits WHERE key=$1", [key]);
      }
    });
    await reviewChecks(t, api, owner, other, missionId, cp, original);
    await t.test("mission continuation uses the latest draft while checkpoints and review identity stay historical", async () => {
      const made = await api("/missions", "POST", { title: "Continuity provenance regression", subject: "", goal: "", requestKey: randomUUID() });
      assert.equal(made.status, 201);
      const id = made.body.id;
      const values = { notes: "Notes stay as authored", understanding: "", questions: "", reasoning: "", nextAction: "Old checkpoint action" };
      const draft = await api(`/missions/${id}/draft`, "PUT", { ...values, version: 0 });
      assert.equal(draft.status, 200);
      const saved = await api(`/missions/${id}/checkpoints`, "POST", { ...values, version: draft.body.version, requestKey: randomUUID(), simulateFailure: true });
      assert.equal(saved.status, 201);
      const workspace = await api(`/missions/${id}`);
      const latest = { ...values, nextAction: "New current draft action\nwith a second line" };
      assert.equal((await api(`/missions/${id}/draft`, "PUT", { ...latest, version: workspace.body.draft.version })).status, 200);
      const listed = (await api("/missions")).body.find((m: any) => m.id === id);
      assert.equal(listed.nextAction, latest.nextAction);
      const historical = (await api(`/missions/${id}`)).body.checkpoints[0];
      assert.equal(historical.nextAction, values.nextAction);
      assert.equal(historical.notes, values.notes);
      assert.equal(historical.enhancementStatus, "queued");
      const run = await api(`/workflows/${saved.body.workflowId}`);
      assert.equal(run.status, 200);
      assert.equal(run.body.operation, "checkpoint.create");
      assert.equal(run.body.status, "saved");
      assert.equal(run.body.missionId, id);
      assert.equal((await api(`/workflows/${saved.body.workflowId}`, "GET", undefined, other)).status, 404);
      const schedule = (await api("/reviews")).body.items.find((r: any) => r.checkpointId === saved.body.id);
      assert.equal(schedule.checkpointNextAction, values.nextAction);
      assert.equal(schedule.checkpointCreatedAt, saved.body.createdAt);
    });
  } finally {
    await transaction(async c => {
      await c.query("DELETE FROM recall_attempts WHERE review_id IN (SELECT id FROM review_schedules WHERE owner=ANY($1))", [[owner, other]]);
      await c.query("DELETE FROM review_schedules WHERE owner=ANY($1)", [[owner, other]]);
      await c.query("DELETE FROM resumptions WHERE mission_id IN (SELECT id FROM missions WHERE owner=$1)", [owner]);
      await c.query("DELETE FROM ai_jobs WHERE owner=ANY($1)", [[owner, other]]);
      await c.query("DELETE FROM checkpoints WHERE mission_id IN (SELECT id FROM missions WHERE owner=$1)", [owner]);
      await c.query("DELETE FROM drafts WHERE mission_id IN (SELECT id FROM missions WHERE owner=$1)", [owner]);
      await c.query("DELETE FROM execution_events WHERE workflow_id IN (SELECT id FROM workflows WHERE owner=ANY($1))", [[owner, other]]);
      await c.query("DELETE FROM execution_updates WHERE owner=ANY($1)", [[owner, other]]);
      await c.query("DELETE FROM workflows WHERE owner=ANY($1)", [[owner, other]]);
      await c.query("DELETE FROM request_records WHERE owner=ANY($1)", [[owner, other]]);
      await c.query("DELETE FROM missions WHERE owner=$1", [owner]);
      await c.query("DELETE FROM rate_limits WHERE key=ANY($1::text[])", [[owner, other].map(identity => createHash("sha256").update(`ai-owner:${identity}`).digest("hex"))]);
    });
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await pool.end();
  }
});
