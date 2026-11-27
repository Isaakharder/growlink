// Pest Control execution over HTTP: mixes beyond the plan, actual amounts,
// leftovers, rows across two tanks, corrections and retry safety.
// The real pestControl router runs on PGlite with the pest migrations
// (0032-0034, 0048) and 0158 applied verbatim.
// Run: node --require tsx/cjs --test src/routes/__tests__/pestMixes.http.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { readFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const OPERATOR = "aaaaaaaa-0000-4000-8000-00000000000b"; // mobile:pest only
const VIEWER = "aaaaaaaa-0000-4000-8000-00000000000c"; // pest:view only
const CHEM = "c0000000-0000-4000-8000-000000000001";
const OTHER_CHEM = "c0000000-0000-4000-8000-000000000002";

const migration = (name: string) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", name), "utf8");

let db: PGlite;
let server: Server;
let baseUrl: string;

// A Wanjet plan: 600 L tanks at 0.44 ml/L; 9,300 L in total = 15 full tanks
// + a 300 L final tank, so the plan says 16 mixes.
const PLAN16 = {
  type: "spray", method: "wanjet", rate_unit: "ml_per_acre", rate_value: 1000,
  total_volume_l: 9300, total_chemical_ml: 4092, tank_volume_l: 600, tank_count: 16,
  chem_per_liter_ml: 0.44, chem_per_full_tank_ml: 264, final_tank_volume_l: 300,
  chem_for_final_tank_ml: 132, is_last_full: false
};

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key, name text not null default '');
    insert into organizations (id, name) values ('${ORG}', 'Test Farm'), ('${OTHER_ORG}', 'Other');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'),
      ('${OPERATOR}', '${ORG}', 'member', '{"mobile:pest": true}'),
      ('${VIEWER}', '${ORG}', 'member', '{"pest:view": true}'),
      ('${OWNER}', '${OTHER_ORG}', 'owner', '{}');
    create function public.is_org_member(org uuid) returns boolean language sql as $$ select true $$;
    create table pest_sprayers (id uuid primary key default gen_random_uuid(), organization_id uuid);
    create table pest_chemicals (id uuid primary key, organization_id uuid not null, name text,
      inventory_qty numeric, inventory_unit text, registration_number text, updated_at timestamptz);
    insert into pest_chemicals values
      ('${CHEM}', '${ORG}', 'Kontos', 20, 'L', '12345', null),
      ('${OTHER_CHEM}', '${ORG}', 'Other', 5, 'L', null, null);
    create table varieties (id uuid primary key, name text, planting_date date, product_code text);
    create table greenhouse_variety_assignments (organization_id uuid, group_id uuid, variety_id uuid);
    create table food_safety_h1_logs (id uuid primary key default gen_random_uuid(), organization_id uuid,
      pest_job_id uuid, sheet_group_id uuid, application_date date, product_name text, pcp_number text,
      actual_quantity_used numeric, actual_quantity_unit text, rate_applied_per_unit text,
      label_instructions_followed boolean, area_quantity_treated_m2 numeric, method_of_application text,
      row_house_zones text, earliest_allowable_harvest_date date, phi_daa int, applicator_name text,
      operation_name text, current_crop text, previous_year_crops text, variety text,
      production_site_information text, production_site_area text, date_planted date,
      confirmation_signature text, confirmation_date date, version_label text, created_at timestamptz default now());
  `);
  for (const name of [
    "0032_pest_control_todos.sql", "0033_pest_todos_progress.sql",
    "0034_pest_control_records.sql", "0048_pest_todos_application_date.sql",
    "0158_pest_job_mixes.sql"
  ]) await db.exec(migration(name));

  const client = createPgliteSupabase(db);
  const id = require.resolve("../../config/supabase");
  require.cache[id] = { id, filename: id, loaded: true, exports: { supabase: client } } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { pestControlRouter } = require("../pestControl") as typeof import("../pestControl");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", pestControlRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

// ── helpers ──────────────────────────────────────────────────────────────────

type Row = { rowId: string; rowNumber: number; rowLengthM: number; completed: boolean; completedAt: string | null; completedByMixNumber: number | null; mixNumbers?: number[] };

async function createJob(opts: { rows: number; calc?: Record<string, unknown>; org?: string; progress?: Record<string, unknown> }) {
  const rows: Row[] = Array.from({ length: opts.rows }, (_, i) => ({
    rowId: randomUUID(), rowNumber: i + 1, rowLengthM: 50, completed: false, completedAt: null, completedByMixNumber: null
  }));
  const progress = opts.progress ?? { phases: [{ phaseId: randomUUID(), phaseName: "Phase 1", completed: false, completedAt: null, rows }] };
  const res = await db.query<{ id: string }>(
    `insert into pest_control_todos (organization_id, type, status, chemical_id, chemical_snapshot, calculation_snapshot, target_snapshot, progress_snapshot)
     values ($1, 'spray', 'pending', $2, $3, $4, $5, $6) returning id`,
    [opts.org ?? ORG, CHEM, JSON.stringify({ id: CHEM, name: "Kontos", rate_unit: "ml_per_acre", rate_value: 1000, phi: "3" }),
      JSON.stringify(opts.calc ?? PLAN16), JSON.stringify({ total_m2: 10000, group_ids: [] }), JSON.stringify(progress)]
  );
  return { id: res.rows[0].id, progress: progress as { phases: Array<{ completed: boolean; rows: Row[] }> } };
}

async function call(method: string, url: string, body?: unknown, user = OWNER, org = ORG) {
  const res = await fetch(`${baseUrl}/api${url}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const chem = (amount: number) => [{ chemical_id: CHEM, name: "Kontos", amount, unit: "ml" }];

async function startMix(todo: string, n: number, water: number, amount: number, extra: Record<string, unknown> = {}) {
  const key = randomUUID();
  const r = await call("POST", `/pest/todos/${todo}/mixes`, { client_key: key, mix_number: n, water_l: water, chemicals: chem(amount), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { key, mix: r.body.mix };
}

async function saveProgress(todo: string, progress: unknown) {
  const r = await call("PATCH", `/pest/todos/${todo}/progress`, { progress_snapshot: progress });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

/** Mark rows [from, to] (1-based) complete with the given tanks. */
function markRows(progress: { phases: Array<{ completed: boolean; rows: Row[] }> }, from: number, to: number, mixNumbers: number[]) {
  for (const r of progress.phases[0].rows) {
    if (r.rowNumber >= from && r.rowNumber <= to) {
      r.completed = true;
      r.completedAt = new Date().toISOString();
      r.mixNumbers = mixNumbers;
      r.completedByMixNumber = mixNumbers[mixNumbers.length - 1];
    }
  }
  progress.phases[0].completed = progress.phases[0].rows.every((r) => r.completed);
}

async function inventory(id = CHEM) {
  return Number((await db.query<{ q: string }>(`select inventory_qty q from pest_chemicals where id = $1`, [id])).rows[0].q);
}

const close = (a: number | null, b: number, eps = 1e-6) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── scenarios ────────────────────────────────────────────────────────────────

test("fewer than 16 mixes: 12 tanks finish the job; totals compare under plan", async () => {
  const job = await createJob({ rows: 24 });
  for (let n = 1; n <= 12; n++) {
    await startMix(job.id, n, 600, 264);
    markRows(job.progress, 2 * n - 1, 2 * n, [n]);
    await saveProgress(job.id, job.progress);
  }
  const done = await call("POST", `/pest/todos/${job.id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const s = done.body.mix_summary;
  assert.equal(s.mixes_made, 12);
  assert.equal(s.planned_mixes, 16);
  assert.equal(s.extra_mixes, 0);
  close(s.water.mixed, 7200);
  close(s.water.applied_vs_plan.diff, 7200 - 9300);
  close(s.water.applied_vs_plan.pct, ((7200 - 9300) / 9300) * 100);
  close(s.chemicals[0].mixed, 12 * 264);
  close(s.chemicals[0].applied_vs_plan.diff, 12 * 264 - 4092);
  close(s.water.per_row, 300);
  close(s.chemicals[0].per_row, 132);
  // Inventory: 20 L − 3.168 L actually mixed (not the planned 4.092 L).
  close(await inventory(), 20 - 3.168);
});

test("more than 16 mixes: 18 tanks are all recorded, 17-18 flagged extra, plan unchanged", async () => {
  const job = await createJob({ rows: 36 });
  const before = (await db.query(`select calculation_snapshot from pest_control_todos where id = $1`, [job.id])).rows[0];
  for (let n = 1; n <= 18; n++) {
    const { mix } = await startMix(job.id, n, 600, 264);
    assert.equal(mix.is_extra, n > 16, `mix ${n} is_extra`);
    markRows(job.progress, 2 * n - 1, 2 * n, [n]);
    await saveProgress(job.id, job.progress);
  }
  const live = await call("GET", `/pest/todos/${job.id}/mixes`);
  assert.equal(live.body.mixes.length, 18);
  assert.equal(live.body.summary.extra_mixes, 2);
  assert.equal(live.body.summary.active_mix_number, 18);
  assert.equal(live.body.summary.applied_pending, true);
  // Planned values are prefilled per mix: #16 is the plan's 300 L final tank,
  // extras beyond the plan are a full tank.
  assert.equal(Number(live.body.mixes[15].planned_water_l), 300);
  assert.equal(Number(live.body.mixes[16].planned_water_l), 600);

  const done = await call("POST", `/pest/todos/${job.id}/complete`, {});
  assert.equal(done.status, 200);
  const s = done.body.mix_summary;
  close(s.water.mixed, 18 * 600);
  close(s.water.applied_vs_plan.diff, 10800 - 9300);
  close(s.chemicals[0].applied_vs_plan.pct, ((18 * 264 - 4092) / 4092) * 100);
  const after = (await db.query(`select calculation_snapshot from pest_control_todos where id = $1`, [job.id])).rows[0];
  assert.deepEqual(after, before, "the plan baseline is never modified");
});

test("partial final tank and leftovers: mixed and applied are separate figures", async () => {
  const job = await createJob({ rows: 4, calc: { ...PLAN16, total_volume_l: 1500, total_chemical_ml: 660, tank_count: 3 } });
  // Plan: 600 + 600 + 300. Mix 3 is the partial final tank.
  await startMix(job.id, 1, 600, 264);
  markRows(job.progress, 1, 2, [1]);
  await saveProgress(job.id, job.progress);
  // Tank 1 had 40 L left over when it was swapped.
  await startMix(job.id, 2, 600, 264, { previous_leftover_l: 40 });
  markRows(job.progress, 3, 3, [2]);
  await saveProgress(job.id, job.progress);
  const { key: key3, mix: mix3 } = await startMix(job.id, 3, 250, 110);
  assert.equal(Number(mix3.planned_water_l), 300, "final tank prefilled from the plan's partial tank");
  markRows(job.progress, 4, 4, [3]);
  await saveProgress(job.id, job.progress);
  // Final tank closed with 25 L unused before completing.
  const last = await call("POST", `/pest/todos/${job.id}/mixes`, { client_key: key3, water_l: 250, chemicals: chem(110), leftover_l: 25, status: "completed" });
  assert.equal(last.status, 200);
  assert.equal(last.body.mix.status, "completed");

  const done = await call("POST", `/pest/todos/${job.id}/complete`, {});
  const s = done.body.mix_summary;
  close(s.water.mixed, 1450);
  close(s.water.leftover, 65);
  close(s.water.applied, 1385);
  close(s.chemicals[0].mixed, 638);
  // Chemical applied follows the tank's applied share: 264·560/600 + 264 + 110·225/250
  close(s.chemicals[0].applied, 264 * (560 / 600) + 264 + 110 * (225 / 250));
  close(s.water.applied_vs_plan.diff, 1385 - 1500);
  // Inventory deducts what was mixed: 638 ml.
  const hist = await call("GET", `/pest/todos/${job.id}/mixes`);
  assert.ok(hist.body.revisions.some((r: any) => r.action === "leftover"), "final leftover is in the history");
  assert.ok(hist.body.revisions.some((r: any) => r.action === "closed" && r.after.leftover_l === 40), "tank 1 closed with its leftover");
});

test("a row started on one tank and finished on the next counts once, half to each tank", async () => {
  const job = await createJob({ rows: 3, calc: { ...PLAN16, total_volume_l: 1200, total_chemical_ml: 528, tank_count: 2 } });
  await startMix(job.id, 1, 600, 264);
  markRows(job.progress, 1, 1, [1]);
  await startMix(job.id, 2, 600, 264, { previous_leftover_l: 0 });
  markRows(job.progress, 2, 2, [1, 2]); // tank 1 ran out mid-row 2
  markRows(job.progress, 3, 3, [2]);
  await saveProgress(job.id, job.progress);

  const done = await call("POST", `/pest/todos/${job.id}/complete`, {});
  const s = done.body.mix_summary;
  assert.equal(s.completed_rows, 3, "row 2 counts once");
  assert.equal(s.per_row_basis_rows, 3);
  assert.deepEqual(s.mixes.map((m: any) => m.rows), [1.5, 1.5]);
  close(s.mixes[0].avg_water_per_row, 400);
  close(s.water.per_row, 400);
  close(s.chemicals[0].per_row, 176);
});

test("correcting an operator entry keeps the history; a retried correction is a no-op", async () => {
  const job = await createJob({ rows: 2, calc: { ...PLAN16, total_volume_l: 600, total_chemical_ml: 264, tank_count: 1 } });
  const { key } = await startMix(job.id, 1, 600, 264);
  const fix = { client_key: key, water_l: 560, chemicals: chem(250), reason: "Tank gauge read 560 L" };
  const first = await call("POST", `/pest/todos/${job.id}/mixes`, fix, OPERATOR);
  assert.equal(first.status, 200);
  assert.equal(first.body.changed, true);
  assert.equal(first.body.mix.revision, 2);
  const again = await call("POST", `/pest/todos/${job.id}/mixes`, fix, OPERATOR);
  assert.equal(again.body.changed, false);

  const hist = await call("GET", `/pest/todos/${job.id}/mixes`);
  const revs = hist.body.revisions;
  assert.deepEqual(revs.map((r: any) => r.action), ["created", "corrected"]);
  assert.equal(revs[1].before.water_l, 600);
  assert.equal(revs[1].after.water_l, 560);
  assert.equal(revs[1].reason, "Tank gauge read 560 L");
  assert.equal(revs[1].changed_by, OPERATOR);
  assert.equal(Number(hist.body.mixes[0].water_l), 560);
});

test("retries never duplicate a mix, a record or an inventory deduction", async () => {
  await db.query(`update pest_chemicals set inventory_qty = 10 where id = $1`, [CHEM]);
  const job = await createJob({ rows: 1, calc: { ...PLAN16, total_volume_l: 600, total_chemical_ml: 264, tank_count: 1 } });
  const body = { client_key: randomUUID(), mix_number: 1, water_l: 600, chemicals: chem(300) };
  const a = await call("POST", `/pest/todos/${job.id}/mixes`, body);
  const b = await call("POST", `/pest/todos/${job.id}/mixes`, body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.created, false);
  assert.equal(b.body.mix.id, a.body.mix.id);
  markRows(job.progress, 1, 1, [1]);
  await saveProgress(job.id, job.progress);

  const [c1, c2] = await Promise.all([
    call("POST", `/pest/todos/${job.id}/complete`, {}),
    call("POST", `/pest/todos/${job.id}/complete`, {})
  ]);
  assert.deepEqual([c1.status, c2.status], [200, 200]);
  const c3 = await call("POST", `/pest/todos/${job.id}/complete`, {});
  assert.equal(c3.body.already_completed, true);
  const records = await db.query(`select mix_summary from pest_control_records where todo_id = $1`, [job.id]);
  assert.equal(records.rows.length, 1);
  close(await inventory(), 10 - 0.3);
  const h1 = await db.query<{ q: string; u: string }>(`select actual_quantity_used q, actual_quantity_unit u from food_safety_h1_logs where pest_job_id = $1`, [job.id]);
  assert.equal(h1.rows.length, 1, "one H1 log");
  assert.deepEqual([Number(h1.rows[0].q), h1.rows[0].u], [300, "ml"], "H1 shows the chemical actually mixed");
  const mixes = await db.query(`select count(*)::int n from pest_job_mixes where todo_id = $1`, [job.id]);
  assert.equal((mixes.rows[0] as { n: number }).n, 1);
  // A mix after completion is refused.
  const late = await call("POST", `/pest/todos/${job.id}/mixes`, { ...body, client_key: randomUUID(), mix_number: 2 });
  assert.equal(late.status, 409);
});

test("checks are kept: permissions, organization, planned chemical, mix order, leftover bounds", async () => {
  const job = await createJob({ rows: 1 });
  const ok = { client_key: randomUUID(), mix_number: 1, water_l: 600, chemicals: chem(264) };
  assert.equal((await call("POST", `/pest/todos/${job.id}/mixes`, ok, VIEWER)).status, 403);
  assert.equal((await call("GET", `/pest/todos/${job.id}/mixes`, undefined, VIEWER)).status, 200);
  assert.equal((await call("POST", `/pest/todos/${job.id}/mixes`, ok, OWNER, OTHER_ORG)).status, 404);
  const other = await call("POST", `/pest/todos/${job.id}/mixes`, { ...ok, chemicals: [{ chemical_id: OTHER_CHEM, name: "Other", amount: 10, unit: "ml" }] });
  assert.equal(other.status, 400);
  assert.equal((await call("POST", `/pest/todos/${job.id}/mixes`, { ...ok, mix_number: 2 })).status, 409);
  assert.equal((await call("POST", `/pest/todos/${job.id}/mixes`, { ...ok, leftover_l: 700 })).status, 400);
  assert.equal((await call("POST", `/pest/todos/${job.id}/mixes`, { ...ok, water_l: -1 })).status, 400);
  assert.equal((await call("POST", `/pest/todos/${job.id}/mixes`, ok, OPERATOR)).status, 201);
  const status = await db.query<{ status: string }>(`select status from pest_control_todos where id = $1`, [job.id]);
  assert.equal(status.rows[0].status, "in_progress");
});

test("a job started before 0158 keeps its snapshot mixes (imported once, planned amounts)", async () => {
  const rows: Row[] = [1, 2].map((n) => ({ rowId: randomUUID(), rowNumber: n, rowLengthM: 50, completed: true, completedAt: "2026-09-24T21:10:00Z", completedByMixNumber: 1 }));
  const job = await createJob({
    rows: 0,
    progress: {
      phases: [{ phaseId: randomUUID(), phaseName: "Phase 1", completed: true, completedAt: null, rows }],
      mixes: [{ mixNumber: 1, status: "active", startedAt: "2026-09-24T21:02:49Z", endedAt: null, waterVolumeL: 600, chemicalAmountMl: 264, completedRowIds: [], completedRowCount: 0, completedRowLengthM: 0, estimatedAppliedWaterL: null, estimatedAppliedChemicalMl: null }],
      activeMixNumber: 1
    }
  });
  const first = await call("GET", `/pest/todos/${job.id}/mixes`);
  const second = await call("GET", `/pest/todos/${job.id}/mixes`);
  assert.equal(first.body.mixes.length, 1);
  assert.equal(second.body.mixes.length, 1);
  assert.equal(first.body.revisions[0].action, "imported");
  assert.equal(first.body.summary.completed_rows, 2);
  // The next mix continues the numbering.
  await startMix(job.id, 2, 600, 264);
});
