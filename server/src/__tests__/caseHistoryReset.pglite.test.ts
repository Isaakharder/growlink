// Runs supabase/maintenance/case_history_reset/01_setup.sql verbatim on PGlite
// (with migrations 0143 + 0144) and exercises backup -> refused resets ->
// reset -> re-sync -> restore for one organization, checking the other
// organization and the uncleared tables are never touched.
// Run: node --require tsx/cjs --test src/__tests__/caseHistoryReset.pglite.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const root = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const setup = read("supabase/maintenance/case_history_reset/01_setup.sql");

let db: PGlite;
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await all<T>(sql, params))[0];

const dump = async (org: string) =>
  JSON.stringify(
    await Promise.all(
      ["color_case_entries", "manual_pack_case_entries", "case_week_sources", "case_rebuild_ranges", "case_week_confirmations", "historical_packs", "pack_case_measurements", "docklink_packs", "docklink_pack_weekly_shipments", "docklink_pack_sync_state"].map(
        (t) => all(`select to_jsonb(t)::text j from ${t} t where organization_id = $1 order by 1`, [org])
      )
    )
  );

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}'), ('${OTHER}');
    create table color_case_entries (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null, color text not null, year int not null, week int not null,
      total_cases numeric not null, case_weight_kg numeric not null, total_kg numeric not null default 0, kg_per_m2 numeric not null default 0,
      color_area_m2 numeric not null default 0, source text default 'manual', synced_at timestamptz, source_summary jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now(), unique (organization_id, color, year, week));
  `);
  await db.exec(read("supabase/migrations/0143_docklink_pack_shipments.sql"));
  await db.exec(read("supabase/migrations/0144_manual_pack_case_entries.sql"));
  await db.exec(read("supabase/migrations/0145_case_rebuild_ranges.sql"));
  for (const org of [ORG, OTHER]) {
    await db.query(
      `insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source, source_summary) values
         ($1, 'red', 2025, 14, 900, 5.15, 4635, 'docklink', '{"docklink_view":"growlink_weekly_color_totals"}'),
         ($1, 'yellow', 2025, 14, 120.5, 5.0, 602.5, 'manual', null),
         ($1, 'red', 2026, 2, 40, 0, 0, 'manual', null)`, [org]
    );
    await db.query(`insert into docklink_packs (organization_id, pack_id, name, status) values ($1, 'pk-red', 'Red 5kg', 'active')`, [org]);
    const [h] = await all<{ id: string }>(
      `insert into historical_packs (organization_id, name, color_kind, color_key, crop_type, tracking_unit) values ($1, 'Old tri', 'mixed', 'mixed', 'pepper', 'kg') returning id`, [org]
    );
    await db.query(
      `insert into manual_pack_case_entries (organization_id, iso_year, iso_week, pack_source, docklink_pack_id, historical_pack_id, pack_name, color_kind, color_key, crop_type, tracking_unit, cases, invoice_ref) values
         ($1, 2025, 15, 'docklink', 'pk-red', null, 'Red 5kg', 'single', 'red', 'pepper', 'kg', 300, 'INV-1'),
         ($1, 2025, 15, 'historical', null, $2, 'Old tri', 'mixed', 'mixed', 'pepper', 'kg', 75.25, ' Inv-2 ')`, [org, h.id]
    );
    await db.query(`insert into case_week_sources (organization_id, iso_year, iso_week, source) values ($1, 2025, 15, 'manual_packs')`, [org]);
    await db.query(`insert into case_rebuild_ranges (organization_id, from_iso_year, from_iso_week, to_iso_year, to_iso_week, note) values ($1, 2025, 1, 2025, 30, 'rebuild')`, [org]);
    await db.query(`insert into case_week_confirmations (organization_id, iso_year, iso_week) values ($1, 2025, 16)`, [org]);
    await db.query(
      `insert into pack_case_measurements (organization_id, iso_year, iso_week, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case) values ($1, 2025, 15, 'pk-red', 'single', 'red', 'pepper', 'kg', 5.1)`, [org]
    );
  }
  await db.exec(setup);
});

const backup = async (label = "before pack re-entry") => (await one<{ id: string }>(`select case_history_backup.take_backup($1, $2) id`, [ORG, label])).id;
const reset = (id: string, clearManual = false, confirm = `RESET ${ORG}`) =>
  one<{ r: any }>(`select case_history_backup.reset_case_history($1, $2, $3, $4) r`, [ORG, id, clearManual, confirm]).then((x) => x.r);
const restore = (id: string, confirm = `RESTORE ${ORG}`) => one<{ r: any }>(`select case_history_backup.restore_case_history($1, $2, $3) r`, [ORG, id, confirm]).then((x) => x.r);
const count = async (table: string, org = ORG) => (await one<{ n: number }>(`select count(*)::int n from ${table} where organization_id = $1`, [org])).n;

test("backup captures every case table of the organization only, verified by checksum", async () => {
  const id = await backup();
  const b = await one(`select row_counts from case_history_backup.backups where backup_id = $1`, [id]);
  assert.deepEqual(b.row_counts, {
    docklink_pack_sync_state: 0, docklink_packs: 1, docklink_pack_weekly_shipments: 0, historical_packs: 1,
    pack_case_measurements: 1, color_case_entries: 3, case_week_sources: 1, case_rebuild_ranges: 1, case_week_confirmations: 1,
    manual_pack_case_entries: 2
  });
  assert.equal((await one<{ n: number }>(`select count(*)::int n from case_history_backup.color_case_entries where organization_id <> $1`, [ORG])).n, 0);
});

test("reset refuses a wrong confirmation, another organization's backup, or data changed since the backup", async () => {
  const id = await backup();
  await assert.rejects(reset(id, false, "RESET"), /confirmation text must be exactly/);
  const otherId = (await one<{ id: string }>(`select case_history_backup.take_backup($1, 'other') id`, [OTHER])).id;
  await assert.rejects(reset(otherId), /not found for organization/);
  await db.query(`update color_case_entries set total_cases = 901 where organization_id = $1 and color = 'red' and week = 14`, [ORG]);
  await assert.rejects(reset(id), /changed after backup/);
  assert.equal(await count("color_case_entries"), 3, "nothing deleted by refused resets");
});

test("reset clears only the organization's colour totals; manual entries only when asked; nothing else, no other organization", async () => {
  const before = { other: await dump(OTHER) };
  const id = await backup();
  const r = await reset(id);
  assert.deepEqual(r.deleted, { color_case_entries: 3 });
  assert.equal(await count("color_case_entries"), 0);
  assert.equal(await count("manual_pack_case_entries"), 2);
  assert.equal(await count("case_week_sources"), 1);
  assert.equal(await count("case_rebuild_ranges"), 1, "rebuild ranges are kept unless manual data is cleared too");
  assert.equal(await count("pack_case_measurements"), 1);
  assert.equal(await count("historical_packs"), 1);
  assert.equal(await dump(OTHER), before.other, "the other organization is untouched");

  const id2 = await backup("before clearing test entries");
  assert.deepEqual((await reset(id2, true)).deleted, {
    manual_pack_case_entries: 2, case_week_sources: 1, case_rebuild_ranges: 1, case_week_confirmations: 1, color_case_entries: 0
  });
  assert.equal(await count("case_rebuild_ranges"), 0);
  assert.equal(await count("manual_pack_case_entries"), 0);
  assert.equal(await count("historical_packs"), 1, "historical packs are kept");
  assert.equal(await dump(OTHER), before.other);
});

test("restore puts back exactly the backed-up rows (ids, values, generated invoice keys), saving anything newer first", async () => {
  const original = await dump(ORG);
  const other = await dump(OTHER);
  const id = await backup();
  await reset(id, true);
  // After the reset: the colour sync brings a week back, and an entry is re-entered.
  await db.query(`insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values ($1, 'red', 2025, 14, 905, 5.15, 4660.75, 'docklink')`, [ORG]);
  await db.query(
    `insert into manual_pack_case_entries (organization_id, iso_year, iso_week, pack_source, docklink_pack_id, pack_name, color_kind, color_key, crop_type, tracking_unit, cases) values ($1, 2025, 16, 'docklink', 'pk-red', 'Red 5kg', 'single', 'red', 'pepper', 'kg', 10)`, [ORG]
  );

  await assert.rejects(restore(id, "RESTORE"), /confirmation text/);
  const r = await restore(id);
  assert.deepEqual(r.restored, { color_case_entries: 3, case_week_sources: 1, case_rebuild_ranges: 1, case_week_confirmations: 1, manual_pack_case_entries: 2 });
  assert.equal(await dump(ORG), original, "byte-for-byte the state before the reset");
  assert.equal(await dump(OTHER), other);
  const [{ k }] = await all<{ k: string }>(`select string_agg(invoice_ref_key, ',' order by invoice_ref_key) k from manual_pack_case_entries where organization_id = $1`, [ORG]);
  assert.equal(k, "inv-1,inv-2");

  // The rows written after the backup were saved first, and restoring that backup brings them back.
  const safety = await one(`select row_counts from case_history_backup.backups where backup_id = $1`, [r.pre_restore_backup_id]);
  assert.equal(safety.row_counts.color_case_entries, 1);
  assert.equal(safety.row_counts.manual_pack_case_entries, 1);
  await restore(r.pre_restore_backup_id);
  assert.equal(await count("color_case_entries"), 1);
  assert.equal((await one(`select total_cases::int c from color_case_entries where organization_id = $1`, [ORG])).c, 905);

  const ops = await all<{ operation: string }>(`select operation from case_history_backup.operations where organization_id = $1 order by id`, [ORG]);
  assert.deepEqual(ops.map((o) => o.operation), ["backup", "reset", "backup", "restore", "backup", "restore"]);
});

test("a failing restore changes nothing", async () => {
  const id = await backup();
  await reset(id, true);
  // The historical pack an entry in the backup points at is deleted after the reset.
  await db.query(`delete from historical_packs where organization_id = $1`, [ORG]);
  const beforeAttempt = await dump(ORG);
  await assert.rejects(restore(id), /manual_pack_case_entries_historical_pack/);
  assert.equal(await dump(ORG), beforeAttempt);
});

test("the backup schema gives the API roles nothing", async () => {
  for (const role of ["anon", "authenticated"]) {
    const [p] = await all<{ u: boolean }>(`select has_schema_privilege($1, 'case_history_backup', 'USAGE') u`, [role]);
    assert.equal(p.u, false, role);
  }
  await backup();
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`select * from case_history_backup.color_case_entries`), /permission denied/);
  await db.exec(`reset role`);
});
