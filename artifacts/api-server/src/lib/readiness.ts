import { pool } from "@workspace/db";

export async function assertRuntimeIsolation(mode = process.env.NODE_ENV, keys = process.env) {
  if (mode !== "production") {
    const production = await pool.query("SELECT scope FROM environment_markers WHERE scope='production'");
    if (production.rowCount) throw new Error("PRODUCTION_DATA_IN_DEVELOPMENT");
    await pool.query("INSERT INTO environment_markers(scope) VALUES('development') ON CONFLICT DO NOTHING");
    return;
  }
  if (!keys.CLERK_SECRET_KEY?.startsWith("sk_live_") || !keys.CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_")) {
    throw new Error("PRODUCTION_CLERK_KEYS_REQUIRED");
  }
  let validProviderURL = false;
  try { validProviderURL = ["http:", "https:"].includes(new URL(keys.AI_INTEGRATIONS_OPENAI_BASE_URL || "").protocol); } catch { /* Refuse malformed configuration. */ }
  // Replit provisions this server-only proxy URL; internal managed gateways
  // need not use the same transport as a public provider endpoint.
  if (!keys.AI_INTEGRATIONS_OPENAI_API_KEY || !validProviderURL) {
    throw new Error("PRODUCTION_AI_CONFIGURATION_REQUIRED");
  }
  const marker = await pool.query("SELECT scope FROM environment_markers WHERE scope='development'");
  if (marker.rowCount) throw new Error("DEVELOPMENT_DATA_IN_PRODUCTION");
  const unclassified = await pool.query(`SELECT
    NOT EXISTS(SELECT 1 FROM environment_markers WHERE scope='production') AND
    (EXISTS(SELECT 1 FROM missions) OR EXISTS(SELECT 1 FROM checkpoints) OR EXISTS(SELECT 1 FROM ai_jobs))
    AS unsafe`);
  if (unclassified.rows[0].unsafe) throw new Error("PRODUCTION_DATABASE_NOT_EMPTY");
  // DML only. Schema is applied by Replit's Publish flow, NEVER by startup.
  await pool.query("INSERT INTO environment_markers(scope) VALUES('production') ON CONFLICT DO NOTHING");
}

let lastCheck = 0;
let available = false;
let checking: Promise<boolean> | null = null;
export function databaseReady(): Promise<boolean> {
  if (Date.now() - lastCheck < 5000) return Promise.resolve(available);
  if (checking) return checking;
  checking = (async () => {
    try {
      const result = await pool.query(`WITH required_tables(name) AS (VALUES
        ('missions'),('drafts'),('checkpoints'),('resumptions'),('request_records'),
        ('workflows'),('execution_events'),('execution_updates'),('ai_jobs'),
        ('review_schedules'),('recall_attempts'),('environment_markers'),('rate_limits'),
        ('operational_alerts'),('operational_deliveries')),
        required_columns(tbl,col) AS (VALUES
        ('execution_events','source_component'),('execution_events','destination_component'),
        ('ai_jobs','lease_token'),('ai_jobs','lease_until'),('ai_jobs','queue'),
        ('review_schedules','version'),('review_schedules','algorithm_version'))
        SELECT NOT EXISTS(SELECT 1 FROM required_tables WHERE to_regclass('public.'||name) IS NULL)
        AND NOT EXISTS(SELECT 1 FROM required_columns r WHERE NOT EXISTS(
          SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public'
          AND c.table_name=r.tbl AND c.column_name=r.col)) AS ready`);
      available = result.rows[0]?.ready === true;
    } catch { available = false; }
    lastCheck = Date.now(); checking = null;
    return available;
  })();
  return checking;
}
