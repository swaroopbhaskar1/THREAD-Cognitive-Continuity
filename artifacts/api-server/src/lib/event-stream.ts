import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { pool, type PoolClient } from "@workspace/db";
import { workflowColumns, eventColumns } from "./records";
import { logger } from "./logger";
import { noteSignal } from "./operational-signals";

const wakeups = new EventEmitter();
wakeups.setMaxListeners(0);
let listener: PoolClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connecting = false;
let subscribers = 0;

// One PostgreSQL LISTEN connection per process, not one per browser tab.
async function listen() {
  if (listener || connecting || !subscribers) return;
  connecting = true;
  try {
    const c = await pool.connect();
    if (!subscribers) { c.release(); return; }
    listener = c;
    c.on("notification", message => { if (message.channel === "thread_execution" && message.payload) wakeups.emit(message.payload); });
    c.on("error", () => {
      if (listener === c) {
        listener = null;
        c.release(true);
        if (subscribers) reconnectTimer = setTimeout(() => { void listen(); }, 1000);
      }
    });
    await c.query("LISTEN thread_execution");
    wakeups.emit("connected");
  } catch {
    if (listener) { listener.release(true); listener = null; }
    if (subscribers) reconnectTimer = setTimeout(() => { void listen(); }, 1000);
    logger.warn("Execution notification listener reconnecting; durable backfill remains available");
  } finally { connecting = false; }
}

export function validCursor(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export async function backfill(owner: string, after: string) {
  const updates = await pool.query("SELECT id::text AS cursor,workflow_id FROM execution_updates WHERE owner=$1 AND id>$2::bigint ORDER BY id LIMIT 100", [owner, after]);
  const frames = [];
  for (const row of updates.rows) {
    const workflow = (await pool.query(`SELECT ${workflowColumns} FROM workflows WHERE id=$1 AND owner=$2`, [row.workflow_id, owner])).rows[0];
    if (!workflow) continue;
    const events = (await pool.query(`SELECT ${eventColumns} FROM execution_events WHERE workflow_id=$1 ORDER BY sequence`, [row.workflow_id])).rows;
    frames.push({ cursor: row.cursor as string, workflow, events });
  }
  return frames;
}

const activeStreams = new Map<string, number>();
// Single Reserved VM generation: a restart/restore forces authoritative
// backfill even when restored sequence numbers have already been reused.
const streamEpoch = randomUUID();
export function streamExecution(req: Request, res: Response, owner: string) {
  const initial = req.get("last-event-id") ?? req.query.after ?? "0";
  if (!validCursor(initial)) {
    res.status(400).json({ error: "Invalid event cursor.", code: "INVALID_CURSOR" });
    return;
  }
  if ((activeStreams.get(owner) ?? 0) >= 6) {
    res.setHeader("Retry-After", "10");
    res.status(429).json({ code: "STREAM_LIMIT", error: "Close an unused THREAD tab before reconnecting." });
    return;
  }
  activeStreams.set(owner, (activeStreams.get(owner) ?? 0) + 1);
  let cursor = initial;
  let closed = false;
  let pumping = false;
  let requested = false;
  let reconciled = false;
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 1500\n\n");

  async function write(frame: string): Promise<boolean> {
    if (closed || res.destroyed) return false;
    if (res.write(frame)) return true;
    return new Promise(resolve => {
      const done = (ok: boolean) => {
        clearTimeout(timeout);
        res.off("drain", drained);
        res.off("close", ended);
        resolve(ok);
      };
      const drained = () => done(true);
      const ended = () => done(false);
      const timeout = setTimeout(() => { done(false); res.end(); }, 10000);
      res.once("drain", drained);
      res.once("close", ended);
    });
  }
  async function pump() {
    requested = true;
    if (pumping || closed) return;
    pumping = true;
    try {
      if (!reconciled) {
        const high = (await pool.query("SELECT COALESCE(MAX(id),0)::text AS cursor FROM execution_updates WHERE owner=$1", [owner])).rows[0].cursor;
        if ((typeof req.query.epoch === "string" && req.query.epoch !== streamEpoch) || BigInt(cursor) > BigInt(high)) {
          // Restored/pruned history may have rewound. Reset the browser's native
          // Last-Event-ID as well as its application cursor before backfill.
          if (!await write(`id:\nevent: reset\ndata: ${JSON.stringify({ reason: "history-reset", cursor: "0", epoch: streamEpoch })}\n\n`)) return;
          cursor = "0";
        }
        reconciled = true;
      }
      while (requested && !closed) {
        requested = false;
        const frames = await backfill(owner, cursor);
        for (const frame of frames) {
          if (!await write(`id: ${frame.cursor}\nevent: execution\ndata: ${JSON.stringify(frame)}\n\n`)) return;
          cursor = frame.cursor;
        }
        if (frames.length === 100) requested = true;
      }
    } catch {
      // End instead of pretending connected: EventSource will retry with its last received cursor.
      noteSignal("sse_failure");
      if (!closed) res.end();
    } finally { pumping = false; }
  }
  const wake = () => { void pump(); };
  subscribers++;
  wakeups.on(owner, wake);
  wakeups.on("connected", wake);
  void listen();
  void pump();
  // Heartbeat also reconciles missed notifications after listener/process outages.
  const heartbeat = setInterval(() => {
    if (!closed) { res.write(`: heartbeat ${Date.now()}\n\n`); void pump(); }
  }, 15000);
  // Bound lifetime so expired Clerk sessions are rechecked on the next connection.
  const expiry = setTimeout(() => res.end(), 60000);
  res.once("close", () => {
    const remaining = (activeStreams.get(owner) ?? 1) - 1;
    if (remaining) activeStreams.set(owner, remaining); else activeStreams.delete(owner);
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    wakeups.off(owner, wake);
    wakeups.off("connected", wake);
    subscribers--;
    if (!subscribers) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (listener) { listener.release(true); listener = null; }
    }
  });
}
