import { pool } from "@workspace/db";
import { runOneAIJob, nextAIJobDelay } from "../src/lib/ai-jobs";
import { createDemandWorker } from "../src/lib/demand-worker";

const options = { jobId: process.argv[2], retryBaseMs: 400 };
const worker = createDemandWorker({
  runOne: () => runOneAIJob(options),
  nextDelay: async () => {
    const delay = await nextAIJobDelay(options);
    if (delay !== null) process.send?.({ kind: "deadline", delay });
    return delay;
  },
  onError: () => { process.send?.({ kind: "error" }); },
  onIdle: () => {
    worker.stop();
    void pool.end().then(() => { process.disconnect?.(); });
  },
});
worker.start();
