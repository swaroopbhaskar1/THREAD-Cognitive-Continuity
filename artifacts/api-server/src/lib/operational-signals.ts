export type Signal = "database_write_failure" | "server_error" | "sse_failure" | "client_sse_failure" | "commit_ack_failure" | "worker_failure";
const signals = new Map<Signal, { start: number; count: number }>();
let workerSeen = 0;
export const SIGNAL_WINDOW_MS = 300_000;
export function noteSignal(name: Signal) {
  const now = Date.now(), prior = signals.get(name);
  if (!prior || now - prior.start >= SIGNAL_WINDOW_MS) signals.set(name, { start: now, count: 1 });
  else prior.count++;
}
export function signalCount(name: Signal, now = Date.now()) {
  const value = signals.get(name);
  return value && now - value.start < SIGNAL_WINDOW_MS ? value.count : 0;
}
export function workerHeartbeat() { workerSeen = Date.now(); }
export function workerLastSeen() { return workerSeen; }
