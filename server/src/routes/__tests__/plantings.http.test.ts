// Crop Planner → Plants over HTTP (stage 1, read-only): GET
// /crop-planner/plantings returns the organization's live assignments, rows
// (with the m² yield analytics uses: the row's own width × length, else its
// section's), groups, varieties with their dates, crops, and today's date in
// the organization's time zone. The real router runs on PGlite with
// migrations 0148-0150 applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/plantings.http.test.ts
import { test, before, after } from "node:test";
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
const CAD = "b0000000-0000-4000-8000-000000000001";
const OTHER_VARIETY = "b0000000-0000-4000-8000-000000000009";
const PHASE_1 = "d0000000-0000-4000-8000-000000000001";
const OTHER_PHASE = "d0000000-0000-4000-8000-000000000009";
const SECTION = "e0000000-0000-4000-8000-000000000001";

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");

let db: PGlite;
let server: Server;
let baseUrl: string;

before(async () => {
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
    insert into varieties (id, name, color, planting_date, pull_out_date, organization_id) values
      ('${CAD}', 'Cadalora', 'red', '2025-12-15', '2026-11-20', '${ORG}'),
      ('${OTHER_VARIETY}', 'Foxtrot', 'red', '2025-12-01', null, '${OTHER_ORG}');
    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      variety_id uuid not null references varieties(id), size_kg jsonb not null default '{}');
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), variety_id uuid not null references varieties(id));
    create table waste_imports (id uuid primary key default gen_random_uuid(), variety_id uuid);
    create table greenhouse_groups (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      type text not null, name text not null, status text not null default 'active', created_at timestamptz default now(), updated_at timestamptz default now());
    create table greenhouse_row_sections (id uuid primary key default gen_random_uuid(), organization_id uuid not null, group_id uuid not null,
      start_row int not null, end_row int not null, width_meters numeric, length_meters numeric);
    create table greenhouse_rows (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, row_number int not null,
      slab_count int not null default 0, plants_per_slab int not null default 0, stems_per_plant numeric not null default 1,
      section_id uuid, width_meters numeric, length_meters numeric, unique (group_id, row_number));
    create table greenhouse_variety_assignments (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      group_id uuid not null references greenhouse_groups(id) on delete cascade, variety_id uuid not null references varieties(id),
      start_row int not null, end_row int not null, assignment_pattern text, created_at timestamptz not null default now());
    insert into greenhouse_groups (id, organization_id, type, name) values
      ('${PHASE_1}', '${ORG}', 'phase', 'Phase 1'), ('${OTHER_PHASE}', '${OTHER_ORG}', 'phase', 'Phase 1');
    insert into greenhouse_row_sections (id, organization_id, group_id, start_row, end_row, width_meters, length_meters)
      values ('${SECTION}', '${ORG}', '${PHASE_1}', 3, 4, 1.6, 50);
    -- row 1: own size; row 2: none at all; rows 3-4: only the section's size
    insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant, section_id, width_meters, length_meters) values
      ('${ORG}', '${PHASE_1}', 1, 106, 3, 2, null, 1.6, 62.5),
      ('${ORG}', '${PHASE_1}', 2, 106, 3, 2.5, null, null, null),
      ('${ORG}', '${PHASE_1}', 3, 0, 0, 1, '${SECTION}', null, null),
      ('${ORG}', '${PHASE_1}', 4, 106, 3, 2, '${SECTION}', null, null),
      ('${OTHER_ORG}', '${OTHER_PHASE}', 1, 50, 2, 1, null, 2, 50);
    insert into greenhouse_variety_assignments (organization_id, group_id, variety_id, start_row, end_row, assignment_pattern) values
      ('${ORG}', '${PHASE_1}', '${CAD}', 1, 4, null),
      ('${ORG}', '${PHASE_1}', '${CAD}', 1, 3, 'every_other'),
      ('${OTHER_ORG}', '${OTHER_PHASE}', '${OTHER_VARIETY}', 1, 1, 'all');
  `);
  for (const name of ["0148_product_catalog.sql", "0149_cucumber_product.sql", "0150_varieties_product_required.sql"]) await db.exec(migration(name));

  const client = createPgliteSupabase(db);
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { plantingsRouter } = require("../plantings") as typeof import("../plantings");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", plantingsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

async function get(user = OWNER, org = ORG) {
  const res = await fetch(`${baseUrl}/api/crop-planner/plantings`, { headers: { "x-test-user": user, "x-test-org": org } });
  return { status: res.status, body: (await res.json()) as any };
}

test("returns the organization's live assignments, rows with resolved m², varieties with dates, and today in its time zone", async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.timeZone, "America/Toronto");
  assert.deepEqual(body.groups.map((g: any) => g.name), ["Phase 1"]);
  assert.deepEqual(
    body.rows.map((r: any) => [r.row_number, r.area_m2, r.slab_count, r.plants_per_slab, r.stems_per_plant]),
    [
      [1, 100, 106, 3, 2],
      [2, null, 106, 3, 2.5],
      [3, 80, 0, 0, 1],
      [4, 80, 106, 3, 2]
    ]
  );
  assert.deepEqual(
    body.assignments.map((a: any) => [a.start_row, a.end_row, a.assignment_pattern]),
    [
      [1, 4, "all"],
      [1, 3, "every_other"]
    ]
  );
  assert.deepEqual(body.varieties, [
    { id: CAD, name: "Cadalora", color: "red", status: "active", product_code: "bell_pepper", planting_date: "2025-12-15", pull_out_date: "2026-11-20" }
  ]);
  assert.ok(body.products.some((p: any) => p.code === "bell_pepper"));
});

test("is read-only and each organization sees only its own greenhouse", async () => {
  const other = await get(OWNER, OTHER_ORG);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.varieties.map((v: any) => v.name), ["Foxtrot"]);
  assert.deepEqual(other.body.assignments.map((a: any) => a.variety_id), [OTHER_VARIETY]);
  assert.deepEqual(other.body.rows.map((r: any) => [r.row_number, r.area_m2]), [[1, 100]]);
  const mine = await get();
  assert.ok(mine.body.assignments.every((a: any) => a.variety_id === CAD));
  const counts = await db.query<{ n: number }>("select count(*)::int as n from greenhouse_variety_assignments");
  assert.equal(counts.rows[0].n, 3);
});

test("uses the Greenhouse Setup view permission", async () => {
  assert.equal((await get(VIEWER)).status, 200);
  assert.equal((await get(YIELD_EDITOR)).status, 403);
});
