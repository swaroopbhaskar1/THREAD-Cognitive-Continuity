// A single-process wake-up driver. Durable job state, not these timers, owns
// scheduling. No periodic work exists once reconciliation finds an empty queue.
export type DemandWorkerOptions = {
  runOne: () => Promise<boolean>;
  nextDelay: () => Promise<number | null>;
  onError?: () => void;
  onIdle?: () => void;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  failureBaseMs?: number;
  failureCapMs?: number;
};

const scheduleTimer = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createDemandWorker(options: DemandWorkerOptions) {
  const schedule = options.schedule ?? scheduleTimer;
  let stopped = true, busy = false, requested = false;
  let cancelTimer: (() => void) | undefined;
  let failures = 0;
  const counters = { wakeups: 0, claimChecks: 0, deadlineChecks: 0, errors: 0 };
  let nextWakeInMs: number | null = null;

  function clearTimer() {
    cancelTimer?.();
    cancelTimer = undefined;
    nextWakeInMs = null;
  }
  function arm(delay: number) {
    clearTimer();
    // setTimeout overflows above ~24 days; re-reconcile at that boundary.
    nextWakeInMs = Math.max(1, Math.min(2_147_483_647, Math.ceil(delay)));
    cancelTimer = schedule(wake, nextWakeInMs);
  }
  async function drain() {
    if (stopped || busy) return;
    busy = true;
    try {
      do {
        requested = false;
        while (!stopped) {
          counters.claimChecks++;
          if (!await options.runOne()) break;
          failures = 0;
          // Yield without another timer or SQL operation.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (stopped) return;
        counters.deadlineChecks++;
        const delay = await options.nextDelay();
        failures = 0;
        // A checkpoint committed while either await was pending. Do not lose
        // its wake-up by going idle or arming an obsolete deadline.
        if (requested) continue;
        if (delay !== null) arm(delay);
        else options.onIdle?.();
      } while (requested && !stopped);
    } catch {
      counters.errors++;
      failures++;
      options.onError?.();
      if (!stopped) arm(Math.min(options.failureCapMs ?? 60_000,
        (options.failureBaseMs ?? 1000) * 2 ** Math.min(failures - 1, 16)));
    } finally {
      busy = false;
    }
  }
  function wake() {
    if (stopped) return;
    counters.wakeups++;
    requested = true;
    clearTimer();
    void drain();
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      wake();
    },
    wake,
    stop() { stopped = true; requested = false; clearTimer(); },
    // In-memory diagnostics never query or write PostgreSQL.
    snapshot: () => ({ ...counters, stopped, busy, nextWakeInMs }),
  };
}
