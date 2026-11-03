import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeftRight } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  getListRecallAttemptsQueryKey, getListReviewsQueryKey, useListRecallAttempts, listReviews,
  type Checkpoint, type ReviewSchedule,
} from "@workspace/api-client-react";
import { errorMessage, fmtTime, type DraftFields } from "@/lib/thread";
import { intelligenceStatus } from "@/lib/intelligence-status";
import { compareLearningFields, LEARNING_FIELDS as FIELDS } from "@/lib/learning-comparison";
import { ReviewCheckpointButton } from "@/components/mission-review-bridge";

export type JourneyProps = {
  missionId: string;
  checkpoints: Checkpoint[];
  /** Live editor values (may be unsaved). Read-only here. */
  current: DraftFields;
  currentUnsaved: boolean;
  /** Disables restore preview while writes are pending. */
  restoreDisabled: boolean;
  onRestore: (cp: Checkpoint) => void;
  onViewAi: (checkpointId: string) => void;
};

export function Journey({ missionId, checkpoints, current, currentUnsaved, restoreDisabled, onRestore, onViewAi }: JourneyProps) {
  const chrono = useMemo(() => [...checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [checkpoints]);
  const [compareId, setCompareId] = useState<string | null>(chrono[0]?.id ?? null);
  const compare = chrono.find((c) => c.id === compareId) ?? null;
  const params = { missionId };
  const reviews = useInfiniteQuery({
    queryKey: [...getListReviewsQueryKey(params), "journey-pages"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listReviews({ ...params, cursor: pageParam }, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const byCp = useMemo(() => {
    const m = new Map<string, ReviewSchedule[]>();
    for (const page of reviews.data?.pages ?? []) {
      for (const s of page.items) m.set(s.checkpointId, [...(m.get(s.checkpointId) ?? []), s]);
    }
    return m;
  }, [reviews.data]);

  if (chrono.length === 0) {
    return (
      <div id="view-journey" role="tabpanel" aria-labelledby="tab-journey" className="rise mt-8 rounded-2xl border border-dashed border-border p-10 text-center" data-testid="empty-journey">
        <p className="font-display text-2xl">Your journey starts with your first checkpoint.</p>
        <p className="mt-2 text-muted-foreground max-w-md mx-auto">Each time you save one, it lands here with a date, so you can compare what you thought then with what you think now.</p>
      </div>
    );
  }

  return (
    <div id="view-journey" role="tabpanel" aria-labelledby="tab-journey" className="rise mt-8 grid lg:grid-cols-[1fr_minmax(0,420px)] gap-8 items-start" data-testid="panel-journey">
      <section aria-labelledby="journey-heading">
        <h2 id="journey-heading" className="font-display text-2xl">Checkpoints, oldest first</h2>
        <p className="text-sm text-muted-foreground mt-1">Saved exactly as you wrote them. Nothing here can change your draft unless you choose Replace.</p>
        {reviews.isError && <p role="alert" className="mt-3 text-xs text-destructive">Recall history did not load: {errorMessage(reviews.error)} <button onClick={() => reviews.refetch()} className="underline" data-testid="button-retry-journey-reviews">retry</button></p>}
        {reviews.hasNextPage && <button onClick={() => void reviews.fetchNextPage()} disabled={reviews.isFetchingNextPage}
          className="mt-3 min-h-10 text-xs underline disabled:opacity-50" data-testid="button-journey-more-reviews">
          {reviews.isFetchingNextPage ? "Loading more recall history…" : "Load more recall history"}
        </button>}
        <ol className="mt-6 relative border-l border-primary/40 ml-2 space-y-8">
          {chrono.map((c, i) => {
            const selected = c.id === compareId;
            return (
              <li key={c.id} className="pl-6 relative" data-testid={`item-checkpoint-${c.id}`}>
                <span className={`absolute -left-[7px] top-1.5 h-3 w-3 rounded-full border-2 border-primary transition-colors ${selected ? "bg-primary" : "bg-background"}`} aria-hidden="true" />
                <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground" data-testid={`text-checkpoint-date-${c.id}`}>Checkpoint {i + 1} · {fmtTime(c.createdAt)}</p>
                <p className="mt-1 font-display text-lg leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]">{c.nextAction || <em className="text-muted-foreground">No next step saved</em>}</p>
                {c.questions && <p className="mt-2 text-sm"><span className="text-muted-foreground">Unsure then: </span><span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{c.questions}</span></p>}
                {c.understanding && <p className="mt-1 text-sm"><span className="text-muted-foreground">Made sense: </span><span className="whitespace-pre-wrap [overflow-wrap:anywhere] line-clamp-4">{c.understanding}</span></p>}
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full saved checkpoint</summary>
                  <dl className="mt-2 space-y-2">
                    {FIELDS.map((f) => <div key={f.key}><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{c[f.key] || <em className="text-muted-foreground">Empty at this checkpoint</em>}</dd></div>)}
                  </dl>
                </details>
                {(byCp.get(c.id) ?? []).map((s) => <RecallHistory key={s.id} review={s} />)}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <button onClick={() => setCompareId(c.id)} aria-pressed={selected}
                    className={`inline-flex items-center gap-1 min-h-9 px-3 rounded-full border transition-colors ${selected ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"}`} data-testid={`button-compare-${c.id}`}>
                    <ArrowLeftRight className="h-3.5 w-3.5" /> {selected ? "Comparing" : "Compare with now"}
                  </button>
                  <button className="underline underline-offset-2" onClick={() => onViewAi(c.id)} data-testid={`button-intelligence-${c.id}`}>AI return cue</button>
                  <span className="text-muted-foreground">{intelligenceStatus(c.enhancementStatus)}</span>
                  {!byCp.has(c.id) && <ReviewCheckpointButton checkpointId={c.id} />}
                  <button onClick={() => onRestore(c)} disabled={restoreDisabled}
                    className="underline text-muted-foreground disabled:opacity-50" data-testid={`button-replace-${c.id}`}>Replace draft fields from checkpoint…</button>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      <aside className="lg:sticky lg:top-20">
        {compare && <ThenNow checkpoint={compare} current={current} unsaved={currentUnsaved} />}
      </aside>
    </div>
  );
}

function RecallHistory({ review }: { review: ReviewSchedule }) {
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1];
  const params = cursor ? { reviewId: review.id, cursor } : { reviewId: review.id };
  const q = useListRecallAttempts(params, { query: { queryKey: getListRecallAttemptsQueryKey(params) } });
  const items = q.data?.items ?? [];
  return (
    <div className="mt-3 rounded-xl bg-muted/60 p-3 text-sm" data-testid={`panel-journey-recall-${review.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-accent">Recall from memory</p>
        <Link href={`/reviews/${review.id}`} className="text-xs underline underline-offset-2" data-testid={`link-journey-review-${review.id}`}>Next review {new Date(review.dueAt).toLocaleDateString()}</Link>
      </div>
      {q.isLoading && <div className="mt-2 h-10 rounded bg-muted animate-pulse" />}
      {q.isError && <p role="alert" className="mt-2 text-xs text-destructive">{errorMessage(q.error)} <button onClick={() => q.refetch()} className="underline">retry</button></p>}
      {q.data && items.length === 0 && <p className="mt-1 text-xs text-muted-foreground">Scheduled, no attempts yet.</p>}
      <ul className="mt-1 space-y-2">
        {items.map((a) => (
          <li key={a.id} className="border-t border-border/60 pt-2 first:border-0 first:pt-0" data-testid={`row-journey-attempt-${a.id}`}>
            <p className="text-xs text-muted-foreground">{fmtTime(a.answeredAt ?? a.startedAt)} · {a.difficulty ? `rated ${a.difficulty}` : a.answeredAt ? "answered, not rated" : "started, not answered"}</p>
            <p className="mt-0.5 font-medium [overflow-wrap:anywhere]">{a.question}</p>
            {a.answeredAt && a.answer !== null
              ? <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] max-h-48 overflow-auto" tabIndex={0}>You answered: {a.answer}</p>
              : <Link href={`/reviews/${review.id}`} className="text-xs underline">Continue this recall</Link>}
          </li>
        ))}
      </ul>
      {(stack.length > 0 || q.data?.nextCursor) && (
        <div className="mt-2 flex gap-3 text-xs">
          <button disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))} className="underline disabled:opacity-40 disabled:no-underline" data-testid={`button-journey-recall-newer-${review.id}`}>Newer</button>
          <button disabled={!q.data?.nextCursor} onClick={() => q.data?.nextCursor && setStack((s) => [...s, q.data!.nextCursor!])} className="underline disabled:opacity-40 disabled:no-underline" data-testid={`button-journey-recall-older-${review.id}`}>Older attempts</button>
        </div>
      )}
    </div>
  );
}

function ThenNow({ checkpoint, current, unsaved }: { checkpoint: Checkpoint; current: DraftFields; unsaved: boolean }) {
  const rows = compareLearningFields(checkpoint, current);
  const changed = rows.some((r) => r.state !== "same" && r.state !== "empty");
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-[0_24px_48px_-32px_hsl(200_32%_14%/0.4)]" data-testid="panel-then-now">
      <p className="font-mono text-[11px] uppercase tracking-widest text-accent">See what changed</p>
      <h2 className="font-display text-xl mt-1">Then and now</h2>
      <p className="text-xs text-muted-foreground mt-1">Read-only. Your words only, no score or judgement.</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-mono uppercase tracking-wider">
        <span className="text-muted-foreground" data-testid="text-then-label">Then · saved {fmtTime(checkpoint.createdAt)}</span>
        <span className={unsaved ? "text-primary" : "text-accent"} data-testid="text-now-label">Now · current draft{unsaved ? ", not saved yet" : ""}</span>
      </div>
      {!changed && <p className="mt-4 text-sm" data-testid="text-compare-identical">Nothing changed. Your current draft matches this checkpoint.</p>}
      <div className="mt-3 space-y-4">
        {rows.map((r) => (
          <div key={r.key} data-testid={`compare-${r.key}`} data-state={r.state}>
            <p className="text-xs font-medium">{r.label} <span className="font-normal text-muted-foreground">· {r.state === "empty" ? "empty in both" : r.state === "same" ? "unchanged" : r.state === "added" ? "new since then" : r.state === "removed" ? "no longer in your draft" : "changed"}</span></p>
            {r.state === "empty" ? <p className="mt-1 text-sm text-muted-foreground">Empty then and now.</p> : r.state === "same" ? (
              <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere] max-h-48 overflow-auto" tabIndex={0}>{r.now}</p>
            ) : (
              <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
                <p className="rounded-lg bg-muted p-2 whitespace-pre-wrap [overflow-wrap:anywhere] max-h-48 overflow-auto">{r.then || <em className="text-muted-foreground">Empty then</em>}</p>
                <p className="rounded-lg border border-accent/40 p-2 whitespace-pre-wrap [overflow-wrap:anywhere] max-h-48 overflow-auto">{r.now || <em className="text-muted-foreground">Empty now</em>}</p>
              </div>
            )}
            {r.state === "removed" && r.key === "questions" && <p className="mt-1 text-[11px] text-muted-foreground">Removing an uncertainty from the draft does not mean it was resolved.</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
