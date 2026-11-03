import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { nextReview } from "../src/lib/retrieval";

type Api = (path: string, method?: string, data?: unknown, identity?: string | null) => Promise<{ status: number; body: any }>;
export async function reviewChecks(t: TestContext, api: Api, owner: string, other: string, missionId: string, cp: any, original: any) {
  const base = { intervalMinutes: 1440, repetitions: 0, lapses: 0, ease: 2.5 };
  const fixed = new Date("2026-03-08T07:30:00.000Z");
  await t.test("spacing algorithm has transparent, deterministic grade intervals and UTC arithmetic", () => {
    for (const [grade, minutes] of [["again", 10], ["hard", 1440], ["good", 1440], ["easy", 5760]] as const) {
      const result = nextReview(base, grade, fixed);
      assert.equal(result.intervalMinutes, minutes);
      assert.equal(new Date(result.dueAt).getTime() - fixed.getTime(), minutes * 60000);
    }
    const first = nextReview(base, "good", fixed);
    const second = nextReview(first, "good", fixed);
    assert.equal(second.intervalMinutes, 4320);
    const third = nextReview(second, "good", fixed);
    assert.equal(third.intervalMinutes, 11520);
    assert.equal(nextReview(third, "again", fixed).repetitions, 0);
    assert.equal(nextReview(third, "again", fixed).lapses, 1);
    assert.equal(nextReview({ ...base, ease: 1.3 }, "hard", fixed).ease, 1.3);
    assert.equal(nextReview({ ...base, ease: 3 }, "easy", fixed).ease, 3);
    assert.equal(nextReview({ ...base, repetitions: 50, intervalMinutes: 365 * 1440 }, "easy", fixed).intervalMinutes, 365 * 1440);
    assert.throws(() => nextReview({ ...base, ease: NaN }, "good", fixed));
    assert.throws(() => nextReview(base, "invalid" as any, fixed));
  });
  let review: any;
  let session: any;
  await t.test("new checkpoints atomically schedule one review and duplicate enrollment is safe", async () => {
    const enrolled = await api(`/checkpoints/${cp.id}/review`, "POST", { requestKey: randomUUID() });
    assert.equal(enrolled.status, 200);
    review = enrolled.body;
    assert.equal(review.checkpointId, cp.id);
    assert.equal(review.version, 0);
    assert.equal(review.algorithmVersion, "thread-spacing-v1");
    assert.ok(new Date(review.dueAt).getTime() > Date.now() + 23 * 3600000);
    const repeated = await Promise.all([1, 2, 3].map(() => api(`/checkpoints/${cp.id}/review`, "POST", { requestKey: randomUUID() })));
    assert.ok(repeated.every(r => r.body.id === review.id));
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM review_schedules WHERE checkpoint_id=$1", [cp.id])).rows[0].n, 1);
    assert.equal((await api(`/reviews/${review.id}`)).body.session, null);
  });
  await t.test("review lists use actual schedules, upcoming/overdue counts, and mission scoping", async () => {
    const listed = await api(`/reviews?missionId=${missionId}`);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((r: any) => r.id === review.id));
    assert.ok(listed.body.counts.upcoming >= 1);
    await pool.query("UPDATE review_schedules SET due_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [review.id]);
    const overdue = await api(`/reviews?missionId=${missionId}`);
    assert.equal(overdue.body.counts.overdue, 1);
    assert.equal(overdue.body.items[0].id, review.id);
    assert.equal((await api(`/reviews?missionId=${missionId}`, "GET", undefined, other)).status, 404);
  });
  await t.test("blind retrieval freezes a question and does not leak reference in any pending response", async () => {
    const input = { requestKey: randomUUID() };
    const started = await api(`/reviews/${review.id}/start`, "POST", input);
    assert.equal(started.status, 200);
    session = started.body.session;
    assert.ok(session.question);
    assert.equal(session.reference, null);
    assert.equal(session.answer, null);
    assert.ok(!JSON.stringify(started.body).includes(original.notes));
    const repeated = await Promise.all([api(`/reviews/${review.id}/start`, "POST", input), api(`/reviews/${review.id}/start`, "POST", { requestKey: randomUUID() })]);
    assert.ok(repeated.every(r => r.body.session.id === session.id));
    assert.equal((await api(`/reviews/${review.id}`)).body.session.reference, null);
    const pendingHistory = await api(`/recall-history?reviewId=${review.id}`);
    assert.equal(pendingHistory.body.items[0].reference, null);
    const privateSnapshot = (await pool.query("SELECT reference FROM recall_attempts WHERE id=$1", [session.id])).rows[0].reference;
    assert.equal(privateSnapshot.notes, original.notes);
  });
  await t.test("rating before an answer and empty answers are rejected without changing schedule", async () => {
    assert.equal((await api(`/recall-attempts/${session.id}/rating`, "POST", { requestKey: randomUUID(), difficulty: "easy" })).status, 409);
    assert.equal((await api(`/recall-attempts/${session.id}/answer`, "POST", { requestKey: randomUUID(), answer: "   " })).status, 400);
    assert.equal((await api(`/reviews/${review.id}`)).body.schedule.version, 0);
  });
  const answerInput = { requestKey: randomUUID(), answer: "Nearby values determine the limit, even when f(a) is missing." };
  await t.test("committed answers reveal reference, survive fresh requests, and cannot be overwritten", async () => {
    const answers = await Promise.all([1, 2, 3].map(() => api(`/recall-attempts/${session.id}/answer`, "POST", answerInput)));
    assert.ok(answers.every(r => r.status === 200 && r.body.session.answer === answerInput.answer));
    assert.equal(answers[0].body.session.reference.notes, original.notes);
    const fresh = await api(`/reviews/${review.id}`);
    assert.equal(fresh.body.session.answer, answerInput.answer);
    assert.equal(fresh.body.session.difficulty, null);
    assert.equal(fresh.body.session.reference.reasoning, original.reasoning);
    assert.equal((await api(`/recall-attempts/${session.id}/answer`, "POST", { ...answerInput, answer: "Changed answer" })).status, 409);
    assert.equal((await api(`/recall-attempts/${session.id}/answer`, "POST", { requestKey: randomUUID(), answer: "Replace historical answer" })).status, 409);
  });
  await t.test("difficulty submissions are atomic, idempotent, and advance the schedule only once", async () => {
    const data = { requestKey: randomUUID(), difficulty: "good" };
    const results = await Promise.all([1, 2, 3].map(() => api(`/recall-attempts/${session.id}/rating`, "POST", data)));
    assert.ok(results.every(r => r.status === 200 && r.body.schedule.version === 1));
    const rated = results[0].body.session;
    assert.equal(rated.difficulty, "good");
    assert.equal(rated.intervalMinutes, 1440);
    assert.equal(new Date(rated.nextDueAt).getTime() - new Date(rated.ratedAt).getTime(), 1440 * 60000);
    assert.equal(results[0].body.schedule.answeredCount, 1);
    assert.equal(results[0].body.schedule.ratedCount, 1);
    assert.equal((await api(`/recall-attempts/${session.id}/rating`, "POST", { requestKey: randomUUID(), difficulty: "easy" })).status, 409);
    assert.equal((await api(`/recall-attempts/${session.id}/rating`, "POST", { requestKey: randomUUID(), difficulty: "good" })).body.schedule.version, 1);
    assert.ok((await api(`/reviews/${review.id}`)).body.session.ratedAt);
  });
  await t.test("review answers and references remain private across owners and after sign-out", async () => {
    for (const path of [`/reviews/${review.id}`, `/recall-history?reviewId=${review.id}`]) {
      assert.equal((await api(path, "GET", undefined, other)).status, 404);
      assert.equal((await api(path, "GET", undefined, null)).status, 401);
    }
    assert.equal((await api(`/recall-attempts/${session.id}/answer`, "POST", answerInput, other)).status, 404);
    assert.equal((await api(`/recall-attempts/${session.id}/rating`, "POST", { requestKey: randomUUID(), difficulty: "easy" }, other)).status, 404);
  });
  await t.test("a failed schedule write rolls back the rating and recovers with the identical request", async () => {
    const started = await api(`/reviews/${review.id}/start`, "POST", { requestKey: randomUUID() });
    const second = started.body.session;
    await api(`/recall-attempts/${second.id}/answer`, "POST", { requestKey: randomUUID(), answer: "I still confuse the point value with nearby values." });
    const name = `review_fault_${randomUUID().replaceAll("-", "")}`;
    const data = { requestKey: randomUUID(), difficulty: "again" };
    try {
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN IF NEW.id='${review.id}'::uuid THEN RAISE EXCEPTION 'isolated test-only write failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${name} BEFORE UPDATE ON review_schedules FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const failed = await api(`/recall-attempts/${second.id}/rating`, "POST", data);
      assert.equal(failed.status, 500);
      const unchanged = await api(`/reviews/${review.id}`);
      assert.equal(unchanged.body.schedule.version, 1);
      assert.equal(unchanged.body.session.difficulty, null);
      assert.equal(unchanged.body.session.answer, "I still confuse the point value with nearby values.");
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM request_records WHERE owner=$1 AND key=$2", [owner, data.requestKey])).rows[0].n, 0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON review_schedules; DROP FUNCTION IF EXISTS ${name}()`);
    }
    const retried = await api(`/recall-attempts/${second.id}/rating`, "POST", data);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.schedule.version, 2);
    assert.equal(retried.body.session.intervalMinutes, 10);
    assert.equal(retried.body.schedule.lapses, 1);
    const persisted = await api(`/recall-history?reviewId=${review.id}`);
    assert.equal(persisted.body.items.length, 2);
    assert.equal(persisted.body.items[0].difficulty, "again");
    assert.equal(persisted.body.items[1].answer, answerInput.answer);
  });
  await t.test("recall history pagination retains older attempts without overlap", async () => {
    const initial = (await pool.query("SELECT reference,workflow_id FROM recall_attempts WHERE id=$1", [session.id])).rows[0];
    await pool.query(`INSERT INTO recall_attempts(review_id,schedule_version,question,question_source,reference,workflow_id,started_at)
      SELECT $1,100+n,'Pagination fixture question','fallback',$2,$3,clock_timestamp()-(n*interval '1 minute') FROM generate_series(1,52) n`,
    [review.id, JSON.stringify(initial.reference), initial.workflow_id]);
    const first = await api(`/recall-history?reviewId=${review.id}`);
    assert.equal(first.body.items.length, 50);
    assert.ok(first.body.nextCursor);
    const rest = await api(`/recall-history?reviewId=${review.id}&cursor=${first.body.nextCursor}`);
    assert.equal(rest.body.items.length, 4);
    assert.equal(new Set([...first.body.items, ...rest.body.items].map((a: any) => a.id)).size, 54);
    assert.ok([...first.body.items, ...rest.body.items].filter((a: any) => !a.answeredAt).every((a: any) => a.reference === null));
  });
  await t.test("execution history has complete persisted parity, boundary provenance, real commit timings and pagination", async () => {
    const all: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await api(`/execution/history${cursor ? `?cursor=${cursor}` : ""}`);
      assert.equal(page.status, 200);
      all.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor);
    const records = (await pool.query(`SELECT e.*,w.operation FROM execution_events e JOIN workflows w ON w.id=e.workflow_id WHERE w.owner=$1
      ORDER BY e.created_at DESC,e.workflow_id DESC,e.sequence DESC`, [owner])).rows;
    assert.equal(all.length, records.length);
    assert.equal(new Set(all.map(r => r.event.id)).size, records.length);
    all.forEach((r, i) => {
      const db = records[i];
      assert.equal(r.event.id, db.id);
      assert.equal(r.event.durationMs, db.duration_ms);
      assert.equal(r.event.sourceComponent, db.source_component);
      assert.equal(r.event.destinationComponent, db.destination_component);
      assert.equal(r.event.details, db.details);
      assert.equal(r.operation, db.operation);
      assert.ok(Number.isFinite(r.event.durationMs) && r.event.durationMs >= 0);
    });
    assert.ok(all.some(r => r.event.name === "transaction.commit.confirmed" && r.event.durationMs > 0));
    assert.ok(all.some(r => r.event.name === "request.receipt.persisted" && r.event.destinationComponent === "database"));
    assert.ok(all.some(r => r.event.name === "review.rating.persisted" && r.event.sourceComponent === "server" && r.event.destinationComponent === "database"));
    assert.ok(all.some(r => r.event.name === "request.rejected" && r.event.outcome === "failure"));
    assert.ok(!JSON.stringify(all).includes(answerInput.answer));
    assert.equal((await api(`/execution/history?cursor=${all[0].event.id}`, "GET", undefined, other)).status, 400);
  });
}
