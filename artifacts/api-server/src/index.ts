import app from "./app";
import { logger } from "./lib/logger";
import { startAIWorker } from "./lib/ai-jobs";
import { assertRuntimeIsolation } from "./lib/readiness";
import { startOperationalMonitor } from "./lib/operational-monitor";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

try { await assertRuntimeIsolation(); }
catch (err) {
  // Never include configuration values or connection strings in startup logs.
  const code = err instanceof Error && /^(PRODUCTION_[A-Z_]+|DEVELOPMENT_DATA_IN_PRODUCTION)$/.test(err.message) ? err.message : "STARTUP_DATABASE_CHECK_FAILED";
  logger.fatal({ code }, "Startup refused; verify production isolation and environment configuration");
  process.exit(1);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  const stop = startAIWorker();
  const stopMonitor = startOperationalMonitor();
  process.once("SIGTERM", () => {
    stop();
    stopMonitor();
    server.close();
    // In-flight jobs retain their leases and are recovered on restart.
    setTimeout(() => process.exit(0), 1500).unref();
  });
});
