// Crop Planner over HTTP (migration 0154): draft plans per season, one
// planting and one slab assignment per row per plan (enforced by the route
// and the database), overlapping selections refused until the user chooses
// to add only the unassigned rows or reassign, layout inputs, oversow, and
// the live greenhouse left untouched. The real router runs on PGlite with
// migrations 0148-0150 and 0154 applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/cropPlanner.http.test.ts
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
const YIELD_EDITOR = "aaaaaaaa-0000-4000-8000-00000000000c";

const CAD = "b0000000-0000-4000-8000-000000000001"; // Cadalora, red pepper
const SUN = "b0000000-0000-4000-8000-000000000002"; // Sunny, yellow pepper
const OTHER_VARIETY = "b0000000-0000-4000-8000-000000000009";
const PHASE_1 = "d0000000-0000-4000-8000-000000000001"; // rows 1-30: 106 slabs x 3 plants
const PHASE_2 = "d0000000-0000-4000-8000-000000000002"; // rows 1-10: 90 slabs x 4 plants; rows 9-10 have no layout
const OTHER_PHASE = "d0000000-0000-4000-8000-000000000009";

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");
const MIGRATIONS = ["0148_product_catalog.sql", "0149_cucumber_product.sql", "0150_varieties_product_required.sql"].map(migration);
const m0154 = migration("0154_crop_planner.sql");

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
      ('${VIEWER}', '${ORG}', 'member', '{"greenhouse_setup:view": true}'),
      ('${YIELD_EDITOR}', '${ORG}', 'member', '{"yield:edit": true}');
    create table varieties (
      id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 double precision not null default 0, case_kg double precision not null default 0,
      planting_date date, pull_out_date date,
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red' check (color in ('red', 'orange', 'yellow', 'green')),
      organization_id uuid not null references organizations(id),
      constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, color, organization_id) values
      ('${CAD}', 'Cadalora', 'red', '${ORG}'), ('${SUN}', 'Sunny', 'yellow', '${ORG}'), ('${OTHER_VARIETY}', 'Foxtrot', 'red', '${OTHER_ORG}');
    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      variety_id uuid not null references varieties(id), size_kg jsonb not null default '{}');
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), variety_id uuid not null references varieties(id));
    create table waste_imports (id uuid primary key default gen_random_uuid(), variety_id uuid);

    -- The greenhouse as production has it (0007 + 0008 + 0018 + 0021)
    create table greenhouse_groups (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      type text not null check (type in ('phase', 'zone', 'color')), name text not null,
      status text not null default 'active', created_at timestamptz default now(), updated_at timestamptz default now(),
      constraint greenhouse_groups_org_type_name_key unique (organization_id, type, name));
    create table greenhouse_rows (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, row_number int not null check (row_number >= 1),
      slab_count int not null default 0, plants_per_slab int not null default 0, stems_per_plant numeric not null default 1,
      section_id uuid, width_meters numeric, length_meters numeric, created_at timestamptz default now(), updated_at timestamptz default now(),
      unique (group_id, row_number));
    create table greenhouse_variety_assignments (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, variety_id uuid not null references varieties(id),
      start_row int not null, end_row int not null, assignment_pattern text);
    insert into greenhouse_groups (id, organization_id, type, name) values
      ('${PHASE_1}', '${ORG}', 'phase', 'Phase 1'), ('${PHASE_2}', '${ORG}', 'phase', 'Phase 2'), ('${OTHER_PHASE}', '${OTHER_ORG}', 'phase', 'Phase 1');
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant)
      select '${ORG}', '${PHASE_1}', n, 106, 3, 2 from generate_series(1, 30) n;
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab)
      select '${ORG}', '${PHASE_2}', n, case when n <= 8 then 90 else 0 end, case when n <= 8 then 4 else 0 end from generate_series(1, 10) n;
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab)
      select '${OTHER_ORG}', '${OTHER_PHASE}', n, 50, 2 from generate_series(1, 5) n;
    -- What is growing today.
    insert into greenhouse_variety_assignments (organization_id, group_id, variety_id, start_row, end_row) values
      ('${ORG}', '${PHASE_1}', '${CAD}', 1, 30);
  `);
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec(m0154);
}

before(async () => {
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as unknown as Record<string | symbol, unknown>)[prop] });
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { cropPlannerRouter } = require("../cropPlanner") as typeof import("../cropPlanner");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", cropPlannerRouter);
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

const rows = (group: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ group_id: group, row_number: from + i }));

async function newPlan(name = "Main plan", season = "2027") {
  const res = await call("/crop-planner/plans", { body: { season, name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

const liveAssignments = async () =>
  (await db.query("select organization_id, group_id, variety_id, start_row, end_row from greenhouse_variety_assignments order by 1")).rows;
const plantingRows = async (plan: string) =>
  (await db.query<{ row_number: number; group_id: string; variety_id: string }>(
    "select group_id, row_number, variety_id from crop_plan_row_plantings where plan_id = $1 order by group_id, row_number",
    [plan]
  )).rows;

test("0154: RLS on with no policies, service role only, and it re-runs cleanly", async () => {
  for (const table of ["crop_plans", "crop_plan_slab_types", "crop_plan_row_plantings", "crop_plan_row_slabs", "crop_plan_row_layouts", "crop_plan_varieties"]) {
    const { rows: r } = await db.query<{ rls: boolean; policies: number }>(
      "select relrowsecurity as rls, (select count(*)::int from pg_policies where tablename = $1) as policies from pg_class where oid = ('public.' || $1)::regclass",
      [table]
    );
    assert.deepEqual(r[0], { rls: true, policies: 0 }, table);
  }
  const plan = await newPlan();
  await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 1, 3), variety_id: CAD } });
  await db.exec(m0154);
  assert.equal((await plantingRows(plan)).length, 3);
});

test("plans: one per season and name; viewers read, only Setup editors change", async () => {
  const plan = await newPlan();
  assert.deepEqual(await call("/crop-planner/plans", { body: { season: "2027", name: "Main plan" } }), {
    status: 409, body: { message: "There is already a 2027 plan named Main plan." }
  });
  assert.equal((await call("/crop-planner/plans", { body: { season: "2028", name: "Main plan" } })).status, 201);
  assert.deepEqual((await call("/crop-planner/plans", { user: VIEWER })).body.map((p: any) => [p.season, p.name]), [["2028", "Main plan"], ["2027", "Main plan"]]);
  assert.equal((await call(`/crop-planner/plans/${plan}`, { user: VIEWER })).status, 200);
  assert.equal((await call("/crop-planner/plans", { user: VIEWER, body: { season: "2029", name: "x" } })).status, 403);
  assert.equal((await call(`/crop-planner/plans/${plan}/plantings`, { user: VIEWER, body: { rows: rows(PHASE_1, 1, 1), variety_id: CAD } })).status, 403);
  assert.equal((await call("/crop-planner/plans", { user: YIELD_EDITOR })).status, 403);
  // Another organization can't see or change it.
  assert.equal((await call(`/crop-planner/plans/${plan}`, { org: OTHER_ORG })).status, 404);
  assert.equal((await call(`/crop-planner/plans/${plan}/plantings`, { org: OTHER_ORG, body: { rows: rows(OTHER_PHASE, 1, 1), variety_id: OTHER_VARIETY } })).status, 404);
});

test("planting: overlapping selections are refused until the user adds only unassigned rows or reassigns", async () => {
  const plan = await newPlan();
  const first = await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 1, 20), variety_id: CAD } });
  assert.deepEqual(first, { status: 200, body: { assigned: 20, reassigned: 0, skipped: 0, unchanged: 0 } });

  // Rows 18-25 for Sunny overlap rows 18-20: refused, listing them; nothing written.
  const overlap = await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 18, 25), variety_id: SUN } });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.message, "3 of the selected rows already have assignments. Add only the unassigned rows, or reassign them.");
  assert.deepEqual(overlap.body.conflicts.map((c: any) => [c.row_number, c.variety_id]), [[18, CAD], [19, CAD], [20, CAD]]);
  assert.equal((await plantingRows(plan)).length, 20);

  // Add only the unassigned rows: 21-25 become Sunny, 18-20 stay Cadalora.
  const skip = await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 18, 25), variety_id: SUN, on_assigned: "skip" } });
  assert.deepEqual(skip.body, { assigned: 5, reassigned: 0, skipped: 3, unchanged: 0 });
  // Reassign, explicitly: 18-20 become Sunny.
  const reassign = await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 18, 20), variety_id: SUN, on_assigned: "reassign" } });
  assert.deepEqual(reassign.body, { assigned: 3, reassigned: 3, skipped: 0, unchanged: 0 });
  const saved = await plantingRows(plan);
  assert.equal(saved.length, 25);
  assert.deepEqual(saved.filter((r) => r.variety_id === SUN).map((r) => r.row_number), [18, 19, 20, 21, 22, 23, 24, 25]);

  // The same variety again is not a conflict.
  assert.deepEqual((await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 1, 2), variety_id: CAD } })).body,
    { assigned: 0, reassigned: 0, skipped: 0, unchanged: 2 });

  // The database refuses a second planting for a row from any writer.
  await assert.rejects(
    db.query(`insert into crop_plan_row_plantings (plan_id, organization_id, group_id, row_number, variety_id) values ('${plan}', '${ORG}', '${PHASE_1}', 1, '${SUN}')`),
    /crop_plan_row_plantings_plan_row_key/
  );

  // Removing frees the rows.
  assert.deepEqual((await call(`/crop-planner/plans/${plan}/plantings/remove`, { body: { rows: rows(PHASE_1, 24, 25) } })).body, { removed: 2 });
  assert.equal((await plantingRows(plan)).length, 23);

  // Another plan for the same season is independent.
  const other = await newPlan("Alternative");
  assert.equal((await call(`/crop-planner/plans/${other}/plantings`, { body: { rows: rows(PHASE_1, 1, 30), variety_id: SUN } })).status, 200);
  assert.equal((await plantingRows(plan)).length, 23);
});

test("planting refuses rows outside Greenhouse Setup, other organizations' rows and varieties, and leaves the live greenhouse alone", async () => {
  const before = await liveAssignments();
  const plan = await newPlan();
  assert.deepEqual(await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 29, 31), variety_id: CAD } }), {
    status: 400, body: { message: "1 selected row is not in this organization's Greenhouse Setup." }
  });
  assert.deepEqual(await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(OTHER_PHASE, 1, 2), variety_id: CAD } }), {
    status: 400, body: { message: "2 selected rows are not in this organization's Greenhouse Setup." }
  });
  assert.deepEqual(await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 1, 2), variety_id: OTHER_VARIETY } }), {
    status: 400, body: { message: "Selected variety was not found" }
  });
  assert.equal((await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rows(PHASE_1, 1, 30), variety_id: SUN } })).status, 200);
  await assert.rejects(
    db.query(`insert into crop_plan_row_plantings (plan_id, organization_id, group_id, row_number, variety_id) values ('${plan}', '${ORG}', '${OTHER_PHASE}', 1, '${CAD}')`),
    /greenhouse group of the plan's organization/
  );
  // Planting next season never touched what is growing today.
  assert.deepEqual(await liveAssignments(), before);
});

test("slabs: mixed slab types in one phase, overlaps refused, one per row", async () => {
  const plan = await newPlan();
  const a = (await call("/crop-planner/slab-types", { body: { name: "Grodan Expert 100" } })).body;
  const b = (await call("/crop-planner/slab-types", { body: { name: "Grodan Vital 120" } })).body;
  assert.deepEqual(await call("/crop-planner/slab-types", { body: { name: "Grodan Vital 120" } }), {
    status: 409, body: { message: "There is already a slab type named Grodan Vital 120." }
  });

  assert.deepEqual((await call(`/crop-planner/plans/${plan}/slabs`, { body: { rows: rows(PHASE_1, 1, 20), slab_type_id: a.id } })).body,
    { assigned: 20, reassigned: 0, skipped: 0, unchanged: 0 });
  // The whole phase for type B overlaps rows 1-20.
  const phase = await call(`/crop-planner/plans/${plan}/slabs`, { body: { rows: rows(PHASE_1, 1, 30), slab_type_id: b.id } });
  assert.equal(phase.status, 409);
  assert.equal(phase.body.conflicts.length, 20);
  // The rest of the phase only.
  assert.deepEqual((await call(`/crop-planner/plans/${plan}/slabs`, { body: { rows: rows(PHASE_1, 1, 30), slab_type_id: b.id, on_assigned: "skip" } })).body,
    { assigned: 10, reassigned: 0, skipped: 20, unchanged: 0 });
  const detail = (await call(`/crop-planner/plans/${plan}`)).body;
  const byType = (id: string) => detail.slabs.filter((s: any) => s.slab_type_id === id).length;
  assert.deepEqual([byType(a.id), byType(b.id)], [20, 10]);
  // Slabs and plantings are separate: no planting was made.
  assert.equal(detail.plantings.length, 0);

  // A retired slab type can't be assigned.
  await call(`/crop-planner/slab-types/${a.id}`, { method: "PUT", body: { name: "Grodan Expert 100", status: "inactive" } });
  assert.deepEqual(await call(`/crop-planner/plans/${plan}/slabs`, { body: { rows: rows(PHASE_2, 1, 2), slab_type_id: a.id } }), {
    status: 400, body: { message: "That slab type is retired" }
  });
});

test("layout inputs and oversow are saved per plan and validated", async () => {
  const plan = await newPlan();
  assert.deepEqual(await call(`/crop-planner/plans/${plan}/layouts`, { method: "PUT", body: { rows: rows(PHASE_2, 9, 10), slabs_per_trough: 53 } }), {
    status: 400, body: { message: "Enter both slabs per trough and troughs per row, or neither" }
  });
  assert.deepEqual(await call(`/crop-planner/plans/${plan}/layouts`, { method: "PUT", body: { rows: rows(PHASE_2, 9, 10), plants_per_slab: 2.5 } }), {
    status: 400, body: { message: "Plants per slab must be a whole number of 1 or more" }
  });
  assert.deepEqual((await call(`/crop-planner/plans/${plan}/layouts`, { method: "PUT", body: { rows: rows(PHASE_2, 9, 10), slabs_per_trough: 53, troughs_per_row: 2, plants_per_slab: 3 } })).body,
    { updated: 2 });
  let detail = (await call(`/crop-planner/plans/${plan}`)).body;
  assert.deepEqual(detail.layouts.map((l: any) => [l.row_number, l.slabs_per_trough, l.troughs_per_row, l.plants_per_slab]), [[9, 53, 2, 3], [10, 53, 2, 3]]);
  // Clearing goes back to the Greenhouse Setup layout.
  assert.deepEqual((await call(`/crop-planner/plans/${plan}/layouts`, { method: "PUT", body: { rows: rows(PHASE_2, 10, 10) } })).body, { removed: 1 });

  assert.deepEqual(await call(`/crop-planner/plans/${plan}/varieties/${CAD}`, { method: "PUT", body: { oversow_pct: 30 } }), {
    status: 200, body: { variety_id: CAD, oversow_pct: 30 }
  });
  assert.equal((await call(`/crop-planner/plans/${plan}/varieties/${CAD}`, { method: "PUT", body: { oversow_pct: -1 } })).status, 400);
  assert.equal((await call(`/crop-planner/plans/${plan}/varieties/${OTHER_VARIETY}`, { method: "PUT", body: { oversow_pct: 5 } })).status, 400);
  detail = (await call(`/crop-planner/plans/${plan}`)).body;
  assert.deepEqual(detail.oversow, [{ variety_id: CAD, oversow_pct: 30 }]);

  // The detail carries the greenhouse with each row's Setup layout.
  assert.deepEqual(detail.greenhouse.groups.map((g: any) => g.name), ["Phase 1", "Phase 2"]);
  assert.equal(detail.greenhouse.rows.length, 40);
  assert.deepEqual(
    detail.greenhouse.rows.find((r: any) => r.group_id === PHASE_1 && r.row_number === 1),
    { group_id: PHASE_1, row_number: 1, slab_count: 106, plants_per_slab: 3, stems_per_plant: 2 }
  );
  // Deleting the plan removes its rows and inputs, nothing else.
  assert.equal((await call(`/crop-planner/plans/${plan}`, { method: "DELETE" })).status, 204);
  assert.equal((await db.query<{ n: number }>("select count(*)::int as n from crop_plan_row_layouts")).rows[0].n, 0);
});
