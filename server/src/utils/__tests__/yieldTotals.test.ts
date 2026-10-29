// Pins the shared yield totals calculation used by Manual Entry, PDF/FlowMaster
// imports and CSV template imports. Literal numbers, including floating-point
// results, so a change of formula or summation order fails here.
// Run: node --require tsx/cjs --test src/utils/__tests__/yieldTotals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateYieldTotals } from "../yieldTotals";

test("total kg sums every size in insertion order; kg/m² and cases divide by area and case weight", () => {
  assert.deepEqual(calculateYieldTotals({ a: 100.5, b: 49.5 }, { area_m2: 1000, case_kg: 5.15 }), {
    total_kg: 150,
    kg_per_m2: 0.15,
    total_cases: 29.126213592233007
  });
  assert.deepEqual(calculateYieldTotals({ a: 0.1, b: 0.2, c: 0.3 }, { area_m2: 3, case_kg: 0.3 }), {
    total_kg: 0.6000000000000001,
    kg_per_m2: 0.20000000000000004,
    total_cases: 2.0000000000000004
  });
});

test("no area or no case weight gives 0, and no sizes gives 0 kg", () => {
  assert.deepEqual(calculateYieldTotals({ a: 10 }, { area_m2: 0, case_kg: 0 }), { total_kg: 10, kg_per_m2: 0, total_cases: 0 });
  assert.deepEqual(calculateYieldTotals({}, { area_m2: 500, case_kg: 5 }), { total_kg: 0, kg_per_m2: 0, total_cases: 0 });
});
