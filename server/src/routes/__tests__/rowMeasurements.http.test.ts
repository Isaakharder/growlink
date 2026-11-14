// Setup → Map row measurements over HTTP (migration 0157, preview): the
// baseline is copied exactly from Greenhouse Setup (per-row differences kept,
// section fallback, missing flagged; the map drawing never used), rows keep
// their ids, moving a row on the map changes nothing measured, and resizing or
// adding rows for a future season changes neither today's nor past figures.
// The real routers run on PGlite with 0148-0150 and 0155-0157 applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/rowMeasurements.http.test.ts
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
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const VIEWER = "aaaaaaaa-0000-4000-8000-00000000000b";
const CAD = "b0000000-0000-4000-8000-000000000001";
const CAD27 = "b0000000-0000-4000-8000-000000000002";
const P1 = "d0000000-0000-4000-8000-000000000001";
const P2 = "d0000000-0000-4000-8000-000000000002";
const S1 = "e0000000-0000-4000-8000-000000000001"; // Phase 1 rows 1-4: 1.61 x 58.52
const S2 = "e0000000-0000-4000-8000-000000000002"; // Phase 2 rows 1-4: 1.6 x 91.44
const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");
const M0157 = migration("0157_row_measurements.sql");

let db: PGlite;
let server: Server;
let baseUrl: string;

async function resetDatabase() {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '');
    insert into organizations (id) values ('${ORG}'), ('${OTHER_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${OTHER_ORG}', 'owner', '{}'),
      ('${VIEWER}', '${ORG}', 'member', '{"greenhouse_setup:view": true}');
    create table varieties (id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 double precision not null default 0, case_kg double precision not null default 0, planting_date date, pull_out_date date,
      status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red', organization_id uuid not null references organizations(id), constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, organization_id) values ('${CAD}', 'Cadalora', '${ORG}'), ('${CAD27}', 'Cadalora 2027', '${ORG}');
    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null, variety_id uuid not null references varieties(id), size_kg jsonb not null default '{}');
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), variety_id uuid not null references varieties(id));
    create table waste_imports (id uuid primary key default gen_random_uuid(), variety_id uuid);
    create table greenhouse_groups (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      type text not null, name text not null, status text not null default 'active', created_at timestamptz default now(), updated_at timestamptz default now());
    create table greenhouse_row_sections (id uuid primary key default gen_random_uuid(), organization_id uuid not null, group_id uuid,
      start_row int, end_row int, row_pattern text, slab_count int, plants_per_slab int, stems_per_plant numeric,
      width_meters numeric, length_meters numeric, created_at timestamptz default now(), updated_at timestamptz default now());
    create table greenhouse_rows (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, row_number int not null,
      slab_count int not null default 0, plants_per_slab int not null default 0, stems_per_plant numeric not null default 1,
      section_id uuid, width_meters numeric, length_meters numeric, updated_at timestamptz default now(), unique (group_id, row_number));
    create table greenhouse_variety_assignments (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, variety_id uuid not null references varieties(id),
      start_row int not null, end_row int not null, assignment_pattern text, created_at timestamptz not null default now());
    insert into greenhouse_groups (id, organization_id, type, name) values ('${P1}', '${ORG}', 'phase', 'Phase 1'), ('${P2}', '${ORG}', 'phase', 'Phase 2');
    insert into greenhouse_row_sections (id, organization_id, group_id, start_row, end_row, width_meters, length_meters) values
      ('${S1}', '${ORG}', '${P1}', 1, 4, 1.61, 58.52), ('${S2}', '${ORG}', '${P2}', 1, 4, 1.6, 91.44);
    -- Phase 1: rows 1-3 own size = section; row 4 own 1.57 (differs from its section).
    -- Phase 2: row 1 own 91.43 (differs); row 2 has no own size (section fallback); rows 3-4 own = section.
    -- Phase 2 row 5: no own size and no section (missing).
    insert into greenhouse_rows (id, organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant, section_id, width_meters, length_meters) values
      ('c0000000-0000-4000-8000-000000000101', '${ORG}', '${P1}', 1, 106, 3, 2, '${S1}', 1.61, 58.52),
      ('c0000000-0000-4000-8000-000000000102', '${ORG}', '${P1}', 2, 106, 3, 2, '${S1}', 1.61, 58.52),
      ('c0000000-0000-4000-8000-000000000103', '${ORG}', '${P1}', 3, 106, 3, 2, '${S1}', 1.61, 58.52),
      ('c0000000-0000-4000-8000-000000000104', '${ORG}', '${P1}', 4, 106, 3, 2, '${S1}', 1.57, 58.52),
      ('c0000000-0000-4000-8000-000000000201', '${ORG}', '${P2}', 1, 166, 3, 2, '${S2}', 1.6, 91.43),
      ('c0000000-0000-4000-8000-000000000202', '${ORG}', '${P2}', 2, 166, 3, 2, '${S2}', null, null),
      ('c0000000-0000-4000-8000-000000000203', '${ORG}', '${P2}', 3, 166, 3, 2, '${S2}', 1.6, 91.44),
      ('c0000000-0000-4000-8000-000000000204', '${ORG}', '${P2}', 4, 166, 3, 2, '${S2}', 1.6, 91.44),
      ('c0000000-0000-4000-8000-000000000205', '${ORG}', '${P2}', 5, 166, 3, 2, null, null, null);
  `);
  for (const name of ["0148_product_catalog.sql", "0149_cucumber_product.sql", "0150_varieties_product_required.sql", "0155_greenhouse_maps.sql", "0156_dated_plantings.sql"]) {
    await db.exec(migration(name));
  }
  await db.exec(M0157);
  // The imported drawing: Phase 1 drawn at LabourLink's 5.28 ft x 192 ft (row 4 drawn too wide), Phase 2 at 5.25 x 300, row 5 not on the map.
  await db.exec(`
    insert into greenhouse_maps (id, organization_id, name, east_west_feet, north_south_feet, source) values ('f0000000-0000-4000-8000-000000000001', '${ORG}', 'Imported', 1000, 1000, 'labourlink_import');
    insert into greenhouse_map_phases (map_id, organization_id, group_id, x_feet_from_west, y_feet_from_north, east_west_feet, north_south_feet) values
      ('f0000000-0000-4000-8000-000000000001', '${ORG}', '${P1}', 0, 0, 300, 300), ('f0000000-0000-4000-8000-000000000001', '${ORG}', '${P2}', 400, 0, 300, 400);
    insert into greenhouse_map_rows (map_id, organization_id, group_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
      select 'f0000000-0000-4000-8000-000000000001', '${ORG}', '${P1}', n, 10, n * 10, 5.28, 192, 'horizontal' from generate_series(1, 4) n;
    insert into greenhouse_map_rows (map_id, organization_id, group_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
      select 'f0000000-0000-4000-8000-000000000001', '${ORG}', '${P2}', n, n * 10, 10, 5.25, 300, 'vertical' from generate_series(1, 4) n;
  `);
}

before(async () => {
  // The future-season tests run with future-dated sizes on; one test turns them off.
  process.env.ROW_SIZES_FUTURE_DATES = "on";
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as unknown as Record<string | symbol, unknown>)[prop] });
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { rowMeasurementsRouter } = require("../rowMeasurements") as typeof import("../rowMeasurements");
  const { datedPlantingsRouter } = require("../datedPlantings") as typeof import("../datedPlantings");
  const { greenhouseSetupRouter } = require("../greenhouseSetup") as typeof import("../greenhouseSetup");
  const { greenhouseMapRouter } = require("../greenhouseMap") as typeof import("../greenhouseMap");
  const { yieldEntriesRouter } = require("../yieldEntries") as typeof import("../yieldEntries");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", rowMeasurementsRouter);
  app.use("/api", datedPlantingsRouter);
  app.use("/api", greenhouseSetupRouter);
  app.use("/api", greenhouseMapRouter);
  app.use("/api", yieldEntriesRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(async () => {
  await resetDatabase();
});

type Opts = { user?: string; org?: string; body?: unknown; method?: string };
async function call(pathname: string, { user = OWNER, org = ORG, body, method }: Opts = {}) {
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-test-user": user, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const rowsFingerprint = async () =>
  (await db.query<{ f: string }>("select md5(string_agg(id || '|' || group_id || '|' || row_number || '|' || coalesce(width_meters::text,'') || '|' || coalesce(length_meters::text,'') || '|' || slab_count || '|' || plants_per_slab || '|' || stems_per_plant, ',' order by id)) f from greenhouse_rows")).rows[0].f;
const measuredOn = async (date: string) =>
  (await db.query<{ r: any }>(`select row_measurements_on('${ORG}', '${date}') r`)).rows[0].r.map((m: any) => [m.row_number, Number(m.width_m), Number(m.length_m)]);
const today = async () => (await call("/setup/map/measurements")).body.today as string;
const ROW = (id: string) => `c0000000-0000-4000-8000-000000000${id}`;

test("0157: RLS on with no policies, service role only, safe to re-run", async () => {
  const r = await db.query<{ rls: boolean; policies: number }>(
    `select relrowsecurity as rls, (select count(*)::int from pg_policies where tablename = 'greenhouse_row_measurements') as policies from pg_class where oid = 'public.greenhouse_row_measurements'::regclass`
  );
  assert.deepEqual(r.rows[0], { rls: true, policies: 0 });
  await db.exec(M0157);
});

test("copy: each row's exact Greenhouse Setup size, per-row differences kept, section fallback, missing flagged; same row ids; nothing else changes", async () => {
  const rowsBefore = await rowsFingerprint();
  const reportBefore = (await call("/setup/map/measurements/report")).body;
  assert.equal(reportBefore.total.not_copied, 9);

  const copied = await call("/setup/map/measurements/copy", { body: {} });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.deepEqual(copied.body, { copied_from_row: 7, copied_from_section: 1, missing: 1 });
  // Safe to run again.
  assert.deepEqual((await call("/setup/map/measurements/copy", { body: {} })).body, { copied_from_row: 0, copied_from_section: 0, missing: 0 });
  assert.equal(await rowsFingerprint(), rowsBefore, "greenhouse_rows (ids, phases, numbers, sizes, inputs) unchanged");

  const exact = await db.query<{ row_id: string; w: string | null; l: string | null; source: string }>(
    "select row_id, width_m::text w, length_m::text l, source from greenhouse_row_measurements order by row_id"
  );
  assert.deepEqual(
    exact.rows.map((r) => [r.row_id.slice(-3), r.w, r.l, r.source]),
    [
      ["101", "1.61", "58.52", "greenhouse_setup_row"],
      ["102", "1.61", "58.52", "greenhouse_setup_row"],
      ["103", "1.61", "58.52", "greenhouse_setup_row"],
      ["104", "1.57", "58.52", "greenhouse_setup_row"],
      ["201", "1.6", "91.43", "greenhouse_setup_row"],
      ["202", "1.6", "91.44", "greenhouse_setup_section"],
      ["203", "1.6", "91.44", "greenhouse_setup_row"],
      ["204", "1.6", "91.44", "greenhouse_setup_row"],
      ["205", null, null, "missing"]
    ]
  );

  const report = (await call("/setup/map/measurements/report")).body;
  assert.equal(report.total.area_changed, 0, "every row's area is the same before and after");
  assert.equal(report.total.area_before_m2, report.total.area_after_m2);
  assert.equal(report.total.missing, 1);
  assert.deepEqual(
    report.phases.map((p: any) => [p.phase, p.rows, p.area_before_m2 === p.area_after_m2, p.missing, p.differs_from_section, p.drawing_differs, p.not_on_map]),
    [
      ["Phase 1", 4, true, 0, 1, 1, 0],
      ["Phase 2", 5, true, 1, 1, 0, 1]
    ]
  );
  const flags = Object.fromEntries(report.rows.map((r: any) => [`${r.phase} ${r.row_number}`, r.flags]));
  assert.deepEqual(flags["Phase 1 4"], ["row differs from its section (row's own size kept)", "map drawing differs (drawing not used)"]);
  assert.deepEqual(flags["Phase 2 1"], ["row differs from its section (row's own size kept)"]);
  assert.deepEqual(flags["Phase 2 2"], ["copied from section (row has no own size)"]);
  assert.deepEqual(flags["Phase 2 5"], ["missing measurement", "not on the map"]);
  const csv = await call("/setup/map/measurements/report?format=csv");
  assert.match(String(csv.body), /^phase,row_number,row_id,setup_width_m/);
  assert.equal(String(csv.body).trim().split("\n").length, 10);
});

test("moving or redrawing a row on the map changes only its position", async () => {
  await call("/setup/map/measurements/copy", { body: {} });
  const before = await db.query("select row_id, width_m, length_m, effective_from from greenhouse_row_measurements order by row_id");
  const map = (await call("/greenhouse-map")).body.map;
  // Move every Phase 1 row and redraw them at a different size.
  for (const p of map.phases) for (const r of p.rows) if (p.group_id === P1) Object.assign(r, { x_ft: r.x_ft + 20, length_ft: 150 });
  const saved = await call("/greenhouse-map", { method: "PUT", body: { map, expected_updated_at: map.updated_at } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = await db.query("select row_id, width_m, length_m, effective_from from greenhouse_row_measurements order by row_id");
  assert.deepEqual(after.rows, before.rows);
});

test("resizing for a future season keeps today's and past sizes; a resize from today updates the mirror", async () => {
  await call("/setup/map/measurements/copy", { body: {} });
  const t = await today();
  const season = addDays(t, 25);
  const rowsBefore = await rowsFingerprint();
  const todaySizes = await measuredOn(t);

  const future = await call("/setup/map/measurements", { method: "PUT", body: { effective_from: season, rows: [{ row_id: ROW("201"), width_m: 1.6, length_m: 100.58 }] } });
  assert.equal(future.status, 200, JSON.stringify(future.body));
  assert.deepEqual(await measuredOn(t), todaySizes, "today unchanged");
  assert.deepEqual(await measuredOn(addDays(t, -400)), todaySizes, "the past unchanged");
  assert.deepEqual((await measuredOn(season)).find((r: any) => r[0] === 1 && r[2] !== 58.52), [1, 1.6, 100.58]);
  assert.equal(await rowsFingerprint(), rowsBefore, "the mirror isn't touched by a future change");

  // Plants: today's totals unchanged, the season's area changes, plants and heads don't.
  const cad = (await call("/crop-planner/dated-plantings", { body: { variety_id: CAD, planting_date: addDays(t, -300), pull_out_date: addDays(t, 20) } })).body.id;
  assert.equal((await call(`/crop-planner/dated-plantings/${cad}/rows`, { method: "PUT", body: { rows: [{ group_id: P2, row_number: 1 }] } })).status, 200);
  const nxt = (await call("/crop-planner/dated-plantings", { body: { variety_id: CAD27, planting_date: season } })).body.id;
  assert.equal((await call(`/crop-planner/dated-plantings/${nxt}/rows`, { method: "PUT", body: { rows: [{ group_id: P2, row_number: 1 }] } })).status, 200);
  const onToday = (await call(`/crop-planner/dated-plantings/on?date=${t}`)).body.totals;
  const onSeason = (await call(`/crop-planner/dated-plantings/on?date=${season}`)).body.totals;
  assert.deepEqual(onToday.map((x: any) => [x.variety_id, Math.round(x.m2 * 1000) / 1000, x.plants, x.heads]), [[CAD, Math.round(1.6 * 91.43 * 1000) / 1000, 498, 996]]);
  assert.deepEqual(onSeason.map((x: any) => [x.variety_id, Math.round(x.m2 * 1000) / 1000, x.plants, x.heads]), [[CAD27, Math.round(1.6 * 100.58 * 1000) / 1000, 498, 996]]);
  const greenhouseRow = (await call("/crop-planner/dated-plantings")).body.rows.find((r: any) => r.group_id === P2 && r.row_number === 1);
  assert.deepEqual(greenhouseRow.measurements.map((m: any) => [m.effective_from, m.length_m]), [[null, 91.43], [season, 100.58]]);

  // A resize that applies from today updates the mirror; yesterday keeps the old size.
  assert.equal((await call("/setup/map/measurements", { method: "PUT", body: { effective_from: t, rows: [{ row_id: ROW("101"), width_m: 1.6, length_m: 58 }] } })).status, 200);
  const mirror = await db.query<{ w: string; l: string }>(`select width_meters::text w, length_meters::text l from greenhouse_rows where id = '${ROW("101")}'`);
  assert.deepEqual(mirror.rows[0], { w: "1.6", l: "58" });
  assert.deepEqual((await measuredOn(addDays(t, -1))).find((r: any) => r[0] === 1), [1, 1.61, 58.52]);
});

test("history can't be rewritten: a new size must start after the row's latest; versions can't be edited", async () => {
  await call("/setup/map/measurements/copy", { body: {} });
  const t = await today();
  await call("/setup/map/measurements", { method: "PUT", body: { effective_from: addDays(t, 30), rows: [{ row_id: ROW("203"), width_m: 1.6, length_m: 95 }] } });
  const early = await call("/setup/map/measurements", { method: "PUT", body: { effective_from: addDays(t, 10), rows: [{ row_id: ROW("203"), width_m: 1.6, length_m: 96 }] } });
  assert.equal(early.status, 400);
  assert.deepEqual(early.body.rowsWithLaterSize, [{ row_id: ROW("203"), latest: addDays(t, 30) }]);
  await assert.rejects(db.query(`update greenhouse_row_measurements set length_m = 10 where row_id = '${ROW("203")}'`), (e: any) => e.code === "23514");
  // Invalid sizes are refused.
  assert.equal((await call("/setup/map/measurements", { method: "PUT", body: { effective_from: addDays(t, 40), rows: [{ row_id: ROW("203"), width_m: 0, length_m: 95 }] } })).status, 400);
});

test("new rows for a future season exist only from their date: not counted today, not linkable before it", async () => {
  await call("/setup/map/measurements/copy", { body: {} });
  const t = await today();
  const season = addDays(t, 25);
  const todaySizes = await measuredOn(t);
  const added = await call("/setup/map/rows", { body: { group_id: P1, from_row: 5, to_row: 6, width_m: 1.61, length_m: 58.52, slab_count: 106, plants_per_slab: 3, stems_per_plant: 2, effective_from: season } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const created = await db.query<{ row_number: number; width_meters: string | null }>(`select row_number, width_meters from greenhouse_rows where group_id = '${P1}' and row_number >= 5 order by row_number`);
  assert.deepEqual(created.rows.map((r) => [r.row_number, r.width_meters]), [[5, null], [6, null]], "the mirror stays empty until the rows exist");
  assert.deepEqual(await measuredOn(t), todaySizes, "today's sizes don't include them");
  assert.equal((await measuredOn(season)).length, todaySizes.length + 2);
  // Existing row numbers are refused.
  assert.equal((await call("/setup/map/rows", { body: { group_id: P1, from_row: 4, to_row: 5, width_m: 1.6, length_m: 58, effective_from: season } })).status, 409);

  const early = (await call("/crop-planner/dated-plantings", { body: { variety_id: CAD27, planting_date: addDays(t, 5) } })).body.id;
  const refused = await call(`/crop-planner/dated-plantings/${early}/rows`, { method: "PUT", body: { rows: [{ group_id: P1, row_number: 5 }] } });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.rowsNotYetBuilt, [{ group_id: P1, row_number: 5, available_from: season }]);
  const onTime = (await call("/crop-planner/dated-plantings", { body: { variety_id: CAD, planting_date: season } })).body.id;
  assert.equal((await call(`/crop-planner/dated-plantings/${onTime}/rows`, { method: "PUT", body: { rows: [{ group_id: P1, row_number: 5 }, { group_id: P1, row_number: 6 }] } })).status, 200);
});

test("measured rows can't be deleted with their history; viewers read only; organizations are separate", async () => {
  await call("/setup/map/measurements/copy", { body: {} });
  const del = await call(`/greenhouse-row-sections/${S1}`, { method: "DELETE" });
  assert.equal(del.status, 409);
  assert.match(del.body.message, /history/);
  assert.equal((await db.query(`select 1 from greenhouse_rows where section_id = '${S1}'`)).rows.length, 4);
  await assert.rejects(db.query(`delete from greenhouse_rows where id = '${ROW("101")}'`), (e: any) => e.code === "23503");

  assert.equal((await call("/setup/map/measurements", { user: VIEWER })).status, 200);
  assert.equal((await call("/setup/map/measurements/copy", { user: VIEWER, body: {} })).status, 403);
  const t = await today();
  assert.equal((await call("/setup/map/measurements", { user: VIEWER, method: "PUT", body: { effective_from: t, rows: [] } })).status, 403);

  const other = (await call("/setup/map/measurements", { org: OTHER_ORG })).body;
  assert.deepEqual(other.rows, []);
  const cross = await call("/setup/map/measurements", { org: OTHER_ORG, method: "PUT", body: { effective_from: addDays(t, 5), rows: [{ row_id: ROW("101"), width_m: 1, length_m: 1 }] } });
  assert.equal(cross.status, 400, "another organization's row is unknown there");
  assert.deepEqual(cross.body.unknownRows, [ROW("101")]);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from greenhouse_row_measurements where row_id = '${ROW("101")}'`)).rows[0].n, 1);
});

// ── Area and yield reports that used to read greenhouse_rows' size fields ───
import { physicalAreasByVariety } from "../../lib/croplinkV2";
// Loaded on use: the store imports the Supabase client, which before() replaces with PGlite.
const croplinkV2Store = {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  physicalAreas: (org: string) => (require("../croplinkV2Store") as typeof import("../croplinkV2Store")).supabaseCroplinkV2Store.physicalAreas(org)
};
const r3 = (n: number | null | undefined) => (n == null ? n : Math.round(n * 1000) / 1000);
const nextMonday = (iso: string, atLeastDays: number) => {
  let d = addDays(iso, atLeastDays);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
};
/** Moves the process clock to `iso` (still ticking), as if that day had come; returns the undo. */
function shiftClockTo(iso: string) {
  const RealDate = Date;
  const offset = new RealDate(iso).getTime() - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
const setupTotals = async () => {
  const body = (await call("/greenhouse-setup")).body;
  const rows = body.rows as Array<{ group_id: string; row_number: number; width_meters: number | null; length_meters: number | null }>;
  return {
    rowSizes: body.rowSizes,
    rows: rows.map((r) => `${r.group_id === P1 ? "P1" : "P2"}:${r.row_number}=${r.width_meters ?? "-"}x${r.length_meters ?? "-"}`).sort(),
    m2: r3(rows.reduce((t, r) => t + Number(r.width_meters ?? 0) * Number(r.length_meters ?? 0), 0))
  };
};

test("future-dated sizes are off unless ROW_SIZES_FUTURE_DATES=on; today and earlier always work", async () => {
  delete process.env.ROW_SIZES_FUTURE_DATES;
  try {
    await call("/setup/map/measurements/copy", { body: {} });
    const t = await today();
    assert.equal((await call("/setup/map/measurements")).body.future_dates_enabled, false);
    const resize = await call("/setup/map/measurements", { method: "PUT", body: { effective_from: addDays(t, 1), rows: [{ row_id: ROW("101"), width_m: 1.6, length_m: 60 }] } });
    assert.equal(resize.status, 403);
    assert.equal(resize.body.futureDatesDisabled, true);
    const add = await call("/setup/map/rows", { body: { group_id: P1, from_row: 9, to_row: 9, width_m: 1.6, length_m: 60, effective_from: addDays(t, 30) } });
    assert.equal(add.status, 403);
    assert.equal((await db.query("select 1 from greenhouse_row_measurements where effective_from > current_date")).rows.length, 0, "nothing future-dated was saved");
    assert.equal((await call("/setup/map/measurements", { method: "PUT", body: { effective_from: t, rows: [{ row_id: ROW("101"), width_m: 1.6, length_m: 60 }] } })).status, 200);
    assert.equal((await call("/setup/map/rows", { body: { group_id: P1, from_row: 9, to_row: 9, width_m: 1.6, length_m: 60, effective_from: t } })).status, 201);
  } finally {
    process.env.ROW_SIZES_FUTURE_DATES = "on";
  }
  assert.equal((await call("/setup/map/measurements")).body.future_dates_enabled, true);
});

test("area and yield reports use the size in effect on their own date, before and after a future resize takes effect", async () => {
  // Cadalora grows on Phase 2 rows 1-6 (row 6 is only added for next season).
  await db.exec(`insert into greenhouse_variety_assignments (organization_id, group_id, variety_id, start_row, end_row) values ('${ORG}', '${P2}', '${CAD}', 1, 6)`);
  const t = await today();
  const pastMonday = nextMonday(addDays(t, -200), 0);
  const season = nextMonday(t, 21);

  // Before the switch (no measurements): Greenhouse Setup's values.
  const legacy = await call("/yield-analytics/area-footprints");
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.measured, false);
  const cadBefore = physicalAreasByVariety(legacy.body).get(CAD);
  const setupBefore = await setupTotals();
  assert.equal(setupBefore.rowSizes.source, "greenhouse_setup");

  // The switch: identical figures.
  await call("/setup/map/measurements/copy", { body: {} });
  const copied = (await call("/yield-analytics/area-footprints")).body;
  assert.equal(copied.measured, true);
  assert.deepEqual(physicalAreasByVariety(copied).get(CAD), cadBefore, "yield analytics / CropLink area unchanged by the copy");
  assert.deepEqual(physicalAreasByVariety(copied, pastMonday).get(CAD), cadBefore);
  assert.deepEqual(physicalAreasByVariety(await croplinkV2Store.physicalAreas(ORG), pastMonday).get(CAD), cadBefore, "CropLink's store loads the same footprints");
  const setupCopied = await setupTotals();
  assert.deepEqual({ rows: setupCopied.rows, m2: setupCopied.m2 }, { rows: setupBefore.rows.map((r) => (r === "P2:2=-x-" ? "P2:2=1.6x91.44" : r)), m2: r3(setupBefore.m2! + 1.6 * 91.44) },
    "Greenhouse Setup shows the copied sizes (row 2 had no own size; it now shows its section's, which it already counted with)");
  assert.equal(setupCopied.rowSizes.source, "setup_map");

  // Next season: row 1 resized (91.43 -> 100.58 m) and row 6 added, both from a Monday.
  assert.equal((await call("/setup/map/measurements", { method: "PUT", body: { effective_from: season, rows: [{ row_id: ROW("201"), width_m: 1.6, length_m: 100.58 }] } })).status, 200);
  assert.equal((await call("/setup/map/rows", { body: { group_id: P2, from_row: 6, to_row: 6, width_m: 1.6, length_m: 91.44, slab_count: 166, plants_per_slab: 3, stems_per_plant: 2, effective_from: season } })).status, 201);
  const delta = 1.6 * (100.58 - 91.43) + 1.6 * 91.44;
  const mirrorBefore = await rowsFingerprint();

  const check = async (label: string) => {
    const f = (await call("/yield-analytics/area-footprints")).body;
    const store = await croplinkV2Store.physicalAreas(ORG);
    for (const src of [f, store]) {
      assert.deepEqual(physicalAreasByVariety(src, pastMonday).get(CAD), cadBefore, `${label}: a past week keeps its area`);
      assert.deepEqual(physicalAreasByVariety(src, addDays(season, -7)).get(CAD), cadBefore, `${label}: the week before the resize keeps its area`);
      const after = physicalAreasByVariety(src, season).get(CAD)!;
      assert.equal(r3(after.areaM2), r3(cadBefore!.areaM2! + delta), `${label}: from the resize week, the new sizes and the new row`);
      assert.equal(after.rowCount, cadBefore!.rowCount + 1);
    }
    return f;
  };

  // Before the resize takes effect: today's figures unchanged, the new row isn't in the greenhouse yet.
  const beforeEffect = await check("before it takes effect");
  assert.deepEqual(physicalAreasByVariety(beforeEffect).get(CAD), cadBefore, "today's area unchanged");
  const setupBeforeEffect = await setupTotals();
  assert.deepEqual({ rows: setupBeforeEffect.rows, m2: setupBeforeEffect.m2 }, { rows: setupCopied.rows, m2: setupCopied.m2 });
  assert.equal(setupBeforeEffect.rowSizes.upcomingRows, 1);

  // After it takes effect (the clock moved to the season's Monday): nothing rewrote greenhouse_rows,
  // yet every reader shows the new sizes from that date, and earlier weeks keep theirs.
  const restoreClock = shiftClockTo(`${season}T17:00:00Z`);
  try {
    assert.equal((await call("/setup/map/measurements")).body.today, season);
    const afterEffect = await check("after it takes effect");
    assert.equal(r3(physicalAreasByVariety(afterEffect).get(CAD)!.areaM2), r3(cadBefore!.areaM2! + delta), "today's area is the new one");
    const setupAfter = await setupTotals();
    assert.ok(setupAfter.rows.includes("P2:1=1.6x100.58") && setupAfter.rows.includes("P2:6=1.6x91.44"), JSON.stringify(setupAfter.rows));
    assert.equal(setupAfter.m2, r3(setupCopied.m2! + delta));
    assert.equal(setupAfter.rowSizes.upcomingRows, 0);
    assert.equal(await rowsFingerprint(), mirrorBefore, "greenhouse_rows (the old size fields) was never rewritten; no reader depends on it");
  } finally {
    restoreClock();
  }
});

test("Greenhouse Setup can't overwrite measured sizes: section saves keep each row's own measurement; row edits point to Setup → Map", async () => {
  await call("/setup/map/measurements/copy", { body: {} });
  const sizes = async () => (await db.query<{ n: number; w: string | null; l: string | null; s: number }>(`select row_number n, width_meters::text w, length_meters::text l, slab_count s from greenhouse_rows where group_id = '${P2}' order by row_number`)).rows;
  const before = await sizes();
  // Saving Phase 2's section with a 100.58 m length (the kind of mismatch First Light has) and new slab counts.
  const saved = await call(`/greenhouse-row-sections/${S2}`, {
    method: "PUT",
    body: { group_id: P2, start_row: 1, end_row: 4, row_pattern: "all", slab_count: 170, plants_per_slab: 3, stems_per_plant: 2, width_meters: 1.6, length_meters: 100.58 }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = await sizes();
  assert.deepEqual(after.filter((r) => r.n <= 4).map((r) => [r.n, r.w, r.l, r.s]), before.filter((r) => r.n <= 4).map((r) => [r.n, r.w, r.l, 170]), "sizes kept, other inputs saved");
  assert.deepEqual((await measuredOn(await today())).filter((r: any) => r[2] > 91.44), [], "no measurement changed");

  const resize = await call(`/greenhouse-rows/${ROW("201")}`, { method: "PUT", body: { row_number: 1, slab_count: 166, plants_per_slab: 3, stems_per_plant: 2, width_meters: 1.6, length_meters: 100.58 } });
  assert.equal(resize.status, 409);
  assert.match(resize.body.message, /Setup → Map/);
  const inputs = await call(`/greenhouse-rows/${ROW("201")}`, { method: "PUT", body: { row_number: 1, slab_count: 160, plants_per_slab: 3, stems_per_plant: 2, width_meters: 1.6, length_meters: 91.43 } });
  assert.equal(inputs.status, 200, JSON.stringify(inputs.body));
  assert.equal(inputs.body.slab_count, 160);
});
