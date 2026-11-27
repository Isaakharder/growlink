// Rollout safety: the new server on a database WITHOUT migration 0158.
// Mix endpoints answer "not set up yet", and completing a job still works
// exactly as before (record + status + planned inventory deduction).
// Run: node --require tsx/cjs --test src/routes/__tests__/pestMixes.notSetUp.http.test.ts
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
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const CHEM = "c0000000-0000-4000-8000-000000000001";
const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");

let db: PGlite;
let server: Server;
let baseUrl: string;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '');
    insert into organizations values ('${ORG}', 'Test Farm');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values ('${OWNER}', '${ORG}', 'owner', '{}');
    create function public.is_org_member(org uuid) returns boolean language sql as $$ select true $$;
    create table pest_sprayers (id uuid primary key default gen_random_uuid(), organization_id uuid);
    -- double precision: the PGlite shim returns numeric as a string, PostgREST as a number.
    create table pest_chemicals (id uuid primary key, organization_id uuid not null, name text,
      inventory_qty double precision, inventory_unit text, registration_number text, updated_at timestamptz);
    insert into pest_chemicals values ('${CHEM}', '${ORG}', 'Kontos', 20, 'L', null, null);
  `);
  for (const name of ["0032_pest_control_todos.sql", "0033_pest_todos_progress.sql", "0034_pest_control_records.sql", "0048_pest_todos_application_date.sql"]) {
    await db.exec(migration(name));
  }
  const client = createPgliteSupabase(db);
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { pestControlRouter } = require("../pestControl") as typeof import("../pestControl");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = OWNER;
    req.organizationId = ORG;
    next();
  });
  app.use("/api", pestControlRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

test("without 0158: mixes report not set up; completion keeps the pre-0158 behaviour", async () => {
  const progress = { phases: [{ phaseId: "p1", phaseName: "Phase 1", completed: true, completedAt: null, rows: [{ rowId: "r1", rowNumber: 1, completed: true, completedAt: null, completedByMixNumber: 1 }] }] };
  const todo = (await db.query<{ id: string }>(
    `insert into pest_control_todos (organization_id, type, status, chemical_id, chemical_snapshot, calculation_snapshot, progress_snapshot)
     values ($1, 'spray', 'in_progress', $2, $3, $4, $5) returning id`,
    [ORG, CHEM, JSON.stringify({ name: "Kontos", rate_unit: "ml_per_acre" }), JSON.stringify({ total_chemical_ml: 4092, tank_count: 16, total_volume_l: 9300 }), JSON.stringify(progress)]
  )).rows[0].id;

  const get = await call("GET", `/pest/todos/${todo}/mixes`);
  assert.equal(get.status, 200);
  assert.equal(get.body.available, false);
  const post = await call("POST", `/pest/todos/${todo}/mixes`, { client_key: "5b8f3c1e-0000-4000-8000-000000000001", mix_number: 1, water_l: 600, chemicals: [] });
  assert.equal(post.status, 409);
  assert.equal(post.body.notSetUp, true);

  const done = await call("POST", `/pest/todos/${todo}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const again = await call("POST", `/pest/todos/${todo}/complete`, {});
  assert.equal(again.body.already_completed, true);
  const records = await db.query(`select id from pest_control_records where todo_id = $1`, [todo]);
  assert.equal(records.rows.length, 1);
  const inv = await db.query<{ q: string }>(`select inventory_qty q from pest_chemicals where id = $1`, [CHEM]);
  assert.ok(Math.abs(Number(inv.rows[0].q) - (20 - 4.092)) < 1e-9, "planned amount, deducted once");
});
