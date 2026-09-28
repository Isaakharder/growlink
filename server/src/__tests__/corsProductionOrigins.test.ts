// The real app's CORS with a production-style CORS_ORIGINS: the old Railway
// web address and the custom domain (entered with a trailing slash and
// capitals, as it might be pasted into Railway) are both allowed, as is the
// native iOS app's capacitor://localhost; look-alikes are not. Set before
// app.ts is loaded, because it reads CORS_ORIGINS once at startup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;

before(async () => {
  process.env.CORS_ORIGINS = "https://growlinkclient-production.up.railway.app, https://GrowLink.lltech.io/";
  process.env.SUPABASE_URL ??= "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  // require, not import(): loaded after the env is set, through tsx's CJS hook like the rest of the suite.
  const { app } = require("../app") as typeof import("../app");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

for (const origin of ["https://growlink.lltech.io", "https://growlinkclient-production.up.railway.app", "capacitor://localhost"]) {
  test(`${origin} is allowed, with credentials, on requests and preflights`, async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");

    const preflight = await fetch(`${baseUrl}/api/yield-entries`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  });
}

for (const origin of ["https://www.growlink.lltech.io", "http://growlink.lltech.io", "https://growlink.lltech.io.evil.example"]) {
  test(`${origin} is not granted CORS access`, async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: origin } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
}
