// Tests for the CSV Template Builder's rate-limit fix: preview requests
// (fired on every mapping change) and the Save Template request must use
// independent buckets, so a normal burst of live-editing preview calls can
// never block a save. Each test builds a FRESH, isolated standalone app
// from the exported factories (createStrictLimiter/createPreviewLimiter) —
// never the real app.ts singletons — so tests never share rate-limit state
// with each other or with other test files that import the real app.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createStrictLimiter, createPreviewLimiter, createApiLimiter } from "../rateLimiters";

// Mirrors app.ts's mounting shape: previewLimiter scoped to the exact
// preview path, strictLimiter on the parent prefix with a skip for it.
function buildTestApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  const strict = createStrictLimiter();
  const preview = createPreviewLimiter();

  app.use("/api/csv-templates/preview", preview);
  app.use("/api/csv-templates", strict);

  app.post("/api/csv-templates/preview", (_req, res) => res.json({ ok: true, kind: "preview" }));
  app.post("/api/csv-templates", (_req, res) => res.status(201).json({ ok: true, kind: "save" }));
  app.get("/api/csv-templates/pending", (_req, res) => res.json({ ok: true, kind: "pending" }));

  return app;
}

async function withServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("rapid mapping changes: a burst of preview requests well past the strict 20/15min cap never returns 429", async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    // 25 requests — more than strictLimiter's limit (20) would allow if
    // preview were still sharing that bucket, but under previewLimiter's
    // own limit (30).
    for (let i = 1; i <= 25; i++) {
      const res = await fetch(`${baseUrl}/api/csv-templates/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 200, `preview request #${i} was unexpectedly blocked`);
    }
  });
});

test("preview debouncing/burst: the preview bucket has its own cap and returns a useful 429 body once exceeded", async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    let last: Response | null = null;
    for (let i = 1; i <= 31; i++) {
      last = await fetch(`${baseUrl}/api/csv-templates/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }
    assert.equal(last!.status, 429);
    const body = (await last!.json()) as { message: string; retryAfterSeconds: number; retryAt: string };
    assert.equal(body.message, "Too many preview requests. Please slow down and try again shortly.");
    assert.ok(Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds > 0);
    assert.ok(!Number.isNaN(new Date(body.retryAt).getTime()));
  });
});

test("successful saving after a preview burst: exhausting the preview bucket does not block Save Template", async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    // Exhaust the preview bucket completely (30 allowed + a few over).
    for (let i = 1; i <= 33; i++) {
      await fetch(`${baseUrl}/api/csv-templates/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }

    const saveRes = await fetch(`${baseUrl}/api/csv-templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(saveRes.status, 201, "Save Template was blocked by the preview bucket's exhaustion");
    const saveBody = await saveRes.json();
    assert.equal(saveBody.kind, "save");
  });
});

test("duplicate-save prevention (server-side half): the strict bucket independently caps repeated Save Template calls at its own limit", async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    let blockedAt: number | null = null;
    let last: Response | null = null;
    for (let i = 1; i <= 22; i++) {
      last = await fetch(`${baseUrl}/api/csv-templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (last.status === 429 && blockedAt === null) blockedAt = i;
    }
    assert.equal(blockedAt, 21, "strictLimiter's 20-request cap should trip on the 21st save-bucket request");
    const body = (await last!.json()) as { message: string; retryAfterSeconds: number };
    assert.equal(body.message, "Too many requests for this operation. Please wait before retrying.");
    assert.ok(body.retryAfterSeconds > 0);
  });
});

test("strict limiter is not weakened globally: a non-preview route under the same prefix still caps at 20 per window", async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    let saw429 = false;
    for (let i = 1; i <= 21; i++) {
      const res = await fetch(`${baseUrl}/api/csv-templates/pending`);
      if (res.status === 429) saw429 = true;
    }
    assert.equal(saw429, true, "the strict bucket's 20-request cap should still apply to non-preview csv-templates routes");
  });
});

test("skip() only excludes the exact preview path, not a hypothetical sibling path", async () => {
  const app = express();
  app.set("trust proxy", 1);
  const strict = createStrictLimiter();
  app.use("/api/csv-templates", strict);
  app.get("/api/csv-templates/preview-summary", (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    let saw429 = false;
    for (let i = 1; i <= 21; i++) {
      const res = await fetch(`${baseUrl}/api/csv-templates/preview-summary`);
      if (res.status === 429) saw429 = true;
    }
    assert.equal(saw429, true, "a route that merely starts with 'preview' should still be strict-limited, not skipped");
  });
});

test("apiLimiter (general) factory still produces a working, generously-capped limiter — unaffected by this change", async () => {
  const app = express();
  const api = createApiLimiter();
  app.use("/api", api);
  app.get("/api/anything", (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/anything`);
    assert.equal(res.status, 200);
  });
});
