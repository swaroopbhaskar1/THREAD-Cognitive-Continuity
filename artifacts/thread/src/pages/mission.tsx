import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { AlertTriangle, ArrowLeft, BookmarkCheck, Check, ChevronDown, ClipboardCopy, CloudOff, Download, Loader2, RotateCw, Undo2 } from "lucide-react";
import {
  getGetMissionQueryKey,
  getGetSummaryQueryKey,
  getListMissionsQueryKey,
  useCreateCheckpoint,
  useGetMission,
  useRecordMeaningfulAction,
  useSaveDraft,
  type Checkpoint,
  type Draft,
  type Workspace,
} from "@workspace/api-client-react";
import {
  EMPTY_FIELDS,
  clearRecovery,
  errorMessage,
  errorStatus,
  fmtTime,
  newKey,
  readPendingCheckpoint,
  readRecovery,
  sameFields,
  writePendingCheckpoint,
  writeRecovery,
  type DraftFields,
  type PendingCheckpoint,
} from "@/lib/thread";

import { IntelligencePanel } from "@/components/intelligence-panel";
import { MissionReviewBridge } from "@/components/mission-review-bridge";
import { Journey } from "@/components/journey";
import { useExecutionStream } from "@/hooks/use-execution-stream";
import { REPLACED_FIELDS, fieldsFromCheckpoint, readReplacement, writeReplacement, undoDisposition, type ReplacementSnapshot } from "@/lib/checkpoint-replacement";
import { CheckpointReplacementDialog } from "@/components/checkpoint-replacement-dialog";
import { ResumePanel as SafeResumePanel } from "@/components/resume-panel";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogFooter } from "@/components/ui/alert-dialog";

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

const PRIMARY_FIELDS: { key: keyof DraftFields; label: string; hint: string; max: number }[] = [
  { key: "understanding", label: "What makes sense now?", hint: "Optional — one idea in your own words.", max: 20000 },
  { key: "questions", label: "What are you still unsure about?", hint: "Optional — a question you want to work out.", max: 20000 },
];
const MORE_FIELDS: { key: keyof DraftFields; label: string; hint: string; rows: number; max: number }[] = [
  { key: "reasoning", label: "Reasoning", hint: "Optional — the chain of thinking you want to keep.", rows: 3, max: 20000 },
  { key: "notes", label: "Working notes", hint: "Optional — scratch work or anything you want to keep.", rows: 6, max: 100000 },
];
/** Mirrors the server's sparse-content threshold for an optional, non-blocking hint only. */
const SPARSE_CHARS = 30;
const PRESERVED_LABELS: [keyof DraftFields, string][] = [["nextAction", "your next step"], ["understanding", "what made sense"], ["questions", "what you were unsure about"], ["reasoning", "your reasoning"], ["notes", "your working notes"]];
function preserved(cp: Checkpoint) {
  const parts = PRESERVED_LABELS.filter(([k]) => cp[k].trim()).map(([, l]) => l);
  return parts.length <= 1 ? (parts[0] ?? "your next step") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function toFields(d: Draft): DraftFields {
  return { notes: d.notes, understanding: d.understanding, questions: d.questions, reasoning: d.reasoning, nextAction: d.nextAction };
}

function SaveBadge({ state, storageOk, onRetry }: { state: SaveState; storageOk: boolean; onRetry: () => void }) {
  const map = {
    saved: { icon: <Check className="h-3.5 w-3.5" />, text: "Saved", cls: "text-accent" },
    unsaved: { icon: <span className="h-1.5 w-1.5 rounded-full bg-primary" />, text: "Unsaved", cls: "text-muted-foreground" },
    saving: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: "Saving", cls: "text-muted-foreground" },
    error: { icon: <CloudOff className="h-3.5 w-3.5" />, text: storageOk ? "Not saved to server · copy kept on this device" : "Not saved anywhere yet", cls: "text-destructive" },
    conflict: { icon: <AlertTriangle className="h-3.5 w-3.5" />, text: "Version conflict", cls: "text-destructive" },
  }[state];
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 text-xs font-mono ${map.cls}`} data-testid="status-save">
      {map.icon} {map.text}
      {state === "error" && (
        <button onClick={onRetry} className="ml-1 underline underline-offset-2 hover:text-foreground" data-testid="button-retry-save">retry</button>
      )}
    </span>
  );
}

export default function MissionPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  // Keyed by id: every ref, timer and queue is torn down when switching missions.
  return <MissionEditor key={id} id={id} />;
}

function MissionEditor({ id }: { id: string }) {
  useExecutionStream();
  const [intelligenceCheckpoint, setIntelligenceCheckpoint] = useState<string | null>(null);
  const { user } = useUser();
  const userId = user?.id ?? "anon";
  const qc = useQueryClient();
  const query = useGetMission(id, { query: { enabled: !!id, queryKey: getGetMissionQueryKey(id) } });
  const ws = query.data;
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;

  const [fields, setFields] = useState<DraftFields>(EMPTY_FIELDS);
  const fieldsRef = useRef(fields);
  const versionRef = useRef(0);
  const lastSavedRef = useRef<DraftFields>(EMPTY_FIELDS);
  const initialized = useRef(false);
  const timer = useRef<number | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [saveState, setSaveStateRaw] = useState<SaveState>("saved");
  const stateRef = useRef<SaveState>("saved");
  const setSaveState = (s: SaveState) => { stateRef.current = s; setSaveStateRaw(s); };
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [storageOk, setStorageOk] = useState(true);
  const [entered, setEntered] = useState(false);
  const [replacement, setReplacement] = useState<ReplacementSnapshot | null>(() => readReplacement(userId, id));
  const [replacementPreview, setReplacementPreview] = useState<{ checkpoint: Checkpoint; before: DraftFields } | null>(null);
  const [replacementBusy, setReplacementBusy] = useState(false);
  const replacementBusyRef = useRef(false);
  const [replacementMessage, setReplacementMessage] = useState<string | null>(null);
  const [replacementDurable, setReplacementDurable] = useState(true);
  const replacementFocus = useRef<HTMLElement | null>(null);

  const saveDraft = useSaveDraft();
  const saveFnRef = useRef(saveDraft.mutateAsync);
  saveFnRef.current = saveDraft.mutateAsync;

  const persistLocal = (f: DraftFields) => {
    const ok = writeRecovery(userId, id, { fields: f, baseVersion: versionRef.current, updatedAt: new Date().toISOString() });
    setStorageOk(ok);
    return ok;
  };
  const adoptVersion = (v: number) => { versionRef.current = v; setVersion(v); };

  /** Serialize every write (autosave + checkpoint) so versions never compete. */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.current.then(fn, fn);
    chain.current = p.catch(() => undefined);
    return p;
  }, []);

  useEffect(() => {
    if (!ws || initialized.current) return;
    initialized.current = true;
    if (ws.checkpoints.length === 0) setEntered(true);
    const server = toFields(ws.draft);
    adoptVersion(ws.draft.version);
    lastSavedRef.current = server;
    setSavedAt(ws.draft.savedAt);
    const local = readRecovery(userId, id);
    if (local && !sameFields(local.fields, server)) {
      setFields(local.fields);
      fieldsRef.current = local.fields;
      if (local.baseVersion === ws.draft.version) {
        setSaveState("unsaved");
        setRecoveryNotice("Restored unsaved edits from this device. They'll sync now.");
        scheduleSave(400);
      } else {
        setSaveState("conflict");
        setRecoveryNotice("This device has edits made against an older version.");
      }
    } else {
      if (local) clearRecovery(userId, id);
      setFields(server);
      fieldsRef.current = server;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const saveOnce = async (): Promise<boolean> => {
    if (!initialized.current) return false;
    if (stateRef.current === "conflict") return false;
    const snapshot = fieldsRef.current;
    if (sameFields(snapshot, lastSavedRef.current)) {
      if (stateRef.current !== "error") setSaveState("saved");
      return true;
    }
    setSaveState("saving");
    try {
      const draft = await saveFnRef.current({ id, data: { ...snapshot, version: versionRef.current } });
      adoptVersion(draft.version);
      lastSavedRef.current = snapshot;
      setSavedAt(draft.savedAt);
      setSaveError(null);
      qc.setQueryData<Workspace>(getGetMissionQueryKey(id), (old) => (old ? { ...old, draft } : old));
      if (sameFields(fieldsRef.current, snapshot)) {
        clearRecovery(userId, id);
        setSaveState("saved");
        setRecoveryNotice(null);
      } else {
        persistLocal(fieldsRef.current);
        setSaveState("unsaved");
        scheduleSave(300);
      }
      return true;
    } catch (err) {
      setSaveError(errorMessage(err));
      setSaveState(errorStatus(err) === 409 ? "conflict" : "error");
      return false;
    }
  };
  const saveOnceRef = useRef(saveOnce);
  saveOnceRef.current = saveOnce;
  const runSave = useCallback(() => enqueue(() => saveOnceRef.current()), [enqueue]);

  function scheduleSave(delay = 1200) {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void runSave(); }, delay);
  }

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
    // SPA navigation drains the same writer; full browser close retains local recovery.
    if (initialized.current && !sameFields(fieldsRef.current, lastSavedRef.current) && stateRef.current !== "conflict") void runSave();
  }, [runSave]);

  const dirty = saveState !== "saved";
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Meaningful action tracking (resumption id persisted per user + mission)
  const recordAction = useRecordMeaningfulAction();
  const recordRef = useRef(recordAction.mutate);
  recordRef.current = recordAction.mutate;
  const resKey = `thread:v1:${userId}:resumption:${id}`;
  const armedResumption = useRef<string | null>(null);
  useEffect(() => {
    try { armedResumption.current = localStorage.getItem(resKey); } catch { /* ignore */ }
  }, [resKey]);
  const arm = (rid: string | null) => {
    armedResumption.current = rid;
    try { if (rid) localStorage.setItem(resKey, rid); else localStorage.removeItem(resKey); } catch { /* in-memory only */ }
  };

  const applyFields = (next: DraftFields, fromUser: boolean) => {
    setFields(next);
    fieldsRef.current = next;
    persistLocal(next);
    if (stateRef.current !== "conflict") { setSaveState("unsaved"); scheduleSave(); }
    if (fromUser && armedResumption.current) {
      const rid = armedResumption.current;
      armedResumption.current = null;
      recordRef.current({ id: rid }, {
        onSuccess: (r) => {
          arm(null);
          qc.invalidateQueries({ queryKey: getGetSummaryQueryKey() });
        },
        onError: () => { armedResumption.current = rid; },
      });
    }
  };
  const onField = (key: keyof DraftFields, value: string) => applyFields({ ...fieldsRef.current, [key]: value }, true);

  // Conflict resolution
  const [resolving, setResolving] = useState(false);
  const resolveConflict = (mode: "keep" | "server") => enqueue(async () => {
    setResolving(true);
    try {
      const res = await refetchRef.current();
      const fresh = res.data;
      if (!fresh) throw res.error ?? new Error("Could not load server version");
      adoptVersion(fresh.draft.version);
      const server = toFields(fresh.draft);
      lastSavedRef.current = server;
      setRecoveryNotice(null);
      setReplacementMessage(null);
      setSavedAt(fresh.draft.savedAt);
      if (mode === "server") {
        setFields(server);
        fieldsRef.current = server;
        clearRecovery(userId, id);
        setSaveState("saved");
      } else {
        persistLocal(fieldsRef.current);
        setSaveState("unsaved");
        scheduleSave(0);
      }
    } catch (err) {
      setSaveError(errorMessage(err));
      setSaveState("conflict");
    } finally {
      setResolving(false);
    }
  });

  // Checkpoint: frozen payload + key, persisted until success.
  const createCp = useCreateCheckpoint();
  const createCpRef = useRef(createCp.mutateAsync);
  createCpRef.current = createCp.mutateAsync;
  const [pending, setPending] = useState<PendingCheckpoint | null>(() => readPendingCheckpoint(userId, id));
  const [cpBusy, setCpBusy] = useState<null | "flushing" | "sending">(null);
  const [cpError, setCpError] = useState<string | null>(null);
  const [cpResult, setCpResult] = useState<Checkpoint | null>(null);

  // Presentation-only state. Never touches the writer, refs or field values.
  const search = useSearch();
  const [view, setView] = useState<"study" | "journey">(() => (new URLSearchParams(search).get("view") === "journey" ? "journey" : "study"));
  const [outcomeDismissed, setOutcomeDismissed] = useState(false);
  useEffect(() => { if (cpResult) setOutcomeDismissed(false); }, [cpResult]);
  const [moreOpen, setMoreOpen] = useState(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return;
    if (fields.reasoning.trim() || fields.notes.trim()) { autoOpened.current = true; setMoreOpen(true); }
  }, [fields.reasoning, fields.notes]);
  /** Focus-only: no write, no checkpoint, no AI request. */
  const focusIdea = () => {
    setView("study");
    const target = fieldsRef.current.understanding.trim() ? "field-questions" : "field-understanding";
    window.requestAnimationFrame(() => {
      const el = document.getElementById(target);
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  };
  /** Explicit user choice from the AI disclosure; same path as the previous "use suggestion". */
  const applyAiAction = (action: string) => { if (!replacementBusyRef.current) onField("nextAction", action); };

  const submitCheckpoint = async () => {
    if (cpBusy) return;
    setCpError(null);
    setCpResult(null);
    let frozen = pending;
    if (!frozen) {
      if (!fieldsRef.current.nextAction.trim()) { setCpError("Write a next action first."); return; }
      if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
      setCpBusy("flushing");
      const ok = await runSave();
      if (!ok || !sameFields(fieldsRef.current, lastSavedRef.current)) {
        setCpBusy(null);
        setCpError(`Draft couldn't be saved first, so no checkpoint was sent. ${saveErrorRef.current ?? ""}`.trim());
        return;
      }
      const key = newKey("checkpoint");
      frozen = { requestKey: key, frozenAt: new Date().toISOString(), payload: { ...fieldsRef.current, version: versionRef.current, requestKey: key, simulateFailure: false } };
      const stored = writePendingCheckpoint(userId, id, frozen);
      setStorageOk(stored);
      setPending(frozen);
    }
    const toSend = frozen;
    setCpBusy("sending");
    await enqueue(async () => {
      try {
        const cp = await createCpRef.current({ id, data: toSend.payload });
        writePendingCheckpoint(userId, id, null);
        setPending(null);
        setCpResult(cp);
        setIntelligenceCheckpoint(cp.id);
        const res = await refetchRef.current();
        if (res.data) {
          adoptVersion(res.data.draft.version);
          setSavedAt(res.data.draft.savedAt);
          if (sameFields(fieldsRef.current, toFields(res.data.draft))) {
            lastSavedRef.current = fieldsRef.current;
          } else {
            persistLocal(fieldsRef.current);
          }
        }
        qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSummaryQueryKey() });
      } catch (err) {
        setCpError(errorStatus(err) === 409
          ? `Server rejected this frozen checkpoint (version ${toSend.payload.version} is no longer current). Discard it and create a new one. ${errorMessage(err)}`
          : `Checkpoint not confirmed: ${errorMessage(err)}. Retry re-sends the identical frozen request, so it can't duplicate.`);
      } finally {
        setCpBusy(null);
      }
    });
  };
  const saveErrorRef = useRef(saveError);
  saveErrorRef.current = saveError;
  const discardPending = () => {
    writePendingCheckpoint(userId, id, null);
    setPending(null);
    setCpError(null);
  };

  const previewReplacement = (checkpoint: Checkpoint) => {
    replacementFocus.current = document.activeElement as HTMLElement | null;
    setReplacementMessage(null);
    if (pending || cpBusy || replacementBusyRef.current || stateRef.current === "conflict") {
      setReplacementMessage("Resolve the unconfirmed checkpoint or draft conflict before replacing fields.");
      return;
    }
    const before = { ...fieldsRef.current };
    if (sameFields(before, fieldsFromCheckpoint(before, checkpoint))) {
      setReplacementMessage("Your draft already matches these checkpoint fields. Nothing was changed.");
      return;
    }
    const existingRecovery = replacement ?? readReplacement(userId, id);
    if (existingRecovery) {
      setReplacement(existingRecovery);
      setReplacementMessage("A prior-draft recovery copy is still active. Undo that replacement before replacing from another checkpoint. Your current work and recovery copy are unchanged.");
      return;
    }
    setReplacementPreview({ checkpoint, before });
  };

  const confirmReplacement = () => {
    const preview = replacementPreview;
    if (!preview || replacementBusyRef.current) return;
    replacementBusyRef.current = true;
    setReplacementBusy(true);
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    void enqueue(async () => {
      try {
        if (replacement || readReplacement(userId, id)) throw new Error("A prior-draft recovery copy is still active. Cancel and resolve that recovery before another replacement; nothing was replaced.");
        if (!sameFields(fieldsRef.current, preview.before)) throw new Error("Your draft changed while the preview was open. Cancel and review the replacement again.");
        if (!await saveOnceRef.current()) throw new Error("Your current draft could not be saved safely. Resolve its save error or conflict first.");
        const fresh = await refetchRef.current();
        if (!fresh.data) throw fresh.error ?? new Error("Could not check the latest saved draft.");
        if (fresh.data.draft.version !== versionRef.current) {
          setSaveState("conflict");
          throw new Error("Another tab changed this draft. Nothing was replaced; resolve the version conflict first.");
        }
        if (!sameFields(fieldsRef.current, preview.before)) throw new Error("Your draft changed. Nothing was replaced; reopen the preview.");
        const snapshot: ReplacementSnapshot = {
          before: { ...preview.before }, after: fieldsFromCheckpoint(preview.before, preview.checkpoint),
          baseVersion: versionRef.current, checkpointId: preview.checkpoint.id, createdAt: new Date().toISOString(),
        };
        // Separate from autosave recovery, which is cleared after a successful save.
        const durable = writeReplacement(userId, id, snapshot);
        setReplacementDurable(durable);
        if (!durable) {
          setStorageOk(false);
          throw new Error("Browser storage could not create a new recovery snapshot, or another recovery copy already exists. No fields were replaced and existing recovery was not overwritten. Cancel, then inspect or download your recovery copy.");
        }
        setReplacement(snapshot);
        setFields(snapshot.after);
        fieldsRef.current = snapshot.after;
        persistLocal(snapshot.after);
        setSaveState("unsaved");
        const saved = await saveOnceRef.current();
        setReplacementPreview(null);
        setReplacementMessage(saved ? "Draft fields replaced and saved. Working notes are unchanged. You can undo below." : "Replacement is not confirmed. Your prior draft is kept below; retry saving or use Undo.");
      } catch (err) { setReplacementMessage(errorMessage(err)); }
      finally { replacementBusyRef.current = false; setReplacementBusy(false); }
    });
  };

  const undoReplacement = () => {
    if (!replacement || replacementBusyRef.current || pending || cpBusy) return;
    replacementBusyRef.current = true;
    setReplacementBusy(true);
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    void enqueue(async () => {
      try {
        const fresh = await refetchRef.current();
        if (!fresh.data) throw fresh.error ?? new Error("Could not check the latest saved draft.");
        const server = toFields(fresh.data.draft);
        const action = undoDisposition(replacement, fieldsRef.current, server, fresh.data.draft.version);
        if (action === "already-undone") {
          adoptVersion(fresh.data.draft.version);
          lastSavedRef.current = server;
          setSavedAt(fresh.data.draft.savedAt);
          clearRecovery(userId, id);
          setSaveState("saved");
          setReplacement(null);
          writeReplacement(userId, id, null);
          setReplacementMessage("Your prior draft is already saved. No additional write was needed.");
          return;
        }
        if (action === "changed") throw new Error("You edited the draft after replacement. Undo will not overwrite those edits. Your prior draft is still available below.");
        if (action === "conflict") {
          setSaveState("conflict");
          throw new Error("The saved draft changed after replacement. Undo stopped to protect newer work. Your prior draft is still available below.");
        }
        adoptVersion(fresh.data.draft.version);
        lastSavedRef.current = server;
        fieldsRef.current = { ...replacement.before };
        setFields(fieldsRef.current);
        persistLocal(fieldsRef.current);
        setSaveState("unsaved");
        if (!await saveOnceRef.current()) throw new Error("Undo is not confirmed. Your prior content is in the editor and recovery snapshot; retry saving.");
        if (action === "local-only") setSavedAt(fresh.data.draft.savedAt);
        setReplacement(null);
        writeReplacement(userId, id, null);
        setReplacementMessage("Replacement undone. Your prior draft is saved; original checkpoints are unchanged.");
      } catch (err) { setReplacementMessage(errorMessage(err)); }
      finally {
        replacementBusyRef.current = false;
        setReplacementBusy(false);
        // A refused Undo must not cancel autosave for the later edits it protected.
        if (stateRef.current === "unsaved" && !sameFields(fieldsRef.current, lastSavedRef.current)) void runSave();
      }
    });
  };

  const copyRecovery = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(fieldsRef.current, null, 2)); } catch { /* clipboard blocked; use download */ }
  };
  const downloadRecovery = () => {
    const blob = new Blob([JSON.stringify({ missionId: id, version: versionRef.current, fields: fieldsRef.current }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thread-${id}-recovery.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (query.isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 space-y-4" aria-busy="true">
        <div className="h-10 w-2/3 rounded-lg bg-muted animate-pulse" />
        <div className="grid lg:grid-cols-[1fr_340px] gap-6">
          <div className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="h-36 rounded-2xl bg-muted animate-pulse" />)}</div>
          <div className="h-72 rounded-2xl bg-muted animate-pulse" />
        </div>
      </div>
    );
  }
  if (query.isError || !ws) {
    const notFound = errorStatus(query.error) === 404;
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center" role="alert">
        <h1 className="font-display text-3xl">{notFound ? "This mission isn't here." : "The workspace didn't load."}</h1>
        <p className="text-muted-foreground mt-2">{notFound ? "It may belong to another account or never existed." : errorMessage(query.error)}</p>
        <div className="mt-6 flex justify-center gap-3">
          {!notFound && <button onClick={() => query.refetch()} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border hover:bg-muted" data-testid="button-retry-mission"><RotateCw className="h-4 w-4" /> Retry</button>}
          <Link href="/missions" className="px-4 py-2 rounded-full bg-foreground text-background" data-testid="link-back-missions">Back to missions</Link>
        </div>
      </div>
    );
  }

  const sortedCps = [...ws.checkpoints].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = sortedCps[0] ?? null;
  const sparse = (["notes", "understanding", "questions", "reasoning", "nextAction"] as const).map(k => fields[k]).join("").trim().length < SPARSE_CHARS;
  const moreHasText = !!(fields.reasoning.trim() || fields.notes.trim());
  const outcomeStale = !!cpResult && !sameFields(fields, { notes: cpResult.notes, understanding: cpResult.understanding, questions: cpResult.questions, reasoning: cpResult.reasoning, nextAction: cpResult.nextAction });
  const showOutcome = !!cpResult && !outcomeDismissed;
  const asideAiId = showOutcome && (intelligenceCheckpoint === cpResult!.id) ? null : (intelligenceCheckpoint ?? latest?.id ?? null);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-10">
      <CheckpointReplacementDialog preview={replacementPreview} busy={replacementBusy} message={replacementMessage}
        opener={replacementFocus} onCancel={() => setReplacementPreview(null)} onConfirm={confirmReplacement} />
      <Link href="/missions" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back">
        <ArrowLeft className="h-4 w-4" /> Missions
      </Link>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {ws.mission.subject && <p className="font-mono text-[11px] uppercase tracking-widest text-accent">{ws.mission.subject}</p>}
          <h1 className="font-display text-3xl sm:text-5xl leading-tight" data-testid="text-mission-title">{ws.mission.title}</h1>
          {ws.mission.goal && <p className="mt-2 text-muted-foreground max-w-2xl">{ws.mission.goal}</p>}
        </div>
        {entered && (
          <div className="flex flex-col items-end gap-1">
            <SaveBadge state={saveState} storageOk={storageOk} onRetry={() => void runSave()} />
            {savedAt && <span className="text-[11px] font-mono text-muted-foreground">v{version} · {fmtTime(savedAt)}</span>}
          </div>
        )}
      </div>

      <div hidden={view !== "study"}>{latest && (
        <SafeResumePanel
          key={latest.id}
          missionId={id}
          checkpoint={latest}
          gated={!entered}
          currentAction={fields.nextAction}
          onResumed={(r) => { arm(r.id); setEntered(true); }}
          onEnterWithoutResume={() => setEntered(true)}
          onRestore={previewReplacement}
        />
      )}</div>

      <>
          <div role="tablist" aria-label="Mission views" className="mt-8 inline-flex rounded-full border border-border bg-card p-1" data-testid="tabs-mission-view"
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "study" : event.key === "End" ? "journey" : view === "study" ? "journey" : "study";
              setView(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}>
            {(["study", "journey"] as const).map((v) => (
              <button key={v} id={`tab-${v}`} role="tab" aria-controls={`view-${v}`} tabIndex={view === v ? 0 : -1} aria-selected={view === v} onClick={() => setView(v)}
                className={`min-h-10 px-5 rounded-full text-sm transition-colors ${view === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`} data-testid={`tab-${v}`}>
                {v === "study" ? "Study" : `Your journey${ws.checkpoints.length ? ` · ${ws.checkpoints.length}` : ""}`}
              </button>
            ))}
          </div>
          {replacementMessage && !replacementPreview && <p role="status" className="mt-4 text-sm" data-testid="text-replacement-status">{replacementMessage}</p>}
          {replacement && <section className="mt-4 rounded-xl border border-accent/40 bg-card p-4 text-sm" data-testid="panel-prior-draft">
            <p className="font-medium">Prior draft recovery · {fmtTime(replacement.createdAt)}</p>
            <p className="mt-1 text-muted-foreground">Undo restores the draft from before replacement only if later local or server work would not be overwritten.</p>
            {!replacementDurable && <p className="mt-1 text-destructive">Recovery is only available in this tab. Download it before leaving.</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={undoReplacement} disabled={replacementBusy || !!pending || !!cpBusy} className="min-h-11 px-4 border rounded-full disabled:opacity-50" data-testid="button-undo-replacement">{replacementBusy ? "Checking…" : "Undo replacement"}</button>
              <button onClick={() => {
                const url = URL.createObjectURL(new Blob([JSON.stringify(replacement.before, null, 2)], { type: "application/json" }));
                const link = document.createElement("a"); link.href = url; link.download = `thread-${id}-prior-draft.json`; link.click(); URL.revokeObjectURL(url);
              }} className="min-h-11 px-4 border rounded-full" data-testid="button-download-prior">Download prior draft</button>
            </div>
            <details className="mt-2"><summary className="cursor-pointer">View prior draft</summary><pre className="mt-2 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{JSON.stringify(replacement.before, null, 2)}</pre></details>
          </section>}
          {!storageOk && (
            <div role="alert" className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3 text-sm" data-testid="banner-storage">
              <CloudOff className="h-5 w-5 text-destructive shrink-0" />
              <p className="flex-1">This browser isn't letting Thread keep a local recovery copy. Unsaved edits exist only in this tab until the server confirms. Keep a copy yourself:</p>
              <div className="flex gap-2">
                <button onClick={copyRecovery} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border hover:bg-muted" data-testid="button-copy-recovery"><ClipboardCopy className="h-4 w-4" /> Copy</button>
                <button onClick={downloadRecovery} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border hover:bg-muted" data-testid="button-download-recovery"><Download className="h-4 w-4" /> Download</button>
              </div>
            </div>
          )}
          {saveState === "error" && saveError && <p role="alert" className="mt-4 text-sm text-destructive" data-testid="text-save-error">Save failed: {saveError}</p>}

          {saveState === "conflict" && (
            <div role="alert" className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/5 p-5 flex flex-col sm:flex-row sm:items-center gap-4" data-testid="banner-conflict">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
              <div className="flex-1 text-sm">
                <p className="font-medium">The server has a newer version of this draft.</p>
                <p className="text-muted-foreground">{recoveryNotice ?? "Another tab or device saved in the meantime."} {storageOk ? "Your edits are kept on this device." : "Your edits are only in this tab."} Nothing is overwritten until you choose.</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button disabled={resolving} onClick={() => void resolveConflict("keep")} className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm disabled:opacity-50" data-testid="button-keep-local">Keep my edits</button>
                <button disabled={resolving} onClick={() => void resolveConflict("server")} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-border text-sm hover:bg-muted disabled:opacity-50" data-testid="button-load-server"><Undo2 className="h-4 w-4" /> Load server version</button>
              </div>
            </div>
          )}
          {recoveryNotice && saveState !== "conflict" && <p className="mt-4 text-sm text-accent font-mono" role="status">{recoveryNotice}</p>}
          <div id="view-study" role="tabpanel" aria-labelledby="tab-study" hidden={!entered || view !== "study"} className="rise mt-8 grid lg:grid-cols-[minmax(0,1fr)_320px] gap-8 items-start" data-testid="view-study">
            <div className="space-y-6 min-w-0">
              {cpResult && !outcomeDismissed && (
                <section className="rise rounded-2xl border border-accent/40 bg-card p-6 sm:p-7 shadow-[0_30px_60px_-36px_hsl(186_32%_30%/0.55)]" role="status" data-testid="text-checkpoint-result">
                  <div className="flex items-start justify-between gap-3">
                    <p className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-accent"><Check className="h-3.5 w-3.5" /> Checkpoint saved · {fmtTime(cpResult.createdAt)}</p>
                    <button onClick={() => setOutcomeDismissed(true)} className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2" data-testid="button-dismiss-outcome">Hide</button>
                  </div>
                  <h2 className="font-display text-3xl sm:text-4xl mt-3 leading-tight">Ready for your next session</h2>
                  <p className="mt-5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Your next step</p>
                  <p className="mt-1 font-display text-xl sm:text-2xl leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="text-outcome-next">{cpResult.nextAction}</p>
                  <p className="mt-4 text-sm text-muted-foreground" data-testid="text-outcome-preserved">
                    Saved with {preserved(cpResult)}. When you return, your original thinking and this next step will be waiting.
                  </p>
                  {outcomeStale && <p className="mt-2 text-sm text-primary" data-testid="text-outcome-stale">You have kept writing since. Those newer edits are in your draft, not in this checkpoint.</p>}
                  <div className="mt-5 border-t border-border pt-4">
                    <IntelligencePanel embedded key={cpResult.id} checkpointId={cpResult.id} checkpoint={cpResult}
                      onUseAction={applyAiAction} onAddIdea={focusIdea} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <button onClick={() => setView("journey")} className="underline underline-offset-2 hover:text-foreground" data-testid="button-outcome-journey">See it in your journey</button>
                    <Link href={`/how-it-works?workflow=${cpResult.workflowId}`} className="underline underline-offset-2 hover:text-foreground" data-testid="link-checkpoint-workflow">View execution</Link>
                  </div>
                </section>
              )}

              <section className="rounded-2xl bg-foreground text-background p-5 sm:p-7">
                <label htmlFor="field-nextAction" className="font-display text-2xl sm:text-3xl">Where will you pick up?</label>
                <p className="mt-1 text-sm text-background/75">One small, concrete step for your next session. For example: trace abba and write each window.</p>
                <textarea id="field-nextAction" value={fields.nextAction} maxLength={4000} rows={2} disabled={replacementBusy} onChange={(e) => onField("nextAction", e.target.value)}
                  placeholder="Next time, I will…"
                  className="mt-4 w-full min-h-20 max-h-80 resize-y bg-background/5 border border-background/20 rounded-xl px-4 py-3 font-display text-xl sm:text-2xl placeholder:text-background/50 focus-visible:outline-none focus-visible:border-background/70 transition-colors [overflow-wrap:anywhere]" data-testid="input-nextAction" />
                <p className="mt-2 text-xs text-background/70 text-right font-mono">{fields.nextAction.length.toLocaleString()} / 4,000</p>
              </section>

              <section className="rounded-2xl border border-border bg-card divide-y divide-border">
                {PRIMARY_FIELDS.map((f) => (
                  <div key={f.key} className="p-5 sm:p-6 focus-within:bg-background/60 transition-colors">
                    <label htmlFor={`field-${f.key}`} className="font-display text-lg">{f.label} <span className="text-xs font-sans text-muted-foreground">optional</span></label>
                    <textarea id={`field-${f.key}`} value={fields[f.key]} rows={2} maxLength={f.max} disabled={replacementBusy} onChange={(e) => onField(f.key, e.target.value)}
                      placeholder={f.hint}
                      className="mt-2 w-full min-h-14 bg-transparent resize-y leading-relaxed rounded placeholder:text-muted-foreground/70 focus-visible:outline-none [overflow-wrap:anywhere]" data-testid={`input-${f.key}`} />
                  </div>
                ))}
                <div className="p-5 sm:p-6">
                  <button type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} aria-controls="more-space"
                    className="w-full flex items-center justify-between gap-3 text-left group" data-testid="button-more-space">
                    <span>
                      <span className="font-display text-lg">More space</span>
                      <span className="block text-xs text-muted-foreground">Reasoning and working notes{!moreOpen && moreHasText ? " · contains your text" : ""}</span>
                    </span>
                    <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${moreOpen ? "rotate-180" : ""}`} />
                  </button>
                  {/* hidden, not unmounted: values stay in the same controlled inputs. */}
                  <div id="more-space" hidden={!moreOpen} className="mt-4 space-y-5" data-testid="panel-more-space">
                    {MORE_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label htmlFor={`field-${f.key}`} className="text-sm font-medium">{f.label}</label>
                        <textarea id={`field-${f.key}`} value={fields[f.key]} rows={f.rows} maxLength={f.max} disabled={replacementBusy} onChange={(e) => onField(f.key, e.target.value)}
                          placeholder={f.hint}
                          className="mt-1.5 w-full rounded-xl border border-input bg-background/60 px-3 py-2 resize-y leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]" data-testid={`input-${f.key}`} />
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>

            <aside className="space-y-5 lg:sticky lg:top-20">
              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="flex items-center gap-2"><BookmarkCheck className="h-5 w-5 text-primary" /><h2 className="font-display text-lg">Stopping here?</h2></div>
                <p className="text-sm text-muted-foreground mt-1">Save this moment and your next step. Keep editing whenever you like.</p>
                {pending ? (
                  <div className="mt-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs" data-testid="panel-pending-checkpoint">
                    <p className="font-medium">Unconfirmed checkpoint frozen {fmtTime(pending.frozenAt)} (v{pending.payload.version})</p>
                    <p className="text-muted-foreground mt-0.5 line-clamp-2">Next step: {pending.payload.nextAction}</p>
                    <button onClick={discardPending} disabled={!!cpBusy} className="mt-2 underline underline-offset-2 disabled:opacity-40" data-testid="button-discard-pending">Discard frozen checkpoint</button>
                  </div>
                ) : !fields.nextAction.trim() ? (
                  <p className="mt-3 text-xs text-primary" data-testid="text-need-next">Write where you will pick up first. That alone is enough to save.</p>
                ) : sparse ? (
                  <p className="mt-3 text-xs text-muted-foreground" data-testid="text-sparse-hint">A next step alone is enough. Optional: add one idea or question so AI has something to build a return question from. <button onClick={focusIdea} className="underline underline-offset-2 text-foreground" data-testid="button-sparse-add-idea">Add one</button></p>
                ) : null}
                <button onClick={() => void submitCheckpoint()} disabled={replacementBusy || !!cpBusy || saveState === "conflict" || (!pending && !fields.nextAction.trim())}
                  className="mt-4 w-full inline-flex justify-center items-center gap-2 px-4 py-3 rounded-full bg-primary text-primary-foreground font-medium disabled:opacity-40 hover:-translate-y-0.5 active:translate-y-0 transition-transform" data-testid="button-create-checkpoint">
                  {cpBusy === "flushing" ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving draft first</> : cpBusy === "sending" ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving checkpoint</> : pending ? "Retry frozen checkpoint" : "Save checkpoint"}
                </button>
                <p className="mt-2 text-[11px] text-muted-foreground">Your draft also autosaves as you type. A checkpoint keeps an unchangeable copy.</p>
                {cpError && <p role="alert" className="mt-3 text-xs text-destructive" data-testid="text-checkpoint-error">{cpError}</p>}
              </section>
              {asideAiId && (
                <IntelligencePanel key={asideAiId} checkpointId={asideAiId}
                  checkpoint={sortedCps.find((cp) => cp.id === asideAiId)}
                  onUseAction={applyAiAction} onAddIdea={focusIdea} />
              )}
            </aside>
          </div>

          {view === "journey" && (
            <Journey missionId={id} checkpoints={ws.checkpoints} current={fields} currentUnsaved={saveState !== "saved"}
              restoreDisabled={replacementBusy || !!pending || !!cpBusy} onRestore={previewReplacement}
              onViewAi={(cpId) => { setIntelligenceCheckpoint(cpId); setOutcomeDismissed(true); setEntered(true); setView("study"); }} />
          )}
          {entered && view === "study" && latest && <MissionReviewBridge missionId={id} latestCheckpointId={latest.id} />}
      </>
    </div>
  );
}
