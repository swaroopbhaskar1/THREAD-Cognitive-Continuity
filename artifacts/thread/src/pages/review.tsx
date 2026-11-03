import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { ArrowLeft, ChevronLeft, ChevronRight, Eye, Loader2, Lock, RotateCw } from "lucide-react";
import {
  getGetReviewQueryKey,
  getListRecallAttemptsQueryKey,
  useGetReview,
  useListRecallAttempts,
  useRateRecallAttempt,
  useStartReview,
  useSubmitRecallAnswer,
  type RecallAttempt,
  type RecallDifficulty,
  type ReviewDetail,
  type ReviewSchedule,
} from "@workspace/api-client-react";
import { errorMessage, errorStatus, newKey, fmtTime } from "@/lib/thread";
import { fmtInterval, fmtUtc, previewInterval, readLocal, relDue, writeLocal, type FrozenAnswer, type FrozenKey, type FrozenRating } from "@/lib/review-store";
import { useExecutionStream } from "@/hooks/use-execution-stream";
import { AlgorithmNote } from "@/pages/reviews";

const RATINGS: { d: RecallDifficulty; label: string; hint: string; tone: string }[] = [
  { d: "again", label: "Again", hint: "I couldn't bring it back", tone: "border-destructive/50 hover:bg-destructive/10" },
  { d: "hard", label: "Hard", hint: "Came back with real effort", tone: "border-primary/50 hover:bg-primary/10" },
  { d: "good", label: "Good", hint: "Came back with some thought", tone: "border-accent/50 hover:bg-accent/10" },
  { d: "easy", label: "Easy", hint: "Came back immediately", tone: "border-accent/50 hover:bg-accent/10" },
];

function failText(err: unknown, what: string) {
  const s = errorStatus(err);
  if (s === 401) return `Your session expired, so the ${what} was not confirmed. Sign in again, then retry; the identical frozen request is kept on this device.`;
  if (s === undefined) return `No response received, so the ${what} is not confirmed. Retry re-sends the identical frozen request.`;
  return `${what[0].toUpperCase()}${what.slice(1)} not confirmed (${s}): ${errorMessage(err)}`;
}

export default function ReviewPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const { userId } = useAuth();
  if (!userId) return <div className="mx-auto max-w-3xl px-4 py-10"><div className="h-64 rounded-2xl bg-muted animate-pulse" aria-busy="true" /></div>;
  return <ReviewSession key={`${userId}:${id}`} id={id} />;
}

const progress = (s: RecallAttempt | null) => (!s ? 0 : s.ratedAt ? 3 : s.answeredAt ? 2 : 1);
/** Pick the fresher of two details so a late GET (e.g. SSE-triggered) can't roll back a newer local state. */
function fresher(a: ReviewDetail | null, b: ReviewDetail | undefined): ReviewDetail | null {
  if (!b) return a;
  if (!a) return b;
  if (a.schedule.id !== b.schedule.id) return b;
  const sa = a.session, sb = b.session;
  if (sa && sb) {
    if (sa.id !== sb.id) return sb.startedAt >= sa.startedAt ? b : a;
    return progress(sb) >= progress(sa) ? b : a;
  }
  if (sa && !sb) return a;
  return b.schedule.version >= a.schedule.version ? b : a;
}

function ReviewSession({ id }: { id: string }) {
  useExecutionStream();
  const { userId: authId } = useAuth();
  const userId = authId ?? "";
  const qc = useQueryClient();
  const detail = useGetReview(id, { query: { enabled: !!id, queryKey: getGetReviewQueryKey(id) } });

  // Highest-progress detail confirmed by a mutation in this view.
  const confirmedRef = useRef<ReviewDetail | null>(null);
  const adopt = (d: ReviewDetail) => {
    confirmedRef.current = fresher(confirmedRef.current, d);
    void qc.cancelQueries({ queryKey: getGetReviewQueryKey(id) });
    qc.setQueryData(getGetReviewQueryKey(id), confirmedRef.current ?? d);
    void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]) === "/api/reviews" });
    void qc.invalidateQueries({ queryKey: getListRecallAttemptsQueryKey({ reviewId: id }).slice(0, 1) });
  };

  // Start: frozen key per review until success.
  const start = useStartReview();
  const [startErr, setStartErr] = useState<string | null>(null);
  const begin = async () => {
    setStartErr(null);
    let frozen = readLocal<FrozenKey>(userId, "start", id);
    if (!frozen) { frozen = { requestKey: newKey("review-start"), frozenAt: new Date().toISOString() }; writeLocal(userId, "start", id, frozen); }
    try {
      const d = await start.mutateAsync({ id, data: { requestKey: frozen.requestKey } });
      writeLocal(userId, "start", id, null);
      adopt(d);
    } catch (err) { setStartErr(failText(err, "recall start")); }
  };

  const view = fresher(confirmedRef.current, detail.data);
  if (view && view !== confirmedRef.current && confirmedRef.current) confirmedRef.current = view;

  if (detail.isLoading) {
    return <div className="mx-auto max-w-3xl px-4 py-10 space-y-4" aria-busy="true"><div className="h-8 w-1/2 rounded bg-muted animate-pulse" /><div className="h-64 rounded-2xl bg-muted animate-pulse" /></div>;
  }
  if (!view) {
    const nf = errorStatus(detail.error) === 404;
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center" role="alert">
        <h1 className="font-display text-3xl">{nf ? "This review isn't here." : "The review didn't load."}</h1>
        <p className="text-muted-foreground mt-2">{nf ? "It may belong to another account." : errorMessage(detail.error)}</p>
        <div className="mt-6 flex justify-center gap-3">
          {!nf && <button onClick={() => detail.refetch()} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border hover:bg-muted" data-testid="button-retry-review"><RotateCw className="h-4 w-4" /> Retry</button>}
          <Link href="/reviews" className="px-4 py-2 rounded-full bg-foreground text-background" data-testid="link-back-reviews-error">All reviews</Link>
        </div>
      </div>
    );
  }

  const { schedule, session, serverNow } = view;
  const due = relDue(schedule.dueAt, serverNow);
  const early = !due.overdue;
  const canStart = !session || !!session.ratedAt;

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-10">
      <Link href="/reviews" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-reviews"><ArrowLeft className="h-4 w-4" /> Reviews</Link>
      <div className="mt-4">
        <Link href={`/missions/${schedule.missionId}`} className="font-mono text-[11px] uppercase tracking-widest text-accent hover:underline" data-testid="link-review-mission">{schedule.missionTitle}</Link>
        <h1 className="font-display text-3xl sm:text-4xl mt-1">Recall, then compare.</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">Try a question from memory, then compare with your saved thinking. Tell THREAD how difficult it felt so it can schedule your next review.</p>
        <ScheduleStrip s={schedule} serverNow={serverNow} />
      </div>

      {session && !session.ratedAt ? (
        <AttemptFlow key={`${userId}:${session.id}`} attempt={session} schedule={schedule} userId={userId} onAdopt={adopt} />
      ) : (
        <section className="rise mt-6 rounded-2xl bg-foreground text-background p-6 sm:p-8" data-testid="panel-review-start">
          {session?.ratedAt && <RatedResult a={session} missionId={schedule.missionId} />}
          <div className={session?.ratedAt ? "mt-6 pt-6 border-t border-background/15" : ""}>
            <p className="font-mono text-[11px] uppercase tracking-widest text-background flex items-center gap-1.5"><Lock className="h-3 w-3" /> Saved checkpoint stays sealed</p>
            <p className="font-display text-2xl mt-2">{early ? "Not due yet. You can practise early." : "This review is due."}</p>
            {early && <p className="mt-1 text-sm text-background/80" data-testid="text-early-practice">Early practice: your rating still changes the schedule. Next review is currently due {fmtTime(schedule.dueAt)}.</p>}
            <button onClick={() => void begin()} disabled={start.isPending || !canStart} className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground disabled:opacity-50 hover:-translate-y-0.5 transition-transform" data-testid="button-start-review">
              {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} {early ? "Start early practice" : "Start recall"}
            </button>
            {startErr && <p role="alert" className="mt-3 text-sm text-[hsl(350_80%_75%)]" data-testid="text-start-error">{startErr}</p>}
          </div>
        </section>
      )}

      <div className="mt-8 grid md:grid-cols-[1fr_300px] gap-6 items-start">
        <History reviewId={id} sealed={!(session && session.answeredAt)} />
        <AlgorithmNote />
      </div>
    </div>
  );
}

function ScheduleStrip({ s, serverNow }: { s: ReviewSchedule; serverNow: string }) {
  const due = relDue(s.dueAt, serverNow);
  return (
    <div className="mt-4" data-testid="panel-schedule">
      <p className="text-sm" data-testid="text-schedule-due">Next review: {fmtTime(s.dueAt)} · {due.label}</p>
      {s.checkpointCreatedAt && <p className="text-xs text-muted-foreground mt-1">From checkpoint saved {fmtTime(s.checkpointCreatedAt)}</p>}
      <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Scheduling details</summary>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 font-mono">
      <div><dt>due (UTC)</dt><dd>{fmtUtc(s.dueAt)}</dd></div>
      <div><dt className="text-muted-foreground">interval</dt><dd>{fmtInterval(s.intervalMinutes)}</dd></div>
      <div><dt className="text-muted-foreground">reps / lapses</dt><dd>{s.repetitions} / {s.lapses}</dd></div>
      <div><dt className="text-muted-foreground">ease</dt><dd>{s.ease.toFixed(2)}</dd></div>
      <div><dt className="text-muted-foreground">answered / rated</dt><dd data-testid="text-schedule-counts">{s.answeredCount} / {s.ratedCount}</dd></div>
      <div><dt className="text-muted-foreground">algorithm</dt><dd>{s.algorithmVersion} · v{s.version}</dd></div>
      </dl></details>
    </div>
  );
}

function AttemptFlow({ attempt, schedule, userId, onAdopt }: { attempt: RecallAttempt; schedule: ReviewSchedule; userId: string; onAdopt: (d: ReviewDetail) => void }) {
  const aid = attempt.id;
  const [pendingAnswer, setPendingAnswer] = useState<FrozenAnswer | null>(() => readLocal<FrozenAnswer>(userId, "answer", aid));
  const [draft, setDraftRaw] = useState<string>(() => readLocal<{ text: string }>(userId, "draft", aid)?.text ?? "");
  const [storageOk, setStorageOk] = useState(true);
  const [ansErr, setAnsErr] = useState<string | null>(null);
  const [divergent, setDivergent] = useState<string | null>(null);
  const submit = useSubmitRecallAnswer();
  const rate = useRateRecallAttempt();
  const [pendingRating, setPendingRating] = useState<FrozenRating | null>(() => readLocal<FrozenRating>(userId, "rating", aid));
  const [rateErr, setRateErr] = useState<string | null>(null);
  const reconciled = useRef(false);

  const setDraft = (t: string) => { setDraftRaw(t); setStorageOk(writeLocal(userId, "draft", aid, { text: t })); };

  // Once the server reports a committed answer, reconcile local copies without silently discarding different text.
  useEffect(() => {
    if (!attempt.answeredAt || reconciled.current) return;
    reconciled.current = true;
    const local = readLocal<FrozenAnswer>(userId, "answer", aid)?.answer ?? readLocal<{ text: string }>(userId, "draft", aid)?.text ?? "";
    if (local.trim() && local !== attempt.answer) setDivergent(local);
    else { writeLocal(userId, "draft", aid, null); }
    writeLocal(userId, "answer", aid, null);
    setPendingAnswer(null);
  }, [attempt.answeredAt, attempt.answer, aid, userId]);

  const sendAnswer = async () => {
    setAnsErr(null);
    let frozen = pendingAnswer;
    if (!frozen) {
      if (!draft.trim()) return;
      frozen = { requestKey: newKey("recall-answer"), answer: draft, frozenAt: new Date().toISOString() };
      setStorageOk(writeLocal(userId, "answer", aid, frozen));
      setPendingAnswer(frozen);
    }
    try {
      const d = await submit.mutateAsync({ id: aid, data: { requestKey: frozen.requestKey, answer: frozen.answer } });
      reconciled.current = true;
      writeLocal(userId, "answer", aid, null);
      writeLocal(userId, "draft", aid, null);
      setPendingAnswer(null);
      onAdopt(d);
    } catch (err) { setAnsErr(failText(err, "answer")); }
  };
  const unfreezeAnswer = () => { writeLocal(userId, "answer", aid, null); setPendingAnswer(null); setAnsErr(null); };

  const sendRating = async (choice?: RecallDifficulty) => {
    setRateErr(null);
    let frozen = pendingRating;
    if (!frozen) {
      if (!choice) return;
      frozen = { requestKey: newKey("recall-rating"), difficulty: choice, frozenAt: new Date().toISOString() };
      setStorageOk(writeLocal(userId, "rating", aid, frozen));
      setPendingRating(frozen);
    }
    try {
      const d = await rate.mutateAsync({ id: aid, data: { requestKey: frozen.requestKey, difficulty: frozen.difficulty } });
      writeLocal(userId, "rating", aid, null);
      setPendingRating(null);
      onAdopt(d);
    } catch (err) { setRateErr(failText(err, "rating")); }
  };
  const unfreezeRating = () => { writeLocal(userId, "rating", aid, null); setPendingRating(null); setRateErr(null); };
  const st = (e: string | null) => e !== null && /\((4\d\d)\)/.test(e) && !/\(401\)/.test(e);

  const answered = !!attempt.answeredAt;
  const shownAnswer = pendingAnswer ? pendingAnswer.answer : draft;

  return (
    <div className="mt-6 space-y-5">
      <section className="rise rounded-2xl bg-foreground text-background p-6 sm:p-8" data-testid="panel-recall-question">
        <p className="font-mono text-[11px] uppercase tracking-widest text-background">{attempt.questionSource === "ai" ? "AI-generated question · grounded in saved content" : "Saved-content question · not AI-generated"}</p>
        <p className="font-display text-2xl sm:text-3xl mt-2 leading-snug" data-testid="text-review-question">{attempt.question}</p>
        <p className="mt-2 text-xs text-background/80">Started {fmtTime(attempt.startedAt)}</p>
      </section>

      {!answered ? (
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-6" data-testid="panel-answer">
          <label htmlFor="recall-answer" className="font-display text-lg">From memory</label>
          <p className="text-xs text-muted-foreground">Your checkpoint is not in this page yet. The server only sends it after your answer is committed.</p>
          <textarea id="recall-answer" value={shownAnswer} onChange={(e) => setDraft(e.target.value)} disabled={!!pendingAnswer} rows={7} maxLength={20000}
            className="mt-3 w-full rounded-lg border border-input bg-background p-3 leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70" data-testid="input-review-answer" />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] font-mono text-muted-foreground">
            <span data-testid="status-answer-draft">{pendingAnswer ? `Frozen ${fmtUtc(pendingAnswer.frozenAt)} · awaiting server confirmation` : storageOk ? "Draft kept on this device" : "Draft only in this tab (storage unavailable)"}</span>
            <span className="ml-auto">{shownAnswer.length} / 20000</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void sendAnswer()} disabled={submit.isPending || (!pendingAnswer && !draft.trim())} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground disabled:opacity-40" data-testid="button-submit-answer">
              {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} {pendingAnswer ? "Retry frozen answer" : "Commit answer and reveal"}
            </button>
            {pendingAnswer && st(ansErr) && <button onClick={unfreezeAnswer} disabled={submit.isPending} className="px-4 py-2 rounded-full border border-border text-sm hover:bg-muted" data-testid="button-unfreeze-answer">Edit again (server rejected it)</button>}
          </div>
          {ansErr && <p role="alert" className="mt-3 text-sm text-destructive" data-testid="text-answer-error">{ansErr}</p>}
        </section>
      ) : (
        <>
          {divergent !== null && (
            <div role="alert" className="rounded-2xl border border-primary/50 bg-primary/5 p-4 text-sm" data-testid="banner-divergent-answer">
              <p className="font-medium">The server already holds a committed answer that differs from text on this device.</p>
              <p className="text-muted-foreground mt-1">Your local text was not sent and is kept here:</p>
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-card border border-border p-3" data-testid="text-divergent-answer">{divergent}</p>
              <button onClick={() => { writeLocal(userId, "draft", aid, null); setDivergent(null); }} className="mt-2 underline underline-offset-2 text-xs" data-testid="button-dismiss-divergent">Dismiss local copy</button>
            </div>
          )}
          <section className="grid md:grid-cols-2 gap-4" data-testid="panel-compare">
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">You recalled · {fmtUtc(attempt.answeredAt)}</p>
              <p className="mt-2 whitespace-pre-wrap" data-testid="text-committed-answer">{attempt.answer}</p>
            </div>
            <div className="rounded-2xl border border-accent/50 bg-card p-5" data-testid="panel-reference">
              <p className="font-mono text-[11px] uppercase tracking-widest text-accent">Saved checkpoint</p>
              {attempt.reference ? (
                <div className="mt-2 space-y-3 text-sm">
                  <div><p className="text-[11px] font-mono text-primary">next action</p><p className="font-medium">{attempt.reference.nextAction || "—"}</p></div>
                  {(["understanding", "questions", "reasoning", "notes"] as const).map((k) => attempt.reference![k] && (
                    <div key={k}><p className="text-[11px] font-mono text-muted-foreground">{k}</p><p className="whitespace-pre-wrap">{attempt.reference![k]}</p></div>
                  ))}
                  {attempt.reference.aiSummary && <div className="rounded-lg bg-muted p-3"><p className="text-[11px] font-mono text-muted-foreground">AI summary · generated server-side</p><p>{attempt.reference.aiSummary}</p></div>}
                </div>
              ) : <p className="mt-2 text-sm text-muted-foreground">Reference not returned by the server.</p>}
            </div>
          </section>
          <section className="rounded-2xl border border-border bg-card p-5 sm:p-6" data-testid="panel-rating">
            <h2 className="font-display text-xl">How hard was that to recall?</h2>
            <p className="text-xs text-muted-foreground">Your own judgement after comparing. Not a correctness score. Intervals shown are a preview; the server decides.</p>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
              {RATINGS.map((r) => {
                const chosen = pendingRating?.difficulty === r.d;
                return (
                  <button key={r.d} onClick={() => void sendRating(r.d)} disabled={rate.isPending || (!!pendingRating && !chosen)}
                    className={`text-left rounded-xl border p-3 transition-colors disabled:opacity-40 ${r.tone} ${chosen ? "ring-2 ring-ring" : ""}`} data-testid={`button-rate-${r.d}`}>
                    <span className="block font-display text-lg">{r.label}</span>
                    <span className="block text-xs text-muted-foreground">{r.hint}</span>
                    <span className="block mt-1 text-[11px] font-mono">next ~{fmtInterval(previewInterval(r.d, schedule))}</span>
                  </button>
                );
              })}
            </div>
            {pendingRating && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs" data-testid="status-rating-pending">
                <span className="font-mono">{rate.isPending ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Frozen rating "{pendingRating.difficulty}" · awaiting confirmation</span>
                {!rate.isPending && <button onClick={() => void sendRating()} className="underline underline-offset-2" data-testid="button-retry-rating">Retry identical rating</button>}
                {!rate.isPending && st(rateErr) && <button onClick={unfreezeRating} className="underline underline-offset-2" data-testid="button-unfreeze-rating">Choose again</button>}
              </div>
            )}
            {rateErr && <p role="alert" className="mt-2 text-sm text-destructive" data-testid="text-rating-error">{rateErr}</p>}
          </section>
        </>
      )}
    </div>
  );
}

function RatedResult({ a, missionId }: { a: RecallAttempt; missionId: string }) {
  return (
    <div data-testid="panel-rated-result">
      <p className="font-mono text-[11px] uppercase tracking-widest text-background/75">Rating saved · {fmtUtc(a.ratedAt)}</p>
      <p className="font-display text-2xl mt-2">You rated it <span className="font-semibold text-background" data-testid="text-rated-difficulty">{a.difficulty}</span>.</p>
      <p className="mt-1 text-sm text-background/80" data-testid="text-next-due">Next review {a.nextDueAt ? fmtTime(a.nextDueAt) : "not recorded"} · in {fmtInterval(a.intervalMinutes)}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href={`/missions/${missionId}`} className="inline-flex min-h-10 items-center px-4 rounded-full bg-background text-foreground text-sm hover:-translate-y-0.5 transition-transform" data-testid="link-rated-mission">Back to studying</Link>
        <Link href={`/missions/${missionId}?view=journey`} className="text-sm underline underline-offset-2" data-testid="link-rated-journey">See your journey</Link>
        <Link href={`/how-it-works?workflow=${a.workflowId}`} className="text-xs underline underline-offset-2 text-background/70" data-testid="link-rating-workflow">View execution</Link>
      </div>
    </div>
  );
}

function History({ reviewId, sealed }: { reviewId: string; sealed: boolean }) {
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1];
  const params = cursor ? { reviewId, cursor } : { reviewId };
  const q = useListRecallAttempts(params, { query: { queryKey: getListRecallAttemptsQueryKey(params) } });
  return (
    <section className="rounded-2xl border border-border bg-card p-5" data-testid="panel-recall-history">
      <h2 className="font-display text-lg">Attempt history</h2>
      <p className="text-xs text-muted-foreground">Immutable record. Answers and references appear only for committed attempts.</p>
      {q.isLoading && <div className="mt-3 space-y-2">{[0, 1].map((i) => <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />)}</div>}
      {q.isError && <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(q.error)} <button onClick={() => q.refetch()} className="underline" data-testid="button-retry-history">retry</button></p>}
      {q.data?.items.length === 0 && <p className="mt-3 text-sm text-muted-foreground" data-testid="empty-history">No attempts yet.</p>}
      <ol className="mt-3 space-y-2">
        {q.data?.items.map((a) => (
          <li key={a.id} className="rounded-lg border border-border p-3 text-sm" data-testid={`row-attempt-${a.id}`}>
            <div className="flex flex-wrap gap-2 items-center text-[11px] font-mono text-muted-foreground">
              <span>{fmtUtc(a.startedAt)}</span>
              <span className="px-2 py-0.5 rounded-full bg-muted">{a.questionSource}</span>
              <span className={`px-2 py-0.5 rounded-full border ${a.difficulty ? "border-accent/50 text-accent" : a.answeredAt ? "border-primary/50 text-primary" : "border-border"}`} data-testid={`status-attempt-${a.id}`}>{a.difficulty ?? (a.answeredAt ? "answered, unrated" : "unanswered")}</span>
              {a.intervalMinutes !== null && <span>next {fmtInterval(a.intervalMinutes)}</span>}
            </div>
            <p className="mt-1 font-medium">{a.question}</p>
            {sealed && a.answer !== null && <p className="mt-1 text-xs text-muted-foreground italic">Answer hidden until you commit the current recall.</p>}
            {!sealed && a.answer !== null && <p className="mt-1 text-muted-foreground whitespace-pre-wrap line-clamp-4">{a.answer}</p>}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex justify-between">
        <button disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-border disabled:opacity-40" data-testid="button-history-prev"><ChevronLeft className="h-3 w-3" /> Newer</button>
        <button disabled={!q.data?.nextCursor} onClick={() => q.data?.nextCursor && setStack((s) => [...s, q.data!.nextCursor!])} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-border disabled:opacity-40" data-testid="button-history-next">Older <ChevronRight className="h-3 w-3" /></button>
      </div>
    </section>
  );
}
