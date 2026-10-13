// DockLink colour case sync over HTTP with the real router and permission
// middleware. Both Supabase clients are replaced with in-memory fakes before
// the router loads (no database, no credentials).
// Run: node --require tsx/cjs --test src/routes/__tests__/docklinkCaseSync.http.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DL_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DL_OTHER_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USER = "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu";

// Minimal PostgREST-style query builder over in-memory tables.
function createFakeClient(tables: Record<string, Row[]>, options: { queryError?: () => { message: string; code?: string } | null } = {}) {
  let nextId = 1;
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let upsertPayload: { row: Row; onConflict: string[] } | null = null;
      const rows = () => (tables[table] ??= []);
      const run = () => {
        const error = options.queryError?.() ?? null;
        if (error) return { data: null, error };
        if (upsertPayload) {
          const { row, onConflict } = upsertPayload;
          const existing = rows().find(r => onConflict.every(k => r[k] === row[k]));
          if (existing) Object.assign(existing, row);
          else rows().push({ id: `row-${nextId++}`, ...row });
          return { data: null, error: null };
        }
        return { data: rows().filter(r => filters.every(f => f(r))).map(r => ({ ...r })), error: null };
      };
      const builder = {
        select: () => builder,
        eq: (k: string, v: unknown) => (filters.push(r => r[k] === v), builder),
        neq: (k: string, v: unknown) => (filters.push(r => r[k] !== v), builder),
        gt: (k: string, v: number) => (filters.push(r => Number(r[k]) > v), builder),
        order: () => builder,
        limit: () => builder,
        upsert: (row: Row, opts: { onConflict: string }) => {
          upsertPayload = { row, onConflict: opts.onConflict.split(",") };
          return builder;
        },
        maybeSingle: async () => {
          const { data, error } = run();
          if (error) return { data: null, error };
          if ((data ?? []).length > 1) return { data: null, error: { message: "multiple rows" } };
          return { data: data?.[0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject)
      };
      return builder;
    }
  };
}

let growlink: Record<string, Row[]>;
let docklink: Record<string, Row[]>;
let docklinkError: { message: string; code?: string } | null = null;

const docklinkView = (week: number, pack_color: string, total_cases: number, organization_id = DL_ORG) => ({
  organization_id, iso_year: 2026, iso_week: week, pack_color, total_cases
});

beforeEach(() => {
  docklinkError = null;
  growlink = {
    memberships: [
      { user_id: USER, organization_id: ORG, role: "owner" },
      { user_id: USER, organization_id: OTHER_ORG, role: "owner" }
    ],
    organization_integrations: [
      { organization_id: ORG, integration_name: "docklink", enabled: true, external_organization_id: DL_ORG }
    ],
    varieties: [
      { organization_id: ORG, color: "red", area_m2: 1000, status: "active" },
      { organization_id: ORG, color: "orange", area_m2: 500, status: "active" },
      { organization_id: ORG, color: "yellow", area_m2: 500, status: "active" }
    ],
    color_case_entries: [
      // Week 39 as last synced (2026-09-26).
      { id: "w39-red", organization_id: ORG, color: "red", year: 2026, week: 39, total_cases: 4568, case_weight_kg: 5.15, source: "docklink" },
      // A manual entry in an earlier week supplies the best-known red case weight.
      { id: "manual-red", organization_id: ORG, color: "red", year: 2026, week: 20, total_cases: 100, case_weight_kg: 5.5, source: "manual" },
      // Another organization's row for the same week must never be touched.
      { id: "other-org", organization_id: OTHER_ORG, color: "red", year: 2026, week: 40, total_cases: 1, case_weight_kg: 9, source: "manual" }
    ]
  };
  docklink = {
    growlink_weekly_color_totals: [
      docklinkView(39, "Red", 4700), // week 39 grew after the mid-week sync
      docklinkView(40, "Red", 6000),
      docklinkView(40, "Orange Pepper", 2000),
      docklinkView(41, "Red", 5500),
      docklinkView(41, "YELLOW", 1200),
      docklinkView(42, "Red", 800),
      docklinkView(40, "Red", 99999, DL_OTHER_ORG)
    ]
  };
});

let server: Server;
let baseUrl: string;

before(async () => {
  process.env.DOCKLINK_SUPABASE_URL = "https://docklink.test";
  process.env.DOCKLINK_SUPABASE_SERVICE_ROLE_KEY = "test-key";

  const growlinkClient = { from: (t: string) => createFakeClient(growlink).from(t) };
  const docklinkClient = { from: (t: string) => createFakeClient(docklink, { queryError: () => docklinkError }).from(t) };
  const stub = (path: string, exports: Record<string, unknown>) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports } as unknown as NodeJS.Module;
  };
  stub("../../config/supabase", { supabase: growlinkClient });
  stub("../../config/docklink", { docklinkSupabase: docklinkClient, isDocklinkConfigured: () => true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { integrationsRouter } = require("../integrations") as typeof import("../integrations");
  const app = express();
  app.use((req, _res, next) => {
    req.userId = USER;
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", integrationsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

const sync = async (org = ORG) => {
  const res = await fetch(`${baseUrl}/api/integrations/docklink/sync-color-cases`, { method: "POST", headers: { "x-test-org": org } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const cases = (org = ORG) =>
  growlink.color_case_entries
    .filter(r => r.organization_id === org)
    .map(r => `${r.week}:${r.color}:${r.total_cases}:${r.case_weight_kg}:${r.source}`)
    .sort();

test("imports weeks after 39 for the mapped organization only, and updates week 39", async () => {
  const { status, body } = await sync();
  assert.equal(status, 200);
  assert.equal(body.imported, 5);
  assert.equal(body.updated, 1);
  assert.match(String(body.message), /imported=5, updated=1/);
  assert.deepEqual(cases(), [
    "20:red:100:5.5:manual",
    "39:red:4700:5.15:docklink", // keeps its own weight; cases refreshed
    "40:orange:2000:5.15:docklink",
    "40:red:6000:5.5:docklink", // best-known manual red weight
    "41:red:5500:5.5:docklink",
    "41:yellow:1200:5.15:docklink",
    "42:red:800:5.5:docklink"
  ]);
  const w40red = growlink.color_case_entries.find(r => r.organization_id === ORG && r.week === 40 && r.color === "red")!;
  assert.equal(w40red.total_kg, 6000 * 5.5);
  assert.equal(w40red.kg_per_m2, (6000 * 5.5) / 1000);
  assert.deepEqual(cases(OTHER_ORG), ["40:red:1:9:manual"]);
});

test("a repeated sync updates in place without duplicating cases", async () => {
  await sync();
  const before = cases();
  const { status, body } = await sync();
  assert.equal(status, 200);
  assert.equal(body.imported, 0);
  assert.equal(body.updated, 6);
  assert.deepEqual(cases(), before);
});

test("a rotated DockLink key fails with a 502 and an actionable message, writing nothing", async () => {
  docklinkError = { message: "Unregistered API key" };
  const before = cases();
  const { status, body } = await sync();
  assert.equal(status, 502);
  assert.match(String(body.message), /DockLink rejected GrowLink's API key/);
  assert.match(String(body.message), /DOCKLINK_SUPABASE_SERVICE_ROLE_KEY/);
  assert.deepEqual(cases(), before);
});

test("an organization without a DockLink mapping is told so and nothing is written", async () => {
  const { status, body } = await sync(OTHER_ORG);
  assert.equal(status, 200);
  assert.match(String(body.message), /integration mapping is not configured/);
  assert.deepEqual(cases(OTHER_ORG), ["40:red:1:9:manual"]);
});
