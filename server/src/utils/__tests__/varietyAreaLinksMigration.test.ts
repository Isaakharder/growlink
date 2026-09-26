// Migrations 0138 (variety_area_links) and 0139 (First Light's links),
// executed as real SQL in an in-process Postgres (PGlite), on the schema
// objects they depend on. Then the links 0139 writes are fed through the same
// footprint resolution and kg/m2 calculation the app uses, on First Light's
// real 2026 greenhouse rows and yield (read-only snapshot in fixtures/).
// The kg/m2 here is recomputed independently of the client's
// computeFarmKgPerM2; the client page test renders the same fixture through
// the real one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { resolveVarietyFootprints, type VarietyFootprints } from "../varietyAreaFootprints";

const MIGRATIONS = join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const M0138 = readFileSync(join(MIGRATIONS, "0138_variety_area_links.sql"), "utf-8");
const M0139 = readFileSync(join(MIGRATIONS, "0139_first_light_variety_area_links.sql"), "utf-8");

type Greenhouse = {
  organization: { id: string; name: string };
  groups: Array<{ id: string; type: string; name: string }>;
  rows: Array<{ group_id: string; row_number: number; width_meters: number | null; length_meters: number | null; section_id: string | null }>;
  sections: Array<{ id: string; width_meters: number | null; length_meters: number | null }>;
  assignments: Array<{ group_id: string; variety_id: string; start_row: number; end_row: number; assignment_pattern: string }>;
  varieties: Array<{ id: string; name: string; area_m2: number }>;
  entries: Array<{ variety_id: string; year: number; week: number; total_kg: number }>;
};
const GREENHOUSE = JSON.parse(readFileSync(join(__dirname, "fixtures", "first-light-2026", "greenhouse.json"), "utf-8")) as Greenhouse;
// The Yield Analytics page test renders this exact area-footprints response.
const PAGE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "client", "src", "pages", "__tests__", "fixtures", "firstLight2026.json"), "utf-8")
);

const ORG = GREENHOUSE.organization.id;
const varietyId = (name: string) => GREENHOUSE.varieties.find((v) => v.name === name)!.id;
const groupId = (name: string) => GREENHOUSE.groups.find((g) => g.name === name)!.id;

/** The objects 0138/0139 reference, as they exist in production, plus First Light's own records. */
async function database(options: { seed?: boolean } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role authenticated;
    create role service_role;
    create table public.organizations (id uuid primary key, name text not null);
    create table public.varieties (id uuid primary key, organization_id uuid not null references public.organizations(id), name text not null, area_m2 numeric not null default 0);
    create table public.greenhouse_groups (id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id), type text not null, name text not null);
    create function public.is_org_member(org uuid) returns boolean language sql as 'select true';
  `);
  if (options.seed !== false) {
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [ORG, GREENHOUSE.organization.name]);
    for (const v of GREENHOUSE.varieties) {
      await db.query("insert into public.varieties (id, organization_id, name, area_m2) values ($1, $2, $3, $4)", [v.id, ORG, v.name, v.area_m2]);
    }
    for (const g of GREENHOUSE.groups) {
      await db.query("insert into public.greenhouse_groups (id, organization_id, type, name) values ($1, $2, $3, $4)", [g.id, ORG, g.type, g.name]);
    }
  }
  await db.exec(M0138);
  return db;
}

/** Independent farm kg/m2: kg of varieties with a footprint over the union of those footprint rows. */
function farm(entries: Greenhouse["entries"], fp: VarietyFootprints) {
  const area = new Map(fp.rows.map((r) => [r.key, r.areaM2 ?? 0]));
  const rows = new Set<string>();
  let qualifyingKg = 0;
  let coveredKg = 0;
  const uncovered = new Set<string>();
  for (const e of entries) {
    qualifyingKg += e.total_kg;
    const footprint = fp.footprints[e.variety_id];
    if (!footprint) {
      uncovered.add(e.variety_id);
      continue;
    }
    coveredKg += e.total_kg;
    footprint.forEach((k) => rows.add(k));
  }
  const areaM2 = [...rows].reduce((sum, k) => sum + (area.get(k) ?? 0), 0);
  return { qualifyingKg, coveredKg, areaM2, kgPerM2: coveredKg / areaM2, uncovered: [...uncovered] };
}

async function links(db: PGlite) {
  const result = await db.query<{ variety_id: string; successor_variety_id: string | null; greenhouse_group_id: string | null }>(
    "select variety_id, successor_variety_id, greenhouse_group_id from public.variety_area_links order by variety_id, successor_variety_id, greenhouse_group_id"
  );
  return result.rows;
}

test("0139 links Levente to both successors and the two trials to Phase 2 — and running it twice changes nothing", async () => {
  const db = await database();
  await db.exec(M0139);
  const first = await links(db);
  assert.equal(first.length, 4);
  assert.deepEqual(
    new Set(first.map((l) => `${l.variety_id}->${l.successor_variety_id ?? l.greenhouse_group_id}`)),
    new Set([
      `${varietyId("Levente")}->${varietyId("Levente Phase 2")}`,
      `${varietyId("Levente")}->${varietyId("Levente Phase 3")}`,
      `${varietyId("0699")}->${groupId("Phase 2")}`,
      `${varietyId("0704")}->${groupId("Phase 2")}`
    ])
  );

  await db.exec(M0139);
  assert.deepEqual(await links(db), first);
  await db.close();
});

test("with 0139's links, all 1,788,834.27 kg counts over the 73,768.3 m² of measured rows: 24.25 kg/m²", async () => {
  const db = await database();
  await db.exec(M0139);
  const footprints = resolveVarietyFootprints({ ...GREENHOUSE, links: await links(db) });
  await db.close();

  // The page test renders exactly this response.
  assert.deepEqual({ ...footprints, linksAvailable: true }, PAGE_FIXTURE.areaFootprints);

  const entries2026 = GREENHOUSE.entries.filter((e) => e.year === 2026);
  const result = farm(entries2026, footprints);
  assert.equal(Math.round(result.qualifyingKg * 100) / 100, 1_788_834.27);
  assert.equal(Math.round(result.coveredKg * 100) / 100, 1_788_834.27);
  assert.deepEqual(result.uncovered, []);
  assert.ok(footprints.rows.every((r) => r.areaM2 !== null && r.areaM2 > 0), "every row is measured");
  assert.equal(Math.round(result.areaM2 * 10) / 10, 73_768.3);
  // Every measured row in the greenhouse, each once.
  const allRows = footprints.rows.reduce((sum, r) => sum + (r.areaM2 ?? 0), 0);
  assert.ok(Math.abs(result.areaM2 - allRows) < 1e-6);
  assert.equal(Math.round((result.kgPerM2 ?? 0) * 100) / 100, 24.25);
});

test("the legacy and trial links add kg but no area", async () => {
  const withoutLinks = resolveVarietyFootprints({ ...GREENHOUSE, links: [] });
  const db = await database();
  await db.exec(M0139);
  const withLinks = resolveVarietyFootprints({ ...GREENHOUSE, links: await links(db) });
  await db.close();

  const entries = GREENHOUSE.entries.filter((e) => e.year === 2026);
  const before = farm(entries, withoutLinks);
  const after = farm(entries, withLinks);
  // Same rows, so the same area (summed in a different order).
  assert.ok(Math.abs(after.areaM2 - before.areaM2) < 1e-6);
  assert.equal(Math.round((after.coveredKg - before.coveredKg) * 100) / 100, 188_649 + 13_516.22 + 10_886.05);
  // Levente's footprint is exactly its successors' rows; the trials' rows are all already assigned.
  assert.deepEqual(
    withLinks.footprints[varietyId("Levente")],
    [...withLinks.footprints[varietyId("Levente Phase 2")], ...withLinks.footprints[varietyId("Levente Phase 3")]].sort()
  );
  const assigned = new Set(Object.values(withoutLinks.footprints).flat());
  for (const key of withLinks.footprints[varietyId("0699")]) assert.ok(assigned.has(key), key);
});

async function assertAborts(prepare: (db: PGlite) => Promise<void>, message: RegExp, options: { seed?: boolean } = {}) {
  const db = await database(options);
  await prepare(db);
  const before = await links(db);
  await assert.rejects(db.exec(M0139), message);
  // Nothing was written.
  assert.deepEqual(await links(db), before);
  await db.close();
}

test("0139 refuses to run when the organization is missing", async () => {
  await assertAborts(async () => {}, /organization .* not found/, { seed: false });
});

test("0139 refuses to run when a variety is missing or has been renamed", async () => {
  await assertAborts(async (db) => {
    await db.query("update public.varieties set name = 'Levente (old)' where id = $1", [varietyId("Levente")]);
  }, /variety "Levente" .* not found/);
  await assertAborts(async (db) => {
    await db.query("delete from public.varieties where id = $1", [varietyId("0704")]);
  }, /variety "0704" .* not found/);
});

test("0139 refuses to run when the target phase is missing or not a phase", async () => {
  await assertAborts(async (db) => {
    await db.query("update public.greenhouse_groups set type = 'zone' where id = $1", [groupId("Phase 2")]);
  }, /greenhouse phase "Phase 2" .* not found/);
});

test("0139 refuses to add to a variety that is already linked somewhere else", async () => {
  await assertAborts(async (db) => {
    await db.query("insert into public.variety_area_links (organization_id, variety_id, greenhouse_group_id) values ($1, $2, $3)", [
      ORG,
      varietyId("0699"),
      groupId("Phase 1")
    ]);
  }, /existing variety_area_links .* point elsewhere/);
});

test("0138's table rejects a link with no target, two targets, or itself as successor", async () => {
  const db = await database();
  const insert = (successor: string | null, group: string | null, variety = varietyId("Levente")) =>
    db.query("insert into public.variety_area_links (organization_id, variety_id, successor_variety_id, greenhouse_group_id) values ($1, $2, $3, $4)", [
      ORG,
      variety,
      successor,
      group
    ]);
  await assert.rejects(insert(null, null), /variety_area_links_one_target/);
  await assert.rejects(insert(varietyId("Levente Phase 2"), groupId("Phase 2")), /variety_area_links_one_target/);
  await assert.rejects(insert(varietyId("Levente"), null), /variety_area_links_not_self/);
  await db.close();
});
