// Runs supabase/migrations/0143 and 0144 verbatim in an in-process Postgres
// (PGlite) and checks 0144's tables, keys, measurement re-keying, privileges
// and its documented rollback.
// Run: node --require tsx/cjs --test src/__tests__/migration0144.pglite.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const read = (f: string) => readFileSync(path.resolve(__dirname, "../../../supabase/migrations", f), "utf8");
const m0143 = read("0143_docklink_pack_shipments.sql");
const m0144 = read("0144_manual_pack_case_entries.sql");

let db: PGlite;
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const fails = async (sql: string, pattern: RegExp, params: unknown[] = []) => {
  await assert.rejects(db.query(sql, params), (e: Error) => pattern.test(e.message));
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(m0143);
  await db.exec(`
    insert into docklink_packs (organization_id, pack_id, name, status) values
      ('${ORG}', 'pk-red', 'Red 5kg', 'active'), ('${OTHER_ORG}', 'pk-other', 'Other red', 'active');
    -- a measurement saved under 0143 (mixed-case values, series-keyed)
    insert into pack_case_measurements (organization_id, iso_year, iso_week, series_key, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case)
    values ('${ORG}', 2026, 47, 's-red-5kg', 'pk-red', 'single', ' Red ', 'Pepper', 'KG', 5.12);
  `);
  await db.exec(m0144);
});

const insertEntry = (o: Record<string, unknown> = {}) => {
  const row = {
    organization_id: ORG, iso_year: 2025, iso_week: 14, pack_source: "docklink", docklink_pack_id: "pk-red", historical_pack_id: null,
    pack_name: "Red 5kg", color_kind: "single", color_key: "red", crop_type: "pepper", tracking_unit: "kg", cases: 10, invoice_ref: null, ...o
  };
  const cols = Object.keys(row);
  return db.query(`insert into manual_pack_case_entries (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, Object.values(row));
};

test("existing 0143 measurements are normalized and re-keyed by pack + classification, series_key kept", async () => {
  const [m] = await all(`select series_key, pack_source, color_key, crop_type, tracking_unit from pack_case_measurements`);
  assert.deepEqual(m, { series_key: "s-red-5kg", pack_source: "docklink", color_key: "red", crop_type: "pepper", tracking_unit: "kg" });
  // A second measurement for the same week, pack and classification is refused, whatever its series key.
  await fails(
    `insert into pack_case_measurements (organization_id, iso_year, iso_week, series_key, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case)
     values ($1, 2026, 47, 'another-series', 'pk-red', 'single', 'red', 'pepper', 'kg', 5)`,
    /pack_case_measurements_pack_identity/, [ORG]
  );
  // Manual weeks store measurements without a series key; historical packs are a separate identity.
  await db.query(
    `insert into pack_case_measurements (organization_id, iso_year, iso_week, series_key, pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case)
     values ($1, 2026, 47, null, 'historical', 'pk-red', 'single', 'red', 'pepper', 'kg', 5)`, [ORG]
  );
});

test("many entries may share a week and pack (several invoices); the invoice key is normalized", async () => {
  await insertEntry({ invoice_ref: " INV-1001 " });
  await insertEntry({ invoice_ref: "inv-1001" });
  await insertEntry({ invoice_ref: "INV-1002", cases: 2.5 });
  const rows = await all<{ invoice_ref_key: string | null }>(`select invoice_ref_key from manual_pack_case_entries order by created_at, id`);
  assert.deepEqual(rows.map((r) => r.invoice_ref_key).sort(), ["inv-1001", "inv-1001", "inv-1002"]);
});

test("entry checks: cases > 0, week 1-53, exactly one pack reference, classification shape", async () => {
  await assert.rejects(insertEntry({ cases: 0 }));
  await assert.rejects(insertEntry({ cases: -3 }));
  await assert.rejects(insertEntry({ iso_week: 54 }));
  await assert.rejects(insertEntry({ historical_pack_id: "0c000000-0000-4000-8000-0000000000c1" }), /manual_pack_case_entries_pack/);
  await assert.rejects(insertEntry({ pack_source: "historical" }), /manual_pack_case_entries_pack/);
  await assert.rejects(insertEntry({ color_kind: "rainbow" }));
});

test("an entry can only reference its own organization's packs", async () => {
  await assert.rejects(insertEntry({ docklink_pack_id: "pk-other" }), /manual_pack_case_entries_docklink_pack/);
  const [h] = await all<{ id: string }>(
    `insert into historical_packs (organization_id, name, color_kind, color_key, crop_type, tracking_unit) values ($1, 'Old red 11lb', 'single', 'red', 'pepper', 'kg') returning id`,
    [OTHER_ORG]
  );
  await assert.rejects(
    insertEntry({ pack_source: "historical", docklink_pack_id: null, historical_pack_id: h.id }),
    /manual_pack_case_entries_historical_pack/
  );
});

test("a pack with entries can't be deleted out from under them", async () => {
  const [h] = await all<{ id: string }>(
    `insert into historical_packs (organization_id, name, color_kind, color_key, crop_type, tracking_unit) values ($1, 'Old tri 3pk', 'mixed', 'mixed', 'pepper', 'kg') returning id`,
    [ORG]
  );
  await insertEntry({ pack_source: "historical", docklink_pack_id: null, historical_pack_id: h.id, color_kind: "mixed", color_key: "mixed" });
  await fails(`delete from historical_packs where id = $1`, /manual_pack_case_entries_historical_pack/, [h.id]);
  await insertEntry();
  await fails(`delete from docklink_packs where pack_id = 'pk-red'`, /manual_pack_case_entries_docklink_pack/);
});

test("historical pack classification shape is enforced", async () => {
  const ins = (kind: string, key: string, crop = "pepper", unit = "kg") =>
    db.query(`insert into historical_packs (organization_id, name, color_kind, color_key, crop_type, tracking_unit) values ($1, 'x', $2, $3, $4, $5)`, [ORG, kind, key, crop, unit]);
  await ins("single", "green");
  await ins("mixed", "mixed");
  await ins("none", "", "cucumber", "piece");
  await assert.rejects(ins("single", "purple"));
  await assert.rejects(ins("mixed", "red"));
  await assert.rejects(ins("single", "red", "herb"));
  await assert.rejects(ins("single", "red", "pepper", "units"));
});

test("week source: one choice per organization and week, manual_packs or legacy_colours only", async () => {
  await db.query(`insert into case_week_sources (organization_id, iso_year, iso_week, source) values ($1, 2025, 14, 'manual_packs')`, [ORG]);
  await assert.rejects(db.query(`insert into case_week_sources (organization_id, iso_year, iso_week, source) values ($1, 2025, 14, 'legacy_colours')`, [ORG]));
  await assert.rejects(db.query(`insert into case_week_sources (organization_id, iso_year, iso_week, source) values ($1, 2025, 15, 'docklink')`, [ORG]));
  await db.query(`insert into case_week_sources (organization_id, iso_year, iso_week, source) values ($1, 2025, 14, 'legacy_colours')`, [OTHER_ORG]);
});

test("server-only: no privileges for anon/authenticated on any new table, RLS on, no policies", async () => {
  for (const t of ["historical_packs", "manual_pack_case_entries", "case_week_sources", "pack_case_measurements"]) {
    for (const role of ["anon", "authenticated"]) {
      const [p] = await all<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
        `select has_table_privilege($1, $2, 'SELECT') s, has_table_privilege($1, $2, 'INSERT') i, has_table_privilege($1, $2, 'UPDATE') u, has_table_privilege($1, $2, 'DELETE') d`,
        [role, `public.${t}`]
      );
      assert.deepEqual(p, { s: false, i: false, u: false, d: false }, `${role} on ${t}`);
    }
    const [r] = await all<{ on: boolean }>(`select relrowsecurity "on" from pg_class where oid = $1::regclass`, [`public.${t}`]);
    assert.equal(r.on, true);
  }
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`select * from manual_pack_case_entries`), /permission denied/);
  await db.exec(`reset role`);
});

test("the documented rollback restores 0143's measurement key", async () => {
  const rollback = m0144.split("-- ROLLBACK")[1].split("\n").filter((l) => l.startsWith("-- ")).map((l) => l.slice(3)).join("\n");
  await db.exec(rollback);
  const tables = await all<{ t: string }>(`select tablename t from pg_tables where schemaname = 'public' and tablename in ('historical_packs', 'manual_pack_case_entries', 'case_week_sources')`);
  assert.deepEqual(tables, []);
  const [c] = await all<{ n: number }>(`select count(*)::int n from pg_constraint where conname = 'pack_case_measurements_identity'`);
  assert.equal(c.n, 1);
  assert.equal((await all(`select * from pack_case_measurements`)).length, 1, "existing DockLink measurements survive the rollback");
});
