// Proves the Capacitor iOS app's origin (capacitor://localhost — see
// client/capacitor.config.ts) is allowed through CORS in dev/test (where
// CORS_ORIGINS is unset, so only the DEV_ORIGINS allowlist in app.ts
// applies), and that CORS remains narrow — an arbitrary unlisted origin is
// still rejected. Hits /api/health (exempt from auth) so this stays a pure
// CORS-layer test with no Supabase/DB dependency.
import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../app";

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("capacitor://localhost (the native iOS app's WKWebView origin) is allowed by CORS", async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "capacitor://localhost" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "capacitor://localhost");
});

test("an arbitrary unlisted origin is not granted CORS access", async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://not-a-growlink-origin.example.com" }
  });
  // The request itself still succeeds (CORS is enforced by the browser,
  // not the server refusing to respond) — what must be absent is the
  // header that would let a browser's JS read the response cross-origin.
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
