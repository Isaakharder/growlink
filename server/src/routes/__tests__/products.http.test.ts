// Setup → Products and variety products over HTTP: the real products and
// varieties routers and permission middleware on PGlite, with migration 0148
// applied verbatim on top of the production shape of organizations and
// varieties. No server, Docker, network or credentials.
// Run: node --require tsx/cjs --test src/routes/__tests__/products.http.test.ts
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
const YIELD_ONLY = "aaaaaaaa-0000-4000-8000-00000000000c";
const RED = "b0000000-0000-4000-8000-000000000001";

const m0148 = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0148_product_catalog.sql"), "utf8");

let db: PGlite;
let server: Server;
let baseUrl: string;

async function resetDatabase() {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    insert into organizations (id) values ('${ORG}'), ('${OTHER_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${OTHER_ORG}', 'owner', '{}'),
      ('${VIEWER}', '${ORG}', 'member', '{"greenhouse_setup:view": true}'),
      ('${YIELD_ONLY}', '${ORG}', 'member', '{"yield:view": true}');
    create table varieties (
      id uuid primary key default gen_random_uuid(), name text not null,
      area_m2 numeric not null default 0 check (area_m2 >= 0), case_kg numeric not null default 0 check (case_kg >= 0),
      planting_date date, pull_out_date date,
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      color text not null default 'red' check (color in ('red', 'orange', 'yellow', 'green')),
      organization_id uuid not null references organizations(id),
      constraint varieties_org_name_key unique (organization_id, name));
    insert into varieties (id, name, area_m2, case_kg, status, color, organization_id) values
      ('${RED}', 'Cadalora', 31397, 5.15, 'active', 'red', '${ORG}'),
      (gen_random_uuid(), 'Levente', 0, 5.15, 'inactive', 'yellow', '${ORG}'),
      (gen_random_uuid(), 'Silverstone', 16644, 5.1, 'active', 'orange', '${OTHER_ORG}');
  `);
  await db.exec(m0148);
}

before(async () => {
  await resetDatabase();
  const client = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as Record<string | symbol, unknown>)[prop] });
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { productsRouter } = require("../products") as typeof import("../products");
  const { varietiesRouter } = require("../varieties") as typeof import("../varieties");
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

// Exactly what Setup → Varieties sends today: no product.
const legacyVariety = (name: string) => ({
  name, area_m2: 1200, case_kg: 5.15, planting_date: "2026-01-10", pull_out_date: null, status: "active", color: "yellow"
});

const KG = { code: "kg", name: "Kilograms", dimension: "weight" };

test("Setup → Products lists the organization's Bell Peppers in kg, with its own variety counts", async () => {
  assert.deepEqual((await call("/products")).body, {
    products: [{
      code: "bell_pepper", name: "Bell Peppers", tracksColour: true, status: "active",
      defaultUnit: KG, supportedUnits: [KG], varietyCount: 2, activeVarietyCount: 1
    }]
  });
  assert.deepEqual((await call("/products", { org: OTHER_ORG })).body.products.map((p: any) => [p.code, p.varietyCount, p.activeVarietyCount]), [["bell_pepper", 1, 1]]);
});

test("viewing products uses the existing Setup permissions", async () => {
  assert.equal((await call("/products", { user: VIEWER })).status, 200);
  assert.equal((await call("/products", { user: YIELD_ONLY })).status, 403);
});

test("a variety saved the way the app saves it today joins Bell Peppers; everything else is stored as sent", async () => {
  const created = await call("/varieties", { body: legacyVariety("Yedda") });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.product_code, "bell_pepper");
  assert.deepEqual(
    [created.body.name, Number(created.body.area_m2), Number(created.body.case_kg), created.body.status, created.body.color],
    ["Yedda", 1200, 5.15, "active", "yellow"]
  );

  // Editing without a product keeps it.
  const edited = await call(`/varieties/${created.body.id}`, { method: "PUT", body: { ...legacyVariety("Yedda"), area_m2: 1300 } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.product_code, "bell_pepper");
  assert.equal(Number(edited.body.area_m2), 1300);

  const listed = (await call("/varieties")).body;
  assert.ok(listed.every((v: any) => v.product_code === "bell_pepper"));
  assert.ok(listed.every((v: any) => ["id", "name", "area_m2", "case_kg", "planting_date", "pull_out_date", "status", "color", "organization_id"].every((k) => k in v)));
});

test("a product must be enabled and active for the organization", async () => {
  assert.equal((await call("/varieties", { body: { ...legacyVariety("A"), product_code: "bell_pepper" } })).status, 201);
  assert.deepEqual(await call("/varieties", { body: { ...legacyVariety("B"), product_code: "cucumber" } }), {
    status: 400, body: { message: "product_code must be an active product enabled for your organization" }
  });
  assert.equal((await call(`/varieties/${RED}`, { method: "PUT", body: { ...legacyVariety("Cadalora"), product_code: "cucumber" } })).status, 400);
});

test("once an organization has two active products, a new variety must name one", async () => {
  await db.exec(`
    begin;
    insert into measurement_units (code, name, dimension, kg_per_unit) values ('piece', 'Pieces', 'count', null);
    insert into catalog_products (code, name, default_unit_code) values ('test_crop', 'Test Crop', 'piece');
    insert into catalog_product_units values ('test_crop', 'piece');
    commit;
    insert into organization_products (organization_id, product_code, default_unit_code) values ('${ORG}', 'test_crop', 'piece');
  `);
  assert.deepEqual(await call("/varieties", { body: legacyVariety("C") }), { status: 400, body: { message: "product_code is required" } });
  const created = await call("/varieties", { body: { ...legacyVariety("C"), product_code: "test_crop" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.product_code, "test_crop");
  assert.deepEqual((await call("/products")).body.products.map((p: any) => [p.name, p.defaultUnit.code, p.varietyCount]), [["Bell Peppers", "kg", 2], ["Test Crop", "piece", 1]]);
});
