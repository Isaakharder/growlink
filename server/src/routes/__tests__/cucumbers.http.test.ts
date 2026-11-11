// Cucumbers end to end over HTTP: enable Cucumbers → create a cucumber
// variety → enter, add to, edit and delete a harvest in kg → read it back
// for Yield Analytics, next to an organization's Bell Peppers. The real
// products, varieties and yield-entries routers and permission middleware run
// on PGlite with migrations 0148, 0149 and 0150 applied verbatim. No server,
// Docker, network or credentials.
// Run: node --require tsx/cjs --test src/routes/__tests__/cucumbers.http.test.ts
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
// The server reads per-crop sizes (0152, which needs 0151), as production will have them.
const m0151 = migration("0151_cucumber_pieces.sql");
const m0152 = migration("0152_crop_yield_sizes.sql");

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
  await db.exec(m0151);
  await db.exec(m0152);
}

// The shim cannot run PostgREST resource embedding; `varieties(...)` on
// yield_entries becomes the same many-to-one row through a subquery.
function withVarietyEmbeds(client: ReturnType<typeof createPgliteSupabase>) {
  return {
    ...client,
    from(table: string) {
      const builder = client.from(table);
      const select = builder.select.bind(builder);
      builder.select = (cols = "*") =>
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
            )
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

test("Cucumbers is off by default: in the catalog, not enabled, and nothing cucumber can be created", async () => {
  const products = (await call("/products")).body;
  assert.deepEqual(products.products.map((p: any) => p.code), ["bell_pepper"]);
  assert.deepEqual(products.available.map((p: any) => [p.code, p.name, p.defaultUnit.code, p.supportedUnits.map((u: any) => u.code)]), [
    // Pieces arrive with 0151, which this suite applies (the server reads 0152's per-crop sizes).
    ["cucumber", "Cucumbers", "kg", ["kg", "pcs"]]
  ]);

  assert.deepEqual(await call("/varieties", { body: cucumberVariety("Bonbon") }), {
    status: 400, body: { message: "product_code must be an active product enabled for your organization" }
  });
  // The database refuses it too, whatever the route does.
  await assert.rejects(
    db.query(`insert into varieties (name, product_code, organization_id) values ('Direct', 'cucumber', '${ORG}')`),
    /An active variety needs an active product|varieties_organization_product_fkey/
  );
  // Manual Entry offers only Bell Peppers.
  const options = (await call("/yield-entry-options")).body;
  assert.deepEqual(options.products.map((p: any) => p.code), ["bell_pepper"]);
});

test("only users who can edit Setup enable or turn off a product, and only for their own organization", async () => {
  assert.equal((await call("/products/cucumber/enable", { user: SETUP_VIEWER, body: {} })).status, 403);
  assert.equal((await call("/products/cucumber/enable", { user: YIELD_EDITOR, body: {} })).status, 403);
  assert.equal((await call("/products/tomato/enable", { body: {} })).status, 404);

  const enabled = await enableCucumbers();
  assert.deepEqual(enabled.products.map((p: any) => [p.code, p.status, p.defaultUnit.code, p.tracksColour, p.tracksSizes]), [
    ["bell_pepper", "active", "kg", true, true],
    ["cucumber", "active", "kg", false, false]
  ]);
  assert.deepEqual(enabled.available, []);
  // Enabling again changes nothing.
  assert.deepEqual((await enableCucumbers()).products, enabled.products);
  // The other organization is untouched.
  assert.deepEqual((await call("/products", { org: PEPPER_ONLY_ORG })).body.products.map((p: any) => p.code), ["bell_pepper"]);
  // Bell Peppers keeps its setup.
  const pepper = (await db.query("select default_unit_code, status from organization_products where organization_id = $1 and product_code = 'bell_pepper'", [ORG])).rows;
  assert.deepEqual(pepper, [{ default_unit_code: "kg", status: "active" }]);
});

test("a cucumber variety stores no colour; a Bell Pepper variety still needs one; each needs its product named", async () => {
  await enableCucumbers();

  const cucumber = await createCucumberVariety();
  assert.equal(cucumber.product_code, "cucumber");
  assert.equal(cucumber.color, null);

  assert.deepEqual(await call("/varieties", { body: cucumberVariety("Painted", { color: "green" }) }), {
    status: 400, body: { message: "Cucumbers varieties have no colour" }
  });
  assert.deepEqual(await call("/varieties", { body: pepperVariety("Plain", { color: null }) }), {
    status: 400, body: { message: "color must be red, orange, yellow, or green" }
  });
  assert.equal((await call("/varieties", { body: pepperVariety("Orangina") })).body.color, "orange");
  // With two products the client has to say which one.
  const { product_code: _omit, ...unnamed } = pepperVariety("Unnamed");
  assert.deepEqual(await call("/varieties", { body: unnamed }), { status: 400, body: { message: "product_code is required" } });

  // Editing keeps the cucumber colourless.
  const edited = await call(`/varieties/${cucumber.id}`, { method: "PUT", body: { ...cucumberVariety("Bonbon"), area_m2: 450 } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.color, edited.body.area_m2, edited.body.product_code], [null, 450, "cucumber"]);

  // The database enforces colour by product as well.
  await assert.rejects(db.query(`update varieties set color = 'green' where id = '${cucumber.id}'`), /Cucumbers variety has no colour/);
  await assert.rejects(db.query(`update varieties set color = null where id = '${RED}'`), /Bell Peppers variety needs a colour/);
  // 0150: a variety written without a product is an error, never a Bell Pepper.
  const productDefault = (await db.query("select column_default from information_schema.columns where table_name = 'varieties' and column_name = 'product_code'")).rows[0];
  assert.deepEqual(productDefault, { column_default: null });
  await assert.rejects(db.query(`insert into varieties (name, color, organization_id, status) values ('Nameless', 'red', '${ORG}', 'inactive')`), /product_code/);
});

test("Manual Entry: a cucumber harvest is a total kg — create, add to the same week, edit and delete", async () => {
  await enableCucumbers();
  const cucumber = await createCucumberVariety();

  const options = (await call("/yield-entry-options")).body;
  assert.deepEqual(options.products.map((p: any) => [p.code, p.tracksSizes]), [["bell_pepper", true], ["cucumber", false]]);
  assert.deepEqual(options.varieties.map((v: any) => [v.name, v.product_code, v.color]), [
    ["Bonbon", "cucumber", null], ["Cadalora", "bell_pepper", "red"], ["Sunny", "bell_pepper", "yellow"]
  ]);

  const created = await call("/yield-entries", {
    user: YIELD_EDITOR,
    body: { variety_id: cucumber.id, year: 2026, week: 12, packed_date: "2026-03-17", total_kg: 1200, average_fruit_weight_g: 350 }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.total_kg, created.body.size_kg, created.body.kg_per_m2, created.body.total_cases], [1200, {}, 3, 100]);

  // A second harvest in the same week adds to it, as for peppers.
  const added = await call("/yield-entries", { body: { variety_id: cucumber.id, year: 2026, week: 12, packed_date: "2026-03-18", total_kg: 600, size_kg: {}, average_fruit_weight_g: 380 } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual([added.body.total_kg, added.body.size_kg, added.body.kg_per_m2, added.body.total_cases, added.body.average_fruit_weight_g], [1800, {}, 4.5, 150, 1800 / (1200 / 350 + 600 / 380)]);
  assert.equal(added.body.message, "Added to existing Bonbon Week 12 entry.");
  const breakdowns = (await db.query("select total_kg, size_kg from yield_entry_daily_breakdown where yield_entry_id = $1 order by total_kg", [created.body.id])).rows;
  assert.deepEqual(breakdowns, [{ total_kg: 600, size_kg: {} }, { total_kg: 1200, size_kg: {} }]);

  // Edit through the same route.
  const edited = await call(`/yield-entries/${created.body.id}`, { method: "PUT", body: { variety_id: cucumber.id, year: 2026, week: 12, packed_date: "2026-03-17", total_kg: 2000, average_fruit_weight_g: null } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.total_kg, edited.body.kg_per_m2, edited.body.total_cases], [2000, 5, 2000 / 12]);

  // Listed with its product so pages can keep crops apart.
  const listed = (await call("/yield-entries?year=2026&week=12")).body;
  assert.deepEqual(listed.map((e: any) => [e.variety_name, e.product_code, e.total_kg]), [["Bonbon", "cucumber", 2000]]);

  assert.equal((await call(`/yield-entries/${created.body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await db.query("select 1 from yield_entries where id = $1", [created.body.id])).rows.length, 0);
});

test("a cucumber harvest refuses Bell Peppers sizes and needs its total; a pepper harvest is unchanged", async () => {
  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  const week = { year: 2026, week: 13, packed_date: "2026-03-24", average_fruit_weight_g: null };

  // Cucumbers may be sized (0152), but only with its own sizes: LG is a Bell Peppers size.
  assert.deepEqual(await call("/yield-entries", { body: { ...week, variety_id: cucumber.id, size_kg: { [LG]: 100 } } }), {
    status: 400, body: { message: "One or more sizes are not Cucumbers sizes." }
  });
  assert.deepEqual(await call("/yield-entries", { body: { ...week, variety_id: cucumber.id } }), { status: 400, body: { message: "total_kg is required" } });
  assert.deepEqual(await call("/yield-entries", { body: { ...week, variety_id: cucumber.id, total_kg: -1 } }), { status: 400, body: { message: "total_kg must be 0 or greater" } });
  // The database refuses another crop's sizes on a cucumber harvest from any writer (imports included).
  await assert.rejects(
    db.query(`insert into yield_entries (organization_id, variety_id, year, week, size_kg, total_kg) values ('${ORG}', '${cucumber.id}', 2026, 14, '{"${LG}": 5}', 5)`),
    /is not one of the Cucumbers sizes/
  );

  // Bell Peppers: kg per size, total summed from them, a sent total ignored — exactly as before.
  const pepper = await call("/yield-entries", { body: { ...week, variety_id: RED, size_kg: { [LG]: 30, [XL]: 20 }, total_kg: 9999 } });
  assert.equal(pepper.status, 201, JSON.stringify(pepper.body));
  assert.deepEqual([pepper.body.total_kg, pepper.body.size_kg, pepper.body.kg_per_m2, pepper.body.total_cases], [50, { [LG]: 30, [XL]: 20 }, 0.05, 10]);
  assert.deepEqual(await call("/yield-entries", { body: { ...week, week: 14, variety_id: RED } }), {
    status: 400, body: { message: "size_kg must be an object of sizeId -> kg number" }
  });
});

test("historical pepper totals don't move, and cucumber kg stays out of them", async () => {
  const before = await pepperTotals();
  const otherBefore = await pepperTotals(PEPPER_ONLY_ORG);

  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  assert.equal((await call("/yield-entries", { body: { variety_id: cucumber.id, year: 2026, week: 10, total_kg: 700, packed_date: null } })).status, 201);

  assert.deepEqual(await pepperTotals(), before);
  assert.deepEqual(await pepperTotals(PEPPER_ONLY_ORG), otherBefore);

  const summary = (await call("/yield-analytics/summary")).body;
  assert.deepEqual(summary.products.map((p: any) => [p.code, p.tracksColour, p.tracksSizes]), [["bell_pepper", true, true], ["cucumber", false, false]]);
  const byProduct = (code: string) => summary.rows.filter((r: any) => r.product_code === code).map((r: any) => [r.variety_name, r.total_kg]);
  assert.deepEqual(byProduct("bell_pepper"), [["Cadalora", 100], ["Sunny", 50]]);
  assert.deepEqual(byProduct("cucumber"), [["Bonbon", 700]]);

  // Colour case totals count pepper area only: the cucumber has no colour.
  assert.deepEqual((await call("/case-entry-options")).body, { colors: ["red", "yellow"] });
});

test("an organization without Cucumbers can't record a cucumber harvest, even with another organization's variety id", async () => {
  await enableCucumbers();
  const cucumber = await createCucumberVariety();

  assert.deepEqual(await call("/yield-entries", { org: PEPPER_ONLY_ORG, body: { variety_id: cucumber.id, year: 2026, week: 12, total_kg: 10 } }), {
    status: 400, body: { message: "Selected variety was not found" }
  });
  assert.deepEqual(await call("/varieties", { org: PEPPER_ONLY_ORG, body: cucumberVariety("Sneaky") }), {
    status: 400, body: { message: "product_code must be an active product enabled for your organization" }
  });
  assert.equal((await db.query("select 1 from yield_entries where organization_id = $1 and variety_id = $2", [PEPPER_ONLY_ORG, cucumber.id])).rows.length, 0);
});

test("a variety's product can't change once it has harvests, so no history is relabelled", async () => {
  await enableCucumbers();

  // Cadalora has 2026 W10 pepper harvests.
  assert.deepEqual(await call(`/varieties/${RED}`, { method: "PUT", body: cucumberVariety("Cadalora", { area_m2: 1000, case_kg: 5 }) }), {
    status: 409, body: { message: "This variety has recorded harvests, so its product can't be changed" }
  });
  assert.equal((await db.query<{ product_code: string }>("select product_code, color from varieties where id = $1", [RED])).rows[0].product_code, "bell_pepper");

  // A variety with no harvests yet can still be corrected.
  const fresh = await createCucumberVariety("Mistake");
  const fixed = await call(`/varieties/${fresh.id}`, { method: "PUT", body: pepperVariety("Mistake", { color: "green" }) });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual([fixed.body.product_code, fixed.body.color], ["bell_pepper", "green"]);
});

test("Cucumbers can be turned off only once its varieties are inactive; its history is kept", async () => {
  await enableCucumbers();
  const cucumber = await createCucumberVariety();
  assert.equal((await call("/yield-entries", { body: { variety_id: cucumber.id, year: 2026, week: 11, total_kg: 50 } })).status, 201);

  assert.deepEqual(await call("/products/cucumber/disable", { body: {} }), {
    status: 409, body: { message: "A product with active varieties cannot be deactivated" }
  });
  assert.equal((await call("/products/cucumber/disable", { user: SETUP_VIEWER, body: {} })).status, 403);

  assert.equal((await call(`/varieties/${cucumber.id}`, { method: "PUT", body: cucumberVariety("Bonbon", { status: "inactive" }) })).status, 200);
  const off = await call("/products/cucumber/disable", { body: {} });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(off.body.products.map((p: any) => [p.code, p.status]), [["bell_pepper", "active"], ["cucumber", "inactive"]]);

  // Off means no new cucumber harvests, and Manual Entry no longer offers it.
  assert.deepEqual(await call("/yield-entries", { body: { variety_id: cucumber.id, year: 2026, week: 12, total_kg: 5 } }), {
    status: 400, body: { message: "Cucumbers is not enabled for your organization" }
  });
  assert.deepEqual((await call("/yield-entry-options")).body.products.map((p: any) => p.code), ["bell_pepper"]);
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from yield_entries where variety_id = $1", [cucumber.id])).rows[0].n, 1);

  // Bell Peppers can't be turned off while it has active varieties either.
  assert.equal((await call("/products/bell_pepper/disable", { body: {} })).status, 409);
});
