import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { CalendarClock, Loader2 } from "lucide-react";
import { getListReviewsQueryKey, useEnsureCheckpointReview, useListReviews } from "@workspace/api-client-react";
import { errorMessage, errorStatus, newKey } from "@/lib/thread";
import { fmtUtc, readLocal, relDue, writeLocal, type FrozenKey } from "@/lib/review-store";

/** Ensures (idempotently) a schedule for a checkpoint, then opens it. Frozen key per checkpoint until success. */
export function ReviewCheckpointButton(props: { checkpointId: string; className?: string }) {
  const { userId } = useAuth();
  // Keyed by identity so no error/pending state carries across accounts.
  return <ReviewCheckpointButtonInner key={`${userId ?? ""}:${props.checkpointId}`} {...props} />;
}

function ReviewCheckpointButtonInner({ checkpointId, className = "" }: { checkpointId: string; className?: string }) {
  const { userId: authId } = useAuth();
  const userId = authId ?? "";
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const ensure = useEnsureCheckpointReview();
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    if (!userId) { setErr("Not signed in; nothing was sent."); return; }
    let frozen = readLocal<FrozenKey>(userId, "ensure", checkpointId);
    if (!frozen) { frozen = { requestKey: newKey("review-ensure"), frozenAt: new Date().toISOString() }; writeLocal(userId, "ensure", checkpointId, frozen); }
    try {
      const s = await ensure.mutateAsync({ id: checkpointId, data: { requestKey: frozen.requestKey } });
      writeLocal(userId, "ensure", checkpointId, null);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]) === "/api/reviews" });
      setLocation(`/reviews/${s.id}`);
    } catch (e) {
      setErr(errorStatus(e) === 401 ? "Session expired; sign in and retry." : `Not confirmed: ${errorMessage(e)}. Retry is identical.`);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <button type="button" onClick={() => void go()} disabled={ensure.isPending} className={`inline-flex items-center gap-1 underline underline-offset-2 disabled:opacity-50 ${className}`} data-testid={`button-review-checkpoint-${checkpointId}`}>
        {ensure.isPending && <Loader2 className="h-3 w-3 animate-spin" />} Review this checkpoint
      </button>
      {err && <span role="alert" className="text-[11px] text-destructive" data-testid={`text-review-ensure-error-${checkpointId}`}>{err}</span>}
    </span>
  );
}

/** Mission-scoped due/upcoming reviews. Dates and links only: no saved content before the recall gate. */
export function MissionReviewBridge({ missionId, latestCheckpointId }: { missionId: string; latestCheckpointId: string | null }) {
  const params = { missionId };
  const q = useListReviews(params, { query: { queryKey: getListReviewsQueryKey(params) } });
  const d = q.data;
  const hasLatest = !!latestCheckpointId && !!d?.items.some((s) => s.checkpointId === latestCheckpointId);
  const sorted = d ? [...d.items].sort((a, b) => a.dueAt.localeCompare(b.dueAt)) : [];

  return (
    <section className="rise mt-6 rounded-2xl border border-border bg-card/70 p-4 sm:p-5" data-testid="panel-mission-reviews">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CalendarClock className="h-5 w-5 text-accent" />
        <h2 className="font-display text-lg">Spaced reviews</h2>
        {q.isLoading && <span className="h-4 w-32 rounded bg-muted animate-pulse" />}
        {d && (
          <span className="text-xs font-mono text-muted-foreground" data-testid="text-mission-review-counts">
            <span className={d.counts.overdue ? "text-primary" : ""}>{d.counts.overdue} due</span> · {d.counts.upcoming} upcoming · {d.counts.answered} answered · {d.counts.rated} rated
          </span>
        )}
        <Link href="/reviews" className="ml-auto text-xs underline underline-offset-2" data-testid="link-all-reviews">All reviews</Link>
      </div>
      {q.isError && <p role="alert" className="mt-2 text-xs text-destructive">{errorMessage(q.error)} <button onClick={() => q.refetch()} className="underline" data-testid="button-retry-mission-reviews">retry</button></p>}
      {sorted.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {sorted.slice(0, 6).map((s) => {
            const due = relDue(s.dueAt, d!.serverNow);
            return (
              <li key={s.id}>
                <Link href={`/reviews/${s.id}`} title={fmtUtc(s.dueAt)} data-testid={`link-mission-review-${s.id}`}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-mono hover:bg-muted ${due.overdue ? "border-primary/60 text-primary" : "border-border"}`}>
                  {due.overdue ? "Review now" : "Upcoming"} · {due.label}
                </Link>
              </li>
            );
          })}
          {d?.nextCursor && <li className="text-xs font-mono text-muted-foreground self-center">more on the reviews page</li>}
        </ul>
      )}
      {d && latestCheckpointId && !hasLatest && (
        <div className="mt-3 text-xs text-muted-foreground flex flex-wrap items-center gap-2">
          <span>Your latest checkpoint has no schedule yet.</span>
          <ReviewCheckpointButton checkpointId={latestCheckpointId} className="text-foreground" />
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">Reviews revisit saved checkpoints. The optional return warm-up is separate and does not change review schedules.</p>
    </section>
  );
}
