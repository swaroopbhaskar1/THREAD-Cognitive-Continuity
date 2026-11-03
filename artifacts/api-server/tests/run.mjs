import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// The negative production-startup test must work from a clean checkout, not
// depend on a dist/ directory left behind by a development workflow.
const productionBuild = spawnSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url))], {
  stdio: "inherit", env: { ...process.env, NODE_ENV: "production" },
});
if (productionBuild.status !== 0) process.exit(productionBuild.status ?? 1);

// Test-only aliases keep simulated identity and the fixture database selection
// out of all application/production bundles. No runtime escape flag exists.
const testClerk = {
  name: "test-only-clerk",
  setup(b) {
    b.onResolve({ filter: /^@clerk\/express$/ }, () => ({ path: fileURLToPath(new URL("./clerk-stub.ts", import.meta.url)) }));
    b.onResolve({ filter: /^\.\/connection$/ }, args => args.importer.endsWith("/lib/db/src/index.ts")
      ? { path: "fixture-database-selection", namespace: "test-only" } : undefined);
    b.onLoad({ filter: /^fixture-database-selection$/, namespace: "test-only" }, () => ({
      contents: `export function databaseConnectionString(env) {
        if (!env.DATABASE_URL) throw new Error("FIXTURE_DATABASE_REQUIRED");
        return env.DATABASE_URL;
      }`,
      loader: "js",
    }));
  },
};
await build({
  entryPoints: [fileURLToPath(new URL("./checkpoint-recovery-child.ts", import.meta.url))],
  outfile: "/tmp/thread-checkpoint-recovery-child.cjs", bundle: true, platform: "node", format: "cjs",
  plugins: [testClerk],
});
const outfile = "/tmp/thread-continuity-tests.cjs";
await build({
  entryPoints: [fileURLToPath(new URL("./demand-recovery-child.ts", import.meta.url))],
  outfile: "/tmp/thread-demand-recovery-child.cjs", bundle: true, platform: "node", format: "cjs",
  plugins: [testClerk],
});
await build({
  entryPoints: [fileURLToPath(new URL("./ai-recovery-child.ts", import.meta.url))],
  outfile: "/tmp/thread-ai-recovery-child.cjs", bundle: true, platform: "node", format: "cjs",
  plugins: [testClerk],
});
await build({
  entryPoints: [fileURLToPath(new URL("./continuity.test.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "cjs",
  plugins: [testClerk],
  external: [],
});
// Bundle workspace imports so temporary output does not depend on module lookup from /tmp.
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), outfile], { stdio: "inherit", env: {
  ...process.env, NODE_ENV: "production", THREAD_AI_QUEUE: `integration-${randomUUID()}`,
} });
process.exitCode = result.status ?? 1;
