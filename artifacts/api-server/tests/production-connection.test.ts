import test from "node:test";
import assert from "node:assert/strict";
import { databaseConnectionString as resolveConnection } from "../../../lib/db/src/connection";

// Only explicit dummy credentials; never use a real connection string here.
const managed = "postgresql://test:dummy@managed.invalid/old?sslmode=require";
const external = "postgresql://test:dummy@external.invalid/clean?sslmode=require";
const databaseConnectionString = (env: Record<string, string | undefined>) => resolveConnection({
  THREAD_PRODUCTION_DATABASE_HOST: "external.invalid", THREAD_PRODUCTION_DATABASE_NAME: "clean", ...env,
});
test("Production-only database selection (no database writes)", async t => {
  await t.test("development uses only its existing database, even with an external secret present", () => {
    assert.equal(databaseConnectionString({ NODE_ENV: "development", DATABASE_URL: managed, THREAD_PRODUCTION_DATABASE_URL: external }), managed);
  });
  await t.test("production uses the external database with verified TLS", () => {
    const selected = new URL(databaseConnectionString({ NODE_ENV: "production", DATABASE_URL: managed, THREAD_PRODUCTION_DATABASE_URL: external }));
    assert.equal(selected.hostname, "external.invalid");
    assert.equal(selected.searchParams.get("sslmode"), "verify-full");
  });
  await t.test("a missing production secret never falls back to the managed database", () => {
    assert.throws(() => databaseConnectionString({ NODE_ENV: "production", DATABASE_URL: managed }), /PRODUCTION_DATABASE_URL_REQUIRED/);
  });
  await t.test("identical managed target is rejected even with different credentials", () => {
    assert.throws(() => databaseConnectionString({ NODE_ENV: "production", DATABASE_URL: managed,
      THREAD_PRODUCTION_DATABASE_URL: "postgresql://other:dummy@managed.invalid/old?sslmode=verify-full" }), /PRODUCTION_DATABASE_EQUALS_MANAGED/);
  });
  await t.test("malformed and non-PostgreSQL targets fail with redacted static codes", () => {
    for (const value of ["not a URL", "https://test:dummy@example.invalid/clean", "postgres://host.invalid/clean"]) {
      assert.throws(() => databaseConnectionString({ NODE_ENV: "production", THREAD_PRODUCTION_DATABASE_URL: value }), /^Error: PRODUCTION_DATABASE_URL_INVALID$/);
    }
  });
  await t.test("insecure TLS and transaction-pooler connections are rejected", () => {
    assert.throws(() => databaseConnectionString({ NODE_ENV: "production", THREAD_PRODUCTION_DATABASE_URL: external.replace("require", "disable") }), /PRODUCTION_DATABASE_TLS_REQUIRED/);
    assert.throws(() => databaseConnectionString({ NODE_ENV: "production", THREAD_PRODUCTION_DATABASE_HOST: "external-pooler.invalid",
      THREAD_PRODUCTION_DATABASE_URL: external.replace("external.invalid", "external-pooler.invalid") }), /PRODUCTION_DATABASE_DIRECT_CONNECTION_REQUIRED/);
  });
  await t.test("production requires an explicit target pin", () => {
    assert.throws(() => resolveConnection({ NODE_ENV: "production", THREAD_PRODUCTION_DATABASE_URL: external }), /PRODUCTION_DATABASE_TARGET_REQUIRED/);
  });
  await t.test("a wrong hostname or database name cannot connect", () => {
    assert.throws(() => databaseConnectionString({ NODE_ENV: "production", THREAD_PRODUCTION_DATABASE_URL: external,
      THREAD_PRODUCTION_DATABASE_HOST: "different.invalid" }), /PRODUCTION_DATABASE_TARGET_MISMATCH/);
    assert.throws(() => databaseConnectionString({ NODE_ENV: "production", THREAD_PRODUCTION_DATABASE_URL: external,
      THREAD_PRODUCTION_DATABASE_NAME: "wrong" }), /PRODUCTION_DATABASE_TARGET_MISMATCH/);
  });
});
