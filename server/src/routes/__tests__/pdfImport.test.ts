// Closes the loop from "corrected preview" to "what actually gets saved":
// takes the exact mapped-only sizeBreakdown a fixed client now sends in the
// /pdf-import/import payload for the three reported CSVs (Aug 17/18/19,
// rolled up into one Week 34 weekly entry) and runs it through the real,
// unmodified mapSizeNamesToIds + calculateTotals the import route uses,
// confirming the combined 31,487.94 kg total and per-size breakdown survive
// the name->id mapping and total/kg-per-m2/cases calculation untouched.
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapSizeNamesToIds,
  calculateTotals,
  type ActiveYieldSizeWithId,
  type VarietyForCalc,
} from "../pdfImport";

const ACTIVE_SIZES: ActiveYieldSizeWithId[] = [
  { id: "id-small", name: "Small" },
  { id: "id-medium", name: "Medium" },
  { id: "id-large", name: "Large" },
  { id: "id-sxl", name: "SXL" },
  { id: "id-xl", name: "XL" },
  { id: "id-xxl", name: "XXL" },
];

// The exact per-file mapped/importable breakdown from lot-2608170362/363/364,
// summed the same way importGroupedCard's group.sizeBreakdown aggregates them.
const MAPPED_SIZE_BREAKDOWN: Record<string, number> = {
  Small: 34.123 + 32.513 + 9.437,
  Medium: 468.121 + 599.873 + 283.177,
  Large: 1380.906 + 2334.673 + 847.496,
  SXL: 3257.101 + 5965.757 + 1882.527,
  XL: 4489.312 + 6639.618 + 2270.658,
  XXL: 353.205 + 558.544 + 80.897,
};

test("mapSizeNamesToIds maps every mapped size name to an active size id with no skips", () => {
  const result = mapSizeNamesToIds(MAPPED_SIZE_BREAKDOWN, ACTIVE_SIZES);

  assert.deepStrictEqual(result.skipped, []);
  assert.strictEqual(result.matched.length, 6);
  assert.strictEqual(result.mapped["id-small"], MAPPED_SIZE_BREAKDOWN.Small);
  assert.strictEqual(result.mapped["id-medium"], MAPPED_SIZE_BREAKDOWN.Medium);
  assert.strictEqual(result.mapped["id-large"], MAPPED_SIZE_BREAKDOWN.Large);
  assert.strictEqual(result.mapped["id-sxl"], MAPPED_SIZE_BREAKDOWN.SXL);
  assert.strictEqual(result.mapped["id-xl"], MAPPED_SIZE_BREAKDOWN.XL);
  assert.strictEqual(result.mapped["id-xxl"], MAPPED_SIZE_BREAKDOWN.XXL);
});

test("calculateTotals preserves the exact combined 31,487.94 kg total through the full import payload path", () => {
  const { mapped } = mapSizeNamesToIds(MAPPED_SIZE_BREAKDOWN, ACTIVE_SIZES);
  const variety: VarietyForCalc = { id: "v1", area_m2: 1000, case_kg: 11 };

  const totals = calculateTotals(mapped, variety);

  assert.strictEqual(Math.round(totals.total_kg * 100) / 100, 31487.94);
  assert.strictEqual(totals.kg_per_m2, totals.total_kg / 1000);
  assert.strictEqual(totals.total_cases, totals.total_kg / 11);
});

test("a raw label still awaiting a saved rule (e.g. 'GREEN') would be rejected by mapSizeNamesToIds, not silently imported", () => {
  // Guards the invariant importGroupedCard's own validation already relies
  // on (blocks import while unmappedCount > 0 / unknownSizes.length > 0):
  // an unresolved raw label can never reach calculateTotals as if it were a
  // real size.
  const withUnresolved = { ...MAPPED_SIZE_BREAKDOWN, GREEN: 943.702 };
  const result = mapSizeNamesToIds(withUnresolved, ACTIVE_SIZES);

  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].pdfLabel, "GREEN");
});
