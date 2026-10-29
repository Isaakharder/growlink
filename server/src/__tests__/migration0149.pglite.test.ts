// Runs supabase/migrations/0149_rls_fix_quality_anon_read.sql verbatim in an in-process
// Postgres (PGlite) on the production policies/grants found on 2026-10-29 (anon TV read
// policies for First Light, 0035's `grant all … to anon, authenticated`) and checks, as
// real database roles with Supabase-style JWT claims:
//   - anonymous callers can no longer read or write either table, for any organization;
//   - organization members keep their own organization's access and never see another's;
//   - authenticated users with no membership see nothing; the service role is unaffected;
//   - no existing row is changed; an unexpected leftover anon policy aborts the migration;
//   - the documented rollback restores the exact prior state and a re-run is clean.
// Run: node --require tsx/cjs --test src/__tests__/migration0149.pglite.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const FL = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c"; // First Light (the org the TV policies exposed)
const O2 = "22222222-2222-4222-8222-222222222222";
const FL_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const O2_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FL_EMP = "e1e1e1e1-0000-4000-8000-000000000001";
const O2_EMP = "e2e2e2e2-0000-4000-8000-000000000002";

const SQL = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0149_rls_fix_quality_anon_read.sql"), "utf8");
const ROLLBACK = SQL.split("-- ROLLBACK")[1].split("\n").filter(l => l.startsWith("-- ") && !l.startsWith("-- ROLLBACK")).map(l => l.slice(3)).filter(l => /^(begin|commit|create|grant)/.test(l)).join("\n");
const TABLES = ["quality_checks", "quality_employees"];
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

async function liveState(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth; grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create table organizations (id uuid primary key);
    create table memberships (organization_id uuid not null references organizations(id), user_id uuid not null, role text not null default 'member');
    insert into organizations values ('${FL}'), ('${O2}');
    insert into memberships (organization_id, user_id) values ('${FL}', '${FL_USER}'), ('${O2}', '${O2_USER}');
    create function public.is_org_member(org_id uuid) returns boolean language sql stable security definer set search_path to 'public' as
      $$ select exists (select 1 from public.memberships where organization_id = org_id and user_id = auth.uid()) $$;

    create table quality_employees (id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
      name text not null, active boolean not null default true, created_at timestamptz not null default now());
    create table quality_checks (id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
      employee_id uuid not null references quality_employees(id), phase_name text not null, row_number int not null,
      stems_checked int not null, total_issues int not null default 0, metric_counts jsonb not null default '{}', notes text,
      created_by uuid, checked_at timestamptz not null default now());
    alter table quality_employees enable row level security;
    alter table quality_checks enable row level security;

    -- 0035
    create policy quality_employees_select on quality_employees for select to authenticated using (public.is_org_member(organization_id));
    create policy quality_employees_insert on quality_employees for insert to authenticated with check (public.is_org_member(organization_id));
    create policy quality_employees_update on quality_employees for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
    create policy quality_checks_select on quality_checks for select to authenticated using (public.is_org_member(organization_id));
    create policy quality_checks_insert on quality_checks for insert to authenticated with check (public.is_org_member(organization_id));
    grant all on table quality_employees, quality_checks to anon, authenticated, service_role;
    -- created outside the migrations
    create policy quality_checks_tv_read_first_light on quality_checks for select to anon using (organization_id = '${FL}'::uuid);
    create policy quality_employees_tv_read_first_light on quality_employees for select to anon using (organization_id = '${FL}'::uuid);

    insert into quality_employees (id, organization_id, name) values ('${FL_EMP}', '${FL}', 'FL picker'), ('${O2_EMP}', '${O2}', 'O2 picker');
    insert into quality_checks (organization_id, employee_id, phase_name, row_number, stems_checked, total_issues, notes, created_by) values
      ('${FL}', '${FL_EMP}', 'Pruning', 12, 40, 2, 'fl note', '${FL_USER}'),
      ('${FL}', '${FL_EMP}', 'Pruning', 13, 40, 0, null, '${FL_USER}'),
      ('${O2}', '${O2_EMP}', 'Picking', 7, 30, 1, 'o2 note', '${O2_USER}');
  `);
  return db;
}

// Run fn as a database role, with the JWT subject PostgREST would set for that caller.
async function as<T>(db: PGlite, role: "anon" | "authenticated" | "service_role", sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub ?? ""]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const count = async (db: PGlite, sql: string) => Number((await db.query<{ n: number }>(`select count(*)::int n from (${sql}) q`)).rows[0].n);
const affected = async (db: PGlite, sql: string) => (await db.query(sql)).affectedRows ?? 0;

async function grants(db: PGlite) {
  const rows: string[] = [];
  for (const t of TABLES) for (const r of ["anon", "authenticated", "service_role"]) {
    const held = [];
    for (const p of PRIVS) if ((await db.query<{ h: boolean }>(`select has_table_privilege($1, $2, $3) h`, [r, `public.${t}`, p])).rows[0].h) held.push(p);
    rows.push(`${t}:${r}:${held.join(",")}`);
  }
  return rows;
}
const policies = async (db: PGlite) =>
  (await db.query<{ p: string }>(`select tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') p from pg_policies where tablename in ('quality_checks','quality_employees') order by 1`)).rows.map(r => r.p);
const snapshot = async (db: PGlite) => {
  const out: Record<string, unknown[]> = {};
  for (const t of [...TABLES, "memberships", "organizations"]) out[t] = (await db.query(`select to_jsonb(x)::text j from ${t} x order by 1`)).rows;
  return out;
};

test("before 0149: the anon key reads First Light's quality data (the reported exposure)", async () => {
  const db = await liveState();
  await as(db, "anon", null, async () => {
    assert.equal(await count(db, "select * from quality_checks"), 2);
    assert.equal(await count(db, "select * from quality_employees"), 1);
    assert.equal(await count(db, `select * from quality_checks where organization_id = '${O2}'`), 0);
  });
});

test("0149: anonymous callers can no longer read or write either table, for any organization", async () => {
  const db = await liveState();
  await db.exec(SQL);
  await as(db, "anon", null, async () => {
    for (const t of TABLES) for (const stmt of [
      `select * from ${t}`,
      `select * from ${t} where organization_id = '${FL}'`,
      `select id from ${t} where organization_id = '${O2}'`,
      t === "quality_checks"
        ? `insert into quality_checks (organization_id, employee_id, phase_name, row_number, stems_checked) values ('${FL}', '${FL_EMP}', 'x', 1, 1)`
        : `insert into quality_employees (organization_id, name) values ('${FL}', 'x')`,
      `update ${t} set organization_id = organization_id`,
      `delete from ${t}`,
      `truncate ${t}`,
    ]) await assert.rejects(db.query(stmt), /permission denied/, `anon: ${stmt}`);
    // The PostgREST embed the TV used (checks → employees) is refused too.
    await assert.rejects(db.query(`select c.id, e.name from quality_checks c join quality_employees e on e.id = c.employee_id`), /permission denied/);
  });
});

test("0149: organization members keep exactly their own organization's access; no cross-organization reads or writes", async () => {
  const db = await liveState();
  await db.exec(SQL);
  for (const [user, own, other, ownEmp, otherEmp, ownChecks] of [
    [FL_USER, FL, O2, FL_EMP, O2_EMP, 2],
    [O2_USER, O2, FL, O2_EMP, FL_EMP, 1],
  ] as const) {
    await as(db, "authenticated", user, async () => {
      assert.equal(await count(db, "select * from quality_checks"), ownChecks, `${user} sees only own checks`);
      assert.equal(await count(db, "select * from quality_employees"), 1);
      assert.equal(await count(db, `select * from quality_checks where organization_id = '${other}'`), 0);
      assert.equal(await count(db, `select * from quality_employees where organization_id = '${other}'`), 0);
      assert.equal(await count(db, `select c.id from quality_checks c join quality_employees e on e.id = c.employee_id`), ownChecks);

      // own organization: insert and update still work under the is_org_member policies
      await db.query(`insert into quality_employees (organization_id, name) values ('${own}', 'new')`);
      await db.query(`insert into quality_checks (organization_id, employee_id, phase_name, row_number, stems_checked) values ('${own}', '${ownEmp}', 'x', 1, 1)`);
      assert.equal(await affected(db, `update quality_employees set active = active where id = '${ownEmp}'`), 1);

      // other organization: refused by RLS, nothing visible to update or delete
      await assert.rejects(db.query(`insert into quality_employees (organization_id, name) values ('${other}', 'x')`), /row-level security/);
      await assert.rejects(db.query(`insert into quality_checks (organization_id, employee_id, phase_name, row_number, stems_checked) values ('${other}', '${otherEmp}', 'x', 1, 1)`), /row-level security/);
      assert.equal(await affected(db, `update quality_employees set name = 'x' where organization_id = '${other}'`), 0);
      assert.equal(await affected(db, `delete from quality_checks where organization_id = '${other}'`), 0);

      // whole-table privileges that sidestep RLS are gone
      for (const t of TABLES) await assert.rejects(db.query(`truncate ${t}`), /permission denied/);
    });
  }
  // the other organization's rows were never touched
  assert.equal(await count(db, `select * from quality_employees where name = 'x'`), 0);
  assert.equal(await count(db, `select * from quality_checks where phase_name = 'Picking'`), 1);
});

test("0149: an authenticated user with no membership sees and changes nothing; the service role is unaffected", async () => {
  const db = await liveState();
  await db.exec(SQL);
  await as(db, "authenticated", STRANGER, async () => {
    for (const t of TABLES) assert.equal(await count(db, `select * from ${t}`), 0);
    await assert.rejects(db.query(`insert into quality_employees (organization_id, name) values ('${FL}', 'x')`), /row-level security/);
  });
  await as(db, "service_role", null, async () => {
    assert.equal(await count(db, "select * from quality_checks"), 3);
    assert.equal(await count(db, "select * from quality_employees"), 2);
    assert.equal(await affected(db, `update quality_checks set notes = notes where organization_id = '${FL}'`), 2);
  });
  assert.deepEqual(await grants(db), [
    "quality_checks:anon:", "quality_checks:authenticated:SELECT,INSERT,UPDATE,DELETE", "quality_checks:service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    "quality_employees:anon:", "quality_employees:authenticated:SELECT,INSERT,UPDATE,DELETE", "quality_employees:service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
  ]);
  assert.deepEqual(await policies(db), [
    "quality_checks.quality_checks_insert:INSERT:authenticated", "quality_checks.quality_checks_select:SELECT:authenticated",
    "quality_employees.quality_employees_insert:INSERT:authenticated", "quality_employees.quality_employees_select:SELECT:authenticated",
    "quality_employees.quality_employees_update:UPDATE:authenticated",
  ]);
});

test("0149 changes no existing row", async () => {
  const db = await liveState();
  const before = await snapshot(db);
  await db.exec(SQL);
  assert.deepEqual(await snapshot(db), before);
});

test("0149 aborts and changes nothing if another anon/public policy exists on these tables", async () => {
  const db = await liveState();
  await db.exec(`create policy unexpected on quality_employees for select to public using (true)`);
  const before = [await policies(db), await grants(db)];
  await assert.rejects(db.exec(SQL), /0149 aborted: public\/anon policies remain: quality_employees\.unexpected/);
  await db.exec("rollback").catch(() => {});
  assert.deepEqual([await policies(db), await grants(db)], before);
});

test("rollback restores the exact pre-migration state; re-applying 0149 is clean", async () => {
  const db = await liveState();
  const before = [await policies(db), await grants(db)];
  await db.exec(SQL);
  await db.exec(ROLLBACK);
  assert.deepEqual([await policies(db), await grants(db)], before);
  await db.exec(SQL);
  await db.exec(SQL);
  assert.equal((await policies(db)).filter(p => p.endsWith(":anon")).length, 0);
});
