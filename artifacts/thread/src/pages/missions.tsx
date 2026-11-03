import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Plus, RotateCw, X } from "lucide-react";
import {
  getGetSummaryQueryKey,
  getListMissionsQueryKey,
  useCreateMission,
  useListMissions,
} from "@workspace/api-client-react";
import { errorMessage, fmtTime, useRequestKey } from "@/lib/thread";
import { useExecutionStream } from "@/hooks/use-execution-stream";

function CreateMission({ onClose }: { onClose?: () => void }) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [goal, setGoal] = useState("");
  const { key, rotate } = useRequestKey("mission");
  const create = useCreateMission();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      { data: { title: title.trim(), subject: subject.trim(), goal: goal.trim(), requestKey: key } },
      {
        onSuccess: (m) => {
          rotate();
          qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetSummaryQueryKey() });
          setLocation(`/missions/${m.id}`);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="rise rounded-2xl border border-border bg-card p-6 sm:p-8 space-y-5" data-testid="form-create-mission">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-accent">New mission</p>
          <h2 className="font-display text-2xl mt-1">What are you trying to understand?</h2>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-full hover:bg-muted" data-testid="button-close-create"><X className="h-4 w-4" /></button>
        )}
      </div>
      <label className="block">
        <span className="text-sm font-medium">Topic or learning goal</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required placeholder="e.g. Sliding-window algorithms"
          className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-ring" data-testid="input-title" />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Subject <span className="text-muted-foreground font-normal">(optional)</span></span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={100} placeholder="Linear algebra"
          className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-ring" data-testid="input-subject" />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Goal <span className="text-muted-foreground font-normal">(optional)</span></span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={2000} rows={3} placeholder="By the end, I can explain it without notes."
          className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-ring resize-y" data-testid="input-goal" />
      </label>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive" data-testid="text-create-error">
          Couldn't create the mission: {errorMessage(create.error)}. Your text is still here; try again.
        </p>
      )}
      <button type="submit" disabled={!title.trim() || create.isPending}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground disabled:opacity-50 hover:-translate-y-0.5 transition-transform" data-testid="button-create-mission">
        {create.isPending ? "Creating…" : "Begin mission"}
      </button>
    </form>
  );
}

export default function MissionsPage() {
  useExecutionStream();
  const { data, isLoading, isError, error, refetch } = useListMissions();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-10">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Your missions</p>
          <h1 className="font-display text-4xl sm:text-5xl mt-2">Where you left off</h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">Each mission is one topic or learning goal. Open one to see your next step, or start a new one.</p>
        </div>
        {data && data.length > 0 && !showCreate && (
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-foreground text-background hover:bg-primary transition-colors" data-testid="button-new-mission">
            <Plus className="h-4 w-4" /> New mission
          </button>
        )}
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-40 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      )}

      {isError && (
        <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-6">
          <p className="font-display text-xl">Missions didn't load.</p>
          <p className="text-sm text-muted-foreground mt-1">{errorMessage(error)}</p>
          <button onClick={() => refetch()} className="mt-4 inline-flex items-center gap-2 text-sm px-4 py-2 rounded-full border border-border hover:bg-muted" data-testid="button-retry-missions"><RotateCw className="h-4 w-4" /> Retry</button>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.2fr] gap-10 items-start">
          <div className="pt-4">
            <svg viewBox="0 0 300 120" className="w-full max-w-sm" aria-hidden="true">
              <path className="thread-line" d="M10 90 C 70 10, 120 120, 180 60 S 260 30, 290 70" fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <h2 className="font-display text-3xl mt-6">Nothing here yet, and that's a good start.</h2>
            <p className="mt-3 text-muted-foreground leading-relaxed">A mission is one topic or learning goal, like sliding-window algorithms. Name it, write one next step, and save. That is the whole first session.</p>
          </div>
          <CreateMission />
        </div>
      )}

      {data && data.length > 0 && (
        <>
          {showCreate && <div className="mb-8"><CreateMission onClose={() => setShowCreate(false)} /></div>}
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.map((m, i) => (
              <li key={m.id} className="rise min-w-0" style={{ animationDelay: `${i * 50}ms` }}>
                <Link href={`/missions/${m.id}`} className="group block h-full rounded-2xl border border-border bg-card p-6 hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-24px_hsl(200_32%_14%/0.35)] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`card-mission-${m.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {m.subject && <p className="font-mono text-[11px] uppercase tracking-widest text-accent truncate">{m.subject}</p>}
                      <h3 className="font-display text-2xl mt-1 leading-tight break-words">{m.title}</h3>
                    </div>
                    <ArrowUpRight className="h-5 w-5 text-muted-foreground group-hover:text-primary group-hover:rotate-45 transition-transform shrink-0" />
                  </div>
                  <div className="mt-5 border-l-2 border-primary pl-3">
                    <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Your next step</p>
                    <p className="text-sm mt-1 line-clamp-2 break-words">{m.nextAction || <span className="text-muted-foreground italic">Not set yet</span>}</p>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
                    <span>{m.checkpointCount} checkpoint{m.checkpointCount === 1 ? "" : "s"}</span>
                    <span>updated {fmtTime(m.updatedAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
