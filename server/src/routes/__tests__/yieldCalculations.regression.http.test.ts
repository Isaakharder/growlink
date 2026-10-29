// Phase 0 regression coverage: pins today's numeric outputs of the yield
// calculations that had no tests, over HTTP with the real routers and
// permission middleware on a real Postgres (PGlite). Numbers are literal on
// purpose — any change to a formula, a rounding, an order or a filter fails
// here. Covered: Manual Entry create / merge / edit totals and daily
// breakdowns, Yield Analytics summary, colour case totals and options, the
// Daily Yield Projection, and CropLink v1. No server, Docker, network or
// credentials.
// Run: node --require tsx/cjs --test src/routes/__tests__/yieldCalculations.regression.http.test.ts
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";

const RED_A = "b0000000-0000-4000-8000-000000000001"; // Alpha Red, red, 1000 m², 5.15 kg cases
const RED_B = "b0000000-0000-4000-8000-000000000002"; // Bravo Red, red, 500 m²
const YEL = "b0000000-0000-4000-8000-000000000003"; // Charlie Yellow, yellow, 800 m², 5 kg cases
const ORA_OLD = "b0000000-0000-4000-8000-000000000004"; // Delta Orange, inactive
const ZERO = "b0000000-0000-4000-8000-000000000005"; // Echo Yellow, no area, no case weight
const OTHER_RED = "b0000000-0000-4000-8000-000000000006"; // another organization
const OTHER_GREEN = "b0000000-0000-4000-8000-000000000007"; // another organization

const LG = "c0000000-0000-4000-8000-000000000001";
const XL = "c0000000-0000-4000-8000-000000000002";
const MD = "c0000000-0000-4000-8000-000000000003";
const OTHER_SIZE = "c0000000-0000-4000-8000-000000000004";

const G1 = "d0000000-0000-4000-8000-000000000001";
const G2 = "d0000000-0000-4000-8000-000000000002";

let db: PGlite;
let server: Server;
let baseUrl: string;

// Numeric columns are double precision here so values come back as JSON
// numbers, the way PostgREST returns numeric columns in production.
async function resetDatabase() {
  db = new PGlite();
  await db.exec(`
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${OTHER_ORG}', 'owner', '{}');

    create table varieties (id uuid primary key, organization_id uuid not null, name text not null, color text not null,
      area_m2 double precision not null default 0, case_kg double precision not null default 0, status text not null default 'active');
    insert into varieties values
      ('${RED_A}', '${ORG}', 'Alpha Red', 'red', 1000, 5.15, 'active'),
      ('${RED_B}', '${ORG}', 'Bravo Red', 'red', 500, 5.15, 'active'),
      ('${YEL}', '${ORG}', 'Charlie Yellow', 'yellow', 800, 5, 'active'),
      ('${ORA_OLD}', '${ORG}', 'Delta Orange', 'orange', 300, 5.15, 'inactive'),
      ('${ZERO}', '${ORG}', 'Echo Yellow', 'yellow', 0, 0, 'active'),
      ('${OTHER_RED}', '${OTHER_ORG}', 'Foxtrot Red', 'red', 999, 5, 'active'),
      ('${OTHER_GREEN}', '${OTHER_ORG}', 'Golf Green', 'green', 777, 5, 'active');

    create table yield_sizes (id uuid primary key, organization_id uuid not null, name text not null, sort_order int not null,
      created_at timestamptz not null default now());
    insert into yield_sizes values
      ('${MD}', '${ORG}', 'MD', 3, now()), ('${LG}', '${ORG}', 'LG', 1, now()), ('${XL}', '${ORG}', 'XL', 2, now()),
      ('${OTHER_SIZE}', '${OTHER_ORG}', 'Other', 1, now());

    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      variety_id uuid not null references varieties(id), year int not null, week int not null, size_kg jsonb not null default '{}',
      total_kg double precision not null default 0, average_fruit_weight_g double precision, kg_per_m2 double precision not null default 0,
      total_cases double precision not null default 0, packed_date text, last_write_source text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (organization_id, variety_id, year, week));
    create table yield_entry_daily_breakdown (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      yield_entry_id uuid not null references yield_entries(id) on delete cascade, packed_date text, size_kg jsonb not null default '{}',
      total_kg double precision not null default 0, average_fruit_weight_g double precision,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());

    create table color_case_entries (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      color text not null check (color in ('red', 'orange', 'yellow', 'green')), year int not null, week int not null,
      total_cases double precision not null, case_weight_kg double precision not null, total_kg double precision not null default 0,
      kg_per_m2 double precision not null default 0, color_area_m2 double precision not null default 0, source text default 'manual',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (organization_id, color, year, week));

    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), organization_id uuid not null, variety_id uuid not null,
      session_year int not null, session_week int not null, calculated_kg_per_stem double precision, sample_date text, created_at text, created_by uuid);
    create table daily_yield_bin_settings (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      cases_per_bin double precision, picking_bin_kg double precision, case_kg double precision, created_at timestamptz not null);
    create table greenhouse_groups (id uuid primary key, organization_id uuid not null, name text not null);
    create table greenhouse_rows (id uuid primary key default gen_random_uuid(), organization_id uuid not null, group_id uuid not null,
      row_number int not null, slab_count double precision, plants_per_slab double precision, stems_per_plant double precision);
    create table greenhouse_variety_assignments (organization_id uuid not null, variety_id uuid not null, group_id uuid not null,
      start_row int not null, end_row int not null);
  `);
}

// The shim cannot run PostgREST resource embedding. The two routes here that
// embed `varieties(...)` on yield_entries get the same many-to-one row through
// a correlated subquery on variety_id, which is what PostgREST resolves.
function withVarietyEmbeds(client: ReturnType<typeof createPgliteSupabase>) {
  return {
    ...client,
    from(table: string) {
      const builder = client.from(table);
      const select = builder.select.bind(builder);
      builder.select = (cols = "*") =>
        select(
          cols.replace(
            /varieties\(([^)]*)\)/,
            (_m, inner: string) =>
              `(select row_to_json(e) from (select ${inner} from public.varieties v where v.id = ${table}.variety_id) e) as varieties`
          )
        );
      return builder;
    }
  };
}

before(async () => {
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (withVarietyEmbeds(createPgliteSupabase(db)) as Record<string | symbol, unknown>)[prop] });
  const stub = (p: string, exports: Record<string, unknown>) => {
    const id = require.resolve(p);
    require.cache[id] = { id, filename: id, loaded: true, exports } as unknown as NodeJS.Module;
  };
  stub("../../config/supabase", { supabase: client });
  // CropLink keys are checked against the database in production; here the
  // test organization header stands in for a valid key's organization.
  stub("../../middleware/requireIntegrationKey", {
    requireIntegrationKey: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.organizationId = String(req.headers["x-test-org"] ?? ORG);
      next();
    }
  });
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { yieldEntriesRouter } = require("../yieldEntries") as typeof import("../yieldEntries");
  const { mobileDailyYieldRouter } = require("../mobileDailyYield") as typeof import("../mobileDailyYield");
  const { croplinkIntegrationRouter } = require("../croplinkIntegration") as typeof import("../croplinkIntegration");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use("/api", croplinkIntegrationRouter);
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", yieldEntriesRouter);
  app.use("/api", mobileDailyYieldRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

beforeEach(async () => {
  await resetDatabase();
});

type Opts = { org?: string; body?: unknown; method?: string };
async function call(pathname: string, { org = ORG, body, method }: Opts = {}) {
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-test-user": OWNER, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const TOTALS = ["variety_id", "year", "week", "size_kg", "total_kg", "kg_per_m2", "total_cases", "average_fruit_weight_g", "packed_date"];

// ---------------------------------------------------------------------------

test("Manual Entry: create, add to the same week, and edit store today's totals and daily breakdowns", async () => {
  const created = await call("/yield-entries", {
    body: { variety_id: RED_A, year: 2026, week: 10, size_kg: { [LG]: 100.5, [XL]: 49.5 }, average_fruit_weight_g: 180, packed_date: "2026-03-02" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(pick(created.body, TOTALS), {
    variety_id: RED_A, year: 2026, week: 10, size_kg: { [LG]: 100.5, [XL]: 49.5 },
    total_kg: 150, kg_per_m2: 0.15, total_cases: 29.126213592233007, average_fruit_weight_g: 180, packed_date: "2026-03-02"
  });

  // A second entry for the same variety and week is added to it, not stored separately.
  const merged = await call("/yield-entries", {
    body: { variety_id: RED_A, year: 2026, week: 10, size_kg: { [LG]: 20 }, average_fruit_weight_g: 200, packed_date: "2026-03-03" }
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.id, created.body.id);
  assert.equal(merged.body.message, "Added to existing Alpha Red Week 10 entry.");
  assert.deepEqual(pick(merged.body, TOTALS), {
    variety_id: RED_A, year: 2026, week: 10, size_kg: { [LG]: 120.5, [XL]: 49.5 },
    total_kg: 170, kg_per_m2: 0.17, total_cases: 33.009708737864074, average_fruit_weight_g: 182.14285714285714, packed_date: "2026-03-02"
  });
  const breakdowns = async (entryId: string) =>
    (await db.query<Record<string, unknown>>(
      "select packed_date, size_kg, total_kg, average_fruit_weight_g from yield_entry_daily_breakdown where yield_entry_id = $1 order by packed_date",
      [entryId]
    )).rows;
  assert.deepEqual(await breakdowns(created.body.id), [
    { packed_date: "2026-03-02", size_kg: { [LG]: 100.5, [XL]: 49.5 }, total_kg: 150, average_fruit_weight_g: 180 },
    { packed_date: "2026-03-03", size_kg: { [LG]: 20 }, total_kg: 20, average_fruit_weight_g: 200 }
  ]);

  // Editing replaces the entry's totals and its breakdowns with one row.
  const edited = await call(`/yield-entries/${created.body.id}`, {
    method: "PUT",
    body: { variety_id: YEL, year: 2026, week: 11, size_kg: { [XL]: 80, [MD]: 20 }, average_fruit_weight_g: null, packed_date: "2026-03-09" }
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(pick(edited.body, TOTALS), {
    variety_id: YEL, year: 2026, week: 11, size_kg: { [XL]: 80, [MD]: 20 },
    total_kg: 100, kg_per_m2: 0.125, total_cases: 20, average_fruit_weight_g: null, packed_date: "2026-03-09"
  });
  assert.deepEqual(await breakdowns(created.body.id), [
    { packed_date: "2026-03-09", size_kg: { [XL]: 80, [MD]: 20 }, total_kg: 100, average_fruit_weight_g: null }
  ]);
});

test("Manual Entry: a variety with no area or case weight stores 0 kg/m² and 0 cases; another organization's variety is refused", async () => {
  const zero = await call("/yield-entries", { body: { variety_id: ZERO, year: 2026, week: 10, size_kg: { [LG]: 10 } } });
  assert.equal(zero.status, 201, JSON.stringify(zero.body));
  assert.deepEqual(pick(zero.body, ["total_kg", "kg_per_m2", "total_cases", "average_fruit_weight_g", "packed_date"]), {
    total_kg: 10, kg_per_m2: 0, total_cases: 0, average_fruit_weight_g: null, packed_date: null
  });

  const foreign = await call("/yield-entries", { org: OTHER_ORG, body: { variety_id: RED_A, year: 2026, week: 10, size_kg: { [LG]: 10 } } });
  assert.deepEqual(foreign, { status: 400, body: { message: "Selected variety was not found" } });
  assert.equal((await db.query("select * from yield_entries where organization_id = $1", [OTHER_ORG])).rows.length, 0);
});

test("Yield Analytics summary: per-variety kg, kg-weighted fruit weight, kg/m² and size shares, this organization only", async () => {
  await db.query(
    `insert into yield_entries (organization_id, variety_id, year, week, size_kg, total_kg, average_fruit_weight_g) values
      ($1, $2, 2026, 1, $7, 100, 200),
      ($1, $2, 2026, 2, $8, 50, null),
      ($1, $3, 2026, 1, $9, 30, 150),
      ($1, $4, 2026, 1, $10, 20, 100),
      ($1, $5, 2026, 1, '{}', 0, 300),
      ($11, $6, 2026, 1, $12, 999, 250)`,
    [ORG, RED_A, RED_B, ORA_OLD, ZERO, OTHER_RED,
      { [LG]: 60, [XL]: 40 }, { [LG]: 50 }, { [MD]: 30 }, { [XL]: 20 }, OTHER_ORG, { [OTHER_SIZE]: 999 }]
  );

  const summary = await call("/yield-analytics/summary");
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.deepEqual(summary.body.sizes.map((s: any) => [s.id, s.name, s.sort_order]), [[LG, "LG", 1], [XL, "XL", 2], [MD, "MD", 3]]);
  assert.deepEqual(summary.body.rows, [
    { variety_id: RED_A, variety_name: "Alpha Red", entries_count: 2, total_kg: 150, avg_fruit_weight_g: 200, kg_per_m2: 0.15,
      size_pct: { [LG]: 73.33333333333333, [XL]: 26.666666666666668, [MD]: 0 } },
    { variety_id: RED_B, variety_name: "Bravo Red", entries_count: 1, total_kg: 30, avg_fruit_weight_g: 150, kg_per_m2: 0.06,
      size_pct: { [LG]: 0, [XL]: 0, [MD]: 100 } },
    { variety_id: ORA_OLD, variety_name: "Delta Orange", entries_count: 1, total_kg: 20, avg_fruit_weight_g: 100, kg_per_m2: 0.06666666666666667,
      size_pct: { [LG]: 0, [XL]: 100, [MD]: 0 } },
    { variety_id: ZERO, variety_name: "Echo Yellow", entries_count: 1, total_kg: 0, avg_fruit_weight_g: null, kg_per_m2: null,
      size_pct: { [LG]: 0, [XL]: 0, [MD]: 0 } }
  ]);
});

test("Colour case totals: kg = cases × case weight; kg/m² over active varieties of that colour; options list active colours", async () => {
  assert.deepEqual((await call("/case-entry-options")).body, { colors: ["red", "yellow"] });
  assert.deepEqual((await call("/case-entry-options", { org: OTHER_ORG })).body, { colors: ["green", "red"] });

  const fields = ["color", "year", "week", "total_cases", "case_weight_kg", "total_kg", "kg_per_m2", "color_area_m2"];
  const red = await call("/color-case-entries", { body: { color: "Red ", year: 2026, week: 5, total_cases: 100, case_weight_kg: 5.15 } });
  assert.equal(red.status, 201, JSON.stringify(red.body));
  assert.deepEqual(pick(red.body, fields), {
    color: "red", year: 2026, week: 5, total_cases: 100, case_weight_kg: 5.15, total_kg: 515, kg_per_m2: 0.3433333333333333, color_area_m2: 1500
  });
  // Orange's only variety is inactive, so it has no area.
  const orange = await call("/color-case-entries", { body: { color: "orange", year: 2026, week: 5, total_cases: 10, case_weight_kg: 5.15 } });
  assert.deepEqual(pick(orange.body, fields), {
    color: "orange", year: 2026, week: 5, total_cases: 10, case_weight_kg: 5.15, total_kg: 51.5, kg_per_m2: 0, color_area_m2: 0
  });
  const yellow = await call("/color-case-entries", { body: { color: "yellow", year: 2026, week: 5, total_cases: 50, case_weight_kg: 5 } });
  assert.deepEqual(pick(yellow.body, fields), {
    color: "yellow", year: 2026, week: 5, total_cases: 50, case_weight_kg: 5, total_kg: 250, kg_per_m2: 0.3125, color_area_m2: 800
  });

  const edited = await call(`/color-case-entries/${red.body.id}`, { method: "PUT", body: { color: "red", year: 2026, week: 5, total_cases: 200, case_weight_kg: 5 } });
  assert.deepEqual(pick(edited.body, fields), {
    color: "red", year: 2026, week: 5, total_cases: 200, case_weight_kg: 5, total_kg: 1000, kg_per_m2: 0.6666666666666666, color_area_m2: 1500
  });

  // One row per colour and week.
  const duplicate = await call("/color-case-entries", { body: { color: "red", year: 2026, week: 5, total_cases: 1, case_weight_kg: 5 } });
  assert.equal(duplicate.status, 500);

  assert.deepEqual((await call("/color-case-entries")).body.map((r: any) => r.color).sort(), ["orange", "red", "yellow"]);
  assert.deepEqual((await call("/color-case-entries", { org: OTHER_ORG })).body, []);
  assert.equal((await call("/color-case-entries", { body: { color: "purple", year: 2026, week: 5, total_cases: 1, case_weight_kg: 5 } })).status, 400);
});

test("Daily Yield Projection: this week's samples × linked stems, cases by kg per case or by bins, totals by colour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-29T12:00:00Z") }); // ISO 2026-W44
  await db.query(`insert into greenhouse_groups values ($1, $3, 'Phase 1'), ($2, $3, 'Phase 2')`, [G1, G2, ORG]);
  await db.query(
    `insert into greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant) values
      ($1, $2, 1, 10, 3, 2), ($1, $2, 2, 10, 3, 2), ($1, $2, 3, 10, 3, 2), ($1, $2, 4, 10, 3, 2), ($1, $3, 1, 5, 4, 1)`,
    [ORG, G1, G2]
  );
  await db.query(
    `insert into greenhouse_variety_assignments values
      ($1, $2, $5, 1, 2), ($1, $2, $6, 1, 1), ($1, $3, $5, 3, 4), ($1, $4, $5, 4, 4)`,
    [ORG, RED_A, YEL, ORA_OLD, G1, G2]
  );
  await db.query(
    `insert into daily_yield_samples (organization_id, variety_id, session_year, session_week, calculated_kg_per_stem, sample_date, created_at, created_by) values
      ($1, $2, 2026, 44, 0.5, '2026-10-27', '2026-10-27T08:00:00+00:00', null),
      ($1, $2, 2026, 44, 0.7, '2026-10-28', '2026-10-28T08:00:00+00:00', null),
      ($1, $2, 2026, 43, 9.9, '2026-10-20', '2026-10-20T08:00:00+00:00', null),
      ($1, $3, 2026, 44, 0.25, '2026-10-29', '2026-10-29T07:00:00+00:00', null),
      ($1, $3, 2026, 44, -1, '2026-10-29', '2026-10-29T09:00:00+00:00', null),
      ($1, $4, 2026, 44, 0.4, '2026-10-29', '2026-10-29T07:30:00+00:00', null),
      ($5, $6, 2026, 44, 3, '2026-10-29', '2026-10-29T07:00:00+00:00', null)`,
    [ORG, RED_A, YEL, RED_B, OTHER_ORG, OTHER_RED]
  );

  assert.deepEqual((await call("/mobile/daily-yield/today-projection")).body, { hasProjection: false });

  await db.query(`insert into daily_yield_bin_settings (organization_id, cases_per_bin, picking_bin_kg, case_kg, created_at) values ($1, 38, 400, 5, '2026-01-01T00:00:00Z')`, [ORG]);
  const byCase = await call("/mobile/daily-yield/today-projection");
  assert.deepEqual(byCase.body, {
    hasProjection: true, sessionYear: 2026, sessionWeek: 44, sampledRowCount: 3,
    byVariety: [
      { varietyId: RED_A, varietyName: "Alpha Red", color: "red", projectedKg: 84, projectedCases: 16.8, sampledRowCount: 2,
        lastSampleDate: "2026-10-28", lastUpdatedAt: "2026-10-28T08:00:00+00:00", lastEnteredByName: null, lastEnteredByInitials: null },
      { varietyId: YEL, varietyName: "Charlie Yellow", color: "yellow", projectedKg: 30, projectedCases: 6, sampledRowCount: 1,
        lastSampleDate: "2026-10-29", lastUpdatedAt: "2026-10-29T07:00:00+00:00", lastEnteredByName: null, lastEnteredByInitials: null }
    ],
    byColor: [{ color: "red", totalCases: 16.8 }, { color: "yellow", totalCases: 6 }],
    grandTotal: 22.8
  });

  // The newest settings row wins; without a kg per case, cases come from bins.
  await db.query(`insert into daily_yield_bin_settings (organization_id, cases_per_bin, picking_bin_kg, case_kg, created_at) values ($1, 38, 400, null, '2026-02-01T00:00:00Z')`, [ORG]);
  const byBin = await call("/mobile/daily-yield/today-projection");
  assert.deepEqual(
    byBin.body.byVariety.map((v: any) => [v.varietyName, v.projectedKg, v.projectedCases]),
    [["Alpha Red", 84, 7.9799999999999995], ["Charlie Yellow", 30, 2.85]]
  );
  assert.deepEqual(byBin.body.byColor, [{ color: "red", totalCases: 7.9799999999999995 }, { color: "yellow", totalCases: 2.85 }]);
  assert.equal(byBin.body.grandTotal, 10.83);
});

test("CropLink v1: active varieties with colour, and harvest actuals in kg ordered by last update", async () => {
  const varieties = await call("/integrations/croplink/varieties");
  assert.deepEqual(varieties.body, {
    varieties: [
      { varietyId: RED_A, name: "Alpha Red", color: "red", active: true },
      { varietyId: RED_B, name: "Bravo Red", color: "red", active: true },
      { varietyId: YEL, name: "Charlie Yellow", color: "yellow", active: true },
      { varietyId: ZERO, name: "Echo Yellow", color: "yellow", active: true }
    ]
  });

  await db.query(
    `insert into yield_entries (organization_id, variety_id, year, week, total_kg, packed_date, updated_at) values
      ($1, $2, 2026, 2, 50.25, '2026-01-05', '2026-01-06T10:00:00Z'),
      ($1, $3, 2026, 1, 30, null, '2026-01-02T10:00:00Z'),
      ($1, $4, 2026, 1, 20, '2025-12-29', '2026-01-04T10:00:00Z'),
      ($5, $6, 2026, 1, 999, '2025-12-29', '2026-01-01T10:00:00Z')`,
    [ORG, RED_A, YEL, ORA_OLD, OTHER_ORG, OTHER_RED]
  );
  const shape = (rows: any[]) => rows.map((r) => [r.varietyName, r.year, r.week, r.harvestDate, r.harvestKg, Date.parse(r.updatedAt)]);
  const all = await call("/integrations/croplink/harvest-actuals");
  assert.deepEqual(shape(all.body.harvestActuals), [
    ["Charlie Yellow", 2026, 1, null, 30, Date.parse("2026-01-02T10:00:00Z")],
    ["Delta Orange", 2026, 1, "2025-12-29", 20, Date.parse("2026-01-04T10:00:00Z")],
    ["Alpha Red", 2026, 2, "2026-01-05", 50.25, Date.parse("2026-01-06T10:00:00Z")]
  ]);
  const since = await call(`/integrations/croplink/harvest-actuals?since=${encodeURIComponent("2026-01-04T10:00:00Z")}`);
  assert.deepEqual(shape(since.body.harvestActuals), [["Alpha Red", 2026, 2, "2026-01-05", 50.25, Date.parse("2026-01-06T10:00:00Z")]]);
  assert.equal((await call("/integrations/croplink/harvest-actuals?since=not-a-date")).status, 400);
});
