// Backward compatibility of integration-key auth before and after migration 0141.
// Run: npm run test:croplink-v2
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  createIntegrationKeyMiddleware, findKeyWithScopeFallback, isMissingColumnError, hashIntegrationKey, IntegrationKeyRecord, LEGACY_DEFAULT_SCOPES
} from "../requireIntegrationKey";

const legacyKey: IntegrationKeyRecord = { id: "k1", organization_id: "org", integration_name: "croplink" };

test("isMissingColumnError recognises PostgREST/Postgres missing-column errors for that column only", () => {
  assert.equal(isMissingColumnError({ code: "42703", message: "column organization_integration_keys.scopes does not exist" }, "scopes"), true);
  assert.equal(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'scopes' column of 'organization_integration_keys' in the schema cache" }, "scopes"), true);
  assert.equal(isMissingColumnError({ code: "42703", message: "column x.label does not exist" }, "scopes"), false);
  assert.equal(isMissingColumnError({ code: "57014", message: "canceling statement due to statement timeout" }, "scopes"), false);
  assert.equal(isMissingColumnError(null, "scopes"), false);
});

test("before migration 0141: key lookup falls back to the original columns", async () => {
  const asked: string[] = [];
  const found = await findKeyWithScopeFallback(async cols => {
    asked.push(cols);
    return cols.includes("scopes") ? { data: null, error: { code: "42703", message: "column organization_integration_keys.scopes does not exist" } } : { data: legacyKey, error: null };
  });
  assert.deepEqual(asked, ["id, organization_id, integration_name, scopes", "id, organization_id, integration_name"]);
  assert.deepEqual(found, { ...legacyKey, scopes: null });
});

test("after migration 0141: one query, scopes returned", async () => {
  let calls = 0;
  const found = await findKeyWithScopeFallback(async () => { calls++; return { data: { ...legacyKey, scopes: ["harvest-actuals:read", "yield-detail:read"] }, error: null }; });
  assert.equal(calls, 1);
  assert.deepEqual(found?.scopes, ["harvest-actuals:read", "yield-detail:read"]);
});

test("other lookup errors are not swallowed", async () => {
  await assert.rejects(findKeyWithScopeFallback(async () => ({ data: null, error: { code: "57014", message: "timeout" } })));
});

function run(mw: ReturnType<typeof createIntegrationKeyMiddleware>, key: string | undefined) {
  return new Promise<{ status: number | null; nextCalled: boolean; req: Request }>((resolve) => {
    const req = { headers: key ? { "x-integration-key": key } : {} } as unknown as Request;
    let status: number | null = null;
    const res = { status(s: number) { status = s; return this; }, json() { resolve({ status, nextCalled: false, req }); return this; } } as unknown as Response;
    void mw(req, res, () => resolve({ status, nextCalled: true, req }));
  });
}

test("v1 endpoint (no scope required) still accepts an existing key without scopes", async () => {
  const store = { findActiveByHash: async (h: string) => (h === hashIntegrationKey("gki_old") ? { ...legacyKey, scopes: null } : null), touch: async () => {} };
  const ok = await run(createIntegrationKeyMiddleware(store, "croplink"), "gki_old");
  assert.equal(ok.nextCalled, true);
  assert.deepEqual(ok.req.integrationScopes, LEGACY_DEFAULT_SCOPES);
  assert.equal((await run(createIntegrationKeyMiddleware(store, "croplink"), undefined)).status, 401);
  assert.equal((await run(createIntegrationKeyMiddleware(store, "croplink"), "gki_unknown")).status, 401);
  assert.equal((await run(createIntegrationKeyMiddleware(store, "croplink", "yield-detail:read"), "gki_old")).status, 403);
});
