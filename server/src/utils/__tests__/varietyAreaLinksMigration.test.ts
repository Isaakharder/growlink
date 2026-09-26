// Migration 0138 (variety_area_links), executed as real SQL in an in-process
// Postgres (PGlite) on the objects it references: the table's constraints
// are what keep a link unambiguous.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const M0138 = readFileSync(join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "0138_variety_area_links.sql"), "utf-8");
const ORG = "11111111-1111-4111-8111-111111111111";
const LEGACY = "aaaaaaaa-0000-4000-8000-000000000001";
const SUCCESSOR = "aaaaaaaa-0000-4000-8000-000000000002";
const PHASE = "bbbbbbbb-0000-4000-8000-000000000001";

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role authenticated;
    create role service_role;
    create table public.organizations (id uuid primary key, name text not null);
    create table public.varieties (id uuid primary key, organization_id uuid not null references public.organizations(id), name text not null);
    create table public.greenhouse_groups (id uuid primary key, organization_id uuid references public.organizations(id), type text not null, name text not null);
    create function public.is_org_member(org uuid) returns boolean language sql as 'select true';
    insert into public.organizations values ('${ORG}', 'Test Org');
    insert into public.varieties values ('${LEGACY}', '${ORG}', 'Legacy'), ('${SUCCESSOR}', '${ORG}', 'Successor');
    insert into public.greenhouse_groups values ('${PHASE}', '${ORG}', 'phase', 'Phase 1');
  `);
  await db.exec(M0138);
  return db;
}

const insert = (db: PGlite, successor: string | null, group: string | null, variety = LEGACY) =>
  db.query("insert into public.variety_area_links (organization_id, variety_id, successor_variety_id, greenhouse_group_id) values ($1, $2, $3, $4)", [
    ORG,
    variety,
    successor,
    group
  ]);

test("0138 accepts one link per target: a successor, or a greenhouse group", async () => {
  const db = await database();
  await insert(db, SUCCESSOR, null);
  await insert(db, null, PHASE);
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.variety_area_links");
  assert.equal(rows[0].n, 2);
  await db.close();
});

test("0138 rejects no target, two targets, itself as successor, and duplicates", async () => {
  const db = await database();
  await assert.rejects(insert(db, null, null), /variety_area_links_one_target/);
  await assert.rejects(insert(db, SUCCESSOR, PHASE), /variety_area_links_one_target/);
  await assert.rejects(insert(db, LEGACY, null), /variety_area_links_not_self/);
  await insert(db, SUCCESSOR, null);
  await assert.rejects(insert(db, SUCCESSOR, null), /variety_area_links_successor_unique/);
  await insert(db, null, PHASE);
  await assert.rejects(insert(db, null, PHASE), /variety_area_links_group_unique/);
  await db.close();
});

test("deleting a variety removes its links", async () => {
  const db = await database();
  await insert(db, SUCCESSOR, null);
  await db.query("delete from public.varieties where id = $1", [SUCCESSOR]);
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.variety_area_links");
  assert.equal(rows[0].n, 0);
  await db.close();
});
