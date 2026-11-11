// Yield sizes per crop over HTTP (migrations 0152/0153): each crop has its own
// size list and sort order, the same size name can exist under two crops,
// Manual Entry sizes a harvest only with its own crop's sizes (kg or pieces),
// a total-only harvest stays a total, combining one with a sized harvest
// keeps the unsized amount, and Bell Pepper sizes, history and imports are
// unchanged. The real routers run on PGlite with migrations 0148-0153
// applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/cropSizes.http.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const ORG = "11111111-1111-4111-8111-111111111111"; // Bell Peppers, and Cucumbers once enabled
const PEPPER_ONLY_ORG = "22222222-2222-4222-8222-222222222222"; // never enables Cucumbers
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const VIEWER = "aaaaaaaa-0000-4000-8000-00000000000b";

const RED = "b0000000-0000-4000-8000-000000000001"; // Cadalora, red pepper, 1000 m², 5 kg cases
const OTHER_RED = "b0000000-0000-4000-8000-000000000003"; // the pepper-only organization's
// Bell Pepper sizes as they exist before 0152: LG, XL, and MD (retired).
const LG = "c0000000-0000-4000-8000-000000000001";
const XL = "c0000000-0000-4000-8000-000000000002";
const MD = "c0000000-0000-4000-8000-000000000003";
const OTHER_ORG_SIZE = "c0000000-0000-4000-8000-000000000009";
// Sizes deleted before 0152 (as production has on one organization's weeks 15-19):
// the ids stay on the harvests, but no yield_sizes row exists for them.
const GONE_A = "e0000000-0000-4000-8000-00000000000a";
const GONE_B = "e0000000-0000-4000-8000-00000000000b";

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");
const MIGRATIONS = [
  "0148_product_catalog.sql",
  "0149_cucumber_product.sql",
  "0150_varieties_product_required.sql",
  "0151_cucumber_pieces.sql"
].map(migration);
const m0152 = migration("0152_crop_yield_sizes.sql");
const m0153 = migration("0153_yield_sizes_product_required.sql");

let db: PGlite;
let server: Server;
let baseUrl: string;

async function resetDatabase({ through = "0153" }: { through?: "0151" | "0152" | "0153" } = {}) {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '');
    insert into organizations (id) values ('${ORG}'), ('${PEPPER_ONLY_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${PEPPER_ONLY_ORG}', 'owner', '{}'),
      ('${VIEWER}', '${ORG}', 'member', '{"yield:view": true}');
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
      ('${OTHER_RED}', 'Foxtrot', 999, 5, 'active', 'red', '${PEPPER_ONLY_ORG}');
    -- yield_sizes as production has it before 0152 (0004 + 0018 + 0021)
    create table yield_sizes (id uuid primary key default gen_random_uuid(), organization_id uuid not null, name text not null,
      sort_order int not null default 0 check (sort_order >= 0),
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz default now(), updated_at timestamptz default now(),
      constraint yield_sizes_org_name_key unique (organization_id, name));
    alter table yield_sizes enable row level security;
    insert into yield_sizes (id, organization_id, name, sort_order, status) values
      ('${LG}', '${ORG}', 'LG', 1, 'active'), ('${XL}', '${ORG}', 'XL', 2, 'active'), ('${MD}', '${ORG}', 'MD', 3, 'inactive'),
      ('${OTHER_ORG_SIZE}', '${PEPPER_ONLY_ORG}', 'Straight', 1, 'active');
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
    create table flowmaster_size_rules (id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      raw_label text not null, action text not null, target_size_id uuid, distribute_size_ids uuid[] not null default '{}');

    -- Bell Pepper history, written before sizes had crops; week 10 carries the retired MD.
    insert into yield_entries (organization_id, variety_id, year, week, size_kg, total_kg, kg_per_m2, total_cases) values
      ('${ORG}', '${RED}', 2026, 10, '{"${LG}": 60, "${XL}": 40, "${MD}": 5}', 105, 0.105, 21),
      ('${ORG}', '${RED}', 2026, 11, '{"${LG}": 50}', 50, 0.05, 10),
      ('${ORG}', '${RED}', 2026, 12, '{"${GONE_A}": 30, "${GONE_B}": 20}', 50, 0.05, 10),
      ('${PEPPER_ONLY_ORG}', '${OTHER_RED}', 2026, 10, '{"${OTHER_ORG_SIZE}": 999}', 999, 1, 199.8);
    insert into yield_entry_daily_breakdown (organization_id, yield_entry_id, size_kg, total_kg)
      select organization_id, id, size_kg, total_kg from yield_entries where week = 10 and organization_id = '${ORG}';
  `);
  for (const sql of MIGRATIONS) await db.exec(sql);
  if (through !== "0151") await db.exec(m0152);
  if (through === "0153") await db.exec(m0153);
}

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
  const { yieldSizesRouter } = require("../yieldSizes") as typeof import("../yieldSizes");
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
  app.use("/api", yieldSizesRouter);
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

async function enableCucumbers(unit: "kg" | "pcs" = "kg") {
  const res = await call("/products/cucumber/enable", { body: { unit_code: unit } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function createCucumberVariety(name = "Bonbon") {
  const res = await call("/varieties", {
    body: { name, area_m2: 400, case_kg: 12, planting_date: null, pull_out_date: null, status: "active", product_code: "cucumber" }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}

async function addSize(name: string, sort_order: number, product_code?: string, org = ORG) {
  return call("/yield-sizes", { org, body: { name, sort_order, status: "active", ...(product_code ? { product_code } : {}) } });
}

/** Cucumbers enabled with a variety and two sizes, "LG" (the same name as a pepper size) and "Straight". */
async function cucumberSetup(unit: "kg" | "pcs" = "kg") {
  await enableCucumbers(unit);
  const cucumber = await createCucumberVariety();
  const cLg = await addSize("LG", 1, "cucumber");
  assert.equal(cLg.status, 201, JSON.stringify(cLg.body));
  const cStraight = await addSize("Straight", 2, "cucumber");
  assert.equal(cStraight.status, 201, JSON.stringify(cStraight.body));
  return { cucumber: cucumber.id, C_LG: cLg.body.id as string, C_STRAIGHT: cStraight.body.id as string };
}

const week = (w: number) => ({ year: 2026, week: w, packed_date: "2026-08-12", average_fruit_weight_g: null });

const sizeRows = async (org = ORG) =>
  (await db.query<{ id: string; name: string; sort_order: number; status: string; product_code: string }>(
    "select id, name, sort_order, status, product_code from yield_sizes where organization_id = $1 order by product_code, sort_order",
    [org]
  )).rows;
const pepperHistory = async () =>
  (await db.query("select organization_id, week, size_kg, total_kg, kg_per_m2, total_cases from yield_entries order by organization_id, week")).rows;
const kgRow = async (id: string) =>
  (await db.query<{ total_kg: number; size_kg: Record<string, number>; kg_per_m2: number }>(
    "select total_kg, size_kg, kg_per_m2 from yield_entries where id = $1",
    [id]
  )).rows[0];
const pieceRow = async (id: string) =>
  (await db.query<{ total_pieces: number; size_pieces: Record<string, number> }>(
    "select total_pieces, size_pieces from yield_piece_entries where id = $1",
    [id]
  )).rows[0];

test("0152 makes every existing size a Bell Peppers size and changes nothing else; it re-runs cleanly", async () => {
  await resetDatabase({ through: "0151" });
  const historyBefore = await pepperHistory();
  await db.exec(m0152);
  const expected = [
    { id: LG, name: "LG", sort_order: 1, status: "active", product_code: "bell_pepper" },
    { id: XL, name: "XL", sort_order: 2, status: "active", product_code: "bell_pepper" },
    { id: MD, name: "MD", sort_order: 3, status: "inactive", product_code: "bell_pepper" }
  ];
  assert.deepEqual(await sizeRows(), expected);
  assert.deepEqual(await sizeRows(PEPPER_ONLY_ORG), [
    { id: OTHER_ORG_SIZE, name: "Straight", sort_order: 1, status: "active", product_code: "bell_pepper" }
  ]);
  assert.deepEqual(await pepperHistory(), historyBefore);

  await db.exec(m0152);
  await db.exec(m0153);
  await db.exec(m0153);
  assert.deepEqual(await sizeRows(), expected);
  assert.deepEqual(await pepperHistory(), historyBefore);

  // The same name once per crop; not twice in one crop. After 0153 a size must name its crop.
  await db.query(`insert into yield_sizes (organization_id, product_code, name, sort_order) values ('${ORG}', 'cucumber', 'LG', 1)`);
  await assert.rejects(
    db.query(`insert into yield_sizes (organization_id, product_code, name, sort_order) values ('${ORG}', 'cucumber', 'LG', 2)`),
    /yield_sizes_org_product_name_key/
  );
  await assert.rejects(db.query(`insert into yield_sizes (organization_id, name, sort_order) values ('${ORG}', 'New', 4)`), /null/);
  // A size keeps its crop.
  await assert.rejects(db.query(`update yield_sizes set product_code = 'cucumber' where id = '${LG}'`), /crop can't be changed/);
});

test("Setup: each crop has its own size list and sort order; names repeat across crops, not within one", async () => {
  await enableCucumbers();
  assert.equal((await addSize("Straight", 2, "cucumber")).status, 201);
  const cLg = await addSize("LG", 1, "cucumber");
  assert.equal(cLg.status, 201, JSON.stringify(cLg.body));
  assert.equal(cLg.body.product_code, "cucumber");

  assert.deepEqual(await addSize("LG", 5, "cucumber"), { status: 409, body: { message: "Cucumbers already has a size named LG." } });
  assert.deepEqual(await addSize("XL", 5, "bell_pepper"), { status: 409, body: { message: "Bell Peppers already has a size named XL." } });
  // A crop the organization hasn't enabled gets no sizes.
  assert.deepEqual(await addSize("Straight", 1, "cucumber", PEPPER_ONLY_ORG), {
    status: 400, body: { message: "Cucumbers is not enabled for your organization." }
  });

  const cucumberList = (await call("/yield-sizes?product_code=cucumber")).body;
  assert.deepEqual(cucumberList.map((s: any) => [s.name, s.sort_order, s.product_code]), [["LG", 1, "cucumber"], ["Straight", 2, "cucumber"]]);
  const pepperList = (await call("/yield-sizes?product_code=bell_pepper")).body;
  assert.deepEqual(pepperList.map((s: any) => [s.id, s.name, s.sort_order, s.status]), [[LG, "LG", 1, "active"], [XL, "XL", 2, "active"], [MD, "MD", 3, "inactive"]]);
  // Without a crop, every crop's sizes, each naming its crop.
  assert.equal((await call("/yield-sizes")).body.length, 5);
  // Another organization's sizes are never listed.
  assert.ok(!(await call("/yield-sizes")).body.some((s: any) => s.id === OTHER_ORG_SIZE));

  // A client from before per-crop sizes adds a Bell Peppers size, as it always did.
  const legacy = await addSize("SM", 4);
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body.product_code, "bell_pepper");

  // Editing keeps the crop: renaming and re-ordering work; moving to another crop is refused.
  const moved = await call(`/yield-sizes/${cLg.body.id}`, { method: "PUT", body: { name: "LG", sort_order: 3, status: "active", product_code: "bell_pepper" } });
  assert.deepEqual(moved, { status: 400, body: { message: "A size's crop can't be changed. Add the size to the other crop instead." } });
  const reordered = await call(`/yield-sizes/${cLg.body.id}`, { method: "PUT", body: { name: "Long", sort_order: 3, status: "active", product_code: "cucumber" } });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual([reordered.body.name, reordered.body.sort_order, reordered.body.product_code], ["Long", 3, "cucumber"]);
  assert.equal((await call(`/yield-sizes/${OTHER_ORG_SIZE}`, { method: "PUT", body: { name: "x", sort_order: 1, status: "active" } })).status, 404);

  // A size on recorded harvests is retired, not deleted; an unused one can be deleted.
  assert.deepEqual(await call(`/yield-sizes/${LG}`, { method: "DELETE" }), {
    status: 409, body: { message: "This size is on recorded harvests. Set it to Inactive to retire it; its history stays readable." }
  });
  assert.equal((await sizeRows()).some((s) => s.id === LG), true);
  assert.equal((await call(`/yield-sizes/${legacy.body.id}`, { method: "DELETE" })).status, 204);
  const retired = await call(`/yield-sizes/${LG}`, { method: "PUT", body: { name: "LG", sort_order: 1, status: "inactive" } });
  assert.equal(retired.body.status, "inactive");

  // Only yield editors change sizes.
  assert.equal((await call("/yield-sizes", { user: VIEWER, body: { name: "Q", sort_order: 1, status: "active", product_code: "cucumber" } })).status, 403);
});

test("Manual Entry options: each crop's sizes with their status; the old list stays active Bell Pepper sizes", async () => {
  const { C_LG, C_STRAIGHT } = await cucumberSetup();
  const options = (await call("/yield-entry-options")).body;
  assert.deepEqual(options.yieldSizes, [
    { id: LG, name: "LG", sort_order: 1, status: "active" },
    { id: XL, name: "XL", sort_order: 2, status: "active" }
  ]);
  assert.deepEqual(
    options.sizes.map((s: any) => [s.id, s.product_code, s.status]).sort((a: string[], b: string[]) => (a[1] + a[0]).localeCompare(b[1] + b[0])),
    [[LG, "bell_pepper", "active"], [XL, "bell_pepper", "active"], [MD, "bell_pepper", "inactive"], [C_LG, "cucumber", "active"], [C_STRAIGHT, "cucumber", "active"]]
      .sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0]))
  );
  // An organization without Cucumbers sees only its own Bell Pepper sizes.
  const other = (await call("/yield-entry-options", { org: PEPPER_ONLY_ORG })).body;
  assert.deepEqual(other.sizes.map((s: any) => s.id), [OTHER_ORG_SIZE]);
});

test("cucumber kg: sizes total themselves, a total-only harvest keeps its total, and combining keeps the unsized kg", async () => {
  const { cucumber, C_LG, C_STRAIGHT } = await cucumberSetup();

  // Without sizes: the single total, as before.
  const totalOnly = await call("/yield-entries", { body: { ...week(33), variety_id: cucumber, size_kg: {}, total_kg: 500 } });
  assert.equal(totalOnly.status, 201, JSON.stringify(totalOnly.body));
  assert.deepEqual(await kgRow(totalOnly.body.id), { total_kg: 500, size_kg: {}, kg_per_m2: 1.25 });

  // A sized harvest in the same week adds to it: its sizes are recorded and
  // the 500 kg recorded without sizes stays in the week's total.
  const sized = await call("/yield-entries", { body: { ...week(33), variety_id: cucumber, size_kg: { [C_LG]: 100, [C_STRAIGHT]: 50 } } });
  assert.equal(sized.status, 200, JSON.stringify(sized.body));
  assert.equal(sized.body.message, "Added to existing Bonbon Week 33 entry.");
  assert.deepEqual(await kgRow(totalOnly.body.id), { total_kg: 650, size_kg: { [C_LG]: 100, [C_STRAIGHT]: 50 }, kg_per_m2: 1.625 });

  // Editing it: the sizes plus the unsized kg make the total.
  const edited = await call(`/yield-entries/${totalOnly.body.id}`, {
    method: "PUT", body: { ...week(33), variety_id: cucumber, size_kg: { [C_LG]: 120, [C_STRAIGHT]: 50 }, unsized_kg: 500 }
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(await kgRow(totalOnly.body.id), { total_kg: 670, size_kg: { [C_LG]: 120, [C_STRAIGHT]: 50 }, kg_per_m2: 1.675 });
  assert.deepEqual(
    await call(`/yield-entries/${totalOnly.body.id}`, {
      method: "PUT", body: { ...week(33), variety_id: cucumber, size_kg: { [C_LG]: 120 }, unsized_kg: 1, total_kg: 999 }
    }),
    { status: 400, body: { message: "total_kg must equal the kg per size plus any unsized kg" } }
  );

  // A new sized harvest: the total is the sum of its sizes.
  const fresh = await call("/yield-entries", { body: { ...week(34), variety_id: cucumber, size_kg: { [C_LG]: 10.5, [C_STRAIGHT]: 4.25 } } });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.equal((await kgRow(fresh.body.id)).total_kg, 14.75);

  // An old total-only harvest is still edited as a total; no sizes are invented.
  const old = await call("/yield-entries", { body: { ...week(35), variety_id: cucumber, size_kg: {}, total_kg: 300 } });
  const oldEdit = await call(`/yield-entries/${old.body.id}`, { method: "PUT", body: { ...week(35), variety_id: cucumber, size_kg: {}, total_kg: 320 } });
  assert.equal(oldEdit.status, 200, JSON.stringify(oldEdit.body));
  assert.deepEqual(await kgRow(old.body.id), { total_kg: 320, size_kg: {}, kg_per_m2: 0.8 });

  // Refused: another crop's size (even one with the same name), another
  // organization's size, a retired size on a new harvest, unsized kg without sizes.
  assert.deepEqual(await call("/yield-entries", { body: { ...week(36), variety_id: cucumber, size_kg: { [LG]: 5 } } }), {
    status: 400, body: { message: "One or more sizes are not Cucumbers sizes." }
  });
  assert.deepEqual(await call("/yield-entries", { body: { ...week(36), variety_id: cucumber, size_kg: { [OTHER_ORG_SIZE]: 5 } } }), {
    status: 400, body: { message: "One or more sizes are not Cucumbers sizes." }
  });
  assert.deepEqual(await call("/yield-entries", { body: { ...week(36), variety_id: cucumber, size_kg: { "Straight": 5 } } }), {
    status: 400, body: { message: "One or more sizes are not Cucumbers sizes." }
  });
  await call(`/yield-sizes/${C_STRAIGHT}`, { method: "PUT", body: { name: "Straight", sort_order: 2, status: "inactive" } });
  assert.deepEqual(await call("/yield-entries", { body: { ...week(36), variety_id: cucumber, size_kg: { [C_STRAIGHT]: 5 } } }), {
    status: 400, body: { message: "A retired Cucumbers size can't be used for a new harvest." }
  });
  // ...but stays on the harvests that already carry it.
  const keepRetired = await call(`/yield-entries/${fresh.body.id}`, {
    method: "PUT", body: { ...week(34), variety_id: cucumber, size_kg: { [C_LG]: 11, [C_STRAIGHT]: 4.25 } }
  });
  assert.equal(keepRetired.status, 200, JSON.stringify(keepRetired.body));
  assert.deepEqual(await call("/yield-entries", { body: { ...week(36), variety_id: cucumber, size_kg: {}, total_kg: 5, unsized_kg: 5 } }), {
    status: 400, body: { message: "unsized_kg is only sent with kg per size" }
  });

  // The database refuses another crop's sizes from any writer.
  await assert.rejects(
    db.query(`update yield_entries set size_kg = '{"${LG}": 1}' where id = '${old.body.id}'`),
    /is not one of the Cucumbers sizes/
  );
});

test("cucumber pieces: a count with sizes and one without; combining keeps the unsized pieces; kg stays apart", async () => {
  const { cucumber, C_LG, C_STRAIGHT } = await cucumberSetup("pcs");
  const pieces = (w: number, extra: Record<string, unknown>) => ({ variety_id: cucumber, year: 2026, week: w, packed_date: "2026-08-12", unit_code: "pcs", ...extra });

  const sized = await call("/yield-entries", { body: pieces(33, { size_pieces: { [C_LG]: 300, [C_STRAIGHT]: 200 } }) });
  assert.equal(sized.status, 201, JSON.stringify(sized.body));
  assert.deepEqual(await pieceRow(sized.body.id), { total_pieces: 500, size_pieces: { [C_LG]: 300, [C_STRAIGHT]: 200 } });

  const unsized = await call("/yield-entries", { body: pieces(34, { total_pieces: 800 }) });
  assert.equal(unsized.status, 201, JSON.stringify(unsized.body));
  assert.deepEqual(await pieceRow(unsized.body.id), { total_pieces: 800, size_pieces: {} });

  // A sized count added to the total-only one: 800 unsized + 40 + 20.
  const added = await call("/yield-entries", { body: pieces(34, { size_pieces: { [C_LG]: 40, [C_STRAIGHT]: 20 } }) });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.message, "Added to existing Bonbon Week 34 piece count.");
  assert.deepEqual(await pieceRow(unsized.body.id), { total_pieces: 860, size_pieces: { [C_LG]: 40, [C_STRAIGHT]: 20 } });

  // Edited with its unsized pieces.
  const edited = await call(`/yield-entries/${unsized.body.id}`, {
    method: "PUT", body: pieces(34, { size_pieces: { [C_LG]: 45, [C_STRAIGHT]: 20 }, unsized_pieces: 800 })
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(await pieceRow(unsized.body.id), { total_pieces: 865, size_pieces: { [C_LG]: 45, [C_STRAIGHT]: 20 } });

  // Whole pieces only, and only Cucumbers sizes.
  assert.deepEqual(await call("/yield-entries", { body: pieces(35, { size_pieces: { [C_LG]: 1.5 } }) }), {
    status: 400, body: { message: "Pieces per size must be whole numbers of 0 or more" }
  });
  assert.deepEqual(await call("/yield-entries", { body: pieces(35, { size_pieces: { [XL]: 3 } }) }), {
    status: 400, body: { message: "One or more sizes are not Cucumbers sizes." }
  });

  // Listed with their sizes, apart from kg.
  const listed = (await call("/yield-entries?year=2026&units=all")).body.filter((e: any) => e.variety_id === cucumber);
  assert.deepEqual(listed.map((e: any) => [e.week, e.unit_code, e.total_pieces, e.size_pieces, e.total_kg]).sort(), [
    [33, "pcs", 500, { [C_LG]: 300, [C_STRAIGHT]: 200 }, null],
    [34, "pcs", 865, { [C_LG]: 45, [C_STRAIGHT]: 20 }, null]
  ]);

  // A kg harvest in a sized piece week is its own row (the crop is switched to kg for it).
  assert.equal((await call("/products/cucumber", { method: "PATCH", body: { default_unit_code: "kg" } })).status, 200);
  const kg = await call("/yield-entries", { body: { ...week(33), variety_id: cucumber, size_kg: { [C_LG]: 70 } } });
  assert.equal(kg.status, 201, JSON.stringify(kg.body));
  assert.deepEqual(await pieceRow(sized.body.id), { total_pieces: 500, size_pieces: { [C_LG]: 300, [C_STRAIGHT]: 200 } });
  assert.equal((await kgRow(kg.body.id)).total_kg, 70);

  // The database: whole numbers, no more than the total, own crop only.
  await assert.rejects(db.query(`update yield_piece_entries set size_pieces = '{"${C_LG}": 501}' where id = '${sized.body.id}'`), /add up to more than the total/);
  await assert.rejects(db.query(`update yield_piece_entries set size_pieces = '{"${C_LG}": 2.5}' where id = '${sized.body.id}'`), /whole numbers/);
  await assert.rejects(db.query(`update yield_piece_entries set size_pieces = '{"${LG}": 2}' where id = '${sized.body.id}'`), /is not one of the Cucumbers sizes/);
});

test("Bell Peppers: sizes, totals and history unchanged; a retired size stays on the harvests that carry it", async () => {
  await cucumberSetup();
  const historyBefore = await pepperHistory();

  const created = await call("/yield-entries", { body: { ...week(20), variety_id: RED, size_kg: { [LG]: 30, [XL]: 20 } } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.total_kg, created.body.kg_per_m2, created.body.total_cases], [50, 0.05, 10]);

  // Week 10 carries the retired MD: an edit keeps it, and the total with it.
  const w10 = (await db.query<{ id: string }>(`select id from yield_entries where organization_id = '${ORG}' and week = 10`)).rows[0].id;
  const edit = await call(`/yield-entries/${w10}`, { method: "PUT", body: { ...week(10), variety_id: RED, size_kg: { [LG]: 61, [XL]: 40, [MD]: 5 } } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(await kgRow(w10), { total_kg: 106, size_kg: { [LG]: 61, [XL]: 40, [MD]: 5 }, kg_per_m2: 0.106 });

  // Refused for peppers: a retired size on a new harvest, a cucumber size, unsized kg.
  assert.deepEqual(await call("/yield-entries", { body: { ...week(21), variety_id: RED, size_kg: { [MD]: 5 } } }), {
    status: 400, body: { message: "A retired Bell Peppers size can't be used for a new harvest." }
  });
  const cucumberSize = (await sizeRows()).find((s) => s.product_code === "cucumber")!.id;
  assert.deepEqual(await call("/yield-entries", { body: { ...week(21), variety_id: RED, size_kg: { [cucumberSize]: 5 } } }), {
    status: 400, body: { message: "One or more sizes are not Bell Peppers sizes." }
  });
  assert.deepEqual(await call("/yield-entries", { body: { ...week(21), variety_id: RED, size_kg: { [LG]: 5 }, unsized_kg: 2 } }), {
    status: 400, body: { message: "Every Bell Peppers harvest is recorded by size" }
  });

  // History other than the one edit is exactly as it was.
  const historyAfter = (await pepperHistory()).filter((row: any) => row.week !== 10 || row.organization_id !== ORG);
  const expectedAfter = historyBefore.filter((row: any) => row.week !== 10 || row.organization_id !== ORG);
  assert.deepEqual(historyAfter.filter((row: any) => row.week !== 20), expectedAfter);
});

test("a harvest whose sizes were deleted before 0152 keeps every kg through edits, merges and imports' append", async () => {
  const w12 = (await db.query<{ id: string }>(`select id from yield_entries where organization_id = '${ORG}' and week = 12`)).rows[0].id;

  // Listed with its sizes as stored.
  const listed = (await call("/yield-entries?year=2026&week=12")).body.find((e: any) => e.id === w12);
  assert.deepEqual([listed.total_kg, listed.size_kg], [50, { [GONE_A]: 30, [GONE_B]: 20 }]);

  // An edit that keeps them (as the form sends them back) saves; the total stays their sum.
  const kept = await call(`/yield-entries/${w12}`, {
    method: "PUT", body: { ...week(12), variety_id: RED, size_kg: { [LG]: 0, [XL]: 0, [GONE_A]: 30, [GONE_B]: 20 } }
  });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(await kgRow(w12), { total_kg: 50, size_kg: { [LG]: 0, [XL]: 0, [GONE_A]: 30, [GONE_B]: 20 }, kg_per_m2: 0.05 });

  // Adding a harvest in the same week keeps them beside the new sizes.
  const added = await call("/yield-entries", { body: { ...week(12), variety_id: RED, size_kg: { [LG]: 10 } } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(await kgRow(w12), { total_kg: 60, size_kg: { [LG]: 10, [XL]: 0, [GONE_A]: 30, [GONE_B]: 20 }, kg_per_m2: 0.06 });

  // The database lets any writer (an import's append) keep them too.
  await db.query(`update yield_entries set size_kg = size_kg || '{"${LG}": 11}'::jsonb where id = '${w12}'`);

  // But a deleted size can't be added to a harvest that didn't carry it.
  const w11 = (await db.query<{ id: string }>(`select id from yield_entries where organization_id = '${ORG}' and week = 11`)).rows[0].id;
  assert.deepEqual(
    await call(`/yield-entries/${w11}`, { method: "PUT", body: { ...week(11), variety_id: RED, size_kg: { [LG]: 50, [GONE_A]: 1 } } }),
    { status: 400, body: { message: "One or more sizes are not Bell Peppers sizes." } }
  );
  await assert.rejects(db.query(`update yield_entries set size_kg = '{"${GONE_A}": 1}' where id = '${w11}'`), /is not one of the Bell Peppers sizes/);
});

test("Analytics: each variety's size mix uses its own crop's sizes", async () => {
  const { cucumber, C_LG, C_STRAIGHT } = await cucumberSetup();
  await call("/yield-entries", { body: { ...week(33), variety_id: cucumber, size_kg: { [C_LG]: 75, [C_STRAIGHT]: 25 } } });
  const summary = (await call("/yield-analytics/summary")).body;
  assert.deepEqual(
    summary.sizes.map((s: any) => [s.name, s.product_code]).sort(),
    [["LG", "bell_pepper"], ["LG", "cucumber"], ["MD", "bell_pepper"], ["Straight", "cucumber"], ["XL", "bell_pepper"]]
  );
  const rows = new Map(summary.rows.map((r: any) => [r.variety_id, r]));
  assert.deepEqual((rows.get(cucumber) as any).size_pct, { [C_LG]: 75, [C_STRAIGHT]: 25 });
  assert.deepEqual(Object.keys((rows.get(RED) as any).size_pct).sort(), [LG, MD, XL].sort());
});

test("imports read and create Bell Pepper sizes only, even when Cucumbers has a size of the same name", async () => {
  const { C_LG } = await cucumberSetup();
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { loadSizeNameById } = require("../csvMappingTemplates") as typeof import("../csvMappingTemplates");
  const { loadOrgSizeContext } = require("../pdfImport") as typeof import("../pdfImport");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const names = await loadSizeNameById(ORG);
  assert.deepEqual(Array.from(names.keys()).sort(), [LG, MD, XL].sort());
  assert.ok(!names.has(C_LG));

  const ctx = await loadOrgSizeContext(ORG);
  assert.ok(ctx.ok);
  // The FlowMaster label "LG" resolves to the Bell Peppers LG; the cucumber
  // LG is never an import target, and a retired size is not matched.
  assert.deepEqual(Array.from(ctx.ctx.activeSizeNameById.keys()).sort(), [LG, XL].sort());
});
