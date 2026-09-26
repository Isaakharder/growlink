import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeFarmKgPerM2, type AreaFootprints } from "../farmKgPerM2";

// Farm-wide kg/m2 = qualifying kg ÷ unique physical growing area. The farm
// below mirrors the real situation: three phases of measured rows; one
// record ("legacy") recorded before its crop was split into one record per
// phase, whose footprint is its successors' rows (a continuation link,
// resolved server-side into the same row keys).
const rowsOf = (group: string, count: number, areaM2: number) =>
  Array.from({ length: count }, (_, i) => ({ key: `${group}:${i + 1}`, groupId: group, areaM2 }));

const P1 = rowsOf("p1", 10, 100); // 1,000 m²
const P2 = rowsOf("p2", 6, 100); //    600 m²
const P3 = rowsOf("p3", 3, 100); //    300 m²
const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key);

const AREAS: AreaFootprints = {
  rows: [...P1, ...P2, ...P3],
  footprints: {
    "v-a": keys(P1.slice(0, 7)), // 700 m² of Phase 1
    "v-b": keys(P1.slice(7)), //    300 m² of Phase 1
    "v-successor-p2": keys(P2),
    "v-successor-p3": keys(P3),
    "v-legacy": [...keys(P2), ...keys(P3)]
  }
};

const entry = (variety_id: string, total_kg: number, week = 30) => ({ variety_id, total_kg, week });

describe("computeFarmKgPerM2", () => {
  it("legacy + per-phase successors: every kg counts, the phase areas count once", () => {
    const result = computeFarmKgPerM2(
      [entry("v-a", 16_000), entry("v-b", 6_000), entry("v-legacy", 9_000, 20), entry("v-successor-p2", 5_000), entry("v-successor-p3", 2_000)],
      AREAS
    );
    expect(result.qualifyingKg).toBe(38_000);
    expect(result.coveredKg).toBe(38_000);
    // 1,000 + 600 + 300 — not 1,000 + 600 + 300 + (600 + 300) again for the legacy record.
    expect(result.areaM2).toBe(1_900);
    expect(result.kgPerM2).toBe(20);
    expect(result.uncovered).toEqual([]);
  });

  it("a legacy record with no footprint is never silently dropped: its kg is reported as uncovered", () => {
    const unlinked: AreaFootprints = { ...AREAS, footprints: { ...AREAS.footprints, "v-legacy": [] } };
    const result = computeFarmKgPerM2([entry("v-successor-p2", 5_000), entry("v-legacy", 9_000)], unlinked);
    expect(result.qualifyingKg).toBe(14_000);
    expect(result.coveredKg).toBe(5_000);
    expect(result.uncovered).toEqual([{ varietyId: "v-legacy", kg: 9_000 }]);
    expect(result.uncoveredKg).toBe(9_000);
    expect(result.kgPerM2).toBeCloseTo(5_000 / 600, 10);
  });

  it("several variety records on the same rows don't duplicate the denominator", () => {
    const shared: AreaFootprints = { ...AREAS, footprints: { x: keys(P2), y: keys(P2), z: keys(P2.slice(0, 3)) } };
    const result = computeFarmKgPerM2([entry("x", 1_000), entry("y", 1_000), entry("z", 1_000)], shared);
    expect(result.areaM2).toBe(600);
    expect(result.kgPerM2).toBe(5);
  });

  it("successive crops on the same area across the year count that area once", () => {
    const succession: AreaFootprints = { ...AREAS, footprints: { spring: keys(P3), autumn: keys(P3) } };
    const result = computeFarmKgPerM2([entry("spring", 3_000, 10), entry("spring", 1_500, 20), entry("autumn", 1_500, 40)], succession);
    expect(result.areaM2).toBe(300);
    expect(result.kgPerM2).toBe(20);
  });

  it("date and variety subsets use exactly the area that produced the subset's kg", () => {
    const all = [entry("v-legacy", 9_000, 20), entry("v-successor-p2", 5_000, 30), entry("v-successor-p3", 2_000, 30), entry("v-a", 14_000, 30)];
    // A week when only the legacy record picked: its footprint, Phase 2 + 3.
    const week20 = computeFarmKgPerM2(all.filter((e) => e.week === 20), AREAS);
    expect(week20).toMatchObject({ coveredKg: 9_000, areaM2: 900, kgPerM2: 10 });
    // Week 30 without Phase 1's second variety: only the rows that produced.
    const week30 = computeFarmKgPerM2(all.filter((e) => e.week === 30), AREAS);
    expect(week30).toMatchObject({ coveredKg: 21_000, areaM2: 700 + 600 + 300 });
    // The same subset in any order gives the same answer.
    expect(computeFarmKgPerM2([...all].reverse(), AREAS)).toEqual(computeFarmKgPerM2(all, AREAS));
  });

  it("a single variety uses its own rows, not its whole phase", () => {
    const result = computeFarmKgPerM2([entry("v-a", 14_000)], AREAS);
    expect(result.areaM2).toBe(700);
    expect(result.kgPerM2).toBe(20);
  });

  it("unlinked kg and unmeasured rows are both reported", () => {
    const partial: AreaFootprints = {
      rows: [...P2.slice(0, 5), { key: "p2:6", groupId: "p2", areaM2: null }],
      footprints: { "v-successor-p2": keys(P2) }
    };
    const result = computeFarmKgPerM2([entry("v-successor-p2", 1_000), entry("v-unknown", 250), entry("v-other", 750)], partial);
    expect(result.unmeasuredRowCount).toBe(1);
    expect(result.areaM2).toBe(500);
    expect(result.uncovered).toEqual([
      { varietyId: "v-other", kg: 750 },
      { varietyId: "v-unknown", kg: 250 }
    ]);
    expect(result.uncoveredKg).toBe(1_000);
  });

  it("with no measured area there is no numeric kg/m2 — never a divide-by-zero figure", () => {
    expect(computeFarmKgPerM2([entry("v-a", 1_000)], null)).toMatchObject({ kgPerM2: null, areaM2: 0, coveredKg: 0, uncoveredKg: 1_000 });
    const unmeasured: AreaFootprints = { rows: [{ key: "p1:1", groupId: "p1", areaM2: null }], footprints: { "v-a": ["p1:1"] } };
    expect(computeFarmKgPerM2([entry("v-a", 1_000)], unmeasured).kgPerM2).toBeNull();
    expect(computeFarmKgPerM2([], AREAS)).toMatchObject({ kgPerM2: null, qualifyingKg: 0 });
  });

  it("the ratio is exactly the numerator and denominator it reports", () => {
    const result = computeFarmKgPerM2([entry("v-a", 12_345.67), entry("v-b", 890.12), entry("v-successor-p3", 4_000)], AREAS);
    expect(result.kgPerM2).toBe(result.coveredKg / result.areaM2);
  });

  it("depends on no variety names", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/yieldAnalytics/farmKgPerM2.ts"), "utf-8");
    expect(source).not.toMatch(/levente|cadalora|silverstone|mathieu|lavreysen/i);
  });
});
