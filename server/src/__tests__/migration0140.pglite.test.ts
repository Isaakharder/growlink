// Migration 0140 against the exact production state found by preflight A1/A2
// (2026-10-04), in an in-process Postgres (PGlite — no server, no network).
// Run: npm run test:croplink-v2
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const ORG = "11111111-1111-4111-8111-111111111111";
const SQL = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0140_rls_fix_integration_keys.sql"), "utf8");
const ROLLBACK = SQL.split("-- ROLLBACK")[1].split("\n").filter(l => l.startsWith("-- ") && !l.startsWith("-- ROLLBACK")).map(l => l.slice(3)).filter(l => /^(begin|commit|create|grant)/.test(l)).join("\n");
const TABLES = ["organization_integration_keys", "organization_upload_keys"];
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

async function liveState(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}');
    create table organization_integration_keys (id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
      integration_name text not null, key_hash text not null unique, label text not null, status text not null default 'active', created_at timestamptz default now(), last_used_at timestamptz);
    create table organization_upload_keys (id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
      key_hash text not null unique, label text not null, status text not null default 'active');
    alter table organization_integration_keys enable row level security;
    alter table organization_upload_keys enable row level security;
    create policy organization_integration_keys_select on organization_integration_keys for select to public using (true);
    create policy organization_integration_keys_insert on organization_integration_keys for insert to public with check (true);
    create policy organization_integration_keys_update on organization_integration_keys for update to public using (true) with check (true);
    create policy organization_integration_keys_delete on organization_integration_keys for delete to public using (true);
    revoke all on organization_integration_keys, organization_upload_keys from anon, authenticated;
    grant references, trigger, truncate on organization_integration_keys, organization_upload_keys to anon, authenticated;
    grant all on organization_integration_keys, organization_upload_keys to service_role;
    insert into organization_integration_keys (organization_id, integration_name, key_hash, label) values ('${ORG}', 'croplink', 'h1', 'CropLink');
    insert into organization_upload_keys (organization_id, key_hash, label) values ('${ORG}', 'u1', 'Agent');
  `);
  return db;
}

async function grants(db: PGlite) {
  const rows: string[] = [];
  for (const t of TABLES) for (const r of ["anon", "authenticated", "service_role"]) {
    const held = [];
    for (const p of PRIVS) if ((await db.query<{ h: boolean }>(`select has_table_privilege($1, $2, $3) h`, [r, `public.${t}`, p])).rows[0].h) held.push(p);
    rows.push(`${t}:${r}:${held.join(",")}`);
  }
  return rows;
}
const policies = async (db: PGlite) => (await db.query<{ p: string }>(`select tablename || '.' || policyname p from pg_policies where tablename in ('organization_integration_keys','organization_upload_keys') order by 1`)).rows.map(r => r.p);

test("0140 on the live state: policies dropped, anon/authenticated hold nothing, service role keeps SELECT/INSERT/UPDATE/DELETE", async () => {
  const db = await liveState();
  await db.exec(SQL);
  assert.deepEqual(await policies(db), []);
  assert.deepEqual(await grants(db), [
    "organization_integration_keys:anon:", "organization_integration_keys:authenticated:", "organization_integration_keys:service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    "organization_upload_keys:anon:", "organization_upload_keys:authenticated:", "organization_upload_keys:service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
  ]);
  for (const role of ["anon", "authenticated"]) for (const t of TABLES) {
    await db.exec(`set role ${role}`);
    try {
      for (const stmt of [`select * from ${t}`, `insert into ${t} (organization_id, key_hash, label${t.includes("integration") ? ", integration_name" : ""}) values ('${ORG}', 'x', 'x'${t.includes("integration") ? ", 'croplink'" : ""})`, `update ${t} set label = 'x'`, `delete from ${t}`, `truncate ${t}`]) {
        await assert.rejects(db.query(stmt), /permission denied/, `${role}: ${stmt}`);
      }
    } finally { await db.exec("reset role"); }
  }
  await db.exec("set role service_role");
  try {
    for (const t of TABLES) {
      assert.equal((await db.query(`select id from ${t}`)).rows.length, 1);
      await db.query(`update ${t} set label = label`);
    }
    await db.query(`insert into organization_integration_keys (organization_id, integration_name, key_hash, label) values ('${ORG}', 'croplink', 'h2', 'new')`);
    await db.query(`delete from organization_integration_keys where key_hash = 'h2'`);
  } finally { await db.exec("reset role"); }
});

test("0140 aborts and changes nothing if an unexpected policy exists", async () => {
  const db = await liveState();
  await db.exec(`create policy unexpected on organization_upload_keys for select to authenticated using (true)`);
  const before = [await policies(db), await grants(db)];
  await assert.rejects(db.exec(SQL), /0140 aborted: policies remain/);
  await db.exec("rollback").catch(() => {});
  assert.deepEqual([await policies(db), await grants(db)], before);
});

test("rollback restores the exact pre-migration state; re-applying 0140 is clean", async () => {
  const db = await liveState();
  const before = [await policies(db), await grants(db)];
  await db.exec(SQL);
  await db.exec(ROLLBACK);
  assert.deepEqual([await policies(db), await grants(db)], before);
  await db.exec(SQL);
  await db.exec(SQL);
  assert.deepEqual(await policies(db), []);
});
