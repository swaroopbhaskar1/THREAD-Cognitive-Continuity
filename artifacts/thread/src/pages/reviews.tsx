import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { getListReviewsQueryKey, useListReviews } from "@workspace/api-client-react";
import { errorMessage, fmtTime } from "@/lib/thread";
import { fmtInterval, fmtUtc, relDue } from "@/lib/review-store";
import { useExecutionStream } from "@/hooks/use-execution-stream";

export function AlgorithmNote() {
  return (
    <details className="rounded-2xl border border-border bg-card p-5 group" data-testid="panel-algorithm">
      <summary className="cursor-pointer font-display text-lg list-none flex flex-wrap items-center justify-between gap-2">
        Scheduling details
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">A self-assessment heuristic, not proof of mastery. You rate how hard recall felt after comparing with your saved checkpoint; nothing is scored for correctness. All times use the server's UTC clock.</p>
      <p className="mt-2 text-xs font-mono text-muted-foreground">Algorithm: thread-spacing-v1</p>
      <dl className="mt-3 grid sm:grid-cols-2 gap-2 text-xs font-mono">
        <div className="rounded-lg bg-muted p-3"><dt className="text-destructive">Again</dt><dd>10 min · repetitions reset to 0 · ease -0.20 (min 1.3) · lapses +1</dd></div>
        <div className="rounded-lg bg-muted p-3"><dt className="text-primary">Hard</dt><dd>max(1 day, previous x 1.2 rounded to days) · ease -0.15</dd></div>
        <div className="rounded-lg bg-muted p-3"><dt className="text-accent">Good</dt><dd>1 day first, 3 days second, then previous x ease</dd></div>
        <div className="rounded-lg bg-muted p-3"><dt className="text-accent">Easy</dt><dd>4 days first, else max(4 days, previous x ease x 1.3) · ease +0.15 (max 3.0)</dd></div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">Intervals cap at 365 days. New checkpoints get a review due 24 h later; older checkpoints get one only when you ask. Practising early is allowed and labeled.</p>
    </details>
  );
}

export default function ReviewsPage() {
  useExecutionStream();
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1];
  const params = cursor ? { cursor } : undefined;
  const q = useListReviews(params, { query: { queryKey: getListReviewsQueryKey(params) } });
  const d = q.data;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-14">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Spaced retrieval</p>
      <h1 className="font-display text-4xl sm:text-5xl mt-2">Pull it back from memory.</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">Try a question from memory, then compare with your saved thinking. Tell THREAD how difficult it felt so it can schedule your next review. A review is a chance to revisit, not a test.</p>

      <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-2xl overflow-hidden bg-border" data-testid="panel-review-counts">
        {(["overdue", "upcoming", "answered", "rated"] as const).map((c) => (
          <div key={c} className="bg-card p-5">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{c}</p>
            <p className={`font-display text-4xl mt-1 ${c === "overdue" && (d?.counts.overdue ?? 0) > 0 ? "text-primary" : ""}`} data-testid={`text-review-count-${c}`}>
              {q.isLoading ? <span className="inline-block h-8 w-10 rounded bg-muted animate-pulse" /> : d?.counts[c] ?? 0}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl">Schedules</h2>
          </div>
          {q.isLoading && <div className="mt-4 space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />)}</div>}
          {q.isError && (
            <p role="alert" className="mt-4 text-sm text-destructive">{errorMessage(q.error)}
              <button onClick={() => q.refetch()} className="ml-2 inline-flex items-center gap-1 underline" data-testid="button-retry-reviews"><RotateCw className="h-3 w-3" /> retry</button>
            </p>
          )}
          {d && d.items.length === 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center" data-testid="empty-reviews">
              <p className="font-display text-lg">Nothing scheduled{stack.length ? " on this page" : ""}.</p>
              <p className="text-sm text-muted-foreground mt-1">Leave a checkpoint in a mission, or open an older one and choose "Review this checkpoint".</p>
              <Link href="/missions" className="mt-3 inline-block underline underline-offset-2 text-sm" data-testid="link-empty-missions">Go to missions</Link>
            </div>
          )}
          <ul className="mt-4 space-y-2">
            {d?.items.map((s) => {
              const due = relDue(s.dueAt, d.serverNow);
              return (
                <li key={s.id}>
                  <Link href={`/reviews/${s.id}`} data-testid={`link-review-${s.id}`}
                    className={`group flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border p-3 sm:p-4 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${due.overdue ? "border-primary/50 bg-primary/5" : "border-border"}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium whitespace-normal break-words [overflow-wrap:anywhere]">{s.missionTitle}</span>
                      <span className="mt-1 block text-sm text-muted-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere] line-clamp-3">{s.checkpointNextAction || "Review the context saved in this checkpoint"}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{s.checkpointCreatedAt ? `Checkpoint saved ${fmtTime(s.checkpointCreatedAt)}` : `Saved checkpoint ${s.checkpointId.slice(0, 8)}`}</span>
                    </span>
                    <span className="text-right">
                      <span className={`block text-sm font-mono ${due.overdue ? "text-primary" : "text-accent"}`} data-testid={`status-review-due-${s.id}`}>{due.label}</span>
                      <span className="block text-xs text-muted-foreground">{new Date(s.dueAt).toLocaleDateString()}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {d && <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Exact schedule records</summary>
            <p data-testid="text-server-now" className="mt-2">Server {fmtUtc(d.serverNow)}</p>
            {d.items.map(s => <p key={s.id} className="mt-2 break-words">{s.checkpointId} · due {fmtUtc(s.dueAt)} · interval {fmtInterval(s.intervalMinutes)} · ease {s.ease.toFixed(2)} · repetitions {s.repetitions} · lapses {s.lapses} · {s.answeredCount} answered / {s.ratedCount} rated</p>)}
          </details>}
          <div className="mt-4 flex items-center justify-between">
            <button disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-full border border-border hover:bg-muted disabled:opacity-40" data-testid="button-reviews-prev"><ChevronLeft className="h-4 w-4" /> Newer</button>
            <span className="text-[11px] font-mono text-muted-foreground">page {stack.length + 1}</span>
            <button disabled={!d?.nextCursor} onClick={() => d?.nextCursor && setStack((s) => [...s, d.nextCursor!])} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-full border border-border hover:bg-muted disabled:opacity-40" data-testid="button-reviews-next">More <ChevronRight className="h-4 w-4" /></button>
          </div>
        </section>
        <aside className="min-w-0 lg:sticky lg:top-20"><AlgorithmNote /></aside>
      </div>
    </div>
  );
}
