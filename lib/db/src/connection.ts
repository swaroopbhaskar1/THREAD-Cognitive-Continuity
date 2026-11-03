type DatabaseEnvironment = Record<string, string | undefined>;

// Production never falls back to either Replit-managed database. Development
// deliberately ignores the production-only secret, even if mis-scoped.
export function databaseConnectionString(env: DatabaseEnvironment): string {
  if (env.NODE_ENV !== "production") {
    if (!env.DATABASE_URL) throw new Error("DEVELOPMENT_DATABASE_URL_REQUIRED");
    return env.DATABASE_URL;
  }
  if (!env.THREAD_PRODUCTION_DATABASE_URL?.trim()) throw new Error("PRODUCTION_DATABASE_URL_REQUIRED");
  let target: URL;
  try { target = new URL(env.THREAD_PRODUCTION_DATABASE_URL); }
  catch { throw new Error("PRODUCTION_DATABASE_URL_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !target.hostname || !target.username || !target.password || target.pathname.length < 2) {
    throw new Error("PRODUCTION_DATABASE_URL_INVALID");
  }
  if (env.DATABASE_URL) {
    let managed: URL | undefined;
    try { managed = new URL(env.DATABASE_URL); } catch { /* Target still validates independently. */ }
    if (managed && target.hostname === managed.hostname && target.pathname === managed.pathname) {
      throw new Error("PRODUCTION_DATABASE_EQUALS_MANAGED");
    }
  }
  if (!env.THREAD_PRODUCTION_DATABASE_HOST || !env.THREAD_PRODUCTION_DATABASE_NAME) {
    throw new Error("PRODUCTION_DATABASE_TARGET_REQUIRED");
  }
  if (target.hostname !== env.THREAD_PRODUCTION_DATABASE_HOST ||
      decodeURIComponent(target.pathname.slice(1)) !== env.THREAD_PRODUCTION_DATABASE_NAME) {
    throw new Error("PRODUCTION_DATABASE_TARGET_MISMATCH");
  }
  if (target.hostname.includes("-pooler.")) throw new Error("PRODUCTION_DATABASE_DIRECT_CONNECTION_REQUIRED");
  // LISTEN requires a session-preserving connection. Certificate verification
  // must not weaken when the pg driver's libpq compatibility defaults change.
  if (!["require", "verify-full"].includes(target.searchParams.get("sslmode") ?? "")) {
    throw new Error("PRODUCTION_DATABASE_TLS_REQUIRED");
  }
  target.searchParams.set("sslmode", "verify-full");
  target.searchParams.delete("uselibpqcompat");
  return target.toString();
}
