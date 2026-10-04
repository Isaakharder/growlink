// Runs supabase/migrations/0141_croplink_v2_yield_detail.sql verbatim in an
// in-process Postgres (PGlite, WASM — no server, no network, no credentials)
// on top of minimal stand-ins for the tables it alters, then exercises its
// triggers and functions.
// Run: npm run test:croplink-v2
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const ORG = "11111111-1111-4111-8111-111111111111";
const VARIETY = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
const migration = (f: string) => readFileSync(path.resolve(__dirname, "../../../supabase/migrations", f), "utf8");

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

before(async () => {
  db = new PGlite();
  // Minimal shapes of the pre-existing tables (see migrations 0005, 0056, 0057, 0072).
  await db.exec(`
    create role anon; create role authenticated;
    create table organizations (id uuid primary key);
    create table varieties (id uuid primary key, organization_id uuid, name text, area_m2 numeric not null default 0, updated_at timestamptz default now());
    create table organization_integration_keys (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
      integration_name text not null check (integration_name in ('croplink')), key_hash text not null unique, label text not null,
      status text not null default 'active', created_at timestamptz not null default now(), last_used_at timestamptz);
    create table yield_entries (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id), variety_id uuid not null references varieties(id),
      year integer not null, week integer not null check (week >= 1 and week <= 53), size_kg jsonb not null default '{}'::jsonb,
      total_kg numeric not null default 0, average_fruit_weight_g numeric, kg_per_m2 numeric not null default 0, total_cases numeric not null default 0,
      packed_date date, created_at timestamptz default now(), updated_at timestamptz default now(),
      unique (organization_id, variety_id, year, week));
    create table yield_entry_daily_breakdown (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
      yield_entry_id uuid not null references yield_entries(id) on delete cascade, packed_date date, size_kg jsonb not null default '{}',
      total_kg numeric not null default 0, average_fruit_weight_g numeric, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    insert into organizations values ('${ORG}');
    insert into varieties (id, organization_id, name, area_m2) values ('${VARIETY}', '${ORG}', 'Mathieu', 11627);
    insert into organization_integration_keys (organization_id, integration_name, key_hash, label) values ('${ORG}', 'croplink', 'legacyhash', 'legacy');
  `);
  // 0072's original policies and Supabase's default grants, then 0140 (security fix) and 0141.
  await db.exec(`
    create role service_role bypassrls; -- as in Supabase
    create policy organization_integration_keys_select on organization_integration_keys for select to public using (true);
    create policy organization_integration_keys_insert on organization_integration_keys for insert to public with check (true);
    create policy organization_integration_keys_update on organization_integration_keys for update to public using (true) with check (true);
    create policy organization_integration_keys_delete on organization_integration_keys for delete to public using (true);
    alter table organization_integration_keys enable row level security;
    grant all on table organization_integration_keys to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  await db.exec(migration("0140_rls_fix_integration_keys.sql"));
  await db.exec(migration("0141_croplink_v2_yield_detail.sql"));
});

test("0140: anon/authenticated can no longer read or mint integration keys; service role keeps access", async () => {
  try {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select key_hash from organization_integration_keys"), /permission denied/);
      await assert.rejects(db.query(`insert into organization_integration_keys (organization_id, integration_name, key_hash, label) values ('${ORG}', 'croplink', 'attacker', 'x')`), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.ok((await all("select id from organization_integration_keys")).length >= 1);
  } finally {
    await db.exec("reset role");
  }
  assert.equal((await all("select 1 from pg_policies where tablename = 'organization_integration_keys'")).length, 0);
});

test("existing keys get the legacy v1 scope only; unknown scopes are rejected", async () => {
  assert.deepEqual((await one<{ scopes: string[] }>("select scopes from organization_integration_keys where label = 'legacy'")).scopes, ["harvest-actuals:read"]);
  await db.query(`insert into organization_integration_keys (organization_id, integration_name, key_hash, label, scopes) values ($1, 'croplink', 'h2', 'v2', '{harvest-actuals:read,yield-detail:read}')`, [ORG]);
  await assert.rejects(db.query(`insert into organization_integration_keys (organization_id, integration_name, key_hash, label, scopes) values ($1, 'croplink', 'h3', 'bad', '{admin:write}')`, [ORG]));
  await assert.rejects(db.query(`insert into organization_integration_keys (organization_id, integration_name, key_hash, label, scopes) values ($1, 'croplink', 'h4', 'empty', '{}')`, [ORG]));
});

test("last_write_source defaults to unknown and only accepts known sources", async () => {
  const r = await one<{ last_write_source: string }>(`insert into yield_entries (organization_id, variety_id, year, week) values ($1, $2, 2026, 10) returning last_write_source`, [ORG, VARIETY]);
  assert.equal(r.last_write_source, "unknown");
  await assert.rejects(db.query(`update yield_entries set last_write_source = 'magic' where week = 10`));
});

test("settlement function matches the TypeScript rule (Toronto week end + 10 days, 3 quiet days)", async () => {
  assert.equal((await one<{ e: Date }>("select iso_week_end_local(2026, 38, 'America/Toronto') e")).e.toISOString(), "2026-09-21T04:00:00.000Z");
  assert.equal((await one<{ e: Date }>("select iso_week_end_local(2026, 53, 'America/Toronto') e")).e.toISOString(), "2027-01-04T05:00:00.000Z");
  const s = (changed: string, at: string) => one<{ s: boolean }>("select yield_week_is_settled(2026, 38, $1::timestamptz, $2::timestamptz) s", [changed, at]).then(r => r.s);
  assert.equal(await s("2026-09-22T21:30:21Z", "2026-10-01T03:59:59Z"), false);
  assert.equal(await s("2026-09-22T21:30:21Z", "2026-10-01T04:00:00Z"), true);
  assert.equal(await s("2026-09-29T10:00:00Z", "2026-10-01T04:00:00Z"), false);
});

test("late edit to a settled week is audited with was_settled = true; a fresh edit is not", async () => {
  const { id } = await one<{ id: string }>(
    `insert into yield_entries (organization_id, variety_id, year, week, total_kg, average_fruit_weight_g, last_write_source, updated_at)
     values ($1, $2, 2026, 30, 16818, 219, 'import_pdf', now() - interval '60 days') returning id`, [ORG, VARIETY]);
  await db.query(`update yield_entries set total_kg = 17000, last_write_source = 'manual_edit', updated_at = now() where id = $1`, [id]);
  await db.query(`update yield_entries set total_kg = 17100, updated_at = now() where id = $1`, [id]);
  const revs = await all<{ change_kind: string; was_settled: boolean; previous: { total_kg: number }; current: { total_kg: number }; last_write_source: string }>(
    `select change_kind, was_settled, previous, current, last_write_source from yield_entry_revisions where yield_entry_id = $1 order by id`, [id]);
  assert.equal(revs.length, 2);
  assert.deepEqual([revs[0].change_kind, revs[0].was_settled, Number(revs[0].previous.total_kg), Number(revs[0].current.total_kg), revs[0].last_write_source], ["update", true, 16818, 17000, "manual_edit"]);
  assert.equal(revs[1].was_settled, false);
});

test("an update that changes no tracked data writes no revision", async () => {
  const { id } = await one<{ id: string }>(`insert into yield_entries (organization_id, variety_id, year, week) values ($1, $2, 2026, 31) returning id`, [ORG, VARIETY]);
  await db.query(`update yield_entries set updated_at = now() where id = $1`, [id]);
  assert.equal((await all(`select 1 from yield_entry_revisions where yield_entry_id = $1`, [id])).length, 0);
});

test("daily breakdown changes are audited and make the parent provisional again (updated_at bumped)", async () => {
  const { id } = await one<{ id: string }>(
    `insert into yield_entries (organization_id, variety_id, year, week, total_kg, updated_at) values ($1, $2, 2026, 32, 13420, now() - interval '40 days') returning id`, [ORG, VARIETY]);
  const before = (await one<{ u: Date }>(`select updated_at u from yield_entries where id = $1`, [id])).u;
  await db.query(`insert into yield_entry_daily_breakdown (organization_id, yield_entry_id, packed_date, total_kg, average_fruit_weight_g) values ($1, $2, '2026-08-07', 500, 205)`, [ORG, id]);
  const after = (await one<{ u: Date }>(`select updated_at u from yield_entries where id = $1`, [id])).u;
  assert.ok(after.getTime() > before.getTime());
  const rev = await one<{ change_kind: string; was_settled: boolean; previous: unknown; current: { average_fruit_weight_g: number } }>(
    `select change_kind, was_settled, previous, current from yield_entry_revisions where yield_entry_id = $1`, [id]);
  assert.deepEqual([rev.change_kind, rev.was_settled, rev.previous, Number(rev.current.average_fruit_weight_g)], ["daily_breakdown", true, null, 205]);
  assert.equal((await one<{ s: boolean }>(`select yield_week_is_settled(year, week, updated_at, now()) s from yield_entries where id = $1`, [id])).s, false);
});

test("hard delete leaves a tombstone and a delete revision; cascaded breakdown deletes don't fail", async () => {
  const { id } = await one<{ id: string }>(`insert into yield_entries (organization_id, variety_id, year, week) values ($1, $2, 2026, 33) returning id`, [ORG, VARIETY]);
  await db.query(`insert into yield_entry_daily_breakdown (organization_id, yield_entry_id, total_kg) values ($1, $2, 1)`, [ORG, id]);
  await db.query(`delete from yield_entries where id = $1`, [id]);
  const t = await one<{ entity: string; year: number; week: number }>(`select entity, year, week from integration_deletions where entity_id = $1`, [id]);
  assert.deepEqual([t.entity, t.year, t.week], ["yield_entry", 2026, 33]);
  assert.equal((await all(`select 1 from yield_entry_revisions where yield_entry_id = $1 and change_kind = 'delete'`, [id])).length, 1);
});

test("manifests must carry exactly as many ids as expected_count", async () => {
  await db.query(`insert into integration_manifests values (gen_random_uuid(), $1, 'yield_entry', array[$2]::uuid[], 1, 'c', 'a', now(), now() + interval '1 hour')`, [ORG, VARIETY]);
  await assert.rejects(db.query(`insert into integration_manifests values (gen_random_uuid(), $1, 'yield_entry', array[$2]::uuid[], 2, 'c', 'a', now(), now())`, [ORG, VARIETY]));
});

test("new tables have row-level security enabled (service role only)", async () => {
  const rows = await all<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class where relname in ('integration_deletions','integration_manifests','yield_entry_revisions') order by relname`);
  assert.deepEqual(rows.map(r => [r.relname, r.relrowsecurity]), [["integration_deletions", true], ["integration_manifests", true], ["yield_entry_revisions", true]]);
});
