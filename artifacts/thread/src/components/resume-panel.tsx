import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2 } from "lucide-react";
import { useStartResumption, useGetCheckpointIntelligence, getGetSummaryQueryKey, type Checkpoint, type Resumption, type ResumptionInputObstacle } from "@workspace/api-client-react";
import { errorMessage, fmtTime, newKey, OBSTACLES } from "@/lib/thread";

export function ResumePanel({ missionId, checkpoint, currentAction, gated, onResumed, onEnterWithoutResume, onRestore }: {
  missionId: string; checkpoint: Checkpoint; currentAction: string; gated: boolean;
  onResumed: (r: Resumption) => void; onEnterWithoutResume: () => void; onRestore: (cp: Checkpoint) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [obstacle, setObstacle] = useState<ResumptionInputObstacle>("ready");
  const [warming, setWarming] = useState(false);
  const [resumption, setResumption] = useState<Resumption | null>(null);
  const [closed, setClosed] = useState(false);
  const frozen = useRef<{ obstacle: ResumptionInputObstacle; recallAnswer: string; requestKey: string } | null>(null);
  const busy = useRef(false);
  const start = useStartResumption();
  const qc = useQueryClient();
  const intelligence = useGetCheckpointIntelligence(checkpoint.id);
  const [prompt, setPrompt] = useState<{ text: string; ai: boolean } | null>(null);
  useEffect(() => {
    if (prompt || (!intelligence.data && !intelligence.isError)) return;
    const data = intelligence.data;
    const ready = data?.source === "ai" && data.status === "succeeded" && !!data.result;
    setPrompt({ text: ready ? data.result!.retrievalQuestion.text : checkpoint.recallQuestion, ai: !!ready });
  }, [prompt, intelligence.data, intelligence.isError, checkpoint.recallQuestion]);
  const begin = (skip: boolean) => {
    if (busy.current) return;
    busy.current = true;
    frozen.current ??= { obstacle, recallAnswer: skip ? "" : answer, requestKey: newKey("resume") };
    start.mutate({ id: missionId, data: frozen.current }, {
      onSuccess: r => { frozen.current = null; setResumption(r); onResumed(r); qc.invalidateQueries({ queryKey: getGetSummaryQueryKey() }); },
      onSettled: () => { busy.current = false; },
    });
  };
  const error = start.isError && <div role="alert" className="mt-3 text-sm text-destructive">
    Could not confirm the resumption: {errorMessage(start.error)}. Retry sends the identical saved request.
    <button onClick={() => begin(true)} disabled={start.isPending} className="block min-h-11 underline" data-testid="button-retry-resume">Retry same resumption</button>
    <button onClick={onEnterWithoutResume} className="block min-h-11 underline text-foreground" data-testid="button-enter-without-resume">Continue draft without recording a resumption</button>
  </div>;
  if (closed && !gated) return null;
  if (gated && !warming) return <section className="rise mt-8 grid md:grid-cols-[1.4fr_1fr] rounded-2xl border bg-card overflow-hidden shadow-[0_30px_60px_-40px_hsl(200_32%_14%/0.5)]" data-testid="panel-resume">
    <div className="p-6 sm:p-8">
      <p className="font-mono text-xs uppercase tracking-widest text-accent">Welcome back · your current draft</p>
      <h2 className="font-display text-lg mt-3 text-muted-foreground">Your next step</h2>
      <p className="mt-1 font-display text-2xl sm:text-3xl leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="text-current-action">{currentAction || "Open your draft and choose a next step."}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button onClick={() => begin(true)} disabled={start.isPending} className="min-h-11 px-6 rounded-full bg-primary text-primary-foreground font-medium hover:-translate-y-0.5 transition-transform disabled:opacity-50" data-testid="button-continue-draft">{start.isPending ? "Opening…" : "Continue learning"}</button>
        <button onClick={() => setWarming(true)} disabled={start.isPending || !!frozen.current} className="min-h-11 px-4 rounded-full border hover:bg-muted transition-colors disabled:opacity-50" data-testid="button-try-warmup">Try a question from memory</button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Continuing opens your newest draft. Older checkpoints never replace it.</p>
    </div>
    <div className="bg-muted/70 p-6 sm:p-8 border-t md:border-t-0 md:border-l border-border">
      <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Where you were stuck</p>
      {checkpoint.questions.trim()
        ? <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] line-clamp-6" data-testid="text-resume-stuck">{checkpoint.questions}</p>
        : <p className="mt-2 text-sm text-muted-foreground" data-testid="text-resume-stuck">No uncertainty was saved in your last checkpoint.</p>}
      <p className="mt-3 text-xs text-muted-foreground">From your checkpoint saved {fmtTime(checkpoint.createdAt)}</p>
    </div>
    {error}
  </section>;
  if (gated) return <section className="rise mt-6 rounded-2xl border bg-card p-5 sm:p-7" data-testid="panel-resume">
    <p className="text-xs font-mono uppercase tracking-widest text-accent">Optional · a question from memory</p>
    <h2 className="mt-2 font-display text-2xl [overflow-wrap:anywhere]" data-testid="text-recall-question">{prompt?.text ?? "Loading your recall prompt…"}</h2>
    <p className="text-xs text-muted-foreground mt-2">{prompt?.ai ? "AI-personalized question, grounded in your checkpoint" : "Saved-content recall prompt"}. Reference context stays hidden until you submit or skip.</p>
    <textarea aria-label="Your recall answer" value={answer} onChange={e => setAnswer(e.target.value)} disabled={!!frozen.current}
      rows={4} maxLength={20000} className="mt-4 w-full rounded-lg border p-3 bg-background focus-visible:ring-2 focus-visible:ring-ring" data-testid="input-recall" />
    <details className="mt-4"><summary className="cursor-pointer text-sm">Need a different way back in?</summary>
      <fieldset disabled={!!frozen.current} className="mt-3"><legend className="text-sm font-medium">Optional restart strategy</legend>
        <div className="mt-2 grid sm:grid-cols-2 gap-2">{OBSTACLES.map(o => <label key={o.value} className={`flex gap-3 border rounded-lg p-3 ${obstacle === o.value ? "border-primary" : ""}`}>
          <input type="radio" name="obstacle" checked={obstacle === o.value} onChange={() => setObstacle(o.value)} data-testid={`radio-obstacle-${o.value}`} />
          <span className="text-sm"><span className="block font-medium">{o.label}</span><span className="text-xs text-muted-foreground">{o.hint}</span></span>
        </label>)}</div>
      </fieldset>
    </details>
    <div className="mt-4 flex flex-wrap gap-2">
      <button disabled={start.isPending || !answer.trim()} onClick={() => begin(false)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 text-sm disabled:opacity-50" data-testid="button-reveal">
        {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Submit recall and continue
      </button>
      <button disabled={start.isPending} onClick={() => begin(true)} className="min-h-11 px-4 rounded-full border text-sm disabled:opacity-50" data-testid="button-skip-recall">Skip and continue current draft</button>
    </div>
    {error}
  </section>;
  if (!resumption) return null;
  return <section className="mt-6 rounded-2xl border bg-card p-5" data-testid="panel-resume-result">
    <div className="flex flex-wrap justify-between items-center gap-2"><p className="text-sm font-medium">Your working draft is open. Continue editing below.</p>
      <button onClick={() => setClosed(true)} className="min-h-11 px-3 text-sm underline" data-testid="button-close-resume">Dismiss</button></div>
    <details className="mt-2 text-sm"><summary className="cursor-pointer min-h-11 flex items-center">Saved context and restart strategy · {fmtTime(checkpoint.createdAt)}</summary>
      <p data-testid="text-strategy" className="mt-2 text-muted-foreground">{resumption.strategy}</p>
      {answer.trim() && <p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere]">You recalled: {answer}</p>}
      <p className="mt-3 text-xs text-muted-foreground">Original checkpoint context, not your current working draft:</p>
      {(["nextAction", "understanding", "questions", "reasoning"] as const).map(key => <p key={key} className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]"><strong>{key === "nextAction" ? "Next action then" : key}: </strong>{checkpoint[key] || "Empty"}</p>)}
      <button onClick={() => onRestore(checkpoint)} className="mt-3 min-h-11 px-4 border rounded-full text-sm" data-testid="button-restore">Replace draft fields from this checkpoint…</button>
    </details>
  </section>;
}
