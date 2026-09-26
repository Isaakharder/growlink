// Builds the Yield Analytics page's post-conversion fixture from migration
// 0139's real output, so the client test renders exactly what the migration
// produces. `npx tsx src/utils/__tests__/leventeConversionFixture.ts --write`
// regenerates it; leventeConversionMigration.test.ts asserts it is current.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { resolveVarietyFootprints } from "../varietyAreaFootprints";

export const CLIENT_FIXTURE = join(__dirname, "..", "..", "..", "..", "client", "src", "pages", "__tests__", "fixtures", "firstLight2026AfterLeventeConversion.json");

/** Rows approved as 2026 growing area but unassigned in Greenhouse Setup when the snapshot was taken (Silverstone's until 2026-09-26). */
export const APPROVED_UNASSIGNED_ROWS = { variety: "Silverstone", phase: "Phase 2", rows: [590, 591, 592, 593, 594, 595, 596, 598] };

export function pageFixture(fx: any, afterEntries: any[]) {
  const variety = fx.varieties.find((v: any) => v.name === APPROVED_UNASSIGNED_ROWS.variety).id;
  const group = fx.groups.find((g: any) => g.name === APPROVED_UNASSIGNED_ROWS.phase).id;
  const assignments = [
    ...fx.assignments,
    ...APPROVED_UNASSIGNED_ROWS.rows.map((n) => ({ group_id: group, variety_id: variety, start_row: n, end_row: n, assignment_pattern: "all" }))
  ];
  const areaFootprints = { ...resolveVarietyFootprints({ ...fx, assignments, links: [] }), linksAvailable: true };
  const varieties = fx.varieties.map((v: any) => ({ id: v.id, name: v.name, area_m2: Number(v.area_m2), color: v.color, case_kg: Number(v.case_kg), status: v.status }));
  const nameOf = Object.fromEntries(varieties.map((v: any) => [v.id, v.name]));
  const entries = afterEntries
    .map((e: any) => ({
      id: e.id,
      variety_id: e.variety_id,
      variety_name: nameOf[e.variety_id],
      year: Number(e.year),
      week: Number(e.week),
      total_kg: Number(e.total_kg),
      kg_per_m2: Number(e.kg_per_m2),
      average_fruit_weight_g: e.average_fruit_weight_g === null ? null : Number(e.average_fruit_weight_g),
      size_kg: e.size_kg
    }))
    .sort((a: any, b: any) => (a.variety_id + a.week).localeCompare(b.variety_id + b.week) || a.week - b.week);
  return { note: "Output of migration 0139 on the First Light snapshot; area rows include the approved-but-unassigned rows.", sizes: fx.sizes, varieties, entries, areaFootprints };
}

if (process.argv.includes("--write")) {
  (async () => {
    const { database, M0139 } = await import("./leventeConversionHarness");
    const db = await database();
    await db.exec(M0139);
    const { rows } = await db.query("select * from public.yield_entries order by id");
    const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "levente-conversion", "production.json"), "utf-8"));
    writeFileSync(CLIENT_FIXTURE, JSON.stringify(pageFixture(fx, rows)));
    await db.close();
    console.log("wrote", CLIENT_FIXTURE);
  })();
}
