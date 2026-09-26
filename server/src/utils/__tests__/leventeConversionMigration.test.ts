// Migration 0139 (legacy Levente -> Levente Phase 2 / Phase 3) and its
// rollback script, executed as real SQL in an in-process Postgres (PGlite)
// on First Light's actual 2026 production rows (read-only snapshot in
// fixtures/levente-conversion). Every expected figure is re-derived here
// from the source rows, independently of the literals in the migration.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { resolveVarietyFootprints } from "../varietyAreaFootprints";
import { database, FX, M0139, ORG, ROLLBACK, type Entry } from "./leventeConversionHarness";
import { CLIENT_FIXTURE, pageFixture } from "./leventeConversionFixture";

const id = (name: string) => FX.varieties.find((v) => v.name === name)!.id;
const LEGACY = id("Levente");
const P2 = id("Levente Phase 2");
const P3 = id("Levente Phase 3");
const PHASE = (name: string) => FX.groups.find((g) => g.name === name)!.id;
const g = (kg: number | string) => Math.round(Number(kg) * 1000);
const SIZE_IDS = [...FX.sizes].sort((a, b) => a.sort_order - b.sort_order).map((s) => s.id);

const legacyEntries = FX.entries.filter((e) => e.variety_id === LEGACY).sort((a, b) => a.week - b.week);
const converted = legacyEntries.filter((e) => e.week <= 26);
const duplicateW27 = legacyEntries.find((e) => e.week === 27)!;

async function entries(db: PGlite): Promise<Entry[]> {
  const { rows } = await db.query<Entry>("select * from public.yield_entries order by id");
  return rows.map((r) => ({ ...r, total_kg: Number(r.total_kg), average_fruit_weight_g: r.average_fruit_weight_g === null ? null : Number(r.average_fruit_weight_g) }));
}
async function snapshot(db: PGlite) {
  const tables = ["yield_entries", "yield_entry_daily_breakdown", "daily_yield_samples", "varieties"];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = (await db.query(`select to_jsonb(x) as r from public.${t} x order by id`)).rows.map((r: any) => r.r);
  return out;
}
const count = async (db: PGlite, sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

// Method A, re-derived: Phase 2 share = observed Phase 2 kg / observed Phase 2 + 3 kg, weeks 27-39.
const OBS_P2 = FX.entries.filter((e) => e.variety_id === P2).reduce((t, e) => t + g(e.total_kg), 0);
const OBS_P3 = FX.entries.filter((e) => e.variety_id === P3).reduce((t, e) => t + g(e.total_kg), 0);
function expectedSplit(e: Entry) {
  const total = g(e.total_kg);
  const p2 = Math.floor((total * OBS_P2) / (OBS_P2 + OBS_P3) + 0.5);
  const raw = SIZE_IDS.map((s) => g(e.size_kg[s] ?? 0));
  const want = raw.map((x) => (x * p2) / total);
  const p2s = want.map(Math.floor);
  const order = want.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const remainder = p2 - p2s.reduce((a, b) => a + b, 0);
  for (let k = 0; k < remainder; k += 1) p2s[order[k][1]] += 1;
  return { p2, p3: total - p2, p2s, p3s: raw.map((x, i) => x - p2s[i]) };
}

test("the fixture is the reviewed production state", () => {
  assert.equal(legacyEntries.length, 11);
  assert.equal(legacyEntries.reduce((t, e) => t + g(e.total_kg), 0), 188_649_000);
  assert.equal(converted.reduce((t, e) => t + g(e.total_kg), 0), 174_958_000);
  assert.equal(FX.entries.reduce((t, e) => t + g(e.total_kg), 0), 1_788_834_266);
  assert.equal(OBS_P2, 79_059_057);
  assert.equal(OBS_P2 + OBS_P3, 185_694_247);
});

test("0139 splits weeks 17-26 by the observed ratio: every week and size bucket adds back exactly", async () => {
  const db = await database();
  await db.exec(M0139);
  const after = await entries(db);

  for (const legacy of converted) {
    const p2 = after.find((e) => e.variety_id === P2 && e.week === legacy.week)!;
    const p3 = after.find((e) => e.variety_id === P3 && e.week === legacy.week)!;
    const want = expectedSplit(legacy);
    assert.equal(g(p2.total_kg), want.p2, `week ${legacy.week} Phase 2`);
    assert.equal(g(p3.total_kg), want.p3, `week ${legacy.week} Phase 3`);
    assert.equal(g(p2.total_kg) + g(p3.total_kg), g(legacy.total_kg));
    SIZE_IDS.forEach((s, i) => {
      assert.equal(g(p2.size_kg[s]), want.p2s[i], `week ${legacy.week} size ${s} Phase 2`);
      assert.equal(g(p2.size_kg[s]) + g(p3.size_kg[s]), g(legacy.size_kg[s] ?? 0), `week ${legacy.week} size ${s}`);
    });
    // Each phase's sizes add up to its total.
    assert.equal(SIZE_IDS.reduce((t, s) => t + g(p2.size_kg[s]), 0), g(p2.total_kg));
    // AFW copied, not divided; the combined weighted AFW is therefore the legacy AFW.
    assert.equal(p2.average_fruit_weight_g, legacy.average_fruit_weight_g);
    assert.equal(p3.average_fruit_weight_g, legacy.average_fruit_weight_g);
    // Packed date and original creation time preserved.
    const day = (v: unknown) => (v === null ? null : new Date(v as string).toISOString().slice(0, 10));
    assert.equal(day(p2.packed_date), legacy.packed_date);
    assert.equal(day(p3.packed_date), legacy.packed_date);
    assert.equal(new Date(p3.created_at).toISOString(), new Date(legacy.created_at).toISOString());
  }

  // Annual: 174,958 kg moved, the duplicated week-27 13,691 kg removed.
  const sum = (list: Entry[], v?: string) => list.filter((e) => !v || e.variety_id === v).reduce((t, e) => t + g(e.total_kg), 0);
  assert.equal(sum(after, P2) + sum(after, P3) - (OBS_P2 + OBS_P3), 174_958_000);
  assert.equal(sum(after), 1_788_834_266 - 13_691_000);
  // Every size's farm total changes only by the removed week 27 amount.
  for (const s of SIZE_IDS) {
    const before = FX.entries.reduce((t, e) => t + g(e.size_kg[s] ?? 0), 0);
    const now = after.reduce((t, e) => t + g(e.size_kg[s] ?? 0), 0);
    assert.equal(now, before - g(duplicateW27.size_kg[s] ?? 0), `size ${s}`);
  }
  await db.close();
});

test("week 27: the duplicate legacy entry is removed, the genuine Phase 2 and Phase 3 entries are untouched", async () => {
  const db = await database();
  await db.exec(M0139);
  const after = await entries(db);
  for (const v of [P2, P3]) {
    const before = FX.entries.find((e) => e.variety_id === v && e.week === 27)!;
    const now = after.find((e) => e.variety_id === v && e.week === 27)!;
    assert.equal(now.total_kg, Number(before.total_kg));
    assert.deepEqual(now.size_kg, before.size_kg);
    assert.equal(now.average_fruit_weight_g, Number(before.average_fruit_weight_g));
    assert.equal(new Date(now.updated_at).toISOString(), new Date(before.updated_at).toISOString());
  }
  assert.equal(after.some((e) => e.id === duplicateW27.id), false);
  await db.close();
});

test("the legacy variety is archived with no production records; every reference stays valid", async () => {
  const db = await database();
  await db.exec(M0139);
  assert.equal(await count(db, "select count(*) as n from public.yield_entries where variety_id = $1", [LEGACY]), 0);
  assert.equal(await count(db, "select count(*) as n from public.daily_yield_samples where variety_id = $1", [LEGACY]), 0);
  const { rows } = await db.query<{ name: string; status: string }>("select name, status from public.varieties where id = $1", [LEGACY]);
  assert.deepEqual(rows[0], { name: "Levente", status: "inactive" });
  // Samples follow their recorded physical phase.
  for (const s of FX.samples.filter((x) => x.variety_id === LEGACY)) {
    const want = s.phase_id === PHASE("Phase 2") ? P2 : P3;
    assert.equal(await count(db, "select count(*) as n from public.daily_yield_samples where id = $1 and variety_id = $2", [s.id, want]), 1);
  }
  // Breakdowns: every one points at an existing entry and adds up to it.
  assert.equal(
    await count(db, "select count(*) as n from public.yield_entry_daily_breakdown b where not exists (select 1 from public.yield_entries e where e.id = b.yield_entry_id)"),
    0
  );
  const mismatched = await count(
    db,
    `select count(*) as n from public.yield_entries e
      where e.id in (select row_id from public.variety_conversion_rows where role = 'generated' and table_name = 'yield_entries')
        and exists (select 1 from public.yield_entry_daily_breakdown b where b.yield_entry_id = e.id)
        and e.total_kg <> (select sum(total_kg) from public.yield_entry_daily_breakdown b where b.yield_entry_id = e.id)`
  );
  assert.equal(mismatched, 0);
  // Weeks 25 and 26 had breakdowns; each now has one per phase per original day.
  assert.equal(await count(db, "select count(*) as n from public.yield_entry_daily_breakdown b join public.yield_entries e on e.id = b.yield_entry_id where e.variety_id in ($1, $2) and e.week in (25, 26)", [P2, P3]), 6);
  // No duplicate weekly entries.
  assert.equal(await count(db, "select count(*) as n from (select variety_id, week from public.yield_entries group by variety_id, year, week having count(*) > 1) d"), 0);
  // The marker and backup are complete.
  assert.equal(await count(db, "select count(*) as n from public.variety_conversion_rows where role = 'original' and table_name = 'yield_entries'"), 11);
  assert.equal(await count(db, "select count(*) as n from public.variety_conversion_rows where role = 'original' and table_name = 'yield_entry_daily_breakdown'"), 4);
  assert.equal(await count(db, "select count(*) as n from public.variety_conversion_rows where role = 'original' and table_name = 'daily_yield_samples'"), 91);
  assert.equal(await count(db, "select count(*) as n from public.variety_conversion_rows where role = 'generated' and table_name = 'yield_entries'"), 20);
  await db.close();
});

test("0139 cannot apply twice: the second run changes nothing", async () => {
  const db = await database();
  await db.exec(M0139);
  const once = await snapshot(db);
  await db.exec(M0139);
  assert.deepEqual(await snapshot(db), once);
  await db.close();
});

async function assertAborts(prepare: (db: PGlite) => Promise<void>, message: RegExp) {
  const db = await database();
  await prepare(db);
  const before = await snapshot(db);
  await assert.rejects(db.exec(M0139), message);
  assert.deepEqual(await snapshot(db), before, "nothing changed");
  // The whole file is one transaction: even its marker and backup tables were rolled back.
  assert.equal(await count(db, "select count(*) as n from pg_class where relname in ('variety_conversions', 'variety_conversion_rows')"), 0);
  await db.close();
}

test("0139 aborts, changing nothing, when production differs from the reviewed state", async () => {
  await assertAborts((db) => db.query("update public.yield_entries set total_kg = total_kg + 1 where id = $1", [converted[3].id]).then(() => {}), /differ from the reviewed values/);
  await assertAborts(
    (db) =>
      db.query("update public.yield_entries set size_kg = jsonb_set(size_kg, $2, '1') where id = $1", [converted[0].id, `{${SIZE_IDS[0]}}`]).then(() => {}),
    /differ from the reviewed values/
  );
  await assertAborts(
    (db) =>
      db.query("insert into public.yield_entries (organization_id, variety_id, year, week, total_kg) values ($1, $2, 2026, 20, 5)", [ORG, P2]).then(() => {}),
    /already exists in weeks 17-26/
  );
  await assertAborts((db) => db.query("update public.yield_entries set total_kg = 13000 where variety_id = $1 and week = 27", [P3]).then(() => {}), /week 27 entries differ/);
  await assertAborts(
    (db) => db.query("update public.daily_yield_samples set phase_id = null where id = (select id from public.daily_yield_samples where variety_id = $1 limit 1)", [LEGACY]).then(() => {}),
    /no Phase 2\/3 row/
  );
  await assertAborts((db) => db.query("update public.varieties set name = 'Levente (old)' where id = $1", [LEGACY]).then(() => {}), /variety "Levente"/);
  await assertAborts((db) => db.query("delete from public.yield_entry_daily_breakdown where yield_entry_id = $1", [converted[9].id]).then(() => {}), /legacy daily breakdowns/);
});

test("the rollback script restores the exact pre-conversion state, and 0139 can then be applied again", async () => {
  const db = await database();
  const original = await snapshot(db);
  await db.exec(M0139);
  await db.exec(ROLLBACK);
  assert.deepEqual(await snapshot(db), original);
  assert.equal(await count(db, "select count(*) as n from public.variety_conversions"), 0);
  await db.exec(M0139);
  assert.equal(await count(db, "select count(*) as n from public.yield_entries where variety_id = $1", [LEGACY]), 0);
  await assert.rejects(db.exec(ROLLBACK.replace("'first-light-2026-legacy-levente'", "'no-such-conversion'")), /is not applied/);
  await db.close();
});

test("farm-wide kg/m²: all converted kg is covered by the phases' own rows, with no link and no duplicated area", async () => {
  const db = await database();
  await db.exec(M0139);
  const after = await entries(db);
  await db.close();

  const footprints = resolveVarietyFootprints({ ...FX, links: [] });
  const area = new Map(footprints.rows.map((r) => [r.key, r.areaM2 ?? 0]));
  const uncovered = after.filter((e) => !footprints.footprints[e.variety_id]);
  assert.deepEqual(uncovered, [], "every 2026 kg has a physical footprint without any variety_area_links");

  const union = new Set(after.flatMap((e) => footprints.footprints[e.variety_id]));
  const denominator = [...union].reduce((t, k) => t + (area.get(k) ?? 0), 0);
  const allRows = footprints.rows.reduce((t, r) => t + (r.areaM2 ?? 0), 0);
  const unassigned = footprints.rows.filter((r) => !union.has(r.key));
  // Rows 590-596 and 598 are currently unassigned in Greenhouse Setup; once
  // reassigned (approved as 2026 growing area) the denominator is every row.
  assert.deepEqual(unassigned.map((r) => Number(r.key.split(":")[1])).sort((a, b) => a - b), [590, 591, 592, 593, 594, 595, 596, 598]);
  assert.equal(Math.round(allRows * 10) / 10, 73_768.3);
  assert.equal(Math.round(denominator * 10) / 10, 72_597.9);
  const kg = after.reduce((t, e) => t + g(e.total_kg), 0) / 1000;
  assert.equal(Math.round(kg * 100) / 100, 1_775_143.27);
  assert.equal(Math.round((kg / allRows) * 1000) / 1000, 24.064);
  assert.equal(Math.round((kg / denominator) * 1000) / 1000, 24.452);
});

test("the Yield Analytics page fixture is exactly 0139's output", async () => {
  const db = await database();
  await db.exec(M0139);
  const { rows } = await db.query("select * from public.yield_entries order by id");
  await db.close();
  // Compared through JSON, the way the page receives it.
  assert.deepEqual(JSON.parse(JSON.stringify(pageFixture(FX, rows))), JSON.parse(readFileSync(CLIENT_FIXTURE, "utf-8")));
});
