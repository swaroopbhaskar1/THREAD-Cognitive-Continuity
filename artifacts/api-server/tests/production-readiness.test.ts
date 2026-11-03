import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import express from "express";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import { securityHeadersAndAdmission, protectLearningAPI, safeRequestErrors } from "../src/middlewares/security";
import { consumeLimit, reserveAICall } from "../src/lib/limits";
import { assertRuntimeIsolation, databaseReady } from "../src/lib/readiness";
import { requestIntelligence, validateIntelligence } from "../src/lib/ai-content";
import { streamExecution } from "../src/lib/event-stream";

test("Production readiness safeguards (development database; test-only identity adapter)", async t => {
  const owner = `readiness-${randomUUID()}`;
  const bucket = `readiness-${randomUUID()}`;
  const keys: string[] = [];
  const hash = (b: string, identity: string) => {
    const key = createHash("sha256").update(`${b}:${identity}`).digest("hex"); keys.push(key); return key;
  };
  const app = express();
  app.set("trust proxy", 1); app.disable("x-powered-by");
  app.use(pinoHttp({ enabled: false }), securityHeadersAndAdmission, express.json({ limit: "1mb", inflate: false }));
  app.use("/api", protectLearningAPI);
  app.get("/api/admission", (_req, res) => res.json({ ok: true }));
  app.post("/api/admission", (_req, res) => res.json({ ok: true }));
  app.get("/api/events/stream", (req, res) => streamExecution(req, res, owner));
  app.use(safeRequestErrors);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assertRuntimeIsolation("development");
    await t.test("readiness queries PostgreSQL and production refuses development data or non-live configuration", async () => {
      assert.equal(await databaseReady(), true);
      await assert.rejects(assertRuntimeIsolation("production", {}), /PRODUCTION_CLERK_KEYS_REQUIRED/);
      await assert.rejects(assertRuntimeIsolation("production", {
        CLERK_SECRET_KEY: "sk_live_nonfunctional_fixture", CLERK_PUBLISHABLE_KEY: "pk_live_nonfunctional_fixture",
        AI_INTEGRATIONS_OPENAI_API_KEY: "nonfunctional_fixture", AI_INTEGRATIONS_OPENAI_BASE_URL: "https://example.invalid",
      }), /DEVELOPMENT_DATA_IN_PRODUCTION/);
    });
    await t.test("actual production entrypoint refuses the development database before listening", () => {
      const child = spawnSync(process.execPath, [join(process.cwd(), "dist/index.mjs")], {
        timeout: 12000, encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", PORT: "19511",
          THREAD_PRODUCTION_DATABASE_URL: "",
          CLERK_SECRET_KEY: "sk_live_nonfunctional_fixture", CLERK_PUBLISHABLE_KEY: "pk_live_nonfunctional_fixture",
          AI_INTEGRATIONS_OPENAI_API_KEY: "nonfunctional_fixture", AI_INTEGRATIONS_OPENAI_BASE_URL: "https://example.invalid" },
      });
      assert.equal(child.status, 1, "Unsafe production startup must terminate, not serve learning data.");
      assert.match(child.stdout + child.stderr, /PRODUCTION_DATABASE_URL_REQUIRED/);
      assert.ok(!(child.stdout + child.stderr).includes("Server listening"));
    });
    await t.test("same-origin admission, hostile/null origins, fetch metadata and safe parser errors", async () => {
      const ok = await fetch(base + "/api/admission", { headers: { origin: base } });
      assert.equal(ok.status, 200); assert.equal(ok.headers.get("x-powered-by"), null);
      assert.equal(ok.headers.get("cache-control"), "no-store");
      assert.equal(ok.headers.get("access-control-allow-origin"), null);
      for (const origin of ["https://attacker.invalid", "null", "not-a-url", base.replace("http:", "https:")]) {
        assert.equal((await fetch(base + "/api/admission", { headers: { origin } })).status, 403);
      }
      assert.equal((await fetch(base + "/api/admission", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
      for (const [body, extra, status] of [
        ["{", {}, 400], ['"' + "x".repeat(1048576) + '"', {}, 413],
        [gzipSync(Buffer.from('{"x":1}')), { "content-encoding": "gzip" }, 415],
      ] as const) {
        const r = await fetch(base + "/api/admission", { method: "POST", headers: { "content-type": "application/json", ...extra }, body });
        assert.equal(r.status, status);
        const text = await r.text(); assert.ok(!text.includes("SyntaxError") && !text.includes("stack") && text.length < 300);
      }
    });
    await t.test("durable 300/min admission returns Retry-After without executing the handler", async () => {
      const key = hash("api-owner", owner);
      await pool.query("INSERT INTO rate_limits(key,count,expires_at) VALUES($1,299,now()+interval '60 seconds')", [key]);
      const headers = { "x-test-owner": owner };
      assert.equal((await fetch(base + "/api/admission", { headers })).status, 200);
      const denied = await fetch(base + "/api/admission", { headers });
      assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get("retry-after")) > 0);
      await pool.query("DELETE FROM rate_limits WHERE key=$1", [key]);
    });
    await t.test("concurrent durable budget increments are atomic and expired windows recover", async () => {
      const identity = randomUUID(); const key = hash(bucket, identity);
      const results = await Promise.all(Array.from({ length: 12 }, () => consumeLimit(pool, bucket, identity, 5, 60)));
      assert.equal(results.filter(r => r.allowed).length, 5);
      assert.equal((await pool.query("SELECT count FROM rate_limits WHERE key=$1", [key])).rows[0].count, 12);
      await pool.query("UPDATE rate_limits SET expires_at=now()-interval '1 second' WHERE key=$1", [key]);
      assert.equal((await consumeLimit(pool, bucket, identity, 5, 60)).allowed, true);
      assert.equal((await pool.query("SELECT count FROM rate_limits WHERE key=$1", [key])).rows[0].count, 1);
    });
    await t.test("exhausted AI allowance is rejected transactionally without making a provider call", async () => {
      const key = hash("ai-owner", owner);
      await pool.query("INSERT INTO rate_limits(key,count,expires_at) VALUES($1,60,now()+interval '1 day')", [key]);
      assert.equal(await reserveAICall(owner), false);
      assert.equal((await pool.query("SELECT count FROM rate_limits WHERE key=$1", [key])).rows[0].count, 60);
    });
    await t.test("SSE resets a future/restored cursor before backfill and releases closed connections", async () => {
      const controller = new AbortController();
      const r = await fetch(base + "/api/events/stream?after=9223372036854775807", { signal: controller.signal });
      assert.equal(r.status, 200);
      const reader = r.body!.getReader(); let text = "";
      try {
        while (!text.includes("event: reset")) {
          const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value);
        }
        assert.match(text, /id:\nevent: reset\ndata: .*"cursor":"0"/);
      } finally { controller.abort(); await reader.cancel().catch(() => {}); }
    });
    await t.test("provider response byte cap rejects oversized real HTTP fixture bodies", async () => {
      const provider = express();
      provider.post("/chat/completions", (_req, res) => res.json({ oversized: "x".repeat(70000) }));
      const stub = provider.listen(0, "127.0.0.1"); await new Promise<void>(r => stub.once("listening", r));
      const addr = stub.address(); assert.ok(addr && typeof addr === "object");
      try {
        await assert.rejects(requestIntelligence({ understanding: "", questions: "", reasoning: "", notes: "", nextAction: "" },
          { baseURL: `http://127.0.0.1:${addr.port}`, apiKey: "fixture", timeoutMs: 1000 }), /RESPONSE_TOO_LARGE/);
      } finally { await new Promise<void>(r => stub.close(() => r())); }
    });
    await t.test("a new server generation resets even an otherwise valid cursor, then reconnects with its generation", async () => {
      const old = new AbortController();
      const r = await fetch(base + "/api/events/stream?after=0&epoch=obsolete-generation", { signal: old.signal });
      const reader = r.body!.getReader(); let text = "";
      try {
        while (!text.includes("event: reset")) {
          const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value);
        }
        const control = JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
        assert.equal(control.cursor, "0"); assert.match(control.epoch, /^[0-9a-f-]{36}$/);
        old.abort(); await reader.cancel().catch(() => {});
        const current = new AbortController();
        const second = await fetch(base + `/api/events/stream?after=0&epoch=${control.epoch}`, { signal: current.signal });
        const secondReader = second.body!.getReader(); let received = "";
        const timeout = setTimeout(() => current.abort(), 150);
        try {
          while (true) {
            const part = await secondReader.read(); if (part.done) break; received += new TextDecoder().decode(part.value);
          }
        } catch { assert.equal(current.signal.aborted, true); }
        finally { clearTimeout(timeout); current.abort(); await secondReader.cancel().catch(() => {}); }
        assert.ok(!received.includes("event: reset"), "A current generation must not enter a reset/reconnect loop.");
      } finally { old.abort(); await reader.cancel().catch(() => {}); }
    });
    await t.test("isolated development pg_dump/pg_restore rehearsal preserves snapshot JSON exactly", async sub => {
      const schema = `restore_audit_${randomUUID().replace(/-/g, "")}`;
      const dir = mkdtempSync(join(tmpdir(), "thread-restore-"));
      const file = join(dir, "fixture.dump");
      const env = { ...process.env, PGDATABASE: process.env.DATABASE_URL };
      try {
        await pool.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(`CREATE TABLE "${schema}".snapshots(id integer PRIMARY KEY, original jsonb NOT NULL)`);
        await pool.query(`INSERT INTO "${schema}".snapshots VALUES(1,$1),(2,$2)`, [JSON.stringify({ label: "synthetic backup fixture", understanding: "Original content", nextAction: "Resume original work" }), JSON.stringify({ label: "synthetic review fixture", difficulty: "good", reference: { understanding: "Original content" } })]);
        const before = (await pool.query(`SELECT * FROM "${schema}".snapshots ORDER BY id`)).rows;
        const dump = spawnSync("pg_dump", ["--dbname", process.env.DATABASE_URL!, "--schema", schema, "--no-owner", "--no-acl", "--format=custom", "--file", file], { env, encoding: "utf8" });
        assert.equal(dump.status, 0, "Development fixture backup command failed (connection details withheld).");
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        const restore = spawnSync("pg_restore", ["--dbname", process.env.DATABASE_URL!, "--no-owner", "--no-acl", "--exit-on-error", file], { env, encoding: "utf8" });
        assert.equal(restore.status, 0, "Development fixture restore command failed (connection details withheld).");
        assert.deepEqual((await pool.query(`SELECT * FROM "${schema}".snapshots ORDER BY id`)).rows, before);
        sub.diagnostic("Actual development-only custom-format backup and restore: 2 synthetic rows restored, exact JSON equality. No real user tables exported, deleted or restored.");
      } finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); rmSync(dir, { recursive: true, force: true }); }
    });
  } finally {
    if (keys.length) await pool.query("DELETE FROM rate_limits WHERE key=ANY($1::text[])", [keys]);
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
});
