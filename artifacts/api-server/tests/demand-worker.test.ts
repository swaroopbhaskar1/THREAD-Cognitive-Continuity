import test from "node:test";
import assert from "node:assert/strict";
import { createDemandWorker } from "../src/lib/demand-worker";

async function settled(worker: ReturnType<typeof createDemandWorker>) {
  for (let i = 0; i < 200; i++) {
    if (!worker.snapshot().busy) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("Worker did not settle");
}
function timers() {
  let clock = 0, serial = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    schedule(callback: () => void, delay: number) {
      const id = ++serial; pending.set(id, { at: clock + delay, callback });
      return () => { pending.delete(id); };
    },
    async advance(ms: number, worker: ReturnType<typeof createDemandWorker>) {
      const target = clock + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        pending.delete(next[0]); clock = next[1].at; next[1].callback();
        await settled(worker);
      }
      clock = target;
    },
    now: () => clock,
    count: () => pending.size,
  };
}

test("Demand-driven worker scheduling (controlled clock, no external AI)", async t => {
  await t.test("empty startup stays query-free through a simulated idle month", async () => {
    const time = timers();
    let queries = 0;
    const worker = createDemandWorker({ schedule: time.schedule,
      runOne: async () => { queries++; return false; },
      nextDelay: async () => { queries++; return null; } });
    worker.start(); await settled(worker);
    assert.equal(queries, 2); assert.equal(time.count(), 0);
    await time.advance(31 * 86400_000, worker);
    assert.equal(queries, 2);
    worker.stop();
  });
  await t.test("durable delayed jobs run no earlier than their deadline", async () => {
    const time = timers();
    let done = false, runs = 0;
    const worker = createDemandWorker({ schedule: time.schedule,
      runOne: async () => {
        if (done || time.now() < 2000) return false;
        runs++; done = true; return true;
      },
      nextDelay: async () => done ? null : 2000 - time.now() });
    worker.start(); await settled(worker);
    await time.advance(1999, worker); assert.equal(runs, 0);
    await time.advance(1, worker); assert.equal(runs, 1); assert.equal(time.count(), 0);
    worker.stop();
  });
  await t.test("new earlier work cancels an old timer and drains without overlap", async () => {
    const time = timers();
    let ready = false, consumed = 0;
    const worker = createDemandWorker({ schedule: time.schedule,
      runOne: async () => { if (!ready) return false; ready = false; consumed++; return true; },
      nextDelay: async () => 10_000 });
    worker.start(); await settled(worker);
    ready = true; worker.wake(); worker.wake(); await settled(worker);
    assert.equal(consumed, 1); assert.equal(time.count(), 1);
    worker.stop(); assert.equal(time.count(), 0);
  });
  await t.test("a wake-up during an empty deadline read cannot be lost", async () => {
    let release!: () => void;
    let reading!: () => void;
    const entered = new Promise<void>(resolve => { reading = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let ready = false, reads = 0, consumed = 0;
    const worker = createDemandWorker({
      runOne: async () => { if (!ready) return false; ready = false; consumed++; return true; },
      nextDelay: async () => { if (++reads === 1) { reading(); await blocked; } return null; },
    });
    worker.start(); await entered;
    ready = true; worker.wake(); release(); await settled(worker);
    assert.equal(consumed, 1); assert.equal(worker.snapshot().nextWakeInMs, null);
    worker.stop();
  });
  await t.test("database-unavailable injection backs off to a cap then resumes and sleeps", async () => {
    const time = timers();
    let unavailable = true;
    const delays: number[] = [];
    const worker = createDemandWorker({
      schedule: (callback, delay) => { delays.push(delay); return time.schedule(callback, delay); },
      failureBaseMs: 1000, failureCapMs: 4000,
      runOne: async () => { if (unavailable) throw new Error("CONTROLLED_DATABASE_UNAVAILABLE"); return false; },
      nextDelay: async () => null,
    });
    worker.start(); await settled(worker);
    await time.advance(11_000, worker);
    assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000]);
    unavailable = false;
    await time.advance(4000, worker);
    assert.equal(time.count(), 0);
    const checks = worker.snapshot().claimChecks;
    await time.advance(86400_000, worker);
    assert.equal(worker.snapshot().claimChecks, checks);
    worker.stop();
  });
  await t.test("an idle database wakes only on demand; transient deadline-query failure recovers", async () => {
    const time = timers();
    let suspended = false, ready = false, firstDeadlineFailure = false, consumed = 0;
    const worker = createDemandWorker({ schedule: time.schedule,
      runOne: async () => {
        // Controlled stand-in for the managed service's reconnect-on-query contract.
        if (suspended) suspended = false;
        if (!ready) return false;
        ready = false; consumed++; firstDeadlineFailure = true; return true;
      },
      nextDelay: async () => {
        if (firstDeadlineFailure) { firstDeadlineFailure = false; throw new Error("CONTROLLED_RECONNECT_ERROR"); }
        return null;
      } });
    worker.start(); await settled(worker);
    suspended = true;
    await time.advance(600_000, worker); assert.equal(suspended, true);
    ready = true; worker.wake(); await settled(worker);
    assert.equal(suspended, false); assert.equal(consumed, 1);
    await time.advance(1000, worker); assert.equal(time.count(), 0);
    worker.stop();
  });
  await t.test("stop during in-flight reconciliation prevents rearming", async () => {
    const time = timers();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const worker = createDemandWorker({ schedule: time.schedule,
      runOne: async () => { await blocked; return false; }, nextDelay: async () => 20 });
    worker.start(); worker.stop(); release(); await settled(worker);
    assert.equal(time.count(), 0); assert.equal(worker.snapshot().deadlineChecks, 0);
  });
});
