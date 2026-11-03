import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, Clock, Database, HelpCircle,
  Layers, Monitor, Pause, Play, RotateCcw, RotateCw, Server, SkipForward, Sparkles,
} from "lucide-react";
import {
  getGetExecutionHistoryQueryKey, getGetSummaryQueryKey, getGetWorkflowEventsQueryKey, getListWorkflowsQueryKey,
  useGetExecutionHistory, useGetSummary, useGetWorkflowEvents, useListWorkflows, useGetWorkflow,
  type ExecutionEvent, type ExecutionEventSourceComponent,
} from "@workspace/api-client-react";
import { errorMessage, fmtMs, fmtTime } from "@/lib/thread";
import { fmtUtc } from "@/lib/review-store";
import { useExecutionStream } from "@/hooks/use-execution-stream";
import {
  SPEEDS, aiWasCalled, aiReceiptUnknown, buildStory, cursorPosition, isCommitAck, isKnownEvent, isMeaningfulOp, isProblem, opTitle, outcomeTone, paceMs,
  pickDefaultWorkflow, readWorkflowParam, recordedInputs, replayState, replayGroupLabel, sortBySequence, statusInfo, stepForward, stepLabel, storyIndexOf,
  type Tone,
} from "@/lib/execution-model";

const TONE: Record<Tone, { cls: string; icon: typeof CheckCircle2 }> = {
  ok: { cls: "text-accent border-accent/40 bg-accent/5", icon: CheckCircle2 },
  fallback: { cls: "text-primary border-primary/40 bg-primary/5", icon: Layers },
  fail: { cls: "text-destructive border-destructive/50 bg-destructive/5", icon: AlertTriangle },
  pending: { cls: "text-foreground border-border bg-muted", icon: Clock },
  unknown: { cls: "text-muted-foreground border-dashed border-border", icon: HelpCircle },
};
function Badge({ tone, children, testid }: { tone: Tone; children: ReactNode; testid?: string }) {
  const t = TONE[tone];
  return <span data-testid={testid} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-mono ${t.cls}`}><t.icon className="h-3 w-3 shrink-0" aria-hidden />{children}</span>;
}

const COMP_META: Record<ExecutionEventSourceComponent, { label: string; icon: typeof Monitor }> = {
  browser: { label: "Browser", icon: Monitor }, server: { label: "Server", icon: Server },
  database: { label: "Database", icon: Database }, ai: { label: "AI", icon: Sparkles }, unknown: { label: "not recorded", icon: HelpCircle },
};
const NODES = ["browser", "server", "database", "ai"] as const;

function usePrefersReducedMotion() {
  const [r, setR] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setR(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return r;
}

function Endpoint({ c }: { c: ExecutionEventSourceComponent }) {
  const m = COMP_META[c] ?? COMP_META.unknown;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-mono ${c === "unknown" ? "border border-dashed border-border text-muted-foreground italic" : "bg-muted"}`}><m.icon className="h-3 w-3" aria-hidden /> {m.label}</span>;
}
function Edge({ e, testid }: { e: ExecutionEvent; testid?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid={testid} aria-label={`from ${COMP_META[e.sourceComponent].label} to ${COMP_META[e.destinationComponent].label}`}>
      <Endpoint c={e.sourceComponent} /><ArrowRight className="h-3 w-3 text-primary shrink-0" aria-hidden /><Endpoint c={e.destinationComponent} />
    </span>
  );
}

/** Component map for the selected run only. Highlights the inspected event's recorded path. */
function ComponentMap({ active, used, aiCalled, aiUncertain, still }: { active: ExecutionEvent | null; used: Set<string>; aiCalled: boolean; aiUncertain: boolean; still: boolean }) {
  return (
    <div data-testid="panel-component-map">
      <div className="grid grid-cols-2 gap-2" aria-label="Components involved in this run">
        {NODES.map((n) => {
          const m = COMP_META[n];
          const src = active?.sourceComponent === n, dst = active?.destinationComponent === n;
          const on = src || dst;
          const inRun = used.has(n);
          return (
            <div key={n} data-testid={`node-${n}`}
              className={`rounded-xl border p-3 ${still ? "" : "transition-colors duration-300"} ${on ? "border-primary bg-primary/10" : inRun ? "border-border bg-card" : "border-dashed border-border bg-muted/40 text-muted-foreground"}`}>
              <div className="flex items-center gap-2">
                <m.icon className={`h-4 w-4 ${on ? "text-primary" : ""}`} aria-hidden />
                <span className="font-display text-base">{m.label}</span>
              </div>
              <p className="mt-1 text-[10px] font-mono uppercase tracking-widest">
                {src && dst ? <span className="text-primary">source + destination</span> : src ? <span className="text-primary">source</span> : dst ? <span className="text-primary">destination</span>
                  : n === "ai" && aiUncertain ? "call receipt unknown" : n === "ai" && !aiCalled ? "no external call recorded" : inRun ? "in this run" : "not in this run"}
              </p>
            </div>
          );
        })}
      </div>
      <div className="mt-2 rounded-lg border border-border bg-card px-3 py-2 text-xs flex flex-wrap items-center gap-2" data-testid="text-diagram-edge">
        {active ? <><Edge e={active} />{(active.sourceComponent === "unknown" || active.destinationComponent === "unknown") && <span className="text-muted-foreground">Path not recorded for this legacy event; none is inferred.</span>}</>
          : <span className="text-muted-foreground">Select a step to see its recorded path.</span>}
      </div>
    </div>
  );
}

function EventDetail({ e, operation }: { e: ExecutionEvent; operation?: string }) {
  const rows: [string, string][] = [
    ["Event", e.name], ["Event ID", e.id], ["Workflow", e.workflowId], ...(operation ? [["Operation", operation] as [string, string]] : []),
    ["Sequence", String(e.sequence)], ["Recorded (UTC)", fmtUtc(e.createdAt)],
    [isCommitAck(e) ? "Commit round-trip (separate; may be shared)" : "Measured duration", fmtMs(e.durationMs)],
    ["Attempt", String(e.attempt)], ["Outcome", e.outcome], ["Fallback", e.fallback ? "yes, labeled fallback output" : "no"], ["Component", e.component],
  ];
  return (
    <div className="rounded-lg bg-muted/60 p-3 text-xs" data-testid={`panel-event-detail-${e.id}`}>
      <div className="mb-2"><Edge e={e} testid={`text-event-edge-${e.id}`} /></div>
      <dl className="space-y-1.5 font-mono">
        {rows.map(([k, v]) => <div key={k} className="grid grid-cols-1 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-all">{v}</dd></div>)}
      </dl>
      <p className="mt-2 font-mono text-muted-foreground">Details</p>
      <p className="font-mono whitespace-pre-wrap break-words">{e.details || "none recorded"}</p>
    </div>
  );
}

function GlobalHistory({ selected, onSelect }: { selected: string; onSelect: (workflowId: string, operation: string) => void }) {
  const [stack, setStack] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const cursor = stack[stack.length - 1];
  const params = cursor ? { cursor } : undefined;
  const q = useGetExecutionHistory(params, { query: { queryKey: getGetExecutionHistoryQueryKey(params) } });
  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5" data-testid="panel-global-history">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl">All recorded events</h2>
        <span className="text-[11px] font-mono text-muted-foreground">newest first · server timestamps (UTC)</span>
      </div>
      <p className="text-xs text-muted-foreground">Every event, including reads and telemetry, exactly as stored. Open a workflow to replay it.</p>
      {q.isLoading && <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />)}</div>}
      {q.isError && <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(q.error)} <button onClick={() => q.refetch()} className="underline min-h-[44px]" data-testid="button-retry-global-history">Retry</button></p>}
      {q.data?.items.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No events recorded yet.</p>}
      <ol className="mt-3 space-y-1.5">
        {q.data?.items.map(({ event: e, operation }) => (
          <li key={e.id} className={`rounded-lg border p-2.5 ${e.workflowId === selected ? "border-primary/50" : "border-border"}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button onClick={() => setOpen((o) => (o === e.id ? null : e.id))} aria-expanded={open === e.id} className="text-left font-medium break-all hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`button-history-event-${e.id}`}>{e.name}</button>
              {isCommitAck(e) && <span className="font-mono px-2 py-0.5 rounded-full border border-dashed border-accent/60 text-accent">commit confirmation</span>}
              <Edge e={e} />
              <Badge tone={outcomeTone(e.outcome, e.fallback)}>{e.outcome}</Badge>
              {e.fallback && <Badge tone="fallback">fallback</Badge>}
              <span className="ml-auto font-mono text-muted-foreground">{fmtUtc(e.createdAt)}</span>
              <button onClick={() => onSelect(e.workflowId, operation)} className="font-mono underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`button-open-workflow-${e.id}`}>{operation} · open run</button>
            </div>
            {open === e.id && <div className="mt-2"><EventDetail e={e} operation={operation} /></div>}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex justify-between">
        <button disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))} className="inline-flex min-h-[44px] items-center gap-1 text-xs px-4 rounded-full border border-border disabled:opacity-40" data-testid="button-global-history-newer"><ChevronLeft className="h-3 w-3" aria-hidden /> Newer</button>
        <button disabled={!q.data?.nextCursor} onClick={() => q.data?.nextCursor && setStack((s) => [...s, q.data!.nextCursor!])} className="inline-flex min-h-[44px] items-center gap-1 text-xs px-4 rounded-full border border-border disabled:opacity-40" data-testid="button-global-history-older">Older <ChevronRight className="h-3 w-3" aria-hidden /></button>
      </div>
    </section>
  );
}

const ctrl = "inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

export default function HowItWorksPage() {
  const still = usePrefersReducedMotion();
  // URL is the source of truth for the selected run. Back/Forward restores it.
  const [urlWf, setUrlWf] = useState<string | null>(() => readWorkflowParam(window.location.search));
  useEffect(() => {
    const onPop = () => setUrlWf(readWorkflowParam(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [showAll, setShowAll] = useState(false);
  const stream = useExecutionStream();
  const summary = useGetSummary({ query: { queryKey: getGetSummaryQueryKey(), refetchOnWindowFocus: false } });
  const workflows = useListWorkflows({ query: { queryKey: getListWorkflowsQueryKey() } });

  // Default once (replaceState); later SSE arrivals can never move the selection.
  useEffect(() => {
    if (urlWf || !workflows.data) return;
    const id = pickDefaultWorkflow(workflows.data);
    if (!id) return;
    const url = new URL(window.location.href);
    url.searchParams.set("workflow", id);
    window.history.replaceState(window.history.state, "", url);
    setUrlWf(id);
  }, [urlWf, workflows.data]);

  const selectWorkflow = (id: string) => {
    if (id === urlWf) return;
    const url = new URL(window.location.href);
    url.searchParams.set("workflow", id);
    window.history.pushState(window.history.state, "", url);
    setUrlWf(id);
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
  };

  const wfId = urlWf ?? "";
  const events = useGetWorkflowEvents(wfId, { query: { enabled: !!wfId, queryKey: getGetWorkflowEventsQueryKey(wfId) } });
  const sorted = useMemo(() => sortBySequence(events.data ?? []), [events.data]);
  const story = useMemo(() => buildStory(sorted), [sorted]);
  const run = useGetWorkflow(wfId, { query: { enabled: !!wfId } });
  const wf = run.data ?? workflows.data?.find((w) => w.id === wfId);
  const opFromEvents = useRef<Record<string, string>>({});
  const operation = wf?.operation ?? opFromEvents.current[wfId];
  const status = statusInfo(wf?.status, operation);
  const problems = sorted.filter(isProblem);
  const commitAcks = sorted.filter(isCommitAck);
  const inputs = useMemo(() => recordedInputs(sorted), [sorted]);
  const aiCalled = aiWasCalled(sorted);
  const aiUncertain = aiReceiptUnknown(sorted);
  const used = useMemo(() => new Set(sorted.flatMap((e) => [e.sourceComponent, e.destinationComponent])), [sorted]);

  // Replay: cursor indexes the original sequence-sorted events. -1 = full record (not replaying).
  const [cursor, setCursor] = useState(-1);
  const [inspect, setInspect] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  useEffect(() => { setCursor(-1); setInspect(-1); setPlaying(false); setOpenGroups(new Set()); }, [wfId]);
  useEffect(() => {
    if (!playing) return;
    if (cursor >= sorted.length - 1) { setPlaying(false); return; }
    const t = window.setTimeout(() => setCursor((c) => c + 1), paceMs(speed));
    return () => window.clearTimeout(t);
  }, [playing, cursor, sorted.length, speed]);
  const rstate = replayState(cursor, playing, sorted.length);
  const focusIdx = cursor >= 0 ? cursor : inspect >= 0 ? inspect : Math.max(0, story.find((s) => s.kind === "step" && sorted[s.indices[0]].name === "ai.external_call")?.indices[0] ?? sorted.findIndex(isProblem));
  const active = sorted[focusIdx] ?? null;
  const activeStory = active ? storyIndexOf(story, focusIdx) : -1;

  const play = () => { if (playing) { setPlaying(false); return; } if (cursor >= sorted.length - 1) setCursor(-1); setInspect(-1); setPlaying(true); };
  const step = () => { setPlaying(false); setCursor((c) => stepForward(c, sorted.length)); };
  const reset = () => { setPlaying(false); setCursor(-1); };
  const pick = (i: number) => { setPlaying(false); if (cursor >= 0) setCursor(i); else setInspect(i); };

  const recent = workflows.data ?? [];
  const browserList = showAll ? recent : recent.filter((w) => isMeaningfulOp(w.operation));
  const hidden = recent.length - recent.filter((w) => isMeaningfulOp(w.operation)).length;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">How THREAD runs · Execution</p>
      <h1 className="font-display text-2xl sm:text-4xl mt-1">One real recorded run.</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Persisted steps. Measured server timings.</p>

      {/* Level 1: what happened */}
      <section className="mt-6 rounded-2xl border border-border bg-card p-4 sm:p-6" aria-labelledby="run-title" data-testid="panel-selected-run">
        {!wfId ? (
          workflows.isLoading ? <div className="space-y-3"><div className="h-8 w-2/3 rounded bg-muted animate-pulse" /><div className="h-5 w-1/2 rounded bg-muted animate-pulse" /><div className="h-11 w-full rounded-full bg-muted animate-pulse" /></div>
            : workflows.isError ? <p role="alert" className="text-sm text-destructive">{errorMessage(workflows.error)} <button onClick={() => workflows.refetch()} className="underline min-h-[44px]" data-testid="button-retry-workflows">Retry</button></p>
            : <div><h2 id="run-title" className="font-display text-2xl">Nothing recorded yet</h2><p className="mt-1 text-sm text-muted-foreground">Create a mission, save a draft, or leave a checkpoint. The run will appear here.</p></div>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row items-start gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Selected run</p>
                <h2 id="run-title" className="font-display text-2xl sm:text-3xl break-words" data-testid="text-run-title">{operation ? opTitle(operation) : "Recorded run"}</h2>
                <p className="mt-1 text-xs font-mono text-muted-foreground break-words">{operation ?? "operation unknown"}</p>
              </div>
              <Badge tone={status.tone} testid="status-run">{status.label}</Badge>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Replay controls">
              <button onClick={play} disabled={!sorted.length} className={`${ctrl} bg-primary text-primary-foreground`} data-testid="button-replay-play">{playing ? <><Pause className="h-4 w-4" aria-hidden /> Pause</> : <><Play className="h-4 w-4" aria-hidden /> {rstate === "paused" ? "Resume" : "Replay"}</>}</button>
              <button onClick={step} disabled={!sorted.length || cursor >= sorted.length - 1} className={`${ctrl} border border-border hover:bg-muted`} data-testid="button-replay-step"><SkipForward className="h-4 w-4" aria-hidden /> Step</button>
              <button onClick={reset} disabled={cursor < 0} className={`${ctrl} border border-border hover:bg-muted`} data-testid="button-replay-reset"><RotateCcw className="h-4 w-4" aria-hidden /> Reset</button>
              <label className="inline-flex items-center gap-2 text-sm">Speed
                <select value={speed} onChange={e => setSpeed(Number(e.target.value))} className="min-h-[44px] rounded-full border border-border bg-background px-3 text-sm font-mono" data-testid="select-replay-speed">
                  {SPEEDS.map(s => <option key={s} value={s}>{s}x</option>)}
                </select>
              </label>
            </div>
            <dl className="mt-4 grid grid-cols-3 sm:grid-cols-4 gap-3 text-sm">
              <div><dt className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Recorded</dt><dd data-testid="text-run-time">{wf ? fmtTime(wf.createdAt) : sorted[0] ? fmtTime(sorted[0].createdAt) : "unknown"}</dd></div>
              <div><dt className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Processing</dt><dd className="font-mono" data-testid="text-run-duration">{wf ? fmtMs(wf.durationMs) : "unknown"}</dd></div>
              <div><dt className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Events</dt><dd className="font-mono">{events.isLoading ? "…" : sorted.length}</dd></div>
              <div className="col-span-3 sm:col-span-1"><dt className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Inputs recorded</dt><dd className="break-words" data-testid="text-run-inputs">{inputs.length ? inputs.join(", ") : "none recorded"}</dd></div>
            </dl>
            <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Timing details and run ID</summary><p className="mt-1 break-all">{wfId}</p><p className="mt-1">Processing is the server's measured workflow total; it excludes queue and retry wait and separate COMMIT acknowledgments{commitAcks.length ? ` (${commitAcks.map(c => fmtMs(c.durationMs)).join(", ")}, possibly shared)` : ""}.{!wf && " Workflow metadata has not loaded; its status and total are unknown."}</p></details>
            {problems.length > 0 && (
              <div role="status" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="panel-run-problems">
                <p className="flex items-center gap-1.5 font-medium text-destructive"><AlertTriangle className="h-4 w-4" aria-hidden /> {problems.length} failure or retry event{problems.length > 1 ? "s" : ""} recorded</p>
                <ul className="mt-1 space-y-0.5 text-xs font-mono">{problems.map((p) => <li key={p.id}><button className="underline text-left break-all" onClick={() => pick(sorted.indexOf(p))} data-testid={`button-problem-${p.id}`}>#{p.sequence} {stepLabel(p.name)} · {p.outcome} · attempt {p.attempt}</button></li>)}</ul>
              </div>
            )}
            {aiUncertain && <p className="mt-3 text-sm" data-testid="text-ai-receipt-unknown">A dispatch intent or interrupted worker is recorded, but no completed external-call receipt is available. Whether the provider received the call, its outcome, and its unfinished duration are unknown.</p>}
            {sorted.length > 0 && !aiCalled && !aiUncertain && operation && /^(ai|intelligence)\./.test(operation) && <p className="mt-3 text-sm text-muted-foreground" data-testid="text-ai-not-called">No external AI call was recorded in this run. The steps show the actual local path.</p>}

            <p className="mt-2 text-xs" role="status" aria-live="polite" data-testid="text-diagram-mode">
              {rstate === "idle" ? <span className="text-muted-foreground">Showing the complete recorded run. Replay pacing is {paceMs(speed)} ms per step for display only.</span>
                : <span><span className="font-medium">{rstate === "done" ? "Replay finished" : `Replaying${rstate === "paused" ? " (paused)" : ""}: ${stepLabel(sorted[cursor].name)}`}</span> <span className="font-mono text-muted-foreground">· event {cursor + 1} of {sorted.length} · {paceMs(speed)} ms per step, not execution time</span></span>}
            </p>
          </>
        )}
      </section>

      {/* Level 2: how it happened */}
      {wfId && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
          <section aria-labelledby="story-title" className="min-w-0">
            <h2 id="story-title" className="font-display text-xl">Execution story</h2>
            <p className="text-xs text-muted-foreground">In recorded order. Routine database writes are grouped; open a group to see each one.</p>
            {events.isLoading && <div className="mt-3 space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-14 rounded-xl bg-muted animate-pulse" />)}</div>}
            {events.isError && <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(events.error)} <button className="underline min-h-[44px]" onClick={() => events.refetch()} data-testid="button-retry-events">Retry</button></p>}
            {events.data?.length === 0 && <p className="mt-3 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No events recorded for this run.</p>}
            <ol className="mt-3 space-y-2" data-testid="list-story">
              {story.map((s, si) => {
                const first = sorted[s.indices[0]];
                const isActive = si === activeStory;
                const pos = s.indices.map((i) => cursorPosition(i, cursor));
                const posLabel = replayGroupLabel(pos, rstate);
                const dim = cursor >= 0 && pos.every((p) => p === "upcoming");
                if (s.kind === "instrumentation") {
                  const open = openGroups.has(si) || isActive;
                  return (
                    <li key={first.id} className={`rounded-xl border border-dashed p-3 ${isActive ? "border-primary bg-primary/5" : "border-border"} ${dim ? "opacity-50" : ""}`} data-testid={`group-instrumentation-${first.id}`}>
                      <button className="flex w-full items-center gap-2 text-left text-sm rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={open}
                        onClick={() => setOpenGroups((g) => { const n = new Set(g); if (n.has(si)) n.delete(si); else n.add(si); return n; })} data-testid={`button-group-${first.id}`}>
                        <Layers className="h-4 w-4 text-muted-foreground" aria-hidden />
                        <span className="text-muted-foreground">{s.indices.length} instrumentation write{s.indices.length > 1 ? "s" : ""} · {[...new Set(s.indices.map((i) => stepLabel(sorted[i].name)))].join(", ")}</span>
                        {posLabel && <span className="ml-auto text-[10px] font-mono uppercase tracking-widest text-primary">{posLabel}</span>}
                        <ChevronDown className={`h-4 w-4 shrink-0 ${posLabel ? "" : "ml-auto"} ${open ? "rotate-180" : ""}`} aria-hidden />
                      </button>
                      {open && <ul className="mt-2 space-y-1">{s.indices.map((i) => { const e = sorted[i]; return (
                        <li key={e.id}><button onClick={() => pick(i)} className={`w-full flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted ${i === focusIdx ? "bg-muted" : ""}`} data-testid={`button-event-${e.id}`}>
                          <span className="font-mono text-muted-foreground">#{e.sequence}</span><span>{stepLabel(e.name)}</span>
                          {isCommitAck(e) && <span className="font-mono text-accent" data-testid={`badge-commit-${e.id}`}>outside processing total</span>}
                          <span className="ml-auto font-mono text-muted-foreground">{fmtMs(e.durationMs)}</span>
                        </button></li>); })}</ul>}
                    </li>
                  );
                }
                const i = s.indices[0], e = first, tone = outcomeTone(e.outcome, e.fallback);
                return (
                  <li key={e.id} data-testid={`row-event-${e.id}`} className={`rounded-xl border p-3 ${still ? "" : "transition-colors"} ${isActive ? "border-primary bg-primary/5" : tone === "fail" ? "border-destructive/50" : "border-border bg-card"} ${dim ? "opacity-50" : ""}`}>
                    <button type="button" onClick={() => pick(i)} aria-current={isActive ? "step" : undefined} className="w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`button-event-${e.id}`}>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">#{e.sequence}</span>
                        <span className="font-medium break-words">{stepLabel(e.name)}</span>
                        {!isKnownEvent(e.name) && <span className="text-[11px] font-mono text-muted-foreground">(unrecognized event type)</span>}
                        <Badge tone={tone}>{e.outcome}</Badge>
                        {e.fallback && <Badge tone="fallback">fallback</Badge>}
                        {e.attempt > 1 && <Badge tone="pending">attempt {e.attempt}</Badge>}
                        {posLabel && <span className="ml-auto text-[10px] font-mono uppercase tracking-widest text-primary">{posLabel}</span>}
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                        <Edge e={e} />
                        <span className="font-mono text-muted-foreground">{fmtMs(e.durationMs)}</span>
                      </span>
                      {e.details && <span className="mt-1 block text-xs text-muted-foreground break-words line-clamp-2">{e.details}</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          <aside className="lg:sticky lg:top-4 space-y-3 min-w-0" aria-labelledby="inspector-title" data-testid="panel-inspector">
            <h2 id="inspector-title" className="font-display text-xl">{active ? `Step: ${stepLabel(active.name)}` : "Step inspector"}</h2>
            <ComponentMap active={active} used={used} aiCalled={aiCalled} aiUncertain={aiUncertain} still={still} />
            {active && <EventDetail e={active} operation={operation} />}
          </aside>
        </div>
      )}

      {/* Level 3: engineering details */}
      {wfId && sorted.length > 0 && (
        <details className="mt-6 rounded-2xl border border-border bg-card p-4 sm:p-5" data-testid="panel-engineering">
          <summary className="cursor-pointer font-display text-lg min-h-[44px] flex items-center">Engineering details · all {sorted.length} original events</summary>
          <p className="text-xs text-muted-foreground">Original sequence and values. COMMIT acknowledgments are measured separately, may be shared by workflows committed together, and are never added to the processing total.</p>
          <ol className="mt-3 space-y-2">{sorted.map((e) => <li key={e.id}><EventDetail e={e} operation={operation} /></li>)}</ol>
        </details>
      )}

      {/* Browse runs + counters */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
        <section className="rounded-2xl border border-border bg-card p-4" data-testid="panel-workflows">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg">Recent runs</h2>
            <span role="status" className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground" data-testid="text-stream-status"><CircleDashed className="h-3 w-3" aria-hidden /> Live updates · {stream.status}</span>
          </div>
          <p className="text-xs text-muted-foreground">New activity appears here without changing the run you are viewing.</p>
          {hidden > 0 && <label className="mt-2 flex items-center gap-2 text-xs min-h-[44px]"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="checkbox-show-reads" /> Include {hidden} reads and counts</label>}
          {workflows.isLoading && <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />)}</div>}
          <ul className="mt-2 space-y-1 max-h-[420px] overflow-auto pr-1">
            {browserList.map((w) => { const st = statusInfo(w.status, w.operation); return (
              <li key={w.id}>
                <button onClick={() => selectWorkflow(w.id)} aria-current={w.id === wfId ? "true" : undefined} data-testid={`button-workflow-${w.id}`}
                  className={`w-full text-left rounded-lg px-3 py-2 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${w.id === wfId ? "bg-foreground text-background" : "hover:bg-muted"}`}>
                  <span className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{opTitle(w.operation)}</span><span className="font-mono text-[11px] opacity-70">{fmtMs(w.durationMs)}</span></span>
                  <span className="block text-[11px] font-mono opacity-70">{st.label} · {w.operation} · {fmtTime(w.createdAt)}</span>
                </button>
              </li>); })}
          </ul>
        </section>
        <section className="rounded-2xl border border-border bg-card p-4" data-testid="panel-summary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg">Your activity</h2>
            <button onClick={() => summary.refetch()} disabled={summary.isFetching} className="inline-flex min-h-[44px] items-center gap-1.5 text-xs font-mono px-3 rounded-full border border-border hover:bg-muted disabled:opacity-50" data-testid="button-refresh-summary"><RotateCw className={`h-3 w-3 ${summary.isFetching && !still ? "animate-spin" : ""}`} aria-hidden /> Refresh counts</button>
          </div>
          {summary.isError ? <p className="mt-2 text-sm text-destructive" role="alert">Counts unavailable: {errorMessage(summary.error)}</p> : (
            <dl className="mt-2 grid grid-cols-3 gap-2">
              {([["Missions", summary.data?.missions], ["Checkpoints", summary.data?.checkpoints], ["Resumptions", summary.data?.resumptions]] as const).map(([l, v]) => (
                <div key={l} className="rounded-lg bg-muted/50 p-3 min-w-0"><dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground truncate">{l}</dt><dd className="font-display text-2xl" data-testid={`text-count-${l.toLowerCase()}`}>{summary.isLoading ? "…" : v ?? 0}</dd></div>
              ))}
            </dl>
          )}
        </section>
      </div>

      <div className="mt-6">
        <GlobalHistory selected={wfId} onSelect={(id, op) => { opFromEvents.current[id] = op; selectWorkflow(id); }} />
      </div>
    </div>
  );
}
