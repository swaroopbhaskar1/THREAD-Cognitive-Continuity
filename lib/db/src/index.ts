import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { databaseConnectionString } from "./connection";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: databaseConnectionString(process.env),
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 10000,
  lock_timeout: 5000,
});
pool.on("error", () => {
  console.error(JSON.stringify({ level: "error", event: "database.pool_error", message: "An idle database connection failed; reconnect will be attempted on demand." }));
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export type { PoolClient } from "pg";
