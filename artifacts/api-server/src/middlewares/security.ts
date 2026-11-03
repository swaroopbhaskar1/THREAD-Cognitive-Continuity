import type { RequestHandler, ErrorRequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "@workspace/db";
import { consumeLimit } from "../lib/limits";

const ipWindows = new Map<string, { until: number; count: number }>();
let sweepAt = 0;

// Coarse bounded-memory admission before Clerk/parsing. Durable per-user
// protection below is authoritative across instances. No IPs are logged.
export const securityHeadersAndAdmission: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  if (now >= sweepAt) {
    for (const [key, value] of ipWindows) if (value.until <= now) ipWindows.delete(key);
    sweepAt = now + 60000;
  }
  const ip = req.ip || "unknown";
  let bucket = ipWindows.get(ip);
  if (!bucket || bucket.until <= now) {
    if (ipWindows.size >= 10000 && !bucket) { res.status(503).json({ code: "ADMISSION_BUSY", error: "Please retry shortly." }); return; }
    bucket = { until: now + 60000, count: 0 }; ipWindows.set(ip, bucket);
  }
  if (++bucket.count > 600) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.until - now) / 1000))));
    res.status(429).json({ code: "RATE_LIMITED", error: "Too many requests. Your saved work is unchanged." }); return;
  }
  next();
};

export const protectLearningAPI: RequestHandler = async (req, res, next) => {
  if (req.path === "/healthz" || req.path === "/readyz") { next(); return; }
  // No reflected credentialed CORS. Browsers must use this artifact's own origin.
  const origin = req.get("origin");
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  let sameOrigin = true;
  if (origin) {
    try { sameOrigin = new URL(origin).origin === `${req.protocol}://${host}`; }
    catch { sameOrigin = false; }
  }
  if (!sameOrigin || req.get("sec-fetch-site") === "cross-site") {
    res.status(403).json({ code: "ORIGIN_REJECTED", error: "Use THREAD from its own site." }); return;
  }
  const owner = getAuth(req).userId;
  if (!owner) { next(); return; }
  try {
    const limit = await consumeLimit(pool, "api-owner", owner, 300, 60);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfter));
      res.status(429).json({ code: "RATE_LIMITED", error: "Too many requests. Retry with the same request key." }); return;
    }
    next();
  } catch {
    req.log.error({ code: "RATE_LIMIT_STORE_UNAVAILABLE" }, "Request admission unavailable");
    res.status(503).json({ code: "SERVICE_UNAVAILABLE", error: "Unable to verify request admission. Your local edits should be retained." });
  }
};

export const safeRequestErrors: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) { res.end(); return; }
  const status = [400, 401, 403, 413, 415, 429].includes(Number(err?.status)) ? Number(err.status) : 500;
  req.log.error({ code: "REQUEST_REJECTED", status }, "Request failed before workflow execution");
  res.status(status).json({ code: status === 500 ? "SERVER_ERROR" : "INVALID_REQUEST", error: status === 500 ? "Request unavailable. Please retry." : "Invalid or unsupported request body." });
};
