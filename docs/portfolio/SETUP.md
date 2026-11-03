# Setup and configuration

## Supported starting point: Replit

THREAD is a pnpm monorepo using Replit's path-based application router. A GitHub
clone is source code, not a copy of the author's credentials, database, or live
deployment.

1. Import the repository into your own Replit app.
2. Copy `.replit.example` to `.replit` **only in that new import**, if needed.
   The example describes configuration; it is not authorization to provision a
   paid deployment. Review costs before publishing.
3. Install the locked dependencies: `pnpm install --frozen-lockfile`.
4. Configure your own PostgreSQL database and Clerk tenant/integration.
   Use `.env.example` as an inventory of names, not as working credentials.
5. In the new development database only, review and apply the schema:
   `pnpm --filter @workspace/db run push`. Apply
   `lib/db/dev-checkpoint-guard.sql` explicitly afterward to install the
   checkpoint-immutability function/trigger. Do not substitute a force-push
   command or point these commands at production.
6. Configure/start the API and web artifact services:
   - `pnpm --filter @workspace/api-server run dev`
   - `pnpm --filter @workspace/thread run dev`
   Each needs its assigned `PORT`. Web also requires `BASE_PATH=/`.
   Route `/api` to the API artifact and `/` to the web artifact.
7. Configure the managed OpenAI-compatible integration if genuine enhancement
   is needed. Without it, preserve explicit failure/fallback labels; do not
   fabricate successful AI results.
8. Open the app, sign in, create a topic, and save your own checkpoint.

The separate mockup-sandbox artifact is a design workspace and is not necessary
to use the learning application.

## Environment inventory

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Your development/test PostgreSQL database; never a copied production credential |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Backend Clerk configuration |
| `VITE_CLERK_PUBLISHABLE_KEY` | Intentionally public frontend Clerk key, not the secret key |
| `VITE_CLERK_PROXY_URL` | Optional tenant/router-specific Clerk proxy |
| `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` | Server-side managed AI endpoint and credential |
| `PORT` | Separate service port, provided per service |
| `BASE_PATH` | Web artifact prefix; `/` for the root app |
| `THREAD_PRODUCTION_DATABASE_URL` | Separate external production connection, production only |
| `THREAD_PRODUCTION_DATABASE_HOST`, `THREAD_PRODUCTION_DATABASE_NAME` | Expected target checked against the production URL |
| `THREAD_MONITOR_ENABLED`, `THREAD_ALERT_FROM`, `THREAD_ALERT_TO` | Optional operational email configuration |

Never put a secret in a `VITE_` variable. Do not commit a filled `.env`, local
`.replit`, database export, session cookie, or production connection string.
Production host/email values from the author's local configuration are not
included in this repository.

## Verification commands

```bash
pnpm run typecheck
node --experimental-strip-types --test artifacts/thread/src/lib/*.test.mjs
PORT=24644 BASE_PATH=/ pnpm --filter @workspace/thread run build
```

The backend suite requires the full schema/trigger in **your own disposable
development/test database**:

```bash
pnpm --filter @workspace/api-server run test
```

It performs real database operations and creates/cleans synthetic fixtures.
Never run it against production or a database whose records you need to preserve.
The test-only Clerk/provider adapters are bundled by the test runner, not
enabled by a production runtime bypass.

## Off-platform development

Node 24 matches the Replit configuration. pnpm supports the workspace/catalog
lockfile. You must provide PostgreSQL and Clerk and configure your own routing:

- Route `/api/*` to the Express service, including the `/api/__clerk` proxy if
  your tenant uses it.
- Route the SPA and its deep links to the Vite/web service.
- Keep web API requests same-origin. The checked-in Vite config is not a
  standalone two-port API proxy; starting two local ports alone is insufficient.
- The committed artifact descriptors describe Replit service routing; other
  hosting environments need equivalent configuration.

This is not a claim that every off-platform configuration was tested.

## Production boundaries

Development deliberately ignores the production-only URL. Production requires
its own URL plus matching expected host/name, verified TLS, and a direct
session-preserving PostgreSQL connection. It rejects missing/mismatched targets
and use of the managed database target.

Schema initialization must preserve tables, constraints, indexes and the
checkpoint-immutability trigger/function. Production startup checks remain
enabled. Never copy development records or bypass guards to make startup pass.
Development schema commands are not an unattended production migration process.

Publishing, resource selection, database initialization and email-domain setup
are separate operational decisions, not effects of cloning or GitHub export.

## Maintaining this public repository

The original Replit workspace contains private configuration and checkpoint
history. Its public repository starts from a reviewed source-only snapshot,
not a push of that history.

From the originating workspace:

```bash
node scripts/export-public.mjs --audit
node scripts/export-public.mjs --prepare
# Review the generated source snapshot and diff first:
node scripts/export-public.mjs --push
```

This does not republish the app or change repository visibility. Do not force-push
the workspace's unrelated private checkpoint history into the public repository.
When working from a normal public clone, use ordinary Git commits instead.
