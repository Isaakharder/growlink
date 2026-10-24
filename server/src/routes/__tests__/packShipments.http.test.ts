// DockLink pack shipments end to end over HTTP: the real integrations and
// pack-shipments routers and permission middleware, on a real Postgres
// (PGlite) with migrations 0143-0146 applied. DockLink's growlink_pack_export_v1 is
// stubbed with the mock export fixture. No server, Docker, network or
// credentials.
// Run: node --require tsx/cjs --test src/routes/__tests__/packShipments.http.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DL_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DL_OTHER_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const VIEWER = "aaaaaaaa-0000-4000-8000-00000000000b";

const fixturePath = path.resolve(__dirname, "../../lib/__tests__/fixtures/docklink-pack-export-v1.json");
const migration = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0143_docklink_pack_shipments.sql"), "utf8");
const migration0144 = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0144_manual_pack_case_entries.sql"), "utf8");
const migration0145 = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0145_case_rebuild_ranges.sql"), "utf8");
const migration0146 = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0146_pack_measurement_defaults.sql"), "utf8");
type Doc = ReturnType<typeof JSON.parse>;
const freshFixture = (): Doc => JSON.parse(readFileSync(fixturePath, "utf8"));

let db: PGlite;
let docklinkResponse: () => { data: unknown; error: { message: string; code?: string } | null };
let server: Server;
let baseUrl: string;

async function resetDatabase() {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${OTHER_ORG}', 'owner', '{}'),
      ('${VIEWER}', '${ORG}', 'member', '{"cases:view": true}');
    create table organization_integrations (organization_id uuid, integration_name text, external_organization_id text, enabled boolean);
    insert into organization_integrations values ('${ORG}', 'docklink', '${DL_ORG}', true), ('${OTHER_ORG}', 'docklink', '${DL_OTHER_ORG}', true);
    -- legacy colour totals (migration 0013 + 0014 + 0018 shape)
    create table color_case_entries (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null, color text not null, year int not null, week int not null,
      total_cases numeric not null, case_weight_kg numeric not null, total_kg numeric not null default 0, kg_per_m2 numeric not null default 0,
      color_area_m2 numeric not null default 0, source text default 'manual', synced_at timestamptz, source_summary jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now(), unique (organization_id, color, year, week));
    insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values
      ('${ORG}', 'red', 2026, 44, 1400, 5.15, 7210, 'docklink'),       -- transition week: legacy
      ('${ORG}', 'yellow', 2026, 44, 300, 5.15, 1545, 'docklink'),
      ('${ORG}', 'red', 2026, 45, 1500, 5.15, 7725, 'docklink'),       -- pack week: superseded, never added
      ('${ORG}', 'orange', 2026, 45, 12, 5.5, 66, 'manual');            -- manual entry in a pack week: kept, superseded
  `);
  await db.exec(migration);
  await db.exec(migration0144);
  await db.exec(migration0145);
  await db.exec(migration0146);
}

before(async () => {
  process.env.DOCKLINK_SUPABASE_URL = "https://docklink.test";
  process.env.DOCKLINK_SUPABASE_SERVICE_ROLE_KEY = "test-key";
  await resetDatabase();

  // The route modules import the shared clients at load time: point them at PGlite / the DockLink stub.
  const growlinkClient = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as Record<string | symbol, unknown>)[prop] });
  const docklinkClient = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, "growlink_pack_export_v1");
      assert.ok(typeof args.p_organization_id === "string");
      return docklinkResponse();
    },
    from: () => {
      throw new Error("the pack sync must not read DockLink tables directly");
    }
  };
  const stub = (p: string, exports: Record<string, unknown>) => {
    const id = require.resolve(p);
    require.cache[id] = { id, filename: id, loaded: true, exports } as unknown as NodeJS.Module;
  };
  stub("../../config/supabase", { supabase: growlinkClient });
  stub("../../config/docklink", { docklinkSupabase: docklinkClient, isDocklinkConfigured: () => true });

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { integrationsRouter } = require("../integrations") as typeof import("../integrations");
  const { packShipmentsRouter } = require("../packShipments") as typeof import("../packShipments");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", integrationsRouter);
  app.use("/api", packShipmentsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

beforeEach(async () => {
  await resetDatabase();
  docklinkResponse = () => ({ data: freshFixture(), error: null });
});

type Opts = { user?: string; org?: string; body?: unknown; method?: string };
async function call(pathname: string, { user = OWNER, org = ORG, body, method }: Opts = {}) {
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-test-user": user, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
const sync = (o: Opts = {}) => call("/integrations/docklink/sync-packs", { ...o, method: "POST" });
const week = (w: number, o: Opts = {}) => call(`/pack-shipments/week?isoYear=2026&isoWeek=${w}`, o);
const save = (body: Record<string, unknown>, o: Opts = {}) => call("/pack-shipments/measurements", { ...o, method: "PUT", body: { isoYear: 2026, ...body } });
const counts = async () => (await db.query<{ n: number }>("select count(*)::int n from docklink_pack_weekly_shipments")).rows[0].n;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const RAINBOW = [
  { color: "red", piecesPerCase: 15, fruitWeightG: 180 },
  { color: "yellow", piecesPerCase: 15, fruitWeightG: 175 },
  { color: "orange", piecesPerCase: 15, fruitWeightG: 170 }
];

// ---------------------------------------------------------------------------

test("sync stores the pack export; the weekly screen lists DockLink's packs in display order with ship-time names", async () => {
  const s = await sync();
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.match(s.body.message, /2026-W45 to 2026-W48: 8 packs, 15 new/);

  const w = await week(47);
  assert.equal(w.status, 200);
  assert.equal(w.body.source, "packs");
  assert.deepEqual(
    w.body.packs.map((p: any) => `${p.name}|${p.packCode}|${p.colorKind}:${p.colorKey}|${p.packStatus}|${p.status}`),
    [
      "Red 5kg|RL5|single:red|active|missing",
      "Yellow 5kg|YL5|single:yellow|active|missing",
      "Orange 5kg|OL5|single:orange|active|no_shipments", // active, nothing shipped this week
      "Tri-Colour 3pk|TC3|mixed:mixed|archived|missing", // archived, but shipped this week
      "Sweet Bite 250g|SB25|single:orange|active|missing",
      "Sweet Bite 250g|SB25|single:red|active|missing" // shipped while red, recoloured since: its own series
    ]
  );
  assert.equal(w.body.packs.find((p: any) => p.colorKey === "red" && p.packCode === "SB25").reclassifiedSince, true);
  assert.ok(!w.body.packs.some((p: any) => p.packCode === "GL5"), "archived pack with no shipments this week is hidden");
  assert.deepEqual(w.body.attention.map((a: any) => `${a.name}:${a.reason}:${a.cases}`).sort(), ["Mixed Lot 7:unattributed:45", "Purple Gourmet:unsupported_colour:30"]);
  assert.deepEqual(w.body.nonPepper.map((n: any) => `${n.name}:${n.cropType}:${n.cases}`), ["Basil 12ct:herb:200"]);
  assert.equal(w.body.totals.complete, false);
});

test("single-colour and rainbow measurements give the right kg; the rainbow total is the sum of its colours and its cases count once", async () => {
  await sync();
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 })).status, 200);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-tri-3pk", components: RAINBOW })).status, 200);

  const w = (await week(47)).body;
  const red = w.packs.find((p: any) => p.seriesKey === "s-red-5kg");
  const rainbow = w.packs.find((p: any) => p.seriesKey === "s-tri-3pk");
  close(red.kg, 1840 * 5.12);
  close(rainbow.kgByColor.red, (620 * 15 * 180) / 1000);
  close(rainbow.kgByColor.yellow, (620 * 15 * 175) / 1000);
  close(rainbow.kgByColor.orange, (620 * 15 * 170) / 1000);
  close(rainbow.kg, rainbow.kgByColor.red + rainbow.kgByColor.yellow + rainbow.kgByColor.orange);
  assert.equal(w.totals.mixedCases, 620);
  assert.equal(w.totals.shippedCases, 1840 + 312.5 + 620 + 40 + 80 + 45 + 30);
  close(w.totals.colors.red.kg, 1840 * 5.12 + (620 * 15 * 180) / 1000);
  assert.equal(w.totals.unmeasuredCases, 312.5 + 40 + 80);
  assert.equal(w.totals.attentionCases, 75);
});

test("measurement validation: kind must match the shipment's classification", async () => {
  await sync();
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-tri-3pk", netKgPerCase: 5 })).status, 400);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-red-5kg", components: RAINBOW })).status, 400);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 0 })).status, 400);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-tri-3pk", components: [{ color: "red", piecesPerCase: 15 }] })).status, 400);
  const purple = await save({ isoWeek: 47, seriesKey: "s-purple", netKgPerCase: 4 });
  assert.equal(purple.status, 422);
  assert.match(purple.body.message, /Needs attention/);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-basil", netKgPerCase: 4 })).status, 422);
  const legacyWeek = await save({ isoWeek: 44, seriesKey: "s-red-5kg", netKgPerCase: 5 });
  assert.equal(legacyWeek.status, 409);
  assert.match(legacyWeek.body.message, /legacy colour totals/);
  assert.equal((await save({ isoWeek: 47, seriesKey: "nope", netKgPerCase: 5 })).status, 404);
});

test("repeated syncs — including corrections and voids — never overwrite or delete measurements", async () => {
  await sync();
  await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 });
  await save({ isoWeek: 47, seriesKey: "s-tri-3pk", components: RAINBOW });
  docklinkResponse = () => {
    const doc = freshFixture();
    doc.generated_at = "2026-11-24T09:00:00Z";
    doc.weekly_pack_totals.find((r: any) => r.iso_week === 47 && r.series_key === "s-red-5kg").total_cases = 1790;
    doc.weekly_pack_totals.find((r: any) => r.iso_week === 47 && r.series_key === "s-tri-3pk").total_cases = 0;
    return { data: doc, error: null };
  };
  assert.equal((await sync()).status, 200);
  const w = (await week(47)).body;
  const red = w.packs.find((p: any) => p.seriesKey === "s-red-5kg");
  close(red.kg, 1790 * 5.12);
  const rainbow = w.packs.find((p: any) => p.seriesKey === "s-tri-3pk");
  assert.equal(rainbow.status, "zero");
  assert.equal(rainbow.measurement.components.length, 3, "voided series keeps its measurement");
  assert.equal(w.totals.mixedCases, 0);
});

test("a rejected or failed DockLink response changes nothing", async () => {
  await sync();
  await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 });
  const before = JSON.stringify((await db.query("select * from docklink_pack_weekly_shipments order by iso_week, series_key")).rows);

  docklinkResponse = () => ({ data: { ...freshFixture(), version: 2, generated_at: "2026-11-30T00:00:00Z" }, error: null });
  let r = await sync();
  assert.equal(r.status, 502);
  assert.match(r.body.message, /version must be 1.*Nothing was changed/);

  docklinkResponse = () => {
    const doc = freshFixture();
    doc.generated_at = "2026-11-30T00:00:00Z";
    doc.weekly_pack_totals[2].total_cases = "-3";
    return { data: doc, error: null };
  };
  assert.equal((await sync()).status, 502);

  docklinkResponse = () => ({ data: null, error: { message: "unknown organization", code: "P0002" } });
  r = await sync();
  assert.equal(r.status, 409);
  assert.match(r.body.message, /does not recognise the mapped organization/);

  docklinkResponse = () => ({ data: null, error: { message: "Could not find the function public.growlink_pack_export_v1", code: "PGRST202" } });
  assert.equal((await sync()).status, 503);

  docklinkResponse = () => ({ data: null, error: { message: "Invalid API key" } });
  assert.equal((await sync()).status, 502);

  docklinkResponse = () => ({ data: { ...freshFixture(), generated_at: "2026-11-01T00:00:00Z" }, error: null });
  r = await sync();
  assert.equal(r.status, 409, "older export than the one applied");
  assert.match(r.body.message, /newer DockLink export/);

  assert.equal(JSON.stringify((await db.query("select * from docklink_pack_weekly_shipments order by iso_week, series_key")).rows), before);
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from pack_case_measurements")).rows[0].n, 1);
});

test("pending/not-active exports switch every week back to colour totals without losing counts or measurements; available restores them", async () => {
  await sync();
  await save({ isoWeek: 45, seriesKey: "s-red-5kg", netKgPerCase: 5 });
  docklinkResponse = () => {
    const doc = freshFixture();
    doc.generated_at = "2026-11-24T09:00:00Z";
    doc.scope = { status: "capture_not_active", capture_activated_at: null, transition_week: null, first_week: null, last_week: null };
    doc.weekly_pack_totals = [];
    return { data: doc, error: null };
  };
  const pending = await sync();
  assert.equal(pending.status, 200);
  assert.match(pending.body.message, /still come from colour totals/);
  assert.equal((await week(45)).body.source, "legacy");
  let y = (await call("/shipped-yield?fromYear=2026&fromWeek=45&toYear=2026&toWeek=45")).body;
  assert.equal(y.weeks[0].source, "legacy");
  assert.equal(y.weeks[0].shippedCases, 1512, "legacy 45: red 1500 + manual orange 12");
  assert.equal(await counts(), 15);

  docklinkResponse = () => ({ data: { ...freshFixture(), generated_at: "2026-11-25T09:00:00Z" }, error: null });
  await sync();
  y = (await call("/shipped-yield?fromYear=2026&fromWeek=45&toYear=2026&toWeek=45")).body;
  assert.equal(y.weeks[0].source, "packs");
  close(y.weeks[0].colors.red.kg, 1500 * 5);
});

test("cutover and moving boundary over HTTP: legacy before first_week, packs within, never both", async () => {
  await sync();
  await save({ isoWeek: 45, seriesKey: "s-red-5kg", netKgPerCase: 5 });
  let y = (await call("/shipped-yield?fromYear=2026&fromWeek=44&toYear=2026&toWeek=45")).body;
  assert.deepEqual(y.weeks.map((w: any) => `${w.isoWeek}:${w.source}:${w.shippedCases}`), ["44:legacy:1700", "45:packs:2000"]);
  assert.equal(y.weeks[1].supersededLegacyRows, 2);
  close(y.weeks[0].kg, 7210 + 1545);

  // DockLink finds an uncovered load in week 45: the boundary moves to 46.
  docklinkResponse = () => {
    const doc = freshFixture();
    doc.generated_at = "2026-11-24T09:00:00Z";
    doc.scope.transition_week = { iso_year: 2026, iso_week: 45, week_start: "2026-11-02" };
    doc.scope.first_week = { iso_year: 2026, iso_week: 46, week_start: "2026-11-09" };
    doc.weekly_pack_totals = doc.weekly_pack_totals.filter((r: any) => r.iso_week !== 45);
    return { data: doc, error: null };
  };
  await sync();
  y = (await call("/shipped-yield?fromYear=2026&fromWeek=44&toYear=2026&toWeek=45")).body;
  assert.deepEqual(y.weeks.map((w: any) => `${w.isoWeek}:${w.source}:${w.shippedCases}`), ["44:legacy:1700", "45:legacy:1512"]);
  assert.equal(await counts(), 15, "week 45 pack rows kept (outside scope, unused), not zeroed");
});

test("copy previous week's measurements: explicit, origin shown, never overwrites, and only to the same classification", async () => {
  await sync();
  await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 });
  await save({ isoWeek: 47, seriesKey: "s-yellow-5kg", netKgPerCase: 5.05 });

  const w48 = (await week(48)).body;
  assert.deepEqual(w48.copySource, { isoYear: 2026, isoWeek: 47, matchingSeries: 1 });
  assert.equal(w48.packs.find((p: any) => p.seriesKey === "s-red-5kg").measurement, null, "copying is never automatic");

  const copy = await call("/pack-shipments/measurements/copy", { body: { isoYear: 2026, isoWeek: 48, fromIsoYear: 2026, fromIsoWeek: 47 } });
  assert.equal(copy.status, 200);
  assert.deepEqual(copy.body.copied.map((c: any) => c.seriesKey).sort(), ["s-red-5kg", "s-yellow-5kg"]);
  const red48 = (await week(48)).body.packs.find((p: any) => p.seriesKey === "s-red-5kg");
  assert.deepEqual(red48.measurement.copiedFrom, { isoYear: 2026, isoWeek: 47 });
  close(red48.kg, 900 * 5.12);

  // Editing clears the copied-from marker; copying again never overwrites.
  await save({ isoWeek: 48, seriesKey: "s-red-5kg", netKgPerCase: 5.3 });
  const again = await call("/pack-shipments/measurements/copy", { body: { isoYear: 2026, isoWeek: 48, fromIsoYear: 2026, fromIsoWeek: 47 } });
  assert.ok(again.body.skipped.some((s: any) => s.seriesKey === "s-red-5kg" && /already has a measurement/.test(s.reason)));
  const edited = (await week(48)).body.packs.find((p: any) => p.seriesKey === "s-red-5kg");
  assert.equal(edited.measurement.netKgPerCase, 5.3);
  assert.equal(edited.measurement.copiedFrom, null);

  // A recoloured pack's new series never receives the old colour's measurement.
  await save({ isoWeek: 46, seriesKey: "s-sweet-red", netKgPerCase: 0.25 });
  const toW47 = await call("/pack-shipments/measurements/copy", { body: { isoYear: 2026, isoWeek: 47, fromIsoYear: 2026, fromIsoWeek: 46 } });
  assert.ok(toW47.body.copied.some((c: any) => c.seriesKey === "s-sweet-red"));
  assert.ok(toW47.body.skipped.some((s: any) => s.seriesKey === "s-sweet-orange" && /same pack and classification/.test(s.reason)));

  assert.equal((await call("/pack-shipments/measurements/copy", { body: { isoYear: 2026, isoWeek: 47, fromIsoYear: 2026, fromIsoWeek: 48 } })).status, 400);
});

test("clearing a measurement makes it missing again (not zero)", async () => {
  await sync();
  await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 });
  const del = await call("/pack-shipments/measurements?isoYear=2026&isoWeek=47&seriesKey=s-red-5kg", { method: "DELETE" });
  assert.equal(del.status, 204);
  const red = (await week(47)).body.packs.find((p: any) => p.seriesKey === "s-red-5kg");
  assert.equal(red.status, "missing");
  assert.equal(red.kg, null);
});

test("organization isolation: another organization can't see, measure or copy this organization's shipments", async () => {
  await sync();
  await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 });
  const other = await week(47, { org: OTHER_ORG });
  assert.equal(other.body.source, "legacy");
  assert.deepEqual(other.body.packs, []);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 1 }, { org: OTHER_ORG })).status, 409);
  const y = (await call("/shipped-yield", { org: OTHER_ORG })).body;
  assert.deepEqual([y.totals.shippedCases, y.weeks.length], [0, 0]);

  // The other organization's own sync uses its own mapping and touches only its rows.
  docklinkResponse = () => ({ data: { ...freshFixture(), organization_id: DL_OTHER_ORG }, error: null });
  assert.equal((await sync({ org: OTHER_ORG })).status, 200);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 1 }, { org: OTHER_ORG })).status, 200);
  const mine = (await week(47)).body.packs.find((p: any) => p.seriesKey === "s-red-5kg");
  assert.equal(mine.measurement.netKgPerCase, 5.12);

  // An export for the wrong DockLink organization is refused outright.
  docklinkResponse = () => ({ data: { ...freshFixture(), organization_id: DL_OTHER_ORG, generated_at: "2026-11-30T00:00:00Z" }, error: null });
  assert.equal((await sync()).status, 502);
});

test("permissions: cases:view can read the week and totals but can't sync, save, clear or copy", async () => {
  await sync();
  const v = { user: VIEWER };
  assert.equal((await week(47, v)).status, 200);
  assert.equal((await call("/shipped-yield", v)).status, 200);
  assert.equal((await sync(v)).status, 403);
  assert.equal((await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5 }, v)).status, 403);
  assert.equal((await call("/pack-shipments/measurements?isoYear=2026&isoWeek=47&seriesKey=s-red-5kg", { ...v, method: "DELETE" })).status, 403);
  assert.equal((await call("/pack-shipments/measurements/copy", { ...v, body: { isoYear: 2026, isoWeek: 48, fromIsoYear: 2026, fromIsoWeek: 47 } })).status, 403);
  // A user with no membership in the organization is refused even read access.
  assert.equal((await week(47, { user: VIEWER, org: OTHER_ORG })).status, 403);
});

test("consistent totals: the weekly screen and /shipped-yield agree, and range totals are the sum of their weeks", async () => {
  await sync();
  await save({ isoWeek: 47, seriesKey: "s-red-5kg", netKgPerCase: 5.12 });
  await save({ isoWeek: 47, seriesKey: "s-tri-3pk", components: RAINBOW });
  await save({ isoWeek: 46, seriesKey: "s-red-5kg", netKgPerCase: 5.1 });
  const y = (await call("/shipped-yield?fromYear=2026&fromWeek=44&toYear=2026&toWeek=48")).body;
  const w47 = (await week(47)).body.totals;
  assert.deepEqual(y.weeks.find((w: any) => w.isoWeek === 47), w47);
  const sum = (f: (w: any) => number) => y.weeks.reduce((s: number, w: any) => s + f(w), 0);
  close(y.totals.kg, sum((w) => w.kg));
  assert.equal(y.totals.shippedCases, sum((w) => w.shippedCases));
  assert.equal(y.totals.unmeasuredCases, sum((w) => w.unmeasuredCases));
  assert.equal(y.totals.attentionCases, 75);
  assert.equal(y.totals.complete, false);
  assert.deepEqual(y.totals.nonPepper, [{ cropType: "herb", trackingUnit: "units", cases: 200 }]);
  // All-time (no range) includes the same weeks.
  const allTime = (await call("/shipped-yield")).body;
  close(allTime.totals.kg, y.totals.kg);
});

test("range parameters are validated", async () => {
  assert.equal((await call("/shipped-yield?fromYear=2026&fromWeek=54")).status, 400);
  assert.equal((await call("/shipped-yield?fromYear=abc")).status, 400);
  assert.equal((await call("/pack-shipments/week?isoYear=2025&isoWeek=53")).status, 400);
});
