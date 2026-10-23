// Runs supabase/migrations/0143_docklink_pack_shipments.sql verbatim in an
// in-process Postgres (PGlite, WASM — no server, no Docker, no network) and
// exercises apply_docklink_pack_export with the validated mock export.
// Run: node --require tsx/cjs --test src/__tests__/migration0143.pglite.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { validatePackExport, type NormalizedPackExport } from "../lib/docklinkPackExport";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DL_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const migration = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0143_docklink_pack_shipments.sql"), "utf8");
const rawFixture = () => JSON.parse(readFileSync(path.resolve(__dirname, "../lib/__tests__/fixtures/docklink-pack-export-v1.json"), "utf8"));
const fixture = (mutate?: (doc: ReturnType<typeof rawFixture>) => void): NormalizedPackExport => {
  const doc = rawFixture();
  mutate?.(doc);
  return validatePackExport(doc, DL_ORG);
};

let db: PGlite;
const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await all<T>(sql, params))[0];

const apply = (doc: NormalizedPackExport, org = ORG, externalOrg = DL_ORG) =>
  one<{ r: Record<string, unknown> }>(`select public.apply_docklink_pack_export($1, $2, $3::jsonb) r`, [org, externalOrg, JSON.stringify(doc)]).then((x) => x.r);

const series = (org = ORG) =>
  all<{ k: string }>(
    `select iso_week || ':' || series_key || ':' || total_cases::float8 || (case when absent_from_export then ':absent' else '' end) k
       from docklink_pack_weekly_shipments where organization_id = $1 order by iso_week, series_key`,
    [org]
  ).then((rows) => rows.map((r) => r.k));

const snapshot = async () =>
  JSON.stringify(
    await Promise.all(
      ["docklink_pack_sync_state", "docklink_packs", "docklink_pack_weekly_shipments", "pack_case_measurements"].map((t) =>
        all(`select * from ${t} order by 1, 2`)
      )
    )
  );

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    -- Supabase's default privileges grant every new table/function to the API roles; 0143 must undo that.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(migration);
});

const measure = (week: number, seriesKey: string, kg: number, org = ORG) =>
  db.query(
    `insert into pack_case_measurements (organization_id, iso_year, iso_week, series_key, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case)
     select $1, iso_year, iso_week, series_key, pack_id, 'single', color_key, crop_type, tracking_unit, $4
       from docklink_pack_weekly_shipments where organization_id = $1 and iso_week = $2 and series_key = $3`,
    [org, week, seriesKey, kg]
  );

// ---------------------------------------------------------------------------

test("first sync stores the catalogue, the weekly series and the scope", async () => {
  const result = await apply(fixture());
  assert.deepEqual(result, { scope_status: "available", packs: 8, series_inserted: 15, series_updated: 0, series_zeroed: 0 });
  const state = await one(`select scope_status, first_iso_week, last_iso_week, transition_iso_week, contract_version from docklink_pack_sync_state where organization_id = $1`, [ORG]);
  assert.deepEqual(state, { scope_status: "available", first_iso_week: 45, last_iso_week: 48, transition_iso_week: 44, contract_version: 1 });
  const yellow = await one<{ c: string }>(`select total_cases::text c from docklink_pack_weekly_shipments where organization_id = $1 and iso_week = 47 and series_key = 's-yellow-5kg'`, [ORG]);
  assert.equal(yellow.c, "312.5", "decimal cases stored exactly");
  const archived = await one(`select status, archived_at is not null a from docklink_packs where organization_id = $1 and pack_code = 'TC3'`, [ORG]);
  assert.deepEqual(archived, { status: "archived", a: true });
});

test("a repeated identical sync changes no counts and never touches measurements", async () => {
  await apply(fixture());
  await measure(47, "s-red-5kg", 5.12);
  const before = await all(`select * from pack_case_measurements`);
  const result = await apply(fixture((d) => (d.generated_at = "2026-11-23T15:00:00Z")));
  assert.deepEqual([result.series_inserted, result.series_updated, result.series_zeroed], [0, 15, 0]);
  assert.deepEqual(await all(`select * from pack_case_measurements`), before);
});

test("corrections overwrite a series' count; voids arrive as explicit zeros; both keep the measurement", async () => {
  await apply(fixture());
  await measure(47, "s-red-5kg", 5.12);
  await apply(
    fixture((d) => {
      d.generated_at = "2026-11-24T09:00:00Z";
      d.weekly_pack_totals.find((r: { iso_week: number; series_key: string }) => r.iso_week === 47 && r.series_key === "s-red-5kg").total_cases = 1790; // corrected
      d.weekly_pack_totals.find((r: { iso_week: number; series_key: string }) => r.iso_week === 47 && r.series_key === "s-tri-3pk").total_cases = 0; // voided
    })
  );
  const s = await series();
  assert.ok(s.includes("47:s-red-5kg:1790"));
  assert.ok(s.includes("47:s-tri-3pk:0"));
  assert.equal((await all(`select 1 from pack_case_measurements where series_key = 's-red-5kg' and iso_week = 47`)).length, 1);
});

test("a series missing from a complete export, within scope, becomes zero (flagged absent) — rows outside the scope are untouched", async () => {
  await apply(fixture());
  // A series GrowLink holds for a week that is no longer in scope (scope will start at 46).
  const result = await apply(
    fixture((d) => {
      d.generated_at = "2026-11-24T09:00:00Z";
      d.scope.first_week = { iso_year: 2026, iso_week: 46, week_start: "2026-11-09" };
      d.scope.transition_week = { iso_year: 2026, iso_week: 45, week_start: "2026-11-02" };
      d.weekly_pack_totals = d.weekly_pack_totals.filter(
        (r: { iso_week: number; series_key: string }) => r.iso_week !== 45 && !(r.iso_week === 47 && r.series_key === "s-purple")
      );
    })
  );
  assert.equal(result.series_zeroed, 1);
  const s = await series();
  assert.ok(s.includes("47:s-purple:0:absent"), "missing in-scope series zeroed");
  assert.ok(s.includes("45:s-red-5kg:1500"), "week 45 is outside the new scope: kept as it was, not zeroed");
  // Reapplying the same export does not re-zero or re-count it.
  const again = await apply(fixture((d) => {
    d.generated_at = "2026-11-24T10:00:00Z";
    d.scope.first_week = { iso_year: 2026, iso_week: 46, week_start: "2026-11-09" };
    d.scope.transition_week = { iso_year: 2026, iso_week: 45, week_start: "2026-11-02" };
    d.weekly_pack_totals = d.weekly_pack_totals.filter((r: { iso_week: number; series_key: string }) => r.iso_week !== 45 && !(r.iso_week === 47 && r.series_key === "s-purple"));
  }));
  assert.equal(again.series_zeroed, 0);
});

test("a series that comes back after being zeroed is restored and no longer flagged absent", async () => {
  await apply(fixture());
  await apply(fixture((d) => {
    d.generated_at = "2026-11-24T09:00:00Z";
    d.weekly_pack_totals = d.weekly_pack_totals.filter((r: { series_key: string }) => r.series_key !== "s-purple");
  }));
  await apply(fixture((d) => (d.generated_at = "2026-11-24T10:00:00Z")));
  assert.ok((await series()).includes("47:s-purple:30"));
});

test("a failure part-way through rolls back everything — counts, catalogue and scope", async () => {
  await apply(fixture());
  await measure(47, "s-red-5kg", 5.12);
  const before = await snapshot();
  // Passes JS validation shape-wise but violates a table check inside the transaction (negative cases),
  // after the catalogue and sync state have already been written.
  const doc = fixture((d) => (d.generated_at = "2026-11-25T09:00:00Z"));
  doc.packs[0].name = "Red 5kg RENAMED";
  doc.weekly_pack_totals[3].total_cases = -5;
  await assert.rejects(() => apply(doc), /check constraint/);
  assert.equal(await snapshot(), before);
});

test("the function re-checks contract, organization, scope and identities itself", async () => {
  const doc = fixture();
  await assert.rejects(() => apply({ ...doc, contract: "x" as never }), /unsupported contract/);
  await assert.rejects(() => apply({ ...doc, version: 2 as never }), /unsupported contract version/);
  await assert.rejects(() => apply(doc, ORG, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), /does not match the mapped DockLink organization/);
  const dup = fixture();
  dup.weekly_pack_totals.push({ ...dup.weekly_pack_totals[0] });
  await assert.rejects(() => apply(dup), /repeats a \(iso_year, iso_week, series_key\) identity/);
  const outside = fixture();
  outside.weekly_pack_totals[0] = { ...outside.weekly_pack_totals[0], iso_week: 44, week_start: "2026-10-26" };
  await assert.rejects(() => apply(outside), /outside its authoritative scope/);
  assert.equal((await all(`select 1 from docklink_pack_weekly_shipments`)).length, 0);
});

test("an older export than the last one applied is refused (stale), changing nothing", async () => {
  await apply(fixture((d) => (d.generated_at = "2026-11-24T09:00:00Z")));
  const before = await snapshot();
  await assert.rejects(() => apply(fixture((d) => (d.generated_at = "2026-11-23T09:00:00Z"))), /stale export/);
  assert.equal(await snapshot(), before);
});

test("pending and not-active exports update the scope and catalogue but leave stored series and measurements alone", async () => {
  await apply(fixture());
  await measure(47, "s-red-5kg", 5.12);
  const seriesBefore = await series();
  const measurementsBefore = await all(`select * from pack_case_measurements`);
  for (const [i, status] of (["pending_first_full_week", "capture_not_active"] as const).entries()) {
    const result = await apply(
      fixture((d) => {
        d.generated_at = `2026-11-2${5 + i}T09:00:00Z`;
        d.scope = { status, capture_activated_at: null, transition_week: null, first_week: null, last_week: null };
        d.weekly_pack_totals = [];
      })
    );
    assert.deepEqual([result.scope_status, result.series_zeroed], [status, 0]);
    assert.equal((await one<{ s: string }>(`select scope_status s from docklink_pack_sync_state where organization_id = $1`, [ORG])).s, status);
  }
  assert.deepEqual(await series(), seriesBefore);
  assert.deepEqual(await all(`select * from pack_case_measurements`), measurementsBefore);
});

test("a pack dropped from the catalogue is kept (history), flagged as no longer in the latest export; renames update in place", async () => {
  await apply(fixture());
  await apply(
    fixture((d) => {
      d.generated_at = "2026-11-24T09:00:00Z";
      d.packs = d.packs.filter((p: { pack_code: string }) => p.pack_code !== "GL5");
      d.packs.find((p: { pack_code: string }) => p.pack_code === "RL5").name = "Red 5 kg Loose";
    })
  );
  assert.deepEqual(await one(`select in_latest_export from docklink_packs where pack_code = 'GL5'`), { in_latest_export: false });
  assert.deepEqual(await one(`select name from docklink_packs where pack_code = 'RL5'`), { name: "Red 5 kg Loose" });
  // Historical series keep their ship-time name.
  assert.deepEqual(await one(`select pack_name from docklink_pack_weekly_shipments where series_key = 's-red-5kg' and iso_week = 45`), { pack_name: "Red 5kg" });
});

test("organization isolation: one organization's sync never reads, zeroes or changes another's rows", async () => {
  await apply(fixture(), OTHER_ORG);
  await measure(47, "s-red-5kg", 9.99, OTHER_ORG);
  const otherBefore = await series(OTHER_ORG);
  await apply(fixture((d) => {
    d.generated_at = "2026-11-24T09:00:00Z";
    d.weekly_pack_totals = [];
  }));
  assert.ok((await series()).every((k) => k.includes(":0:absent")), "own org: every in-scope series zeroed");
  assert.deepEqual(await series(OTHER_ORG), otherBefore);
  assert.equal((await one<{ n: number }>(`select count(*)::int n from pack_case_measurements where organization_id = $1`, [OTHER_ORG])).n, 1);
});

test("permissions: anon and authenticated can't read, write or run anything; service_role can", async () => {
  await apply(fixture());
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      for (const t of ["docklink_pack_sync_state", "docklink_packs", "docklink_pack_weekly_shipments", "pack_case_measurements"]) {
        await assert.rejects(() => db.query(`select 1 from public.${t} limit 1`), /permission denied/, `${role} select ${t}`);
      }
      await assert.rejects(() => apply(fixture()), /permission denied/, `${role} execute`);
    } finally {
      await db.exec("reset role");
    }
  }
  await db.exec("set role service_role");
  try {
    assert.equal((await one<{ n: number }>(`select count(*)::int n from public.docklink_pack_weekly_shipments`)).n, 15);
  } finally {
    await db.exec("reset role");
  }
});

test("measurement constraints: single needs kg>0 only; mixed needs 1-4 distinct colours with positive peppers and fruit weight", async () => {
  await apply(fixture());
  const insert = (kind: string, netKg: number | null, components: unknown, colorKey: string | null = "red") =>
    db.query(
      `insert into pack_case_measurements (organization_id, iso_year, iso_week, series_key, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case, components)
       values ($1, 2026, 47, $2, 'p', $3, $4, 'pepper', 'kg', $5, $6::jsonb)`,
      [ORG, `k-${Math.random()}`, kind, colorKey, netKg, components === null ? null : JSON.stringify(components)]
    );
  await insert("single", 5.1, null);
  await assert.rejects(() => insert("single", 0, null), /check constraint/);
  await assert.rejects(() => insert("single", 5, [{ color: "red", pieces_per_case: 1, fruit_weight_g: 1 }]), /check constraint/);
  await insert("mixed", null, [{ color: "red", pieces_per_case: 15, fruit_weight_g: 180 }, { color: "yellow", pieces_per_case: 15, fruit_weight_g: 175 }], "mixed");
  await assert.rejects(() => insert("mixed", null, [], "mixed"), /check constraint/);
  await assert.rejects(() => insert("mixed", null, [{ color: "red", pieces_per_case: 15, fruit_weight_g: 0 }], "mixed"), /check constraint/);
  await assert.rejects(() => insert("mixed", null, [{ color: "purple", pieces_per_case: 15, fruit_weight_g: 100 }], "mixed"), /check constraint/);
  await assert.rejects(
    () => insert("mixed", null, [{ color: "red", pieces_per_case: 1, fruit_weight_g: 1 }, { color: "red", pieces_per_case: 2, fruit_weight_g: 2 }], "mixed"),
    /check constraint/
  );
  await assert.rejects(() => insert("mixed", null, [{ color: "red", pieces_per_case: "15", fruit_weight_g: 180 }], "mixed"), /check constraint/);
});

test("a measurement is unique per organization, ISO week and series", async () => {
  await apply(fixture());
  await measure(47, "s-red-5kg", 5.12);
  await assert.rejects(() => measure(47, "s-red-5kg", 5.2), /duplicate key/);
});
