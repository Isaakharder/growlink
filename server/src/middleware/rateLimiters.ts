import { rateLimit, type RateLimitInfo } from "express-rate-limit";
import type { Request, Response } from "express";

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
    // req.path is relative to this middleware's mount point ("/preview",
    // not "/api/csv-templates/preview") since Express strips the mount
    // prefix for app.use-mounted middleware — req.originalUrl is never
    // stripped, so it's the reliable way to identify the full route here.
    // Exact-match (plus an optional query string) so this never
    // accidentally also skips some future sibling path like
    // /api/csv-templates/preview-something.
    skip: (req) => {
      const path = req.originalUrl.split("?")[0];
      return path === "/api/csv-templates/preview";
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
