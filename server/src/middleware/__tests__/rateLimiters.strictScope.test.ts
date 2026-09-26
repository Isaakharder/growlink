// Proves the strict limiter covers WRITES only, and buckets per caller
// identity rather than per IP.
//
// Background: GET /api/csv-templates/pending/weekly-cards is a read-only list
// the CSV Templates tab issues on mount and on Refresh. It was mounted under
// createStrictLimiter() (20 requests / 15 minutes), the bucket meant for
// expensive write-heavy endpoints. Because the client refreshes the pending
// list after every mutation, each user action spent two tokens, so a normal
// session exhausted the window and subsequent page loads 429'd on a read.
//
// These tests pin the corrected behaviour. They deliberately assert that the
// WRITE limit is still exactly 20 — the fix narrows a mis-scoped bucket, it
// does not raise or disable the limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createStrictLimiter, strictLimiterKey } from "../rateLimiters";

const CSV_READ = "/api/csv-templates/pending/weekly-cards";
const CSV_WRITE = "/api/csv-templates";

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/csv-templates", createStrictLimiter());
  // Plain terminal middleware rather than a route pattern, so this test is
  // independent of Express's path-pattern syntax version.
  app.use("/api/csv-templates", (_req, res) => { res.json({ ok: true }); });

  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

const AUTH = { authorization: "Bearer token-alice" };

test("read-only csv-template requests never exhaust the strict write budget", async () => {
  await withServer(async (base) => {
    // Far more than the 20-per-15-minutes write limit.
    for (let i = 0; i < 60; i++) {
      const res = await fetch(base + CSV_READ, { headers: AUTH });
      assert.equal(res.status, 200, `read #${i + 1} should not be rate limited`);
    }
    // ...and the write budget is still completely intact afterwards.
    const write = await fetch(base + CSV_WRITE, { method: "POST", headers: AUTH });
    assert.equal(write.status, 200, "reads must not consume write tokens");
  });
});

test("writes are still limited to exactly 20 per window", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 20; i++) {
      const res = await fetch(base + CSV_WRITE, { method: "POST", headers: AUTH });
      assert.equal(res.status, 200, `write #${i + 1} should be allowed`);
    }
    const blocked = await fetch(base + CSV_WRITE, { method: "POST", headers: AUTH });
    assert.equal(blocked.status, 429, "the 21st write must be rate limited");

    const body = (await blocked.json()) as { retryAfterSeconds?: number; retryAt?: string };
    assert.ok(typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0,
      "429 body must carry retryAfterSeconds so the client can show a countdown");
    assert.ok(typeof body.retryAt === "string", "429 body must carry retryAt");
  });
});

test("a rate-limited user does not rate-limit a different user on the same IP", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 20; i++) {
      await fetch(base + CSV_WRITE, { method: "POST", headers: { authorization: "Bearer token-alice" } });
    }
    const alice = await fetch(base + CSV_WRITE, { method: "POST", headers: { authorization: "Bearer token-alice" } });
    assert.equal(alice.status, 429, "alice has spent her budget");

    // Same source IP (both requests come from 127.0.0.1), different bearer.
    const bob = await fetch(base + CSV_WRITE, { method: "POST", headers: { authorization: "Bearer token-bob" } });
    assert.equal(bob.status, 200, "bob must have his own bucket behind a shared NAT");
  });
});

test("strictLimiterKey buckets per identity and never returns the raw token", () => {
  const req = (headers: Record<string, string>, ip = "10.0.0.1") =>
    ({ get: (h: string) => headers[h.toLowerCase()], ip }) as unknown as Parameters<typeof strictLimiterKey>[0];

  const alice = strictLimiterKey(req({ authorization: "Bearer secret-alice" }));
  const bob = strictLimiterKey(req({ authorization: "Bearer secret-bob" }));
  assert.notEqual(alice, bob);
  assert.ok(alice.startsWith("tok:"));
  assert.ok(!alice.includes("secret-alice"), "the raw bearer token must never appear in the key");

  // Deterministic: the same caller always lands in the same bucket.
  assert.equal(alice, strictLimiterKey(req({ authorization: "Bearer secret-alice" }, "10.9.9.9")));

  // Agent uploads key on their upload key.
  const agent = strictLimiterKey(req({ "x-upload-key": "abc" }));
  assert.ok(agent.startsWith("key:"));
  assert.ok(!agent.includes("abc"));

  // Anonymous callers still fall back to the IP.
  assert.equal(strictLimiterKey(req({}, "203.0.113.7")), "ip:203.0.113.7");
});
