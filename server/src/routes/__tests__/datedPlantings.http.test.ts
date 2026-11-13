// Dated plantings over HTTP (migration 0156, preview): one row can carry this
// year's crop and next year's crop, today's counts see only what is in the
// ground today, a past date still sees what was in the ground then, and
// overlaps are refused with the rows listed — nothing is ended or replaced
// silently. The real router runs on PGlite with 0148-0150 and 0156 applied
// verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/datedPlantings.http.test.ts
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
const OTHER_VARIETY = "b0000000-0000-4000-8000-000000000009";
const P1 = "d0000000-0000-4000-8000-000000000001";
const OTHER_PHASE = "d0000000-0000-4000-8000-000000000009";

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");
const M0156 = migration("0156_dated_plantings.sql");

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
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${OTHER_ORG}', 'owner', '{}'),
      ('${VIEWER}', '${ORG}', 'member', '{"greenhouse_setup:view": true}');
    create table varieties (
      id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 double precision not null default 0, case_kg double precision not null default 0,
      planting_date date, pull_out_date date,
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red' check (color in ('red', 'orange', 'yellow', 'green')),
      organization_id uuid not null references organizations(id),
      constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, organization_id) values
      ('${CAD}', 'Cadalora', '${ORG}'), ('${CAD27}', 'Cadalora 2027', '${ORG}'), ('${OTHER_VARIETY}', 'Foxtrot', '${OTHER_ORG}');
    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      variety_id uuid not null references varieties(id), size_kg jsonb not null default '{}');
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), variety_id uuid not null references varieties(id));
    create table waste_imports (id uuid primary key default gen_random_uuid(), variety_id uuid);
    create table greenhouse_groups (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      type text not null, name text not null, status text not null default 'active', created_at timestamptz default now(), updated_at timestamptz default now());
    create table greenhouse_row_sections (id uuid primary key default gen_random_uuid(), organization_id uuid not null, width_meters numeric, length_meters numeric);
    create table greenhouse_rows (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, row_number int not null,
      slab_count int not null default 0, plants_per_slab int not null default 0, stems_per_plant numeric not null default 1,
      section_id uuid, width_meters numeric, length_meters numeric, unique (group_id, row_number));
    create table greenhouse_variety_assignments (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, variety_id uuid not null references varieties(id),
      start_row int not null, end_row int not null, assignment_pattern text, created_at timestamptz not null default now());
    insert into greenhouse_groups (id, organization_id, type, name) values
      ('${P1}', '${ORG}', 'phase', 'Phase 1'), ('${OTHER_PHASE}', '${OTHER_ORG}', 'phase', 'Phase 1');
    -- 10 rows of 100 m², 106 slabs x 3 plants, 2 heads per plant
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant, width_meters, length_meters)
      select '${ORG}', '${P1}', n, 106, 3, 2, 1.6, 62.5 from generate_series(1, 10) n;
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab, width_meters, length_meters)
      select '${OTHER_ORG}', '${OTHER_PHASE}', n, 50, 2, 2, 50 from generate_series(1, 3) n;
    -- What Greenhouse Setup says today; plantings must never touch it.
    insert into greenhouse_variety_assignments (organization_id, group_id, variety_id, start_row, end_row, assignment_pattern)
      values ('${ORG}', '${P1}', '${CAD}', 1, 10, 'all');
  `);
  for (const name of ["0148_product_catalog.sql", "0149_cucumber_product.sql", "0150_varieties_product_required.sql"]) await db.exec(migration(name));
  await db.exec(M0156);
}

before(async () => {
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as unknown as Record<string | symbol, unknown>)[prop] });
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { datedPlantingsRouter } = require("../datedPlantings") as typeof import("../datedPlantings");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", datedPlantingsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());
beforeEach(async () => {
  await resetDatabase();
});

type Opts = { user?: string; org?: string; body?: unknown; method?: string };
async function call(pathname: string, { user = OWNER, org = ORG, body, method }: Opts = {}) {
  const res = await fetch(`${baseUrl}/api/crop-planner${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-test-user": user, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}
const rows = (from: number, to: number, group = P1) => Array.from({ length: to - from + 1 }, (_, i) => ({ group_id: group, row_number: from + i }));

async function addPlanting(variety_id: string, planting_date: string, pull_out_date: string | null = null) {
  const res = await call("/dated-plantings", { body: { variety_id, planting_date, pull_out_date } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}
const saveRows = (id: string, list: unknown[]) => call(`/dated-plantings/${id}/rows`, { method: "PUT", body: { rows: list } });
const on = (date: string) => call(`/dated-plantings/on?date=${date}`);
const assignmentsFingerprint = async () =>
  (await db.query<{ f: string }>("select md5(string_agg(t::text, '|' order by id)) f from greenhouse_variety_assignments t")).rows[0].f;

test("0156: RLS on with no policies, service role only, safe to re-run", async () => {
  for (const table of ["plantings", "planting_rows"]) {
    const r = await db.query<{ rls: boolean; policies: number }>(
      `select relrowsecurity as rls, (select count(*)::int from pg_policies where tablename = $1) as policies from pg_class where oid = ('public.' || $1)::regclass`,
      [table]
    );
    assert.deepEqual(r.rows[0], { rls: true, policies: 0 });
  }
  await db.exec(M0156);
});

test("one row carries this year's crop and next year's crop; today's counts see only today's", async () => {
  const before = await assignmentsFingerprint();
  const thisYear = await addPlanting(CAD, "2025-12-15");
  assert.equal((await saveRows(thisYear, rows(1, 8))).status, 200);

  // Next year's crop on the same rows while this year's has no pull-out date: refused, rows listed.
  const nextYear = await addPlanting(CAD27, "2026-12-08");
  const refused = await saveRows(nextYear, rows(1, 8));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.conflicts.length, 8);
  assert.deepEqual(
    { ...refused.body.conflicts[0], group_id: undefined },
    { group_id: undefined, row_number: 1, planting_id: thisYear, variety_id: CAD, variety_name: "Cadalora", planting_date: "2025-12-15", pull_out_date: null }
  );
  // Nothing was ended or saved.
  let all = await call("/dated-plantings");
  assert.equal(all.body.plantings.find((p: any) => p.id === thisYear).pull_out_date, null);
  assert.deepEqual(all.body.plantings.find((p: any) => p.id === nextYear).rows, []);

  // The person sets this year's pull-out date; now next year's crop fits on the same rows.
  assert.equal((await call(`/dated-plantings/${thisYear}`, { method: "PUT", body: { pull_out_date: "2026-11-27" } })).status, 200);
  assert.equal((await saveRows(nextYear, rows(1, 8))).status, 200);
  all = await call("/dated-plantings");
  assert.deepEqual(all.body.plantings.map((p: any) => [p.id, p.rows.length]), [[thisYear, 8], [nextYear, 8]]);

  // Today (Nov 13, 2026): only this year's crop. 8 rows, 800 m², 2,544 plants, 5,088 heads.
  const today = await on("2026-11-13");
  assert.deepEqual(today.body.totals, [{ variety_id: CAD, rows: 8, m2: 800, plants: 2544, heads: 5088, rows_missing_inputs: 0 }]);
  assert.ok(today.body.rows.every((r: any) => r.planting_id === thisYear));
  // Last day of this year's crop, first day of next year's.
  assert.deepEqual((await on("2026-11-27")).body.totals.map((t: any) => t.variety_id), [CAD]);
  assert.deepEqual((await on("2026-11-28")).body.totals, []);
  assert.deepEqual((await on("2026-12-08")).body.totals.map((t: any) => [t.variety_id, t.rows]), [[CAD27, 8]]);
  // A historical date keeps its original planting.
  assert.deepEqual((await on("2026-03-01")).body.totals.map((t: any) => [t.variety_id, t.rows]), [[CAD, 8]]);
  // Without a date it uses the organization's today.
  const live = await on("");
  assert.equal(live.body.date, live.body.today);

  assert.equal(await assignmentsFingerprint(), before, "greenhouse_variety_assignments untouched");
});

test("overlapping dates are refused with the rows listed; nothing changes", async () => {
  const thisYear = await addPlanting(CAD, "2025-12-15", "2026-11-27");
  await saveRows(thisYear, rows(1, 8));
  const nextYear = await addPlanting(CAD27, "2026-12-08");
  await saveRows(nextYear, rows(1, 8));

  // Moving next year's planting date into this year's season.
  const early = await call(`/dated-plantings/${nextYear}`, { method: "PUT", body: { planting_date: "2026-11-20" } });
  assert.equal(early.status, 409);
  assert.equal(early.body.conflicts.length, 8);
  // Clearing this year's pull-out date would make it run into next year's.
  const open = await call(`/dated-plantings/${thisYear}`, { method: "PUT", body: { pull_out_date: null } });
  assert.equal(open.status, 409);
  const all = await call("/dated-plantings");
  assert.deepEqual(all.body.plantings.map((p: any) => [p.planting_date, p.pull_out_date]), [["2025-12-15", "2026-11-27"], ["2026-12-08", null]]);
  // Same-day handover counts as an overlap (both dates inclusive).
  const sameDay = await addPlanting(CAD27, "2026-11-27");
  assert.equal((await saveRows(sameDay, rows(9, 10))).status, 200, "rows 9-10 are free");
  assert.equal((await saveRows(sameDay, rows(8, 10))).status, 409);
});

test("Save rows replaces the selection all-or-nothing; rows off Greenhouse Setup are refused", async () => {
  const p = await addPlanting(CAD, "2025-12-15");
  await saveRows(p, rows(1, 6));
  assert.equal((await saveRows(p, rows(3, 9))).status, 200);
  let all = await call("/dated-plantings");
  assert.deepEqual(all.body.plantings[0].rows.map((r: any) => r.row_number), [3, 4, 5, 6, 7, 8, 9]);

  const missing = await saveRows(p, [...rows(1, 2), { group_id: P1, row_number: 11 }]);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.rowsNotInSetup, [{ group_id: P1, row_number: 11 }]);
  all = await call("/dated-plantings");
  assert.deepEqual(all.body.plantings[0].rows.map((r: any) => r.row_number), [3, 4, 5, 6, 7, 8, 9], "unchanged");
});

test("the database refuses an overlap even without the route (concurrent saves)", async () => {
  const a = await addPlanting(CAD, "2025-12-15");
  await saveRows(a, rows(1, 2));
  const b = await addPlanting(CAD27, "2026-12-08");
  await assert.rejects(
    db.query(`insert into planting_rows (planting_id, organization_id, group_id, row_number) values ($1, $2, $3, 1)`, [b, ORG, P1]),
    (e: any) => e.code === "23P01"
  );
  await assert.rejects(db.query(`update plantings set pull_out_date = planting_date - 1 where id = $1`, [a]), (e: any) => e.code === "23514");
  // A date change straight in the database that would overlap is refused too.
  await db.query(`update plantings set pull_out_date = '2026-11-27' where id = $1`, [a]);
  assert.equal((await saveRows(b, rows(1, 2))).status, 200);
  await assert.rejects(db.query(`update plantings set planting_date = '2026-11-20' where id = $1`, [b]), (e: any) => e.code === "23P01");
  await assert.rejects(db.query(`update plantings set pull_out_date = null where id = $1`, [a]), (e: any) => e.code === "23P01");
});

test("each organization sees and changes only its own plantings; viewers read but don't write", async () => {
  const p = await addPlanting(CAD, "2025-12-15");
  await saveRows(p, rows(1, 2));
  assert.deepEqual((await call("/dated-plantings", { org: OTHER_ORG })).body.plantings, []);
  assert.equal((await call(`/dated-plantings/${p}`, { org: OTHER_ORG, method: "PUT", body: { pull_out_date: "2026-01-01" } })).status, 404);
  assert.equal((await call("/dated-plantings", { org: OTHER_ORG, body: { variety_id: CAD, planting_date: "2026-01-01" } })).status, 400);
  // Another organization's phase can't be linked.
  assert.equal((await saveRows(p, rows(1, 1, OTHER_PHASE))).status, 400);

  assert.equal((await call("/dated-plantings", { user: VIEWER })).status, 200);
  assert.equal((await call("/dated-plantings", { user: VIEWER, body: { variety_id: CAD, planting_date: "2026-01-01" } })).status, 403);
  assert.equal((await call(`/dated-plantings/${p}/rows`, { user: VIEWER, method: "PUT", body: { rows: [] } })).status, 403);
});
