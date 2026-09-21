// Run with tsx's test integration (tsx lives in server/node_modules; the
// client package has no test runner configured):
//   cd server && node_modules/.bin/tsx --test ../client/src/utils/__tests__/pestChemicalCalc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  M2_TO_ACRES,
  M2_TO_HECTARES,
  HECTARES_TO_ACRES,
  BAR_TO_PSI,
  computeChemicalMl,
  computeChemicalNeeded,
  computeSprayVolumeLPerAcre,
  computeMixPlan
} from "../pestChemicalCalc";

const ACRE_M2 = 4046.8564224;

function approx(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test("1 acre = 4046.8564224 m2", () => {
  approx(ACRE_M2 * M2_TO_ACRES, 1);
  approx(1 / M2_TO_ACRES, ACRE_M2);
});

test("1 hectare = 2.4710538147 acres", () => {
  // 1 ha = 10000 m2; converting that to acres must match the spec constant.
  approx(10000 * M2_TO_ACRES, HECTARES_TO_ACRES, 1e-9);
  approx(HECTARES_TO_ACRES, 2.4710538147, 1e-9);
});

test("8.7 bar = ~126.18 PSI", () => {
  approx(8.7 * BAR_TO_PSI, 126.18, 0.01);
});

test("1 acre at 750 L/acre requires exactly 750 L", () => {
  const totalL = computeSprayVolumeLPerAcre(ACRE_M2, 750);
  approx(totalL as number, 750, 1e-9);
});

test("2 acres at 750 L/acre requires 1500 L", () => {
  const totalL = computeSprayVolumeLPerAcre(2 * ACRE_M2, 750);
  approx(totalL as number, 1500, 1e-8);
});

test("no hectare-based assumption leaks into the acre-based spray volume calc", () => {
  // A regression that quietly divided by 10000 (hectares) instead of using
  // acres would be off by the ha->acre ratio (2.4710538147x) on the same
  // physical area. Guard against that class of bug explicitly.
  const correct = computeSprayVolumeLPerAcre(ACRE_M2, 750) as number;
  const hectareMistake = 750 * (ACRE_M2 * M2_TO_HECTARES);
  approx(correct / hectareMistake, HECTARES_TO_ACRES, 1e-6);
  assert.notEqual(Math.round(correct), Math.round(hectareMistake));
});

test("a product labelled 300 mL/acre over 2 acres requires 600 mL, independent of carrier volume", () => {
  const m2 = 2 * ACRE_M2;
  const result = computeChemicalNeeded(m2, 300, "ml_per_acre");
  assert.ok(result);
  approx(result!.ml, 600, 1e-6);

  // Independent of carrier/spray volume: changing target L/acre must not
  // change the product amount at all.
  const mlAtLowVolume = computeChemicalMl(m2, 300, "ml_per_acre");
  const totalAtLowVolume = computeSprayVolumeLPerAcre(m2, 200);
  const totalAtHighVolume = computeSprayVolumeLPerAcre(m2, 900);
  assert.notEqual(totalAtLowVolume, totalAtHighVolume);
  approx(mlAtLowVolume, 600, 1e-6);
});

test("a hectare-based product rate still converts correctly when the physical area is expressed in acres", () => {
  // 2 ha of physical area, entered/derived from m2 (acre-primary UI does not
  // change the underlying m2, only how it's displayed/entered for the robot).
  const twoHectaresInM2 = 2 * 10000;
  const twoHectaresInAcres = twoHectaresInM2 * M2_TO_ACRES;
  approx(twoHectaresInAcres, 2 * HECTARES_TO_ACRES, 1e-9);

  const result = computeChemicalNeeded(twoHectaresInM2, 500, "ml_per_hectare");
  assert.ok(result);
  approx(result!.ml, 1000, 1e-6); // 500 mL/ha x 2 ha = 1000 mL, regardless of acre display
});

test("300 L Bogaerts robot and 1000 L tote mixing plans reconstruct the acre-based total exactly", () => {
  const m2 = 5 * ACRE_M2; // 5 acres
  const targetLPerAcre = 400;
  const totalVolumeL = computeSprayVolumeLPerAcre(m2, targetLPerAcre) as number;
  approx(totalVolumeL, 2000, 1e-6);

  const chemical = computeChemicalNeeded(m2, 300, "ml_per_acre"); // 300 mL/acre
  assert.ok(chemical);
  approx(chemical!.ml, 1500, 1e-6);

  for (const batchSizeL of [300, 1000]) {
    const plan = computeMixPlan(totalVolumeL, chemical!.ml, batchSizeL);
    assert.ok(plan);
    const reconstructedVolume =
      plan!.fullBatchCount * plan!.batchSizeL +
      (plan!.isLastFull ? 0 : plan!.finalBatchVolumeL);
    approx(reconstructedVolume, totalVolumeL, 1e-6);

    const reconstructedChemical =
      plan!.fullBatchCount * plan!.chemPerFullBatchMl +
      (plan!.isLastFull ? 0 : plan!.chemForFinalBatchMl);
    approx(reconstructedChemical, chemical!.ml, 1e-6);

    // A 2.4710538147x (ha/acre) error would blow the volume figure past any
    // plausible batch/robot count — sanity-check it stays in a sane range.
    assert.ok(plan!.totalBatchCount < 20);
  }
});
