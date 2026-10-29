// Runs supabase/migrations/0148_product_catalog.sql verbatim in an in-process
// Postgres (PGlite) on a production-shaped schema and checks: every variety
// becomes Bell Peppers without any existing row being rewritten, every
// organization (and every new one) has Bell Peppers in kg, the product rules,
// privileges, that a second run changes nothing, and the documented rollback.
// Run: node --require tsx/cjs --test src/__tests__/migration0148.pglite.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_EMPTY = "33333333-3333-4333-8333-333333333333";
const RED = "b0000000-0000-4000-8000-000000000001";
const YELLOW_OLD = "b0000000-0000-4000-8000-000000000002";
const B_ORANGE = "b0000000-0000-4000-8000-000000000003";

const m0148 = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0148_product_catalog.sql"), "utf8");
const rollback = m0148
  .slice(m0148.indexOf("-- ROLLBACK"))
  .split("\n")
  .filter((line) => line.startsWith("-- ") && !line.startsWith("-- ROLLBACK"))
  .map((line) => line.slice(3))
  .join("\n");

const ORIGINAL_VARIETY_COLUMNS = "id, organization_id, name, area_m2, case_kg, planting_date, pull_out_date, status, color, created_at, updated_at";

let db: PGlite;
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const fails = async (sql: string, pattern: RegExp, params: unknown[] = []) => {
  await assert.rejects(db.query(sql, params), (e: Error) => pattern.test(e.message), `expected ${pattern}`);
};

const history = async () =>
  JSON.stringify([
    await all(`select ${ORIGINAL_VARIETY_COLUMNS} from varieties order by id`),
    await all(`select * from yield_entries order by id`),
    await all(`select * from daily_yield_samples order by id`)
  ]);
const newObjects = async () =>
  JSON.stringify([
    await all(`select * from measurement_units order by code`),
    await all(`select * from catalog_products order by code`),
    await all(`select * from catalog_product_units order by 1, 2`),
    await all(`select organization_id, product_code, default_unit_code, status from organization_products order by 1, 2`),
    await all(`select id, product_code from varieties order by id`)
  ]);

beforeEach(async () => {
  db = new PGlite();
  // The production shape of the tables 0148 touches (migrations 0002-0021,
  // 0137): varieties with its colour and status checks, history pointing at
  // it, and the 0137 privileges authenticated keeps on varieties.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create table organizations (id uuid primary key, name text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    insert into organizations (id, name) values ('${ORG_A}', 'A'), ('${ORG_B}', 'B'), ('${ORG_EMPTY}', 'Empty');
    create table varieties (
      id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 numeric not null default 0 check (area_m2 >= 0), case_kg numeric not null default 0 check (case_kg >= 0),
      planting_date date, pull_out_date date,
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red' check (color in ('red', 'orange', 'yellow', 'green')),
      organization_id uuid not null references organizations(id),
      constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, area_m2, case_kg, status, color, organization_id, created_at, updated_at) values
      ('${RED}', 'Cadalora', 31397, 5.15, 'active', 'red', '${ORG_A}', '2026-01-05T08:00:00Z', '2026-02-01T08:00:00Z'),
      ('${YELLOW_OLD}', 'Levente', 0, 5.15, 'inactive', 'yellow', '${ORG_A}', '2026-01-05T08:00:00Z', '2026-06-01T08:00:00Z'),
      ('${B_ORANGE}', 'Silverstone', 16644, 5.1, 'active', 'orange', '${ORG_B}', '2026-01-06T08:00:00Z', '2026-01-06T08:00:00Z');
    create table yield_entries (id uuid primary key default gen_random_uuid(), organization_id uuid references organizations(id),
      variety_id uuid references varieties(id), year int, week int, total_kg numeric, kg_per_m2 numeric, total_cases numeric);
    insert into yield_entries (organization_id, variety_id, year, week, total_kg, kg_per_m2, total_cases) values
      ('${ORG_A}', '${RED}', 2026, 10, 1500.5, 0.0478, 291.36), ('${ORG_A}', '${YELLOW_OLD}', 2026, 9, 800, 0, 155.34);
    create table daily_yield_samples (id uuid primary key default gen_random_uuid(), organization_id uuid, variety_id uuid references varieties(id), calculated_kg_per_stem numeric);
    insert into daily_yield_samples (organization_id, variety_id, calculated_kg_per_stem) values ('${ORG_A}', '${RED}', 0.31);
    revoke all on table varieties from anon, authenticated;
    grant select, insert, update, delete on table varieties to authenticated;
  `);
});

test("every existing variety becomes Bell Peppers without any existing row being rewritten; history is untouched", async () => {
  const before = await history();
  const versions = await all(`select id, xmin::text from varieties order by id`);
  await db.exec(m0148);

  assert.equal(await history(), before);
  // Same row versions: the column default filled the rows, no UPDATE ran.
  assert.deepEqual(await all(`select id, xmin::text from varieties order by id`), versions);
  assert.deepEqual(await all(`select id, product_code from varieties order by id`), [
    { id: RED, product_code: "bell_pepper" }, { id: YELLOW_OLD, product_code: "bell_pepper" }, { id: B_ORANGE, product_code: "bell_pepper" }
  ]);
});

test("the catalog holds Bell Peppers in kg, and every organization — including one with no varieties — has it enabled and active", async () => {
  await db.exec(m0148);
  assert.deepEqual(await all(`select code, name, dimension, kg_per_unit::text from measurement_units`), [
    { code: "kg", name: "Kilograms", dimension: "weight", kg_per_unit: "1" }
  ]);
  assert.deepEqual(await all(`select code, name, tracks_colour, pack_crop_type, default_unit_code, enabled_for_new_organizations from catalog_products`), [
    { code: "bell_pepper", name: "Bell Peppers", tracks_colour: true, pack_crop_type: "pepper", default_unit_code: "kg", enabled_for_new_organizations: true }
  ]);
  assert.deepEqual(await all(`select product_code, unit_code from catalog_product_units`), [{ product_code: "bell_pepper", unit_code: "kg" }]);
  assert.deepEqual(await all(`select organization_id, product_code, default_unit_code, status from organization_products order by organization_id`), [
    { organization_id: ORG_A, product_code: "bell_pepper", default_unit_code: "kg", status: "active" },
    { organization_id: ORG_B, product_code: "bell_pepper", default_unit_code: "kg", status: "active" },
    { organization_id: ORG_EMPTY, product_code: "bell_pepper", default_unit_code: "kg", status: "active" }
  ]);
});

test("a new organization gets Bell Peppers automatically, and its varieties default to it", async () => {
  await db.exec(m0148);
  const NEW = "44444444-4444-4444-8444-444444444444";
  await db.query(`insert into organizations (id, name) values ($1, 'New farm')`, [NEW]);
  assert.deepEqual(await all(`select product_code, default_unit_code, status from organization_products where organization_id = $1`, [NEW]), [
    { product_code: "bell_pepper", default_unit_code: "kg", status: "active" }
  ]);
  await db.query(`insert into varieties (name, organization_id) values ('First', $1)`, [NEW]);
  assert.deepEqual(await all(`select product_code from varieties where organization_id = $1`, [NEW]), [{ product_code: "bell_pepper" }]);
});

test("an organization keeps at least one active product, and an organization product never moves", async () => {
  await db.exec(m0148);
  await fails(`update organization_products set status = 'inactive' where organization_id = $1`, /keep at least one active product/, [ORG_EMPTY]);
  await fails(`delete from organization_products where organization_id = $1`, /keep at least one active product/, [ORG_EMPTY]);
  await fails(`update organization_products set organization_id = $1 where organization_id = $2`, /cannot move/, [ORG_EMPTY, ORG_B]);
  // Removing the organization itself removes its products.
  await db.query(`delete from organizations where id = $1`, [ORG_EMPTY]);
  assert.deepEqual(await all(`select count(*)::int n from organization_products where organization_id = $1`, [ORG_EMPTY]), [{ n: 0 }]);
});

test("with a second product: active varieties block deactivation, inactive products take no active varieties, products with varieties stay", async () => {
  await db.exec(m0148);
  // A future catalog product, added the way a later migration would.
  await db.exec(`
    begin;
    insert into measurement_units (code, name, dimension, kg_per_unit) values ('piece', 'Pieces', 'count', null);
    insert into catalog_products (code, name, default_unit_code) values ('test_crop', 'Test Crop', 'piece');
    insert into catalog_product_units values ('test_crop', 'piece');
    commit;
    insert into organization_products (organization_id, product_code, default_unit_code) values ('${ORG_A}', 'test_crop', 'piece');
  `);

  await fails(`update organization_products set status = 'inactive' where organization_id = $1 and product_code = 'bell_pepper'`, /active varieties/, [ORG_A]);
  await db.query(`update varieties set status = 'inactive' where id = $1`, [RED]);
  await db.query(`update organization_products set status = 'inactive' where organization_id = $1 and product_code = 'bell_pepper'`, [ORG_A]);
  await fails(`update varieties set status = 'active' where id = $1`, /needs an active product/, [RED]);
  await fails(`insert into varieties (name, organization_id, product_code) values ('New', $1, 'bell_pepper')`, /needs an active product/, [ORG_A]);
  await db.query(`insert into varieties (name, organization_id, product_code, status) values ('Kept inactive', $1, 'bell_pepper', 'inactive')`, [ORG_A]);
  // A product that still has varieties can't be removed, even when inactive.
  await fails(`delete from organization_products where organization_id = $1 and product_code = 'bell_pepper'`, /violates foreign key constraint/, [ORG_A]);
  // The second product can't be deactivated now: it's the only active one left.
  await fails(`update organization_products set status = 'inactive' where organization_id = $1 and product_code = 'test_crop'`, /keep at least one active product/, [ORG_A]);
});

test("a variety can only use a product its own organization enabled, and a default unit must be supported", async () => {
  await db.exec(m0148);
  await db.exec(`
    begin;
    insert into measurement_units (code, name, dimension, kg_per_unit) values ('lb', 'Pounds', 'weight', 0.45359237);
    insert into catalog_products (code, name, default_unit_code) values ('test_crop', 'Test Crop', 'lb');
    insert into catalog_product_units values ('test_crop', 'lb');
    commit;
    insert into organization_products (organization_id, product_code, default_unit_code) values ('${ORG_B}', 'test_crop', 'lb');
  `);
  // test_crop is enabled for B, not A. An active variety is refused by the
  // active-product rule first; an inactive one reaches the foreign key.
  await fails(`insert into varieties (name, organization_id, product_code) values ('X', $1, 'test_crop')`, /needs an active product/, [ORG_A]);
  await fails(`insert into varieties (name, organization_id, product_code, status) values ('X', $1, 'test_crop', 'inactive')`, /varieties_organization_product_fkey/, [ORG_A]);
  await fails(`insert into varieties (name, organization_id, product_code, status) values ('X', $1, 'not_a_product', 'inactive')`, /varieties_organization_product_fkey/, [ORG_A]);
  await db.query(`insert into varieties (name, organization_id, product_code) values ('Allowed', $1, 'test_crop')`, [ORG_B]);
  // Bell Peppers supports kg only.
  await fails(`update organization_products set default_unit_code = 'lb' where product_code = 'bell_pepper'`, /organization_products_supported_unit/);
  await fails(`insert into catalog_products (code, name, default_unit_code) values ('bad', 'Bad', 'lb')`, /catalog_products_default_unit_supported/);
});

test("server-only privileges; authenticated keeps its existing variety privileges and the rules still apply to it", async () => {
  await db.exec(m0148);
  for (const t of ["measurement_units", "catalog_products", "catalog_product_units", "organization_products"]) {
    for (const r of ["anon", "authenticated"]) {
      assert.deepEqual(await all(`select has_table_privilege($1, $2, 'SELECT') s, has_table_privilege($1, $2, 'INSERT') i`, [r, `public.${t}`]), [{ s: false, i: false }], `${r} on ${t}`);
    }
    assert.deepEqual(await all(`select has_table_privilege('service_role', $1, 'SELECT,INSERT,UPDATE,DELETE') ok, (select relrowsecurity from pg_class where oid = $1::regclass) rls`, [`public.${t}`]), [{ ok: true, rls: true }]);
  }
  // The variety rule reads organization_products as its owner, so a role that
  // can't read that table still edits varieties exactly as before.
  await db.exec(`set role authenticated`);
  await db.query(`update varieties set area_m2 = 31400, status = 'active' where id = $1`, [RED]);
  await db.exec(`reset role`);
  assert.deepEqual(await all(`select area_m2::text from varieties where id = $1`, [RED]), [{ area_m2: "31400" }]);
});

test("a second run changes nothing", async () => {
  await db.exec(m0148);
  const once = await newObjects();
  const historyOnce = await history();
  await db.exec(m0148);
  assert.equal(await newObjects(), once);
  assert.equal(await history(), historyOnce);
});

test("the documented rollback removes only what 0148 added", async () => {
  const before = await history();
  const columns = async () => (await all<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'varieties' order by ordinal_position`)).map((c) => c.column_name);
  const originalColumns = await columns();
  await db.exec(m0148);
  await db.exec(rollback);
  assert.deepEqual(await columns(), originalColumns);
  assert.equal(await history(), before);
  assert.deepEqual(await all(`select count(*)::int n from pg_class where relname in ('measurement_units', 'catalog_products', 'catalog_product_units', 'organization_products')`), [{ n: 0 }]);
  assert.deepEqual(await all(`select count(*)::int n from pg_trigger where not tgisinternal`), [{ n: 0 }]);
  // And the migration applies again afterwards.
  await db.exec(m0148);
});
