// Cucumbers in pieces over HTTP (migration 0151): choose kg or pieces when
// enabling Cucumbers, change the default later, record whole-piece counts
// beside kg harvests, edit each in the unit it was recorded in, and read
// them back separately. The real products, varieties and yield-entries
// routers run on PGlite with migrations 0148–0151 applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/cucumberPieces.http.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const ORG = "11111111-1111-4111-8111-111111111111"; // grows Bell Peppers and, once enabled, Cucumbers
const PEPPER_ONLY_ORG = "22222222-2222-4222-8222-222222222222"; // never enables Cucumbers
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const SETUP_VIEWER = "aaaaaaaa-0000-4000-8000-00000000000b";
const YIELD_EDITOR = "aaaaaaaa-0000-4000-8000-00000000000c";

const RED = "b0000000-0000-4000-8000-000000000001"; // Cadalora, red, 1000 m², 5 kg cases
const YELLOW = "b0000000-0000-4000-8000-000000000002"; // Sunny, yellow, 500 m²
const OTHER_RED = "b0000000-0000-4000-8000-000000000003"; // the pepper-only organization's
const LG = "c0000000-0000-4000-8000-000000000001";
const XL = "c0000000-0000-4000-8000-000000000002";

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");
const m0148 = migration("0148_product_catalog.sql");
const m0149 = migration("0149_cucumber_product.sql");
const m0150 = migration("0150_varieties_product_required.sql");

let db: PGlite;
let server: Server;
let baseUrl: string;

async function resetDatabase() {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '');
    insert into organizations (id) values ('${ORG}'), ('${PEPPER_ONLY_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${PEPPER_ONLY_ORG}', 'owner', '{}'),
      ('${SETUP_VIEWER}', '${ORG}', 'member', '{"greenhouse_setup:view": true}'),
      ('${YIELD_EDITOR}', '${ORG}', 'member', '{"yield:edit": true}');
    -- varieties as production has them (0003 colour check included)
    create table varieties (
      id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 double precision not null default 0, case_kg double precision not null default 0,
      planting_date date, pull_out_date date,
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red' check (color in ('red', 'orange', 'yellow', 'green')),
      organization_id uuid not null references organizations(id),
      constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, area_m2, case_kg, status, color, organization_id) values
      ('${RED}', 'Cadalora', 1000, 5, 'active', 'red', '${ORG}'),
      ('${YELLOW}', 'Sunny', 500, 5, 'active', 'yellow', '${ORG}'),
      ('${OTHER_RED}', 'Foxtrot', 999, 5, 'active', 'red', '${PEPPER_ONLY_ORG}');
    -- yield_sizes as production has it before 0152 (0004 + 0018 + 0021)
    create table yield_sizes (id uuid primary key default gen_random_uuid(), organization_id uuid not null, name text not null,
      sort_order int not null default 0 check (sort_order >= 0),
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz default now(), updated_at timestamptz default now(),
      constraint yield_sizes_org_name_key unique (organization_id, name));
    alter table yield_sizes enable row level security;
    insert into yield_sizes (id, organization_id, name, sort_order) values ('${LG}', '${ORG}', 'LG', 1), ('${XL}', '${ORG}', 'XL', 2);
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
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), variety_id uuid not null references varieties(id));
    create table waste_imports (id uuid primary key default gen_random_uuid(), variety_id uuid);

    -- Historical Bell Pepper harvests, written before Cucumbers existed.
    insert into yield_entries (organization_id, variety_id, year, week, size_kg, total_kg, kg_per_m2, total_cases) values
      ('${ORG}', '${RED}', 2026, 10, '{"${LG}": 60, "${XL}": 40}', 100, 0.1, 20),
      ('${ORG}', '${YELLOW}', 2026, 10, '{"${LG}": 50}', 50, 0.1, 10),
      ('${PEPPER_ONLY_ORG}', '${OTHER_RED}', 2026, 10, '{}', 999, 1, 199.8);
  `);
  await db.exec(m0148);
  await db.exec(m0149);
  await db.exec(m0150);
}

// The shim cannot run PostgREST resource embedding; `varieties(...)` on
// yield_entries becomes the same many-to-one row through a subquery.
function withVarietyEmbeds(client: ReturnType<typeof createPgliteSupabase>) {
  return {
    ...client,
    from(table: string) {
      const builder = client.from(table);
      const select = builder.select.bind(builder);
      builder.select = (cols = "*", options?: { count?: string }) =>
        select(
          cols
            .replace(
              /varieties\(([^)]*)\)/,
              (_m, inner: string) =>
                `(select row_to_json(e) from (select ${inner} from public.varieties v where v.id = ${table}.variety_id) e) as varieties`
            )
            .replace(
              /yield_entry_daily_breakdown\(([^)]*)\)/,
              (_m, inner: string) =>
                `(select coalesce(json_agg(b), '[]') from (select ${inner} from public.yield_entry_daily_breakdown d where d.yield_entry_id = ${table}.id) b) as yield_entry_daily_breakdown`
            ),
          options
        );
      return builder;
    }
  };
}

before(async () => {
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (withVarietyEmbeds(createPgliteSupabase(db)) as Record<string | symbol, unknown>)[prop] });
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { productsRouter } = require("../products") as typeof import("../products");
  const { varietiesRouter } = require("../varieties") as typeof import("../varieties");
  const { yieldEntriesRouter } = require("../yieldEntries") as typeof import("../yieldEntries");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", productsRouter);
  app.use("/api", varietiesRouter);
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

const cucumberVariety = (name: string, extra: Record<string, unknown> = {}) => ({
  name, area_m2: 400, case_kg: 12, planting_date: "2026-02-01", pull_out_date: null, status: "active",
  product_code: "cucumber", ...extra
});
const pepperVariety = (name: string, extra: Record<string, unknown> = {}) => ({
  name, area_m2: 800, case_kg: 5, planting_date: null, pull_out_date: null, status: "active",
  product_code: "bell_pepper", color: "orange", ...extra
});

async function enableCucumbers(org = ORG) {
  const res = await call("/products/cucumber/enable", { org, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function createCucumberVariety(name = "Bonbon") {
  const res = await call("/varieties", { body: cucumberVariety(name) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const pepperTotals = async (org = ORG) =>
  (await db.query<{ variety_id: string; total_kg: number; size_kg: unknown; kg_per_m2: number; total_cases: number }>(
    "select variety_id, total_kg, size_kg, kg_per_m2, total_cases from yield_entries e where organization_id = $1 and exists (select 1 from varieties v where v.id = e.variety_id and v.product_code = 'bell_pepper') order by variety_id",
    [org]
  )).rows;


const m0151 = migration("0151_cucumber_pieces.sql");
// The server reads per-crop sizes (0152), which production applies right after 0151.
const m0152 = migration("0152_crop_yield_sizes.sql");

async function applyPieces() {
  await db.exec(m0151);
  await db.exec(m0152);
}

async function setDefaultUnit(unit: string, { org = ORG, user = OWNER }: { org?: string; user?: string } = {}) {
  return call("/products/cucumber", { method: "PATCH", org, user, body: { default_unit_code: unit } });
}

const pieceEntry = (varietyId: string, pieces: unknown, extra: Record<string, unknown> = {}) => ({
  variety_id: varietyId, year: 2026, week: 33, packed_date: "2026-08-12", unit_code: "pcs", total_pieces: pieces, ...extra
});
const kgEntry = (varietyId: string, kg: number, extra: Record<string, unknown> = {}) => ({
  variety_id: varietyId, year: 2026, week: 33, packed_date: "2026-08-12", size_kg: {}, total_kg: kg, average_fruit_weight_g: null, ...extra
});

const pieceRows = async (org = ORG) =>
  (await db.query<{ variety_id: string; week: number; total_pieces: number; pieces_per_m2: string | null }>(
    "select variety_id, week, total_pieces, pieces_per_m2::text from yield_piece_entries where organization_id = $1 order by week, variety_id",
    [org]
  )).rows;
const kgRows = async (org = ORG) =>
  (await db.query<{ variety_id: string; week: number; total_kg: number; size_kg: unknown }>(
    "select variety_id, week, total_kg, size_kg from yield_entries where organization_id = $1 order by week, variety_id",
    [org]
  )).rows;

test("Products: Cucumbers can be enabled in kg or pieces; Bell Peppers stays kg only", async () => {
  await applyPieces();
  const before = (await call("/products")).body;
  assert.deepEqual(before.available.map((p: any) => [p.code, p.defaultUnit.code, p.supportedUnits.map((u: any) => [u.code, u.name])]), [
    ["cucumber", "kg", [["kg", "Kilograms"], ["pcs", "Pieces"]]]
  ]);
  assert.deepEqual(before.products.map((p: any) => [p.code, p.defaultUnit.code, p.supportedUnits.map((u: any) => u.code)]), [
    ["bell_pepper", "kg", ["kg"]]
  ]);

  // An unsupported unit is refused before anything is saved.
  assert.deepEqual(await call("/products/cucumber/enable", { body: { unit_code: "lb" } }), {
    status: 400, body: { message: "Cucumbers can't be recorded in lb." }
  });
  assert.equal((await call("/products")).body.products.length, 1);

  const enabled = await call("/products/cucumber/enable", { body: { unit_code: "pcs" } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.deepEqual(enabled.body.products.map((p: any) => [p.code, p.defaultUnit.code]), [["bell_pepper", "kg"], ["cucumber", "pcs"]]);

  // Bell Peppers can't be switched to pieces: by the route, and by the database.
  assert.deepEqual(await call("/products/bell_pepper", { method: "PATCH", body: { default_unit_code: "pcs" } }), {
    status: 400, body: { message: "Bell Peppers can't be recorded in Pieces (pcs)." }
  });
  await assert.rejects(
    db.query(`update organization_products set default_unit_code = 'pcs' where organization_id = '${ORG}' and product_code = 'bell_pepper'`),
    /organization_products_supported_unit/
  );
  // A product the organization hasn't enabled can't be changed.
  assert.equal((await setDefaultUnit("pcs", { org: PEPPER_ONLY_ORG })).status, 404);
});

test("only users who can edit Setup change a crop's default unit", async () => {
  await applyPieces();
  await enableCucumbers();
  assert.equal((await setDefaultUnit("pcs", { user: SETUP_VIEWER })).status, 403);
  assert.equal((await setDefaultUnit("pcs", { user: YIELD_EDITOR })).status, 403);
  assert.deepEqual(await call("/products/cucumber", { method: "PATCH", body: {} }), { status: 400, body: { message: "default_unit_code is required" } });

  const changed = await setDefaultUnit("pcs");
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.products.find((p: any) => p.code === "cucumber").defaultUnit.code, "pcs");
  // Manual Entry learns the new unit.
  const options = (await call("/yield-entry-options")).body;
  assert.deepEqual(options.products.map((p: any) => [p.code, p.defaultUnitCode]), [["bell_pepper", "kg"], ["cucumber", "pcs"]]);
  // Turning Cucumbers off and on keeps the unit it had; choosing one on enable changes it.
  await call("/products/cucumber/disable", { body: {} });
  assert.equal((await enableCucumbers()).products.find((p: any) => p.code === "cucumber").defaultUnit.code, "pcs");
  await call("/products/cucumber/disable", { body: {} });
  const back = await call("/products/cucumber/enable", { body: { unit_code: "kg" } });
  assert.equal(back.body.products.find((p: any) => p.code === "cucumber").defaultUnit.code, "kg");
});

test("a piece count in a week that already has a kg harvest keeps both, and a second count adds to the first", async () => {
  await applyPieces();
  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  const pepperBefore = await pepperTotals();

  // Week 33 in kg, before the switch.
  const kg = await call("/yield-entries", { body: kgEntry(cucumber.id, 1200) });
  assert.equal(kg.status, 201, JSON.stringify(kg.body));

  await setDefaultUnit("pcs");
  const pcs = await call("/yield-entries", { body: pieceEntry(cucumber.id, 5000) });
  assert.equal(pcs.status, 201, JSON.stringify(pcs.body));
  assert.equal(pcs.body.unit_code, "pcs");

  const more = await call("/yield-entries", { body: pieceEntry(cucumber.id, 250, { packed_date: "2026-08-13" }) });
  assert.equal(more.status, 200, JSON.stringify(more.body));
  assert.match(more.body.message, /Added to existing Bonbon Week 33 piece count/);

  // 400 m²: 5250 / 400 = 13.125 pieces per m²; the kg row is untouched.
  assert.deepEqual(await pieceRows(), [{ variety_id: cucumber.id, week: 33, total_pieces: 5250, pieces_per_m2: "13.125" }]);
  assert.deepEqual((await kgRows()).filter((r) => r.variety_id === cucumber.id), [{ variety_id: cucumber.id, week: 33, total_kg: 1200, size_kg: {} }]);
  assert.deepEqual(await pepperTotals(), pepperBefore);
});

test("new harvests use the crop's default unit; whole pieces only; a count carries no weight", async () => {
  await applyPieces();
  await enableCucumbers();
  const cucumber = await createCucumberVariety();

  // Default kg: a piece count is refused, kg works (also from a client that sends no unit).
  assert.deepEqual(await call("/yield-entries", { body: pieceEntry(cucumber.id, 10) }), {
    status: 400, body: { message: "New Cucumbers harvests are recorded in Kilograms (kg). Reload the page and enter it again." }
  });
  await setDefaultUnit("pcs");
  // Default pieces: kg is refused, even from an older client.
  assert.deepEqual(await call("/yield-entries", { body: kgEntry(cucumber.id, 100) }), {
    status: 400, body: { message: "New Cucumbers harvests are recorded in Pieces (pcs). Reload the page and enter it again." }
  });

  for (const [bad, message] of [
    [12.5, "total_pieces must be a whole number of 0 or more"],
    [-1, "total_pieces must be a whole number of 0 or more"],
    ["lots", "total_pieces must be a whole number of 0 or more"]
  ] as const) {
    assert.deepEqual(await call("/yield-entries", { body: pieceEntry(cucumber.id, bad) }), { status: 400, body: { message } });
  }
  assert.deepEqual(await call("/yield-entries", { body: pieceEntry(cucumber.id, null) }), { status: 400, body: { message: "total_pieces is required" } });
  assert.deepEqual(await call("/yield-entries", { body: pieceEntry(cucumber.id, 10, { total_kg: 4 }) }), {
    status: 400, body: { message: "A piece count has no kg; send total_pieces" }
  });
  assert.deepEqual(await call("/yield-entries", { body: pieceEntry(cucumber.id, 10, { average_fruit_weight_g: 300 }) }), {
    status: 400, body: { message: "A piece count has no average fruit weight" }
  });
  // Bell Peppers are unchanged: kg only.
  assert.deepEqual(await call("/yield-entries", { body: { ...pieceEntry(RED, 10) } }), {
    status: 400, body: { message: "New Bell Peppers harvests are recorded in Kilograms (kg). Reload the page and enter it again." }
  });
  assert.deepEqual(await pieceRows(), []);
});

test("an old harvest is edited in the unit it was recorded in", async () => {
  await applyPieces();
  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  const kg = (await call("/yield-entries", { body: kgEntry(cucumber.id, 1200) })).body;
  await setDefaultUnit("pcs");
  const pcs = (await call("/yield-entries", { body: pieceEntry(cucumber.id, 800, { week: 34 }) })).body;

  // The kg harvest is still edited in kg after the switch.
  const editedKg = await call(`/yield-entries/${kg.id}`, { method: "PUT", body: kgEntry(cucumber.id, 1300) });
  assert.equal(editedKg.status, 200, JSON.stringify(editedKg.body));
  assert.equal(Number(editedKg.body.total_kg), 1300);
  assert.deepEqual(await call(`/yield-entries/${kg.id}`, { method: "PUT", body: pieceEntry(cucumber.id, 9) }), {
    status: 400, body: { message: "This harvest was recorded in Kilograms (kg) and is edited in Kilograms (kg)." }
  });

  // The piece count is edited in pieces, even after switching back to kg.
  await setDefaultUnit("kg");
  const editedPcs = await call(`/yield-entries/${pcs.id}`, { method: "PUT", body: pieceEntry(cucumber.id, 1000, { week: 34 }) });
  assert.equal(editedPcs.status, 200, JSON.stringify(editedPcs.body));
  assert.deepEqual([editedPcs.body.total_pieces, Number(editedPcs.body.pieces_per_m2)], [1000, 2.5]);
  assert.deepEqual(await call(`/yield-entries/${pcs.id}`, { method: "PUT", body: kgEntry(cucumber.id, 5, { week: 34, unit_code: "kg" }) }), {
    status: 400, body: { message: "This harvest was recorded in Pieces (pcs) and is edited in Pieces (pcs)." }
  });
  assert.deepEqual(await call(`/yield-entries/${pcs.id}`, { method: "PUT", body: pieceEntry(cucumber.id, 1.5, { week: 34 }) }), {
    status: 400, body: { message: "total_pieces must be a whole number of 0 or more" }
  });
  // Moving a count onto a week that already has one is refused, not merged.
  const other = (await call("/yield-entries", { body: kgEntry(cucumber.id, 1, { week: 40 }) })).body;
  void other;
  await setDefaultUnit("pcs");
  const week35 = (await call("/yield-entries", { body: pieceEntry(cucumber.id, 10, { week: 35 }) })).body;
  assert.deepEqual(await call(`/yield-entries/${week35.id}`, { method: "PUT", body: pieceEntry(cucumber.id, 10, { week: 34 }) }), {
    status: 409, body: { message: "Bonbon already has a piece count for Week 34." }
  });
  // Can't be moved onto a Bell Pepper variety.
  const toPepper = await call(`/yield-entries/${week35.id}`, { method: "PUT", body: pieceEntry(RED, 10, { week: 35 }) });
  assert.deepEqual(toPepper, { status: 400, body: { message: "Bell Peppers can't be counted in pieces" } });
  assert.equal((await call("/yield-entries/b0000000-0000-4000-8000-0000000000ff", { method: "PUT", body: pieceEntry(cucumber.id, 1) })).status, 404);

  // Deleting the piece count leaves the kg harvest.
  assert.equal((await call(`/yield-entries/${pcs.id}`, { method: "DELETE" })).status, 204);
  assert.deepEqual((await pieceRows()).map((r) => r.week), [35]);
  assert.deepEqual((await kgRows()).filter((r) => r.variety_id === cucumber.id).map((r) => [r.week, Number(r.total_kg)]), [[33, 1300], [40, 1]]);
});

test("lists: kg only unless piece counts are asked for; Recent Entries pages through both in order", async () => {
  await applyPieces();
  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  await call("/yield-entries", { body: kgEntry(cucumber.id, 1200) });
  await setDefaultUnit("pcs");
  await call("/yield-entries", { body: pieceEntry(cucumber.id, 5000) });
  await call("/yield-entries", { body: pieceEntry(cucumber.id, 40, { week: 9, packed_date: null }) });

  // Callers that know nothing of pieces (Dashboard, Pack History, iOS) still get kg only.
  const kgOnly = (await call("/yield-entries")).body;
  assert.ok(kgOnly.every((e: any) => e.unit_code === "kg" && typeof e.total_kg !== "object"));
  assert.equal(kgOnly.length, 3);
  assert.equal((await call("/yield-entries/recent?limit=50")).body.entries.length, 3);

  const all = (await call("/yield-entries?units=all")).body;
  assert.deepEqual(all.map((e: any) => e.unit_code).sort(), ["kg", "kg", "kg", "pcs", "pcs"]);
  const count = all.find((e: any) => e.unit_code === "pcs" && e.week === 33);
  assert.deepEqual(
    [count.variety_name, count.product_code, count.total_pieces, count.pieces_per_m2, count.total_kg, count.kg_per_m2, count.average_fruit_weight_g],
    ["Bonbon", "cucumber", 5000, 12.5, null, null, null]
  );
  assert.equal((await call("/yield-entries?units=all&year=2026&week=33")).body.length, 2);

  // One page at a time, two rows per page: every row exactly once, newest week first.
  const seen: Array<[number, string, string]> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const page: any = (await call(`/yield-entries/recent?units=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body;
    seen.push(...page.entries.map((e: any) => [e.week, e.unit_code, e.id] as [number, string, string]));
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  assert.equal(new Set(seen.map((s) => s[2])).size, 5);
  assert.deepEqual(seen.map((s) => s[0]), [...seen.map((s) => s[0])].sort((a, b) => b - a));
  assert.deepEqual(seen.filter((s) => s[0] === 33).map((s) => s[1]).sort(), ["kg", "pcs"]);
});

test("Weekly by Variety: piece counts come separately and only when asked for", async () => {
  await applyPieces();
  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  await call("/yield-entries", { body: kgEntry(cucumber.id, 1200) });
  await setDefaultUnit("pcs");
  await call("/yield-entries", { body: pieceEntry(cucumber.id, 5000) });
  await call("/yield-entries", { body: pieceEntry(cucumber.id, 300, { year: 2027, week: 2 }) });

  const kgOnly = (await call("/yield-entries/weekly-by-variety")).body;
  assert.equal("pieceEntries" in kgOnly, false);
  assert.deepEqual(kgOnly.years, [2026]);

  const both = (await call("/yield-entries/weekly-by-variety?units=all&year=2026")).body;
  assert.deepEqual(both.years, [2027, 2026]);
  assert.deepEqual(both.pieceEntries, [{ variety_id: cucumber.id, week: 33, total_pieces: 5000 }]);
  assert.equal(both.pieceEntryCount, 1);
  assert.ok(both.entries.some((e: any) => e.variety_id === cucumber.id && e.total_kg === 1200));

  // A year with piece counts only.
  const only = (await call("/yield-entries/weekly-by-variety?units=all")).body;
  assert.deepEqual([only.year, only.entryCount, only.pieceEntryCount], [2027, 0, 1]);
  assert.deepEqual(only.varieties.map((v: any) => [v.name, v.productCode]), [["Bonbon", "cucumber"]]);
});

test("the database refuses piece counts for Bell Peppers or another organization, and locks the product", async () => {
  await applyPieces();
  await enableCucumbers();
  const cucumber = await createCucumberVariety();

  await assert.rejects(
    db.query(`insert into yield_piece_entries (organization_id, variety_id, year, week, total_pieces) values ('${ORG}', '${RED}', 2026, 1, 5)`),
    /Bell Peppers can't be counted in pieces/
  );
  await assert.rejects(
    db.query(`insert into yield_piece_entries (organization_id, variety_id, year, week, total_pieces) values ('${PEPPER_ONLY_ORG}', '${cucumber.id}', 2026, 1, 5)`),
    /must be for a variety of its own organization/
  );
  await assert.rejects(
    db.query(`insert into yield_piece_entries (organization_id, variety_id, year, week, total_pieces) values ('${ORG}', '${cucumber.id}', 2026, 1, -1)`),
    /check/
  );
  // The pepper-only organization can't record pieces through the API either.
  assert.equal((await call("/yield-entries", { org: PEPPER_ONLY_ORG, body: pieceEntry(OTHER_RED, 5) })).status, 400);

  await db.query(`insert into yield_piece_entries (organization_id, variety_id, year, week, total_pieces) values ('${ORG}', '${cucumber.id}', 2026, 1, 5)`);
  await assert.rejects(
    db.query(`update varieties set product_code = 'bell_pepper', color = 'red' where id = '${cucumber.id}'`),
    /recorded harvests, so its product can't be changed/
  );
  // 0151 re-runs cleanly and changes nothing.
  await db.exec(m0151);
  assert.deepEqual((await pieceRows()).length, 1);
  const units = (await db.query("select product_code, unit_code from catalog_product_units order by 1, 2")).rows;
  assert.deepEqual(units, [
    { product_code: "bell_pepper", unit_code: "kg" },
    { product_code: "cucumber", unit_code: "kg" },
    { product_code: "cucumber", unit_code: "pcs" }
  ]);
});
