# Verification evidence and publication scope

## Recorded acceptance: 2026-11-03

These outcomes were observed in the development workspace before GitHub
publication. They are not fabricated benchmarks or claims about an untested
fresh production build.

| Verification | Observed result |
|---|---|
| PostgreSQL-backed backend tests | 91 passed, 0 failed, 1 opt-in live-provider test skipped |
| Frontend pure regression tests | 34 passed, 0 failed |
| Workspace typechecks | Passed |
| Web production build | Passed; initial JS size warning remains |
| Scripted authenticated desktop journey | Passed after repairs and a targeted recheck |

## Connected first-use acceptance

The tester used a fresh synthetic learner, not the author's personal missions:

1. Enter without reading Guide; create one topic.
2. Capture understanding, uncertainty, reasoning, an exact next step and
   indented scratch notes.
3. Save a checkpoint; verify original values through authenticated API reads.
4. Observe **one genuine managed-provider AI job**, succeeded on attempt 1.
   Its persisted workflow contained 16 real events and exactly one external-call
   event. No extra generation was requested for cosmetic fixes.
5. Leave, return and refresh; continue the newest draft without mandatory recall.
6. Edit understanding; inspect a read-only historical comparison.
7. Answer a scheduled review before revealing its reference; rate Hard;
   confirm the rating/date persisted after refresh.
8. Select a real execution workflow, inspect measured steps and replay its
   five recorded events. Refresh retained the workflow selection.
9. Save action-only content. A labeled `INSUFFICIENT_CONTENT` fallback made
   **zero provider calls** and did not display three fake AI artifacts.
10. Drop a checkpoint response **after** a real server-side 201 commit.
    Frozen retry survived refresh; ordinary UI retry returned the same
    checkpoint, not a duplicate.
11. Cancel a restore; then confirm restore and Undo. Exact retained fields and
    note indentation recovered.
12. Inspect identical/empty comparisons and a live “not saved yet” comparison
    while a draft PUT was deliberately held. After release, Saved v12 and all
    five retained values were confirmed. Exactly two checkpoints remained.

The request-hold duration was a test-harness delay, not a server benchmark.
The first intercepted lost-response attempt omitted browser cookies and
correctly received 401 without committing; after fixing the harness, the
authenticated after-commit response-loss case passed.

## Failures actually found and fixed

- **Blank signed-out entry:** unresolved Clerk state left both conditional
  branches empty. Public Home/Guide now render while identity loads; protected
  routes and server authorization were not weakened.
- **Repeated AI evidence:** exact source pairs are now displayed once, with all
  supported output associations retained. No persisted enhancement was changed.
- **Stale replay caption:** finished groups now say “replayed,” not “replaying.”
  Recorded event outcomes and measured timings are untouched.
- **Misleading empty/saved copy:** optional placeholders are neutral; a
  disclosure does not call potentially-unsaved text “saved.”

## How to reproduce the execution demonstration

Open **[the live inspector](https://thread-cognitive-continuity.replit.app/how-it-works)**
after signing in and creating your own checkpoint. Use the workflow selector,
click a step, and start replay. No private test-user run ID or shared account is
published.

The displayed runtime history comes from persisted PostgreSQL records.
Replay pacing is a display setting, not execution duration. The original
checkpoint's local fallback provenance and a later successful AI job are
separate records/workflows; the latter does not rewrite the original.

Production does not expose a failure-injection switch. Controlled invalid-output,
timeout, duplicate/retry and worker-recovery cases live in the backend tests.

## Evidence limits

- Scripted desktop verification at 1440×1000, not unfamiliar-student usability
  research, mobile certification or a full screen-reader audit.
- Sanctioned programmatic managed-Clerk test login, not email/OAuth UI testing.
- One genuine prompt/provider success, not a multi-topic AI quality study.
- Failure/retry/recovery coverage uses controlled integration fixtures;
  those fixtures are not represented as real external provider failures.
- Paused-caption logic passed a pure regression, but a paused browser screenshot
  was missed because playback had already completed. Finished replay and refresh
  passed in the real browser.
- Some immediate refresh frames were transiently empty/faded before settling.
  No zero-loading-time claim is made.
- Existing bundle-size and tooltip sourcemap warnings remain.
- No cognitive-performance metrics, correctness grade or improvement percentage
  is claimed.

## Source-publication policy

The public source export includes application packages, required generated API
source, schema/guard SQL, test source, lockfile, and these reviewed portfolio docs.
It excludes Replit checkpoint history, `.agents`, uploaded files, personal audit
documents, filled environment files, local `.replit`, caches, database dumps and
build outputs.

The two screenshots are actual signed-out development captures: Home and the
illustrative Guide. They contain no private learner account or saved record.
Guide explicitly labels its example as illustrative.

The export performs a static pattern scan for credential-shaped material,
deployment-specific database hosts and non-example email addresses. A clean
pattern scan is not an exhaustive security audit or a guarantee that no secret
could ever exist.

The initial 299-file public snapshot was also checked independently of the
original working tree: offline frozen-lockfile dependency installation, all
workspace typechecks, all 34 frontend pure tests, and the web production build
passed. Required generated client source was preserved byte-for-byte, including
its harmless final blank lines. The three credential-URL matches first reported
by the pattern scan were explicit dummy fixtures on reserved `.invalid` hosts,
not real database credentials; that narrowly defined fixture case is allowed.
No production connection or database integration suite was invoked for this
export check.

Publishing source does **not** change databases, credentials, production settings,
hosting resources or the live application deployment.
