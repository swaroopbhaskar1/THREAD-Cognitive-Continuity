import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { getListWorkflowsQueryKey, getGetWorkflowEventsQueryKey, getGetWorkflowQueryKey, type Workflow, type ExecutionEvent } from "@workspace/api-client-react";

type Update = { cursor: string; workflow: Workflow; events: ExecutionEvent[] };
type StreamState = { status: "connecting" | "connected" | "reconnecting" | "offline"; updatedAt: number };

export function useExecutionStream() {
  const { user } = useUser();
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>({ status: "connecting", updatedAt: 0 });
  useEffect(() => {
    if (!user?.id) return;
    const key = `thread:sse:${user.id}`;
    let cursor = "0";
    let epoch = "";
    try { cursor = sessionStorage.getItem(key) || "0"; } catch { /* in-memory reconnection remains available */ }
    try { epoch = sessionStorage.getItem(`${key}:epoch`) || ""; } catch { /* In-memory epoch remains available. */ }
    if (!/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n) cursor = "0";
    let source: EventSource | null = null;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1500;
    let consecutiveFailures = 0;
    let lastFailureReport = 0;
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    const dirty = new Set<"all" | "sync" | "history" | "reviews" | "ai" | "missions">();
    const reconcile = (section: "all" | "sync" | "history" | "reviews" | "ai" | "missions") => {
      dirty.add(section);
      if (reconcileTimer) return;
      // Event-driven coalescing, not polling. Hundreds of historical frames
      // must not cancel/restart hundreds of authenticated REST requests.
      reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined;
        if (disposed) return;
        const sections = new Set(dirty); dirty.clear();
        void qc.invalidateQueries({ predicate: q => {
          if (sections.has("all")) return true;
          const path = String(q.queryKey[0]), sync = sections.has("sync");
          return (sync && path === String(getListWorkflowsQueryKey()[0])) ||
            ((sync || sections.has("history")) && path === "/api/execution/history") ||
            ((sync || sections.has("reviews")) && /^\/api\/(?:reviews(?:\/|$)|recall-history$)/.test(path)) ||
             ((sync || sections.has("ai")) && /\/checkpoints\/[^/]+\/intelligence$/.test(path)) ||
             ((sync || sections.has("missions")) && /^\/api\/missions(?:\/[^/]+)?$/.test(path));
        } }, { cancelRefetch: false });
      }, 1000);
    };
    const connect = () => {
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      if (disposed || !navigator.onLine) {
        setState(s => ({ ...s, status: "offline" }));
        return;
      }
      setState(s => ({ ...s, status: s.updatedAt ? "reconnecting" : "connecting" }));
      source = new EventSource(`${import.meta.env.BASE_URL}api/events/stream?after=${cursor}&epoch=${encodeURIComponent(epoch)}`, { withCredentials: true });
      source.onopen = () => {
        if (disposed) return;
        retryDelay = 1500;
        consecutiveFailures = 0;
        setState(s => ({ ...s, status: "connected" }));
        // Reconcile REST snapshots once on connection, not on a recurring poll.
        // Time can cross a due boundary without a write. Reconcile schedules on
        // reconnect too, including the stream's periodic authentication renewal.
        reconcile("sync");
      };
      source.addEventListener("reset", (message: MessageEvent) => {
        if (disposed) return;
        cursor = "0";
        try {
          const reset = JSON.parse(message.data);
          if (typeof reset.epoch === "string" && /^[0-9a-f-]{36}$/i.test(reset.epoch)) epoch = reset.epoch;
          sessionStorage.setItem(`${key}:epoch`, epoch);
        } catch { /* A future-cursor reset can still recover without epoch metadata. */ }
        try { sessionStorage.setItem(key, cursor); } catch { /* Memory recovery remains available. */ }
        // The database may have been restored. Re-fetch authoritative snapshots
        // instead of treating a high pre-restore cursor as current forever.
        qc.removeQueries({ predicate: q => /^\/api\/workflows\/[^/]+\/events$/.test(String(q.queryKey[0])) });
        reconcile("all");
        // Rebuild the URL with the confirmed generation/cursor. Native retry
        // otherwise keeps the old query string after every auth renewal.
        connect();
      });
      source.addEventListener("execution", (message: MessageEvent) => {
        if (disposed) return;
        try {
          const update = JSON.parse(message.data) as Update;
          if (!/^\d+$/.test(update.cursor) || !update.workflow?.id || !Array.isArray(update.events)) throw new Error("Invalid event");
          if (BigInt(update.cursor) <= BigInt(cursor)) return;
          qc.setQueryData<Workflow[]>(getListWorkflowsQueryKey(), old => {
            const merged = [update.workflow, ...(old ?? []).filter(w => w.id !== update.workflow.id)];
            return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
          });
          qc.setQueryData<Workflow>(getGetWorkflowQueryKey(update.workflow.id), update.workflow);
          qc.setQueryData<ExecutionEvent[]>(getGetWorkflowEventsQueryKey(update.workflow.id), old => {
            const unique = new Map((old ?? []).map(e => [e.id, e]));
            update.events.forEach(e => unique.set(e.id, e));
            return [...unique.values()].sort((a, b) => a.sequence - b.sequence);
          });
          // Every committed update can add rows to the global chronological history.
          reconcile("history");
          if (/^(review|recall)\./.test(update.workflow.operation) || (update.workflow.operation.startsWith("checkpoint") )) {
            // Draft text lives in component state/local storage, so refetching never discards edits.
            reconcile("reviews");
          }
          if (update.workflow.operation === "ai.enhance") {
            reconcile("ai");
          }
          if (/^(?:draft\.save|mission\.create|checkpoint\.|ai\.enhance)/.test(update.workflow.operation)) reconcile("missions");
          cursor = update.cursor;
          try { sessionStorage.setItem(key, cursor); } catch { /* cursor is retained in memory */ }
          setState({ status: "connected", updatedAt: Date.now() });
        } catch {
          // Do not acknowledge malformed frames. Restart from last successfully applied cursor.
          source?.close();
          setState(s => ({ ...s, status: "reconnecting" }));
          retryTimer = setTimeout(connect, 1500);
        }
      });
      source.onerror = () => {
        consecutiveFailures++;
        if (consecutiveFailures >= 3 && Date.now() - lastFailureReport >= 300000) {
          lastFailureReport = Date.now();
          // Explicitly client-reported, not proof that the whole API is down.
          void fetch(`${import.meta.env.BASE_URL}api/operations/client-signal`, {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "sse_reconnect_failed", consecutiveFailures: Math.min(100, consecutiveFailures) }),
          }).catch(() => { /* An unavailable network cannot report its own outage; external uptime monitoring is required. */ });
        }
        if (!disposed) setState(s => ({ ...s, status: navigator.onLine ? "reconnecting" : "offline" }));
        // Native EventSource handles dropped connections and Last-Event-ID.
        // Fatal HTTP errors (e.g. 401/503) instead close it permanently; retry
        // explicitly from the last applied cursor, with a bounded backoff.
        if (!disposed && navigator.onLine && source?.readyState === EventSource.CLOSED) {
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
      };
    };
    const offline = () => { source?.close(); setState(s => ({ ...s, status: "offline" })); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", connect);
    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      source?.close();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", connect);
    };
  }, [qc, user?.id]);
  return state;
}
