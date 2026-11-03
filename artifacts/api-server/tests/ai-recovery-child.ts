import { runOneAIJob } from "../src/lib/ai-jobs";
import { pool } from "@workspace/db";
runOneAIJob({
  jobId: process.argv[2], leaseMs: 500, retryBaseMs: 0,
  providerOptions: { baseURL: process.argv[3], apiKey: "local-fixture", timeoutMs: 5000 },
}).then(() => pool.end()).catch(() => { process.exitCode = 1; return pool.end(); });
