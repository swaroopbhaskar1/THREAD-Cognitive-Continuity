import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, PenLine } from "lucide-react";
import { getGetCheckpointIntelligenceQueryKey, useGetCheckpointIntelligence, useRequestCheckpointIntelligence, type Checkpoint } from "@workspace/api-client-react";
import { errorMessage, fmtTime } from "@/lib/thread";
import { intelligenceStatus, fallbackExplanation, aiOutcome, fallbackKind, uniqueIntelligenceEvidence } from "@/lib/intelligence-status";

export type IntelligencePanelProps = {
  checkpointId: string;
  checkpoint?: Checkpoint;
  /** Explicit, user-initiated: copies the AI alternative into the working draft's next action. */
  onUseAction: (action: string) => void;
  /** Focus-only: moves focus to an existing draft field. Must not write, checkpoint or dispatch AI. */
  onAddIdea?: () => void;
  /** Rendered inside the saved outcome (no outer card, no provenance header). */
  embedded?: boolean;
};

export function IntelligencePanel({ checkpointId, checkpoint, onUseAction, onAddIdea, embedded = false }: IntelligencePanelProps) {
  const query = useGetCheckpointIntelligence(checkpointId);
  const request = useRequestCheckpointIntelligence();
  const qc = useQueryClient();
  const job = query.data;
  const outcome = job ? aiOutcome(job) : null;
  const wrap = embedded ? "" : "rounded-2xl border border-border bg-card p-5";

  return (
    <section className={wrap} data-testid="panel-intelligence" aria-label="AI return cue">
      {!embedded && <>
        <p className="font-mono text-[11px] uppercase tracking-widest text-accent">AI return cue · separate from your words</p>
        {checkpoint && <p className="mt-1 text-xs text-muted-foreground" data-testid="text-ai-checkpoint">For the checkpoint saved {fmtTime(checkpoint.createdAt)}</p>}
      </>}

      {query.isLoading && <div className="mt-3 space-y-2" aria-busy="true"><div className="h-4 w-1/2 rounded bg-muted animate-pulse" /><div className="h-4 w-3/4 rounded bg-muted animate-pulse" /></div>}
      {query.isError && <p role="alert" className="text-xs text-destructive mt-3">{errorMessage(query.error)} <button onClick={() => query.refetch()} className="underline" data-testid="button-retry-intelligence">Retry</button></p>}

      {job && <>
        <p className="sr-only" role="status" data-testid="status-intelligence">{outcome === "empty" ? "Enhancement unavailable" : intelligenceStatus(job.status)}</p>

        {outcome === "sparse" && (
          <div className="mt-3" data-testid="ai-sparse">
            <h3 className="font-display text-lg leading-snug">{embedded ? "Want a more useful return cue?" : "Your next step is saved"}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{!embedded && "Want a more useful AI return cue? "}Add one idea you understand or one question you are exploring. THREAD can then try to write a question based on your thinking. This checkpoint was too short for AI, so no AI call was made.</p>
            {onAddIdea && <button onClick={onAddIdea} className="mt-3 inline-flex items-center gap-2 min-h-10 px-4 rounded-full border border-foreground/80 text-sm hover:bg-foreground hover:text-background transition-colors" data-testid="button-add-idea"><PenLine className="h-4 w-4" /> Add an idea or question</button>}
          </div>
        )}

        {outcome === "pending" && (
          <div className="mt-3 flex items-start gap-2 text-sm" data-testid="ai-pending">
            <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-accent shrink-0" />
            <div>
              <p className="font-medium">{job.status === "queued" ? "AI is queued" : job.status === "running" ? "AI is writing a question from your notes" : "AI is retrying"}</p>
              <p className="text-muted-foreground text-xs mt-0.5">You do not need to wait. Keep editing or leave; it will be here when you return.{job.status === "retry_wait" && ` Next attempt ${job.nextAttemptAt ? new Date(job.nextAttemptAt).toLocaleTimeString() : "soon"}.`}</p>
            </div>
          </div>
        )}

        {outcome === "ready" && job.result && (
          <div className="mt-3" data-testid="ai-ready">
            <p className="font-mono text-[11px] uppercase tracking-widest text-primary">A question to come back to</p>
            <p className="mt-1 font-display text-xl leading-snug [overflow-wrap:anywhere]" data-testid="text-ai-retrievalQuestion">{job.result.retrievalQuestion.text}</p>
            <p className="mt-4 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Your return cue</p>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="text-ai-summary">{job.result.summary.text}</p>
            <details className="mt-3 group text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground" data-testid="summary-ai-alternative">Another way to start next time</summary>
              <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="text-ai-nextAction">{job.result.nextAction.text}</p>
              <button onClick={() => onUseAction(job.result!.nextAction.text)} className="mt-2 rounded-full border border-border px-3 py-1.5 text-xs hover:bg-muted" data-testid="button-use-ai-action">Use as my next step in the draft</button>
            </details>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">Where this came from</summary>
              <p className="mt-2">Generated by AI from this checkpoint only. Each line below is an exact quote it had to cite. AI can be wrong; it has not judged whether you are correct.</p>
              {uniqueIntelligenceEvidence(job.result!).map(e => (
                <blockquote key={JSON.stringify([e.field, e.quote])} className="mt-2 border-l-2 pl-2" data-testid="row-ai-evidence">
                  <span className="font-mono">{e.field}</span>: <span className="whitespace-pre-wrap">"{e.quote}"</span>
                  <p className="mt-1">Supports: {e.usedBy.join(", ")}</p>
                </blockquote>
              ))}
            </details>
          </div>
        )}

        {outcome === "fallback" && (
          <div className="mt-3 text-sm" data-testid="ai-fallback">
            <p className="font-medium">{fallbackKind(job)}. Your checkpoint is saved.</p>
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-ai-fallback">{fallbackExplanation(job.lastError, job.attempts, job.maxAttempts)}</p>
            {job.result && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Saved-content prompts (not AI)</summary>
              <p className="mt-2 whitespace-pre-wrap" data-testid="text-ai-retrievalQuestion">{job.result.retrievalQuestion.text}</p>
            </details>}
          </div>
        )}

        {outcome === "empty" && <p className="mt-3 text-sm" data-testid="ai-empty">Enhancement unavailable. The job finished without a usable result; your checkpoint is unchanged.</p>}
        {outcome === "unknown" && <p className="mt-3 text-sm" data-testid="ai-unknown">The AI outcome is unknown or was interrupted ({job.status}). Your checkpoint is saved and unchanged.</p>}

        {outcome === "not_requested" && (
          <div className="mt-3 text-sm">
            <p className="text-muted-foreground">No AI return cue was requested for this checkpoint.</p>
            <button className="mt-2 underline underline-offset-2" disabled={request.isPending} data-testid="button-request-intelligence" onClick={() => request.mutate({ id: checkpointId, data: { simulateFailure: false } }, {
              onSuccess: (value) => qc.setQueryData(getGetCheckpointIntelligenceQueryKey(checkpointId), value),
            })}>{request.isPending ? "Queuing…" : "Ask AI for a return cue"}</button>
          </div>
        )}
        {request.isError && <p role="alert" className="text-xs text-destructive mt-2">{errorMessage(request.error)}</p>}

        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Technical details</summary>
          <p className="mt-2">{intelligenceStatus(job.status)} · checkpoint {checkpointId} · job {job.jobId ?? "not recorded"}</p>
          <p>Attempts {job.attempts}/{job.maxAttempts} · recorded source: {job.source}</p>
          {job.lastError && <p className="mt-1 break-words">Last outcome: {job.lastError}</p>}
          {outcome === "sparse" && <p className="mt-1">Local content check, not an external AI call.</p>}
          {job.failureInjection && <p className="mt-1" data-testid="text-ai-injection">Historical test: local adapter rejection, no external request for injected attempts.</p>}
          {job.workflowId && <Link href={`/how-it-works?workflow=${job.workflowId}`} className="mt-1 inline-block underline" data-testid="link-ai-workflow">View AI execution and replay</Link>}
        </details>
      </>}
    </section>
  );
}
