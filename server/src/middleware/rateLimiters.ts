import { rateLimit, type RateLimitInfo } from "express-rate-limit";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

// Factories (not singletons) so tests can construct fresh, isolated
// instances — each with its own in-memory store — without sharing state
// with the real app's limiters or with each other.

// Builds a 429 handler whose JSON body always carries the retry time —
// req.rateLimit.resetTime is set by express-rate-limit before this runs.
// Read from the body (not headers) since custom response headers aren't
// readable by browser JS unless explicitly CORS-exposed, and the body is
// always readable regardless.
export function rateLimitHandler(message: string) {
  return (req: Request, res: Response) => {
    const resetTime = (req as unknown as { rateLimit?: RateLimitInfo }).rateLimit?.resetTime;
    const retryAfterSeconds = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
    res.status(429).json({
      message,
      retryAfterSeconds,
      retryAt: resetTime ? resetTime.toISOString() : new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
    });
  };
}

// General API limiter — applied to every /api route.
// Generous enough not to affect normal use, tight enough to blunt abuse.
export function createApiLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitHandler("Too many requests. Please try again later.")
  });
}

// express-rate-limit keys on the client IP by default. Every greenhouse user
// sits behind one office NAT, so a single person building templates consumed
// the whole 20-per-15-minutes bucket for ALL their colleagues, who then saw
// 429s on requests they had not made. Key on the caller's bearer token
// instead when there is one, so the limit is per signed-in user and still
// falls back to the IP for unauthenticated callers.
//
// This limiter is mounted before requireOrganizationContext, so req.userId is
// not populated yet -- the raw token is hashed here rather than verified, and
// is only ever used as an opaque bucket key, never for authorization.
export function strictLimiterKey(req: Request): string {
  const auth = req.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    return "tok:" + createHash("sha256").update(auth.slice(7)).digest("hex");
  }
  const uploadKey = req.get("x-upload-key");
  if (uploadKey) {
    return "key:" + createHash("sha256").update(uploadKey).digest("hex");
  }
  return "ip:" + (req.ip ?? "unknown");
}

// Strict limiter for expensive write-heavy endpoints: DockLink sync
// (full-table fetch), PDF batch upload (CPU + DB intensive), and CSV
// template upload/CRUD/import. Deliberately does NOT cover
// /api/csv-templates/preview — that's a lightweight, debounced,
// read-only recompute fired on every mapping edit while a user is
// actively building a template, and sharing this bucket with it starves
// Save Template of requests after a normal editing session (see
// createPreviewLimiter below). skip() excludes it here so the two
// limiters never both count the same preview request.
export function createStrictLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: strictLimiterKey,
    // req.path is relative to this middleware's mount point ("/preview",
    // not "/api/csv-templates/preview") since Express strips the mount
    // prefix for app.use-mounted middleware — req.originalUrl is never
    // stripped, so it's the reliable way to identify the full route here.
    // Exact-match (plus an optional query string) so this never
    // accidentally also skips some future sibling path like
    // /api/csv-templates/preview-something.
    // Also skips SAFE (read-only) requests. This bucket exists for expensive
    // write-heavy work; GET /api/csv-templates/pending/weekly-cards is a
    // plain list read that the CSV Templates tab issues on mount and on
    // Refresh, and it was spending the same 20-per-15-minutes budget as
    // template saves and imports. Because the client refreshes the pending
    // list after every mutation, each user action cost TWO tokens, so a
    // normal session of ten imports exhausted the window and every later
    // page load 429'd on a read that costs the server almost nothing.
    // Reads still fall under the general 300-per-15-minutes apiLimiter, so
    // this narrows a mis-scoped bucket rather than loosening protection:
    // every write keeps the identical 20-per-15-minutes limit it had before.
    skip: (req) => {
      const path = req.originalUrl.split("?")[0];
      if (path === "/api/csv-templates/preview") return true;
      return req.method === "GET" || req.method === "HEAD";
    },
    handler: rateLimitHandler("Too many requests for this operation. Please wait before retrying.")
  });
}

// Live-preview limiter for /api/csv-templates/preview only. Generous
// relative to strictLimiter because the CSV Template Builder fires a
// preview request on every mapping change (debounced ~500ms client-side,
// one in flight at a time) — a normal active editing session can easily
// produce more requests than the 20-per-15-min strict bucket without
// being abusive. Still bounded well under what a scripted flood would
// produce. Separate bucket from Save Template's (strictLimiter) by design.
export function createPreviewLimiter() {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: rateLimitHandler("Too many preview requests. Please slow down and try again shortly.")
  });
}
