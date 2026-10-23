// Manual pack case entries end to end over HTTP: the real integrations,
// pack-shipments, manual-entry and projections routers and permission
// middleware, on a real Postgres (PGlite) with migrations 0143 + 0144
// applied. DockLink's export is the mock fixture (scope 2026-W45..W48,
// transition week 2026-W44). No server, Docker, network or credentials.
// Run: node --require tsx/cjs --test src/routes/__tests__/manualPackEntries.http.test.ts
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
const RED = "a3f00000-0000-4000-8000-000000000001";
const YELLOW = "a3f00000-0000-4000-8000-000000000002";
const TRI = "d91b0000-0000-4000-8000-000000000004"; // archived in DockLink
const GREEN = "a3f00000-0000-4000-8000-000000000005"; // archived in DockLink

const migrations = ["0143_docklink_pack_shipments.sql", "0144_manual_pack_case_entries.sql", "0145_case_rebuild_ranges.sql"].map((f) =>
  readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", f), "utf8")
);
const fixture = () => JSON.parse(readFileSync(path.resolve(__dirname, "../../lib/__tests__/fixtures/docklink-pack-export-v1.json"), "utf8"));

let db: PGlite;
let docklinkResponse: () => { data: unknown; error: null };
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
    create table color_case_entries (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null, color text not null, year int not null, week int not null,
      total_cases numeric not null, case_weight_kg numeric not null, total_kg numeric not null default 0, kg_per_m2 numeric not null default 0,
      color_area_m2 numeric not null default 0, source text default 'manual', synced_at timestamptz, source_summary jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now(), unique (organization_id, color, year, week));
    insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values
      ('${ORG}', 'red', 2026, 44, 1400, 5.15, 7210, 'docklink'),   -- transition week (colour totals)
      ('${ORG}', 'yellow', 2026, 44, 300, 5.15, 1545, 'docklink'),
      ('${ORG}', 'red', 2025, 20, 800, 5.0, 4000, 'manual');        -- an older manual colour entry
    -- projections (shape read by GET /yield/projections)
    create table yield_projections (id uuid primary key default gen_random_uuid(), organization_id uuid, target_year int, target_week int,
      forecast_year int, forecast_week int, weeks_out int, projection_level text, variety_id uuid, color text, unit text, projected_amount numeric, notes text);
    create table varieties (id uuid primary key default gen_random_uuid(), organization_id uuid, name text, color text);
    create table yield_entries (organization_id uuid, variety_id uuid, year int, week int, total_kg numeric, total_cases numeric);
  `);
  for (const m of migrations) await db.exec(m);
}

before(async () => {
  process.env.DOCKLINK_SUPABASE_URL = "https://docklink.test";
  process.env.DOCKLINK_SUPABASE_SERVICE_ROLE_KEY = "test-key";
  await resetDatabase();
  const growlinkClient = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as Record<string | symbol, unknown>)[prop] });
  const docklinkClient = {
    rpc: async () => docklinkResponse(),
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
  const { manualPackEntriesRouter } = require("../manualPackEntries") as typeof import("../manualPackEntries");
  const { yieldProjectionsRouter } = require("../yieldProjections") as typeof import("../yieldProjections");
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
  app.use("/api", manualPackEntriesRouter);
  app.use("/api", yieldProjectionsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

beforeEach(async () => {
  await resetDatabase();
  docklinkResponse = () => ({ data: fixture(), error: null });
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
const sync = () => call("/integrations/docklink/sync-packs", { method: "POST" });
const week = (y: number, w: number, o: Opts = {}) => call(`/pack-shipments/week?isoYear=${y}&isoWeek=${w}`, o);
const add = (body: Record<string, unknown>, o: Opts = {}) => call("/manual-pack-entries", { ...o, method: "POST", body });
const line = (packId: string, cases: number, packSource = "docklink") => ({ packSource, packId, cases });
const measure = (y: number, w: number, measurementKey: string, values: Record<string, unknown>) =>
  call("/pack-shipments/measurements", { method: "PUT", body: { isoYear: y, isoWeek: w, measurementKey, ...values } });
const yieldFor = (y: number, w: number) => call(`/shipped-yield?fromYear=${y}&fromWeek=${w}&toYear=${y}&toWeek=${w}`);
const close = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);
const RAINBOW = [
  { color: "red", piecesPerCase: 15, fruitWeightG: 180 },
  { color: "yellow", piecesPerCase: 15, fruitWeightG: 175 },
  { color: "orange", piecesPerCase: 15, fruitWeightG: 170 }
];
let generation = 0;
function scoped(first: number | null, last: number | null, status = "available") {
  const doc = fixture();
  generation += 1;
  doc.generated_at = new Date(Date.parse("2026-11-24T00:00:00Z") + generation * 3_600_000).toISOString();
  doc.scope.status = status;
  if (first !== null && last !== null) {
    doc.scope.first_week = { iso_year: 2026, iso_week: first, week_start: "", week_end: "" };
    doc.scope.last_week = { iso_year: 2026, iso_week: last, week_start: "", week_end: "" };
    const mondays: Record<number, string> = { 44: "2026-10-26", 45: "2026-11-02", 46: "2026-11-09", 47: "2026-11-16", 48: "2026-11-23", 49: "2026-11-30", 50: "2026-12-07" };
    for (const k of ["first_week", "last_week"] as const) {
      doc.scope[k].week_start = mondays[doc.scope[k].iso_week];
      doc.scope[k].week_end = new Date(Date.parse(mondays[doc.scope[k].iso_week]) + 6 * 86_400_000).toISOString().slice(0, 10);
    }
    doc.scope.transition_week = { iso_year: 2026, iso_week: first - 1, week_start: mondays[first - 1], week_end: new Date(Date.parse(mondays[first - 1]) + 6 * 86_400_000).toISOString().slice(0, 10) };
  }
  doc.weekly_pack_totals = status === "available" ? doc.weekly_pack_totals.filter((r: any) => r.iso_week >= (first ?? 0) && r.iso_week <= (last ?? 0)) : [];
  docklinkResponse = () => ({ data: doc, error: null });
  return doc;
}
const manualEntryRow = (week: number, cases: number) =>
  db.query(
    `insert into manual_pack_case_entries (organization_id, iso_year, iso_week, pack_source, docklink_pack_id, pack_name, color_kind, color_key, crop_type, tracking_unit, cases)
     values ($1, 2026, $2, 'docklink', $3, 'Red 5kg', 'single', 'red', 'pepper', 'kg', $4)`, [ORG, week, RED, cases]
  );

const manualSnapshot = async () =>
  JSON.stringify(
    await Promise.all(
      ["manual_pack_case_entries", "historical_packs", "case_week_sources"].map(async (t) => (await db.query(`select * from ${t} order by 1, 2, 3`)).rows)
    )
  );

// ---------------------------------------------------------------------------

test("pack picker lists every DockLink pack (active, archived, no longer in DockLink) and historical packs", async () => {
  await sync();
  const later = fixture();
  later.generated_at = "2026-11-24T08:00:00Z";
  later.packs = later.packs.filter((p: any) => p.pack_id !== YELLOW);
  later.weekly_pack_totals = later.weekly_pack_totals.filter((r: any) => r.pack_id !== YELLOW);
  docklinkResponse = () => ({ data: later, error: null });
  assert.equal((await sync()).status, 200);
  await call("/historical-packs", { body: { name: "Red 11lb (2024)", packCode: "R11", colorKind: "single", colorKey: "red", cropType: "pepper", trackingUnit: "kg" } });

  const packs = (await call("/manual-pack-entries/packs")).body;
  const status = (id: string) => packs.docklink.find((p: any) => p.packId === id).status;
  assert.equal(status(RED), "active");
  assert.equal(status(TRI), "archived");
  assert.equal(status(GREEN), "archived");
  assert.equal(status(YELLOW), "not_in_docklink");
  assert.deepEqual(packs.docklink.find((p: any) => p.packId === TRI), {
    packSource: "docklink", packId: TRI, name: "Tri-Colour 3pk", packCode: "TC3", description: "15 retail 3-packs per shipping case",
    colorKind: "mixed", colorKey: "mixed", cropType: "pepper", trackingUnit: "kg", displayOrder: 30, status: "archived"
  });
  assert.deepEqual(packs.historical.map((h: any) => `${h.name}|${h.colorKind}:${h.colorKey}|${h.entryCount}`), ["Red 11lb (2024)|single:red|0"]);
});

test("an invoice for a week before DockLink's capture: several packs, several invoices, one total per pack, kg from the week's measurements", async () => {
  await sync();
  const inv1 = await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1001", lines: [line(RED, 400), line(TRI, 120)] });
  assert.equal(inv1.status, 201, JSON.stringify(inv1.body));
  assert.equal(inv1.body.entries.length, 2);
  assert.equal(inv1.body.weekSource, "manual_packs", "a week with no colour totals records manual packs as its source");
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1002", lines: [line(RED, 250)] })).status, 201);

  let w = (await week(2025, 14)).body;
  assert.equal(w.source, "manual");
  assert.equal(w.sourceReason, "chosen_manual");
  assert.equal(w.manualEntryAllowed, true);
  assert.deepEqual(w.manualEntries.map((e: any) => `${e.invoiceRef}:${e.packCode}:${e.cases}`).sort(), ["INV-1001:RL5:400", "INV-1001:TC3:120", "INV-1002:RL5:250"]);
  const red = w.packs.find((p: any) => p.packId === RED);
  const tri = w.packs.find((p: any) => p.packId === TRI);
  assert.equal(red.cases, 650);
  assert.equal(red.entryCount, 2);
  assert.equal(red.origin, "manual");
  assert.equal(tri.packStatus, "archived");
  assert.equal(red.status, "missing");

  assert.equal((await measure(2025, 14, red.measurementKey, { netKgPerCase: 5.12 })).status, 200);
  assert.equal((await measure(2025, 14, tri.measurementKey, { components: RAINBOW })).status, 200);
  w = (await week(2025, 14)).body;
  close(w.packs.find((p: any) => p.packId === RED).kg, 650 * 5.12);
  close(w.totals.colors.red.kg, 650 * 5.12 + (120 * 15 * 180) / 1000);
  close(w.totals.colors.yellow.kg, (120 * 15 * 175) / 1000);
  assert.equal(w.totals.shippedCases, 770);
  assert.equal(w.totals.mixedCases, 120);
  assert.equal(w.totals.complete, true);

  // The same totals everywhere: /shipped-yield (Cases, Dashboard, Analytics, iOS) agrees with the week screen.
  const y = (await yieldFor(2025, 14)).body;
  assert.deepEqual(y.weeks[0], w.totals);
});

test("duplicates are flagged: the same invoice and pack again, or the same week/pack/cases without a reference", async () => {
  await sync();
  await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1001", lines: [line(RED, 400)] });

  const again = await add({ isoYear: 2025, isoWeek: 15, invoiceRef: " inv-1001 ", lines: [line(RED, 400), line(YELLOW, 50)] });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "possible_duplicates");
  assert.deepEqual(again.body.duplicates.map((d: any) => `${d.line}:${d.existing.invoiceRef}:${d.existing.isoWeek}`), ["0:INV-1001:14"]);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from manual_pack_case_entries`)).rows[0].n, 1, "nothing saved until confirmed");

  // Same invoice, different pack: normal (one invoice lists several packs).
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1001", lines: [line(YELLOW, 50)] })).status, 201);

  await add({ isoYear: 2025, isoWeek: 16, lines: [line(RED, 75)] });
  assert.equal((await add({ isoYear: 2025, isoWeek: 16, lines: [line(RED, 75)] })).body.code, "possible_duplicates");
  assert.equal((await add({ isoYear: 2025, isoWeek: 16, lines: [line(RED, 75)], confirmDuplicates: true })).status, 201);
  const flagged = (await week(2025, 16)).body.manualEntries;
  assert.ok(flagged.every((e: any) => e.duplicates.length === 1), "both confirmed duplicates stay flagged on the week screen");
  close((await week(2025, 16)).body.packs[0].cases, 150, "confirmed duplicates count (they were confirmed)");
});

test("a week with colour totals needs an explicit source; the chosen source counts, the other is reported, never added", async () => {
  await sync();
  const blocked = await add({ isoYear: 2026, isoWeek: 44, invoiceRef: "INV-2044", lines: [line(RED, 1390)] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "week_source_required");
  assert.equal(blocked.body.legacyCases, 1700);

  assert.equal((await add({ isoYear: 2026, isoWeek: 44, invoiceRef: "INV-2044", lines: [line(RED, 1390)], weekSource: "manual_packs" })).status, 201);
  let w = (await week(2026, 44)).body;
  assert.equal(w.source, "manual", "the transition week can be reconstructed from invoices");
  assert.equal(w.totals.shippedCases, 1390);
  assert.deepEqual(w.notCounted, { manualCases: 0, manualEntries: 0, legacyCases: 1700, legacyRows: 2 });

  assert.equal((await call("/case-week-sources", { method: "PUT", body: { isoYear: 2026, isoWeek: 44, source: "legacy_colours" } })).status, 200);
  w = (await week(2026, 44)).body;
  assert.equal(w.source, "legacy");
  assert.equal(w.totals.shippedCases, 1700);
  assert.deepEqual(w.notCounted, { manualCases: 1390, manualEntries: 1, legacyCases: 0, legacyRows: 0 });

  // Without any choice (e.g. cleared), both sources exist: colour totals count and the week is flagged.
  assert.equal((await call("/case-week-sources?isoYear=2026&isoWeek=44", { method: "DELETE" })).status, 204);
  w = (await week(2026, 44)).body;
  assert.equal(w.source, "legacy");
  assert.equal(w.needsSourceDecision, true);
  const y = (await call("/shipped-yield?fromYear=2026&fromWeek=40&toYear=2026&toWeek=48")).body;
  assert.equal(y.totals.weeksNeedingSourceDecision, 1);
});

test("DockLink precedence is exactly its validated available scope (first..last, status); moving it forward and back keeps manual history", async () => {
  // Pending scope: nothing is DockLink's yet, so manual entries are accepted in W46 and W49.
  scoped(45, 48, "pending_first_full_week");
  assert.equal((await sync()).status, 200);
  assert.equal((await add({ isoYear: 2026, isoWeek: 46, invoiceRef: "INV-46", lines: [line(RED, 99)] })).status, 201, "pending scope doesn't own W46");
  assert.equal((await add({ isoYear: 2026, isoWeek: 49, invoiceRef: "INV-49", lines: [line(RED, 77)] })).status, 201);
  const history = await manualSnapshot();

  // Available 45..48: W45 and W48 (first and last) refuse new entries; W44 and W49 (just outside) accept them.
  scoped(45, 48);
  assert.equal((await sync()).status, 200);
  for (const w of [45, 46, 48]) {
    const r = await add({ isoYear: 2026, isoWeek: w, lines: [line(YELLOW, 10)] });
    assert.equal(r.status, 409, `W${w}`);
    assert.equal(r.body.code, "docklink_owned_week");
    assert.match(r.body.message, /2026-W45 to 2026-W48/);
  }
  assert.equal((await call("/case-week-sources", { method: "PUT", body: { isoYear: 2026, isoWeek: 46, source: "manual_packs" } })).status, 409);
  let w46 = (await week(2026, 46)).body;
  assert.equal(w46.source, "packs");
  assert.equal(w46.manualEntryAllowed, false);
  assert.match(w46.manualEntryBlockedReason, /2026-W45 to 2026-W48/);
  assert.equal(w46.notCounted.manualCases, 99, "the earlier entry is kept, shown, not counted");
  assert.equal(w46.totals.shippedCases, 1720 + 610 + 120);
  let w49 = (await week(2026, 49)).body;
  assert.equal(w49.source, "manual", "beyond last_week is not DockLink's yet");
  assert.equal(w49.totals.shippedCases, 77);
  assert.equal(w49.manualEntryAllowed, true);

  // Forward: DockLink's scope now runs to W50. W49 becomes DockLink's; its manual entry is kept, not counted.
  scoped(45, 50);
  assert.equal((await sync()).status, 200);
  w49 = (await week(2026, 49)).body;
  assert.equal(w49.source, "packs");
  assert.equal(w49.notCounted.manualCases, 77);
  assert.equal((await add({ isoYear: 2026, isoWeek: 50, lines: [line(RED, 1)] })).status, 409);

  // Backward: DockLink's first pack week moves to W47 (e.g. an uncaptured load). W46 is manual again, with its history.
  scoped(47, 50);
  assert.equal((await sync()).status, 200);
  w46 = (await week(2026, 46)).body;
  assert.equal(w46.source, "manual");
  assert.equal(w46.totals.shippedCases, 99);
  assert.equal(w46.manualEntryAllowed, true);
  const w45 = (await yieldFor(2026, 45)).body.weeks;
  assert.deepEqual(w45, [], "W45 left the scope and has no other data");

  // Not active: every week accepts manual entries; nothing counts as DockLink's.
  scoped(null, null, "capture_not_active");
  assert.equal((await sync()).status, 200);
  assert.equal((await week(2026, 47)).body.source, "legacy");
  assert.equal((await week(2026, 49)).body.source, "manual");
  assert.equal(await manualSnapshot(), history, "no sync, forward or back, changed a manual entry or choice");
});

test("syncs never overwrite, zero or delete manual entries, historical packs or week choices", async () => {
  await sync();
  await call("/historical-packs", { body: { name: "Old 11lb red", colorKind: "single", colorKey: "red", cropType: "pepper", trackingUnit: "kg" } });
  await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1", lines: [line(RED, 400), line(TRI, 50)] });
  await add({ isoYear: 2026, isoWeek: 44, invoiceRef: "INV-2", lines: [line(RED, 1390)], weekSource: "manual_packs" });
  const before = await manualSnapshot();

  // Repeated syncs, a correction that zeroes series, a pending scope, and colour totals arriving for a manual week.
  const voided = fixture();
  voided.generated_at = "2026-11-25T08:00:00Z";
  voided.weekly_pack_totals = voided.weekly_pack_totals.filter((r: any) => r.iso_week !== 47);
  docklinkResponse = () => ({ data: voided, error: null });
  assert.equal((await sync()).status, 200);
  const pending = fixture();
  pending.generated_at = "2026-11-26T08:00:00Z";
  pending.scope.status = "pending_first_full_week";
  pending.weekly_pack_totals = [];
  docklinkResponse = () => ({ data: pending, error: null });
  assert.equal((await sync()).status, 200);
  await db.query(`insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values ($1, 'red', 2025, 14, 999, 5.15, 5144.85, 'docklink')`, [ORG]);

  assert.equal(await manualSnapshot(), before);
  const w = (await week(2025, 14)).body;
  assert.equal(w.source, "manual", "colour totals synced later don't replace entered history");
  assert.equal(w.totals.shippedCases, 450);
  assert.equal(w.notCounted.legacyCases, 999);
});

test("edit and remove individual entries; deleting a week's last entry never switches it back to colour totals", async () => {
  await sync();
  const created = (await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1", lines: [line(RED, 400), line(YELLOW, 30)] })).body.entries;
  const red = created.find((e: any) => e.packId === RED);
  const yellow = created.find((e: any) => e.packId === YELLOW);

  const edited = await call(`/manual-pack-entries/${red.id}`, { method: "PUT", body: { cases: 410, invoiceRef: "INV-1A", note: "recounted" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.entry.cases, edited.body.entry.invoiceRef, edited.body.entry.note, edited.body.entry.colorKey], [410, "INV-1A", "recounted", "red"]);

  const moved = await call(`/manual-pack-entries/${red.id}`, { method: "PUT", body: { isoYear: 2025, isoWeek: 15 } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.previousWeekRemainingEntries, 1);
  assert.equal((await week(2025, 15)).body.source, "manual");

  // Colour totals arrive for W14 (a colour sync), then W14's last entry is deleted.
  await db.query(`insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values ($1, 'red', 2025, 14, 999, 5.15, 5144.85, 'docklink')`, [ORG]);
  const del = await call(`/manual-pack-entries/${yellow.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(del.body.remainingEntries, 0);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from case_week_sources where iso_week = 14 and source = 'manual_packs'`)).rows[0].n, 1, "the week's choice is kept");
  let w14 = (await week(2025, 14)).body;
  assert.equal(w14.source, "manual", "still manual; colour totals don't silently come back");
  assert.equal(w14.manualStatus, "not_entered");
  assert.equal(w14.totals.complete, false, "not entered yet is incomplete, not a zero");
  assert.equal(w14.notCounted.legacyCases, 999);

  // Confirmed zero-shipment week is different from not entered.
  assert.equal((await call("/case-week-confirmations", { method: "PUT", body: { isoYear: 2025, isoWeek: 14, note: "no invoices that week" } })).status, 200);
  w14 = (await week(2025, 14)).body;
  assert.equal(w14.manualStatus, "confirmed");
  assert.equal(w14.totals.shippedCases, 0);
  assert.equal(w14.totals.complete, true);
  assert.equal(w14.confirmation.note, "no invoices that week");
  assert.equal((await call("/case-week-confirmations?isoYear=2025&isoWeek=14", { method: "DELETE" })).status, 204);
  assert.equal((await week(2025, 14)).body.manualStatus, "not_entered");

  // Switching back to colour totals is explicit.
  assert.equal((await call("/case-week-sources", { method: "PUT", body: { isoYear: 2025, isoWeek: 14, source: "legacy_colours" } })).status, 200);
  assert.equal((await week(2025, 14)).body.source, "legacy");
  assert.equal((await call(`/manual-pack-entries/${yellow.id}`, { method: "DELETE" })).status, 404);

  // Editing into a DockLink week is refused; invalid cases are refused.
  assert.equal((await call(`/manual-pack-entries/${red.id}`, { method: "PUT", body: { isoYear: 2026, isoWeek: 47 } })).status, 409);
  assert.equal((await call(`/manual-pack-entries/${red.id}`, { method: "PUT", body: { cases: 0 } })).status, 400);
});

test("an entry keeps the classification it was entered with when the DockLink pack changes later", async () => {
  await sync();
  await add({ isoYear: 2025, isoWeek: 14, lines: [line(RED, 100)] });
  const recoloured = fixture();
  recoloured.generated_at = "2026-11-24T08:00:00Z";
  const pack = recoloured.packs.find((p: any) => p.pack_id === RED);
  Object.assign(pack, { name: "Red 5kg Premium", color_key: "orange", color_label: "Orange" });
  docklinkResponse = () => ({ data: recoloured, error: null });
  await sync();
  const w = (await week(2025, 14)).body;
  assert.equal(w.packs[0].colorKey, "red");
  assert.equal(w.packs[0].name, "Red 5kg");
  assert.equal(w.packs[0].currentName, "Red 5kg Premium");
  assert.equal(w.packs[0].reclassifiedSince, true);
  assert.equal(w.totals.colors.red.cases, 100);
});

test("historical packs: enter an old invoice pack DockLink no longer has; classification fixed once used", async () => {
  const created = await call("/historical-packs", { body: { name: "Tri 3pk (2024 retail)", packCode: "T3-24", colorKind: "mixed", cropType: "pepper", trackingUnit: "kg", note: "From 2024 invoices" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.pack.id;
  assert.equal(created.body.pack.color_key, "mixed");

  // No DockLink sync at all is needed for historical weeks.
  const entry = await add({ isoYear: 2024, isoWeek: 40, invoiceRef: "OLD-77", lines: [line(id, 300, "historical")] });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const w = (await week(2024, 40)).body;
  const row = w.packs[0];
  assert.equal(row.packStatus, "historical");
  assert.equal(row.description, "From 2024 invoices");
  assert.equal((await measure(2024, 40, row.measurementKey, { components: RAINBOW.slice(0, 2) })).status, 200);
  close((await week(2024, 40)).body.totals.kg, (300 * 15 * (180 + 175)) / 1000);

  assert.equal((await call(`/historical-packs/${id}`, { method: "PUT", body: { name: "Tri 3pk (2024)" } })).status, 200);
  const recolour = await call(`/historical-packs/${id}`, { method: "PUT", body: { colorKind: "single", colorKey: "red" } });
  assert.equal(recolour.status, 409);
  assert.match(recolour.body.message, /fixed/);
  assert.equal((await call(`/historical-packs/${id}`, { method: "DELETE" })).status, 409);
  assert.equal((await call("/historical-packs", { body: { name: "Bad", colorKind: "single", colorKey: "purple", cropType: "pepper", trackingUnit: "kg" } })).status, 400);
  const unused = (await call("/historical-packs", { body: { name: "Unused", colorKind: "none", cropType: "cucumber", trackingUnit: "piece" } })).body.pack.id;
  assert.equal((await call(`/historical-packs/${unused}`, { method: "DELETE" })).status, 204);
});

test("a measurement entered for a manual week can be copied to the next DockLink week for the same pack and classification", async () => {
  await sync();
  await add({ isoYear: 2026, isoWeek: 44, lines: [line(TRI, 600)], weekSource: "manual_packs" });
  const tri44 = (await week(2026, 44)).body.packs.find((p: any) => p.packId === TRI);
  await measure(2026, 44, tri44.measurementKey, { components: RAINBOW });

  const w45 = (await week(2026, 45)).body;
  assert.deepEqual(w45.copySource, { isoYear: 2026, isoWeek: 44, matchingSeries: 1 });
  const copy = await call("/pack-shipments/measurements/copy", { body: { isoYear: 2026, isoWeek: 45, fromIsoYear: 2026, fromIsoWeek: 44 } });
  assert.deepEqual(copy.body.copied.map((c: any) => c.seriesKey), ["s-tri-3pk"]);
  const tri45 = (await week(2026, 45)).body.packs.find((p: any) => p.seriesKey === "s-tri-3pk");
  close(tri45.kg, (500 * 15 * (180 + 175 + 170)) / 1000);
  assert.deepEqual(tri45.measurement.copiedFrom, { isoYear: 2026, isoWeek: 44 });
});

test("validation: week, packs, cases, lines", async () => {
  await sync();
  assert.equal((await add({ isoYear: 2025, isoWeek: 54, lines: [line(RED, 1)] })).status, 400);
  assert.equal((await add({ isoYear: 2025, isoWeek: 53, lines: [line(RED, 1)] })).status, 400, "2025 has 52 ISO weeks");
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [] })).status, 400);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [line(RED, 0)] })).status, 400);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [{ packSource: "docklink", packId: RED, cases: "12" }] })).status, 400);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [line(RED, 1), line(RED, 2)] })).status, 400);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [line("no-such-pack", 1)] })).status, 404);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [line(RED, 1, "croplink")] })).status, 400);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "x".repeat(101), lines: [line(RED, 1)] })).status, 400);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from manual_pack_case_entries`)).rows[0].n, 0, "a rejected save writes nothing");
});

test("organization isolation: another organization can't see, change or use this organization's entries and packs", async () => {
  await sync();
  const hist = (await call("/historical-packs", { body: { name: "Old red", colorKind: "single", colorKey: "red", cropType: "pepper", trackingUnit: "kg" } })).body.pack.id;
  const [entry] = (await add({ isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1", lines: [line(RED, 400)] })).body.entries;

  const other = { org: OTHER_ORG };
  assert.equal((await week(2025, 14, other)).body.manualEntries.length, 0);
  assert.equal((await call("/manual-pack-entries?isoYear=2025", other)).body.entries.length, 0);
  assert.equal((await call(`/manual-pack-entries/${entry.id}`, { ...other, method: "PUT", body: { cases: 1 } })).status, 404);
  assert.equal((await call(`/manual-pack-entries/${entry.id}`, { ...other, method: "DELETE" })).status, 404);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [line(hist, 1, "historical")] }, other)).status, 404);
  assert.equal((await add({ isoYear: 2025, isoWeek: 14, lines: [line(RED, 1)] }, other)).status, 404, "org B has no copy of org A's DockLink pack");
  assert.equal((await call("/manual-pack-entries/packs", other)).body.historical.length, 0);
  assert.equal((await call(`/historical-packs/${hist}`, { ...other, method: "DELETE" })).status, 404);
  assert.equal((await db.query<{ c: number }>(`select cases::int c from manual_pack_case_entries`)).rows[0].c, 400);
});

test("permissions: cases:view can read entries and totals but can't add, edit, delete, choose a source or add packs", async () => {
  await sync();
  const [entry] = (await add({ isoYear: 2025, isoWeek: 14, lines: [line(RED, 400)] })).body.entries;
  const viewer = { user: VIEWER };
  assert.equal((await week(2025, 14, viewer)).status, 200);
  assert.equal((await call("/manual-pack-entries?isoYear=2025", viewer)).status, 200);
  assert.equal((await call("/manual-pack-entries/packs", viewer)).status, 200);
  assert.equal((await add({ isoYear: 2025, isoWeek: 15, lines: [line(RED, 1)] }, viewer)).status, 403);
  assert.equal((await call(`/manual-pack-entries/${entry.id}`, { ...viewer, method: "PUT", body: { cases: 1 } })).status, 403);
  assert.equal((await call(`/manual-pack-entries/${entry.id}`, { ...viewer, method: "DELETE" })).status, 403);
  assert.equal((await call("/case-week-sources", { ...viewer, method: "PUT", body: { isoYear: 2025, isoWeek: 14, source: "legacy_colours" } })).status, 403);
  assert.equal((await call("/historical-packs", { ...viewer, body: { name: "x", colorKind: "none", cropType: "other", trackingUnit: "kg" } })).status, 403);
});

test("projections compare against the same weekly shipped cases (manual weeks, colour weeks and DockLink weeks)", async () => {
  await sync();
  await add({ isoYear: 2026, isoWeek: 44, lines: [line(RED, 1390)], weekSource: "manual_packs" });
  await db.query(
    `insert into yield_projections (organization_id, target_year, target_week, forecast_year, forecast_week, weeks_out, projection_level, color, unit, projected_amount) values
      ($1, 2026, 44, 2026, 40, 4, 'color', 'red', 'cases', 1400),
      ($1, 2026, 46, 2026, 40, 6, 'color', 'red', 'cases', 1800)`, [ORG]
  );
  const rows = (await call("/yield/projections?year=2026")).body as unknown as Array<Record<string, any>>;
  const shipped = (await call("/shipped-yield?fromYear=2026&toYear=2026")).body;
  for (const r of rows) {
    const w = shipped.weeks.find((x: any) => x.isoWeek === r.target_week);
    assert.equal(r.actual_amount, w.colors.red.cases, `W${r.target_week}`);
  }
  assert.deepEqual(rows.map((r) => r.actual_amount), [1390, 1720 + 120]);
});

test("a historical rebuild range: every week uses manual entries, entered or not; colour totals never count there", async () => {
  await sync();
  const created = await call("/case-rebuild-ranges", { body: { fromIsoYear: 2025, fromIsoWeek: 10, toIsoYear: 2025, toIsoWeek: 20, note: "Rebuild from first invoices" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    { weeks: created.body.range.weeks, entered: created.body.range.entered, confirmed: created.body.range.confirmed, notEntered: created.body.range.notEntered },
    { weeks: 11, entered: 0, confirmed: 0, notEntered: 11 }
  );

  // W20 has an older manual colour total (800 cases): inside the range it's kept, never counted.
  let w20 = (await week(2025, 20)).body;
  assert.equal(w20.source, "manual");
  assert.equal(w20.sourceReason, "rebuild_range");
  assert.equal(w20.manualStatus, "not_entered");
  assert.equal(w20.notCounted.legacyCases, 800);
  assert.equal(w20.rebuildRange.from.isoWeek, 10);

  // Entries need no per-week choice inside a range, and none is stored.
  assert.equal((await add({ isoYear: 2025, isoWeek: 20, invoiceRef: "INV-520", lines: [line(RED, 650)] })).status, 201);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from case_week_sources`)).rows[0].n, 0);
  w20 = (await week(2025, 20)).body;
  assert.equal(w20.manualStatus, "entered");
  assert.equal(w20.totals.shippedCases, 650);

  // A colour sync bringing totals back for range weeks changes nothing.
  await db.query(`insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values ($1, 'red', 2025, 12, 500, 5.15, 2575, 'docklink')`, [ORG]);
  const w12 = (await week(2025, 12)).body;
  assert.equal(w12.source, "manual");
  assert.equal(w12.totals.shippedCases, 0);
  assert.equal(w12.manualStatus, "not_entered");

  // Confirmed zero vs not entered, over the whole range.
  assert.equal((await call("/case-week-confirmations", { method: "PUT", body: { isoYear: 2025, isoWeek: 11 } })).status, 200);
  const y = (await call("/shipped-yield?fromYear=2025&fromWeek=10&toYear=2025&toWeek=20")).body;
  assert.equal(y.weeks.length, 11, "every week of the range is listed, entered or not");
  assert.equal(y.totals.shippedCases, 650);
  assert.equal(y.totals.weeksNotEntered, 9);
  assert.equal(y.totals.weeksConfirmed, 1);
  assert.equal(y.totals.complete, false);
  const ranges = (await call("/case-rebuild-ranges")).body.ranges;
  assert.deepEqual([ranges[0].entered, ranges[0].confirmed, ranges[0].notEntered], [1, 1, 9]);

  // Deleting the last entry keeps the week manual (not entered yet), never colour totals.
  const [entry] = (await week(2025, 20)).body.manualEntries;
  assert.equal((await call(`/manual-pack-entries/${entry.id}`, { method: "DELETE" })).status, 200);
  w20 = (await week(2025, 20)).body;
  assert.equal(w20.source, "manual");
  assert.equal(w20.manualStatus, "not_entered");
  assert.equal(w20.notCounted.legacyCases, 800);

  // Per-week choices can't override the range; ranges can't overlap each other or DockLink's scope.
  const choice = await call("/case-week-sources", { method: "PUT", body: { isoYear: 2025, isoWeek: 15, source: "legacy_colours" } });
  assert.equal(choice.status, 409);
  assert.equal(choice.body.code, "in_rebuild_range");
  assert.equal((await call("/case-rebuild-ranges", { body: { fromIsoYear: 2025, fromIsoWeek: 18, toIsoYear: 2025, toIsoWeek: 30 } })).body.code, "range_overlap");
  assert.equal((await call("/case-rebuild-ranges", { body: { fromIsoYear: 2026, fromIsoWeek: 40, toIsoYear: 2026, toIsoWeek: 45 } })).body.code, "docklink_scope_overlap");
  assert.equal((await call("/case-rebuild-ranges", { body: { fromIsoYear: 2026, fromIsoWeek: 40, toIsoYear: 2026, toIsoWeek: 44 } })).status, 201, "up to the transition week is fine");
  assert.equal((await call("/case-rebuild-ranges", { body: { fromIsoYear: 2025, fromIsoWeek: 30, toIsoYear: 2025, toIsoWeek: 21 } })).status, 400);

  // Extending the range is an edit; removing it is explicit, and its weeks return to their own rules.
  const id = ranges[0].id;
  assert.equal((await call(`/case-rebuild-ranges/${id}`, { method: "PUT", body: { toIsoWeek: 22 } })).body.range.weeks, 13);
  assert.equal((await call(`/case-rebuild-ranges/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await week(2025, 20)).body.source, "legacy");
  assert.equal((await week(2025, 12)).body.source, "legacy");
});

test("a DockLink scope that later moves back over a rebuild range wins there, and the range's entries are kept", async () => {
  scoped(47, 48);
  await sync();
  assert.equal((await call("/case-rebuild-ranges", { body: { fromIsoYear: 2026, fromIsoWeek: 40, toIsoYear: 2026, toIsoWeek: 46 } })).status, 201);
  assert.equal((await add({ isoYear: 2026, isoWeek: 46, lines: [line(RED, 33)] })).status, 201);
  scoped(45, 48);
  await sync();
  const w46 = (await week(2026, 46)).body;
  assert.equal(w46.source, "packs");
  assert.notEqual(w46.rebuildRange, null, "W46 is still inside the rebuild range");
  assert.equal(w46.notCounted.manualCases, 33);
  const [range] = (await call("/case-rebuild-ranges")).body.ranges;
  assert.equal(range.docklinkWeeks, 2);
  scoped(47, 48);
  await sync();
  assert.equal((await week(2026, 46)).body.totals.shippedCases, 33);
});

test("confirmations only apply to manual weeks", async () => {
  await sync();
  assert.equal((await call("/case-week-confirmations", { method: "PUT", body: { isoYear: 2026, isoWeek: 44 } })).body.code, "not_a_manual_week");
  assert.equal((await call("/case-week-confirmations", { method: "PUT", body: { isoYear: 2026, isoWeek: 46 } })).body.code, "docklink_owned_week");
  const viewer = await call("/case-rebuild-ranges", { user: VIEWER, body: { fromIsoYear: 2025, fromIsoWeek: 1, toIsoYear: 2025, toIsoWeek: 2 } });
  assert.equal(viewer.status, 403);
  assert.equal((await call("/case-rebuild-ranges", { user: VIEWER })).status, 200);
  const other = await call("/case-rebuild-ranges", { org: OTHER_ORG });
  assert.deepEqual(other.body.ranges, []);
});
