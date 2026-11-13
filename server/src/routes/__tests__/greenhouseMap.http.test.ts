// Greenhouse map over HTTP (migration 0155): importing a copy of First Light's
// LabourLink layout, a second organization building a map from scratch, the
// two kept apart, and saving, importing or deleting a map never touching the
// live greenhouse or any crop plan. The real routers run on PGlite with
// migrations 0148-0150, 0154 and 0155 applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/greenhouseMap.http.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const FIRST_LIGHT = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const VIEWER = "aaaaaaaa-0000-4000-8000-00000000000b";
const SECOND_OWNER = "aaaaaaaa-0000-4000-8000-00000000000c";

// First Light's Greenhouse Setup groups (names and row numbers copied from production, ids made up).
const FL_PHASE = ["d0000000-0000-4000-8000-000000000001", "d0000000-0000-4000-8000-000000000002", "d0000000-0000-4000-8000-000000000003"];
const FL_ZONE_PHASE_1 = "d0000000-0000-4000-8000-000000000004";
// The second organization: two bays it draws itself.
const BAY_A = "e0000000-0000-4000-8000-000000000001";
const BAY_B = "e0000000-0000-4000-8000-000000000002";
const CAD = "b0000000-0000-4000-8000-000000000001";
const SUN = "b0000000-0000-4000-8000-000000000002";

const fixture = (name: string) => JSON.parse(readFileSync(path.resolve(__dirname, "fixtures", name), "utf8"));
const LAYOUT = fixture("firstLightLabourLinkLayout.json");
const FL_SETUP = fixture("firstLightGreenhouseSetup.json") as { groups: Array<{ name: string; type: string; row_numbers: number[] }> };

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");
const MIGRATIONS = ["0148_product_catalog.sql", "0149_cucumber_product.sql", "0150_varieties_product_required.sql", "0154_crop_planner.sql"].map(migration);
const m0155 = migration("0155_greenhouse_maps.sql");

let db: PGlite;
let server: Server;
let baseUrl: string;

async function resetDatabase() {
  db = new PGlite();
  const flRows = FL_SETUP.groups
    .flatMap((g, i) => g.row_numbers.map((n) => `('${FIRST_LIGHT}', '${FL_PHASE[i]}', ${n}, 106, 3)`))
    .join(", ");
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '');
    insert into organizations (id, name) values ('${FIRST_LIGHT}', 'First Light'), ('${SECOND}', 'Second');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${FIRST_LIGHT}', 'owner', '{}'),
      ('${VIEWER}', '${FIRST_LIGHT}', 'member', '{"greenhouse_setup:view": true}'),
      ('${SECOND_OWNER}', '${SECOND}', 'owner', '{}');
    create table varieties (
      id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 double precision not null default 0, case_kg double precision not null default 0,
      planting_date date, pull_out_date date,
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red' check (color in ('red', 'orange', 'yellow', 'green')),
      organization_id uuid not null references organizations(id),
      constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, color, organization_id) values ('${CAD}', 'Cadalora', 'red', '${FIRST_LIGHT}'), ('${SUN}', 'Sunny', 'yellow', '${FIRST_LIGHT}');
    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      variety_id uuid not null references varieties(id), size_kg jsonb not null default '{}');
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), variety_id uuid not null references varieties(id));
    create table waste_imports (id uuid primary key default gen_random_uuid(), variety_id uuid);
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
    insert into greenhouse_groups (id, organization_id, type, name, created_at) values
      ${FL_SETUP.groups.map((g, i) => `('${FL_PHASE[i]}', '${FIRST_LIGHT}', '${g.type}', '${g.name}', now() + interval '${i} second')`).join(", ")},
      ('${BAY_A}', '${SECOND}', 'phase', 'Bay A', now()), ('${BAY_B}', '${SECOND}', 'phase', 'Bay B', now() + interval '1 second');
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab) values ${flRows};
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab)
      select '${SECOND}', '${BAY_A}', n, 40, 3 from generate_series(1, 6) n;
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab)
      select '${SECOND}', '${BAY_B}', n, 40, 3 from generate_series(1, 4) n;
    insert into greenhouse_variety_assignments (organization_id, group_id, variety_id, start_row, end_row) values
      ('${FIRST_LIGHT}', '${FL_PHASE[0]}', '${CAD}', 1, 470);
  `);
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec(m0155);
}

before(async () => {
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as unknown as Record<string | symbol, unknown>)[prop] });
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { greenhouseMapRouter } = require("../greenhouseMap") as typeof import("../greenhouseMap");
  const { cropPlannerRouter } = require("../cropPlanner") as typeof import("../cropPlanner");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? FIRST_LIGHT);
    next();
  });
  app.use("/api", greenhouseMapRouter);
  app.use("/api", cropPlannerRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());
beforeEach(async () => {
  await resetDatabase();
});

type Opts = { user?: string; org?: string; body?: unknown; method?: string };
async function call(pathname: string, { user = OWNER, org = FIRST_LIGHT, body, method }: Opts = {}) {
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-test-user": user, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}
const asSecond = (pathname: string, opts: Opts = {}) => call(pathname, { user: SECOND_OWNER, org: SECOND, ...opts });

// Everything a map must never change: Greenhouse Setup, what is growing today, and plans.
async function liveState() {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    groups: await q("select id, organization_id, type, name, status from greenhouse_groups order by id"),
    rows: await q("select organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant from greenhouse_rows order by group_id, row_number"),
    live: await q("select organization_id, group_id, variety_id, start_row, end_row from greenhouse_variety_assignments order by id"),
    plantings: await q("select plan_id, group_id, row_number, variety_id from crop_plan_row_plantings order by group_id, row_number"),
    slabs: await q("select plan_id, group_id, row_number, slab_type_id from crop_plan_row_slabs order by group_id, row_number")
  };
}
const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;

function secondMap(overrides: Partial<{ rows: any[] }> = {}) {
  // Bay A: 6 rows stacked from the north, 4 ft wide, 2 ft apart, 80 ft long. Bay B: 4 vertical rows.
  return {
    name: "Second greenhouse",
    east_west_feet: 200,
    north_south_feet: 100,
    phases: [
      {
        group_id: BAY_A, x_feet_from_west: 0, y_feet_from_north: 0, east_west_feet: 100, north_south_feet: 40, sort_order: 1,
        rows: overrides.rows ?? Array.from({ length: 6 }, (_, i) => ({ row_number: i + 1, x_ft: 10, y_ft: 2 + i * 6, width_ft: 4, length_ft: 80, orientation: "horizontal" }))
      },
      {
        group_id: BAY_B, x_feet_from_west: 110, y_feet_from_north: 0, east_west_feet: 60, north_south_feet: 100, sort_order: 2,
        rows: Array.from({ length: 4 }, (_, i) => ({ row_number: i + 1, x_ft: 5 + i * 12, y_ft: 5, width_ft: 6, length_ft: 90, orientation: "vertical" }))
      }
    ]
  };
}

test("0155: RLS on with no policies, service role only, and it re-runs cleanly", async () => {
  for (const table of ["greenhouse_maps", "greenhouse_map_phases", "greenhouse_map_rows"]) {
    const { rows } = await db.query<{ rls: boolean; policies: number }>(
      "select relrowsecurity as rls, (select count(*)::int from pg_policies where tablename = $1) as policies from pg_class where oid = ('public.' || $1)::regclass",
      [table]
    );
    assert.deepEqual(rows[0], { rls: true, policies: 0 }, table);
  }
  const { rows: grants } = await db.query<{ anon: boolean; service: boolean }>(
    `select has_function_privilege('anon', 'public.save_greenhouse_map(uuid, jsonb, uuid, timestamptz)', 'execute') as anon,
            has_function_privilege('service_role', 'public.save_greenhouse_map(uuid, jsonb, uuid, timestamptz)', 'execute') as service`
  );
  assert.deepEqual(grants[0], { anon: false, service: true });
  assert.equal((await asSecond("/greenhouse-map", { method: "PUT", body: { map: secondMap(), expected_updated_at: null } })).status, 200);
  await db.exec(m0155);
  assert.equal(await count("greenhouse_map_rows"), 10);
});

test("First Light: the LabourLink layout matches every row by phase and row number, previews without writing, then imports", async () => {
  const before = await liveState();
  const preview = await call("/greenhouse-map/import/preview", { body: { layout: LAYOUT } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const { report, map } = preview.body;
  assert.deepEqual(report.lands, ["First Light Greenhouse"]);
  assert.deepEqual(report.phases.map((p: any) => [p.source_name, p.status, p.group_id, p.source_rows, p.matched_rows]), [
    ["Phase 1", "matched", FL_PHASE[0], 467, 467],
    ["Phase 2", "matched", FL_PHASE[1], 142, 142],
    ["Phase 3", "matched", FL_PHASE[2], 72, 72]
  ]);
  assert.equal(report.matched_rows, 681);
  assert.deepEqual(report.row_issues, []);
  // GrowLink rows LabourLink has no position for stay listed, not invented.
  assert.deepEqual(report.setup_rows_not_on_map, [{ group_id: FL_PHASE[0], group_name: "Phase 1", row_numbers: [79, 81, 83] }]);
  assert.deepEqual(report.geometry_problems, []);
  assert.equal(report.ready, true);
  assert.equal(map.phases.length, 3);
  assert.equal(await count("greenhouse_maps"), 0, "a preview writes nothing");

  const imported = await call("/greenhouse-map/import", { body: { layout: LAYOUT, expected_updated_at: null } });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const saved = (await call("/greenhouse-map")).body.map;
  assert.equal(saved.name, "First Light Greenhouse");
  assert.equal(saved.source, "labourlink_import");
  assert.deepEqual([saved.east_west_feet, saved.north_south_feet], [1000, 1480]);
  assert.deepEqual(saved.phases.map((p: any) => [p.group_id, p.rows.length]), [[FL_PHASE[0], 467], [FL_PHASE[1], 142], [FL_PHASE[2], 72]]);
  // Geometry is kept exactly: a row of each phase against the file.
  for (const [i, phase] of LAYOUT.lands[0].phases.entries()) {
    const src = phase.rows[5];
    const dst = saved.phases[i].rows.find((r: any) => r.row_number === src.rowNumber);
    assert.deepEqual(dst, { row_number: src.rowNumber, x_ft: src.xFt, y_ft: src.yFt, width_ft: src.widthFt, length_ft: src.lengthFt, orientation: src.orientation });
    assert.deepEqual(
      [saved.phases[i].x_feet_from_west, saved.phases[i].y_feet_from_north, saved.phases[i].east_west_feet, saved.phases[i].north_south_feet],
      [phase.xFeetFromWest, phase.yFeetFromNorth, phase.eastWestFeet, phase.northSouthFeet]
    );
  }
  // Importing a map changed nothing in Greenhouse Setup, the live greenhouse or plans.
  assert.deepEqual(await liveState(), before);
  // The other organization has no map.
  assert.equal((await asSecond("/greenhouse-map")).body.map, null);
});

test("import: unmatched and ambiguous phases and rows are reported and block the import until resolved; nothing is guessed or created", async () => {
  // A second group named Phase 1 (a zone), Phase 3 renamed in LabourLink, and LabourLink rows GrowLink doesn't have.
  await db.exec(`insert into greenhouse_groups (id, organization_id, type, name) values ('${FL_ZONE_PHASE_1}', '${FIRST_LIGHT}', 'zone', 'phase 1')`);
  const layout = structuredClone(LAYOUT);
  const [p1, p2, p3] = layout.lands[0].phases;
  p3.name = "Phase Three";
  p2.rows.push({ ...p2.rows[0], rowNumber: 999 });
  p2.rows.push({ ...p2.rows[1], rowNumber: 998 });
  const before = await liveState();

  let res = await call("/greenhouse-map/import/preview", { body: { layout } });
  let report = res.body.report;
  assert.deepEqual(report.phases.map((p: any) => [p.source_name, p.status, p.reason]), [
    ["Phase 1", "ambiguous", "2 Greenhouse Setup groups are named Phase 1."],
    ["Phase 2", "matched", null],
    ["Phase Three", "unmatched", "No Greenhouse Setup group has this name."]
  ]);
  assert.deepEqual(report.phases[0].candidates.map((c: any) => c.id).sort(), [FL_PHASE[0], FL_ZONE_PHASE_1].sort());
  // Rows of unresolved phases aren't placed; Phase 2's extra rows are unmatched.
  assert.equal(report.row_issues.filter((r: any) => r.reason === "Its phase isn't matched yet.").length, 467 + 72);
  assert.deepEqual(report.row_issues.filter((r: any) => r.phase === "Phase 2").map((r: any) => [r.row_number, r.status, r.reason]), [
    [998, "unmatched", "Phase 2 has no row 998 in Greenhouse Setup."],
    [999, "unmatched", "Phase 2 has no row 999 in Greenhouse Setup."]
  ]);
  assert.equal(report.ready, false);

  // The import is refused while anything is unresolved, and writes nothing.
  res = await call("/greenhouse-map/import", { body: { layout } });
  assert.equal(res.status, 409);
  assert.equal(res.body.message, "Resolve every unmatched or ambiguous phase and row before importing.");
  assert.equal(await count("greenhouse_maps"), 0);

  // The user resolves: Phase 1 is the phase group, Phase Three is Phase 3, row 999 stays off, row 998 points at a taken row.
  const resolutions = {
    phase_matches: { "Phase 1": FL_PHASE[0], "Phase Three": FL_PHASE[2] },
    row_resolutions: { "Phase 2#999": "skip", "Phase 2#998": 501 } as Record<string, number | "skip">
  };
  res = await call("/greenhouse-map/import/preview", { body: { layout, ...resolutions } });
  report = res.body.report;
  assert.deepEqual(report.phases.map((p: any) => [p.source_name, p.status, p.group_id]), [
    ["Phase 1", "resolved", FL_PHASE[0]], ["Phase 2", "matched", FL_PHASE[1]], ["Phase Three", "resolved", FL_PHASE[2]]
  ]);
  // Row 998 → 501 collides with LabourLink's own row 501: both are flagged, neither placed.
  assert.deepEqual(report.row_issues.filter((r: any) => r.status !== "skipped").map((r: any) => [r.row_number, r.status]), [[501, "ambiguous"], [998, "ambiguous"]]);
  assert.equal(report.ready, false);

  // Row 998 left off too: ready.
  resolutions.row_resolutions["Phase 2#998"] = "skip";
  res = await call("/greenhouse-map/import", { body: { layout, ...resolutions } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.report.matched_rows, 681);
  assert.equal(res.body.report.skipped_rows, 2);
  assert.equal(await count("greenhouse_map_rows"), 681);
  // No Greenhouse Setup row was created for 998 or 999, and nothing live changed.
  assert.deepEqual(await liveState(), before);
});

test("a second organization builds its map from scratch from its own Greenhouse Setup, kept apart from First Light", async () => {
  await call("/greenhouse-map/import", { body: { layout: LAYOUT } });
  const before = await liveState();

  const created = await asSecond("/greenhouse-map", { method: "PUT", body: { map: secondMap(), expected_updated_at: null } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const map = created.body.map;
  assert.equal(map.source, "builder");
  assert.deepEqual(map.phases.map((p: any) => [p.group_id, p.rows.length]), [[BAY_A, 6], [BAY_B, 4]]);

  // Each organization sees only its own map.
  assert.equal((await call("/greenhouse-map")).body.map.name, "First Light Greenhouse");
  assert.equal((await asSecond("/greenhouse-map")).body.map.name, "Second greenhouse");
  assert.deepEqual((await asSecond("/greenhouse-map")).body.setup.groups.map((g: any) => g.name), ["Bay A", "Bay B"]);

  // It can't place another organization's phase, or a row Greenhouse Setup doesn't have.
  const foreign = secondMap();
  foreign.phases[1].group_id = FL_PHASE[0];
  let res = await asSecond("/greenhouse-map", { method: "PUT", body: { map: foreign, expected_updated_at: map.updated_at } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.problems, ["A phase on the map is not a group in this organization's Greenhouse Setup."]);
  res = await asSecond("/greenhouse-map", {
    method: "PUT",
    body: { map: secondMap({ rows: [{ row_number: 7, x_ft: 0, y_ft: 0, width_ft: 4, length_ft: 80, orientation: "horizontal" }] }), expected_updated_at: map.updated_at }
  });
  assert.deepEqual(res.body.problems, ["Bay A row 7 is not in Greenhouse Setup. Add it there first; the map never creates rows."]);
  // Overlapping rows and rows outside their phase are refused.
  res = await asSecond("/greenhouse-map", {
    method: "PUT",
    body: {
      map: secondMap({ rows: [
        { row_number: 1, x_ft: 0, y_ft: 0, width_ft: 4, length_ft: 80, orientation: "horizontal" },
        { row_number: 2, x_ft: 0, y_ft: 3, width_ft: 4, length_ft: 80, orientation: "horizontal" },
        { row_number: 3, x_ft: 30, y_ft: 38, width_ft: 4, length_ft: 80, orientation: "horizontal" }
      ] }),
      expected_updated_at: map.updated_at
    }
  });
  assert.deepEqual(res.body.problems, ["1 row in Bay A falls outside the phase.", "Bay A row 1 overlaps row 2."]);

  // Editing: move Bay B and drop two of its rows. A stale editor can't overwrite it.
  const edited = secondMap();
  edited.phases[1].x_feet_from_west = 120;
  edited.phases[1].rows = edited.phases[1].rows.slice(0, 2);
  res = await asSecond("/greenhouse-map", { method: "PUT", body: { map: edited, expected_updated_at: map.updated_at } });
  assert.equal(res.status, 200);
  const stale = await asSecond("/greenhouse-map", { method: "PUT", body: { map: secondMap(), expected_updated_at: map.updated_at } });
  assert.deepEqual(stale, { status: 409, body: { message: "The map was changed by another save. Reload it and try again." } });
  const reloaded = (await asSecond("/greenhouse-map")).body.map;
  assert.deepEqual([reloaded.phases[1].x_feet_from_west, reloaded.phases[1].rows.length], [120, 2]);

  // Deleting the second organization's map leaves First Light's alone.
  assert.equal((await asSecond("/greenhouse-map", { method: "DELETE" })).status, 204);
  assert.equal((await asSecond("/greenhouse-map")).body.map, null);
  assert.equal((await call("/greenhouse-map")).body.map.phases.length, 3);
  // The database refuses a map phase from another organization's group from any writer.
  await assert.rejects(
    db.query(`insert into greenhouse_map_phases (map_id, organization_id, group_id, x_feet_from_west, y_feet_from_north, east_west_feet, north_south_feet)
              select id, organization_id, '${BAY_A}', 0, 0, 10, 10 from greenhouse_maps where organization_id = '${FIRST_LIGHT}'`),
    /greenhouse group of the map's organization/
  );
  assert.deepEqual(await liveState(), before);
});

test("viewers read the map; only Greenhouse Setup editors build, import or delete it", async () => {
  assert.equal((await call("/greenhouse-map", { user: VIEWER })).status, 200);
  assert.equal((await call("/greenhouse-map", { user: VIEWER, method: "PUT", body: { map: secondMap() } })).status, 403);
  assert.equal((await call("/greenhouse-map/import/preview", { user: VIEWER, body: { layout: LAYOUT } })).status, 403);
  assert.equal((await call("/greenhouse-map/import", { user: VIEWER, body: { layout: LAYOUT } })).status, 403);
  assert.equal((await call("/greenhouse-map", { user: VIEWER, method: "DELETE" })).status, 403);
  assert.deepEqual(await call("/greenhouse-map/import/preview", { body: { layout: { lands: [] } } }), {
    status: 400, body: { message: "This isn't a LabourLink layout file (format labourlink-greenhouse-layout, version 1).", problems: [] }
  });
});

test("editing or deleting the map never changes a plan's assignments or the live greenhouse", async () => {
  await call("/greenhouse-map/import", { body: { layout: LAYOUT } });
  const plan = (await call("/crop-planner/plans", { body: { season: "2027", name: "Main" } })).body.id;
  const rowsOf = (group: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ group_id: group, row_number: from + i }));
  // A row clicked on the map is sent as its Greenhouse Setup group and row number.
  const map = (await call("/greenhouse-map")).body.map;
  const clicked = map.phases[1].rows.find((r: any) => r.row_number === 520);
  assert.ok(clicked);
  assert.equal((await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: [{ group_id: map.phases[1].group_id, row_number: clicked.row_number }], variety_id: SUN } })).status, 200);
  assert.equal((await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rowsOf(FL_PHASE[0], 1, 20), variety_id: CAD } })).status, 200);
  const slabType = (await call("/crop-planner/slab-types", { body: { name: "Expert" } })).body.id;
  assert.equal((await call(`/crop-planner/plans/${plan}/slabs`, { body: { rows: rowsOf(FL_PHASE[0], 1, 20), slab_type_id: slabType } })).status, 200);
  const before = await liveState();
  assert.deepEqual(before.plantings.find((p: any) => p.group_id === FL_PHASE[1]), { plan_id: plan, group_id: FL_PHASE[1], row_number: 520, variety_id: SUN });

  // Remove Phase 1 rows 1-10 from the map and move Phase 3.
  const edited = structuredClone(map);
  edited.phases[0].rows = edited.phases[0].rows.filter((r: any) => r.row_number > 10);
  edited.phases[2].x_feet_from_west = 100;
  assert.equal((await call("/greenhouse-map", { method: "PUT", body: { map: edited, expected_updated_at: map.updated_at } })).status, 200);
  assert.deepEqual(await liveState(), before);
  // Plan rows that are off the map are still in the plan and still assignable.
  assert.equal((await call(`/crop-planner/plans/${plan}`)).body.plantings.length, 21);
  assert.equal((await call(`/crop-planner/plans/${plan}/plantings`, { body: { rows: rowsOf(FL_PHASE[0], 79, 79), variety_id: SUN } })).status, 200);

  assert.equal((await call("/greenhouse-map", { method: "DELETE" })).status, 204);
  const after = await liveState();
  assert.equal(after.plantings.length, 22);
  assert.deepEqual({ ...after, plantings: [] }, { ...before, plantings: [] });
});
