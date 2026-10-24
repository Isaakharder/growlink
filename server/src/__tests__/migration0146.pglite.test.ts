// Runs supabase/migrations/0143-0146 verbatim in an in-process Postgres
// (PGlite) and checks 0146's table: versions, value shapes, normalization,
// privileges, that existing measurements and entries are untouched, and its
// documented rollback.
// Run: node --require tsx/cjs --test src/__tests__/migration0146.pglite.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";

const ORG = "11111111-1111-4111-8111-111111111111";
const read = (f: string) => readFileSync(path.resolve(__dirname, "../../../supabase/migrations", f), "utf8");
const m0146 = read("0146_pack_measurement_defaults.sql");

let db: PGlite;
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const fails = async (sql: string, pattern: RegExp, params: unknown[] = []) => {
  await assert.rejects(db.query(sql, params), (e: Error) => pattern.test(e.message), `expected ${pattern}`);
};

const snapshot = async () =>
  JSON.stringify(
    await Promise.all(["pack_case_measurements", "manual_pack_case_entries", "case_rebuild_ranges"].map((t) => all(`select * from ${t} order by 1, 2, 3`)))
  );

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}');
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const f of ["0143_docklink_pack_shipments.sql", "0144_manual_pack_case_entries.sql", "0145_case_rebuild_ranges.sql"]) await db.exec(read(f));
  await db.exec(`
    insert into pack_case_measurements (organization_id, iso_year, iso_week, series_key, pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case)
    values ('${ORG}', 2026, 30, null, 'docklink', 'pk-red', 'single', 'red', 'pepper', 'kg', 5.12);
    insert into case_rebuild_ranges (organization_id, from_iso_year, from_iso_week, to_iso_year, to_iso_week) values ('${ORG}', 2026, 16, 2026, 43);
  `);
});

const insert = (o: Record<string, unknown> = {}) => {
  const row = {
    organization_id: ORG, pack_source: "docklink", pack_id: "pk-red", color_kind: "single", color_key: "red", crop_type: "pepper", tracking_unit: "kg",
    value_kind: "net_kg", effective_from_iso_year: 2026, effective_from_iso_week: 30, forgotten: false, net_kg_per_case: 5, components: null, ...o
  };
  const cols = Object.keys(row);
  const values = Object.values(row).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v));
  return db.query(`insert into pack_measurement_defaults (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, values);
};

test("applies on top of 0143-0145 without changing existing measurements, entries or rebuild ranges", async () => {
  const before = await snapshot();
  await db.exec(m0146);
  assert.equal(await snapshot(), before);
  assert.deepEqual(await all(`select count(*)::int n from pack_measurement_defaults`), [{ n: 0 }]);
});

test("one version per identity, value kind and effective week; versions for other weeks coexist", async () => {
  await db.exec(m0146);
  await insert();
  await insert({ effective_from_iso_week: 35, net_kg_per_case: 6 });
  await insert({ effective_from_iso_week: 40, forgotten: true, net_kg_per_case: null });
  await fails(`insert into pack_measurement_defaults (organization_id, pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit, value_kind, effective_from_iso_year, effective_from_iso_week, net_kg_per_case)
    values ($1, 'docklink', 'pk-red', 'single', 'red', 'pepper', 'kg', 'net_kg', 2026, 30, 7)`, /pack_measurement_defaults_version/, [ORG]);
  // The same week for another pack source, classification or value kind is a different version.
  await insert({ pack_source: "historical" });
  await insert({ color_key: "yellow" });
  await insert({ pack_id: "pk-tri", color_kind: "mixed", color_key: "mixed", value_kind: "counts", net_kg_per_case: null, components: [{ color: "red", pieces_per_case: 5 }] });
  await insert({ pack_id: "pk-tri", color_kind: "mixed", color_key: "mixed", value_kind: "fruit_weights", net_kg_per_case: null, components: [{ color: "red", fruit_weight_g: 180 }] });
  assert.deepEqual(await all(`select count(*)::int n from pack_measurement_defaults`), [{ n: 7 }]);
});

test("value shapes: kg per case for single packs, counts or fruit weights for rainbow packs, empty tombstones", async () => {
  await db.exec(m0146);
  const tri = { pack_id: "pk-tri", color_kind: "mixed", color_key: "mixed", net_kg_per_case: null };
  await assert.rejects(insert({ net_kg_per_case: 0 }));
  await assert.rejects(insert({ net_kg_per_case: null }));
  await assert.rejects(insert({ components: [{ color: "red", pieces_per_case: 5 }] }));
  await assert.rejects(insert({ value_kind: "counts" }), "single packs remember kg per case only");
  await assert.rejects(insert({ ...tri, value_kind: "net_kg", net_kg_per_case: 5 }), "rainbow packs don't remember kg per case");
  await assert.rejects(insert({ ...tri, value_kind: "counts", components: [{ color: "red", pieces_per_case: 5, fruit_weight_g: 180 }] }), "counts and fruit weights are separate");
  await assert.rejects(insert({ ...tri, value_kind: "counts", components: [{ color: "pink", pieces_per_case: 5 }] }));
  await assert.rejects(insert({ ...tri, value_kind: "counts", components: [{ color: "red", pieces_per_case: 5 }, { color: "red", pieces_per_case: 4 }] }));
  await assert.rejects(insert({ ...tri, value_kind: "fruit_weights", components: [{ color: "red", fruit_weight_g: 0 }] }));
  await assert.rejects(insert({ ...tri, value_kind: "fruit_weights", components: [] }));
  await assert.rejects(insert({ forgotten: true }), "a tombstone holds no value");
  await assert.rejects(insert({ color_key: " Red " }), "identity is stored normalized");
  await assert.rejects(insert({ crop_type: "Pepper" }));
  await assert.rejects(insert({ effective_from_iso_week: 54 }));
  await assert.rejects(insert({ pack_source: "other" }));
  await insert({ ...tri, value_kind: "counts", components: [{ color: "red", pieces_per_case: 5 }, { color: "yellow", pieces_per_case: 5 }] });
  await insert({ ...tri, value_kind: "counts", effective_from_iso_week: 31, forgotten: true, components: null });
});

test("server-only: RLS on, no policies, no anon/authenticated access; service_role can read and write", async () => {
  await db.exec(m0146);
  const [{ rls }] = await all<{ rls: boolean }>(`select relrowsecurity rls from pg_class where oid = 'public.pack_measurement_defaults'::regclass`);
  assert.equal(rls, true);
  assert.deepEqual(await all(`select * from pg_policies where tablename = 'pack_measurement_defaults'`), []);
  for (const role of ["anon", "authenticated"]) {
    const [p] = await all<Record<string, boolean>>(
      `select has_table_privilege($1, 'public.pack_measurement_defaults', 'SELECT') s, has_table_privilege($1, 'public.pack_measurement_defaults', 'INSERT') i,
              has_function_privilege($1, 'public.pack_measurement_default_values_valid(text, jsonb)', 'EXECUTE') x`, [role]
    );
    assert.deepEqual(p, { s: false, i: false, x: false }, role);
  }
  await db.exec(`set role service_role`);
  await insert();
  assert.equal((await all(`select * from pack_measurement_defaults`)).length, 1);
  await db.exec(`reset role`);
  await db.exec(`set role anon`);
  await fails(`select * from pack_measurement_defaults`, /permission denied/);
  await db.exec(`reset role`);
});

test("the documented rollback removes only what 0146 created", async () => {
  await db.exec(m0146);
  await insert();
  const before = await snapshot();
  const rollback = m0146.split("-- ROLLBACK")[1].split("\n").filter((l) => l.startsWith("-- ")).map((l) => l.slice(3)).join("\n");
  await db.exec(rollback);
  assert.deepEqual(await all(`select to_regclass('public.pack_measurement_defaults') t`), [{ t: null }]);
  assert.equal(await snapshot(), before);
  // And 0146 applies again cleanly afterwards.
  await db.exec(m0146);
});
