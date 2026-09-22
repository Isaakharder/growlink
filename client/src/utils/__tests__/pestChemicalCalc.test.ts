// Deliberately node:test, not Vitest — run via:
//   npm run test:node   (from client/)
// or directly:
//   npx tsx --test src/utils/__tests__/pestChemicalCalc.test.ts
// (tsx's own CLI, not `node --require tsx/cjs` — client/package.json is
// "type": "module", so relative imports need real ESM resolution, which
// only tsx's CLI loader hook provides here; the CJS require-hook server's
// own node:test files use doesn't apply to this package).
// client/vitest.config.ts excludes this file by exact path so `npm test`
// (Vitest) never tries to collect it — node:test's `test()`/`describe()`
// registration isn't something Vitest's collector recognizes, which is
// what previously surfaced as a "No test suite found" collection error
// rather than these tests actually running or failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  M2_TO_ACRES,
  M2_TO_HECTARES,
  HECTARES_TO_ACRES,
  BAR_TO_PSI,
  IMPERIAL_GALLON_TO_L,
  TARGET_VOLUME_UNIT_OPTIONS,
  roundTo,
  computeChemicalMl,
  computeChemicalNeeded,
  computeSprayVolumeLPerAcre,
  convertTargetVolumeToLPerAcre,
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

// ── Bogaerts Target Spray Volume unit selector (L/acre vs imp gal/acre) ──────
// Confirmed directly from the physical Bogaerts Qii-Jet display, which reads
// "imp gal/acre": Imperial gallons (1 imp gal = 4.54609 L), not US gallons
// (1 US gal = 3.785411784 L). The stored/selected unit identifier is
// "imp_gal_per_acre" (never bare "gal") so a saved value can never be
// misread as US gallons. These tests lock the constant in; swapping to the
// US value would silently misstate total carrier volume by ~20%.

test("1 Imperial gallon = 4.54609 L", () => {
  assert.strictEqual(IMPERIAL_GALLON_TO_L, 4.54609);
});

test("TARGET_VOLUME_UNIT_OPTIONS exposes L/acre and an explicitly-Imperial imp_gal_per_acre — never bare gal", () => {
  const values = TARGET_VOLUME_UNIT_OPTIONS.map((o) => o.value);
  assert.deepStrictEqual(values.sort(), ["L_per_acre", "imp_gal_per_acre"]);
  const galOption = TARGET_VOLUME_UNIT_OPTIONS.find((o) => o.value === "imp_gal_per_acre");
  assert.strictEqual(galOption?.label, "imp gal/acre");
});

test("convertTargetVolumeToLPerAcre: L_per_acre is an identity conversion", () => {
  approx(convertTargetVolumeToLPerAcre(400, "L_per_acre"), 400, 1e-12);
});

test("convertTargetVolumeToLPerAcre: 250 imp gal/acre = 1,136.5225 L/acre", () => {
  approx(convertTargetVolumeToLPerAcre(250, "imp_gal_per_acre"), 1136.5225, 1e-9);
});

test("5.2637 acres at 250 imp gal/acre requires ~5,982 L total spray solution (not 1,315.9 L)", () => {
  const acres = 5.2637;
  const m2 = acres * ACRE_M2;
  const lPerAcre = convertTargetVolumeToLPerAcre(250, "imp_gal_per_acre");
  approx(lPerAcre, 1136.5225, 1e-9);

  const totalSolutionL = computeSprayVolumeLPerAcre(m2, lPerAcre) as number;
  // Precise value for 5.2637 acres x 1136.5225 L/acre.
  approx(totalSolutionL, 5982.313, 0.01);

  // The old (pre-fix) misinterpretation of the same "250" as 250 L/acre
  // gives a wildly different, much smaller total — confirming this is not
  // just a relabeling and the two must never be conflated.
  const oldMisinterpretedTotal = computeSprayVolumeLPerAcre(m2, 250) as number;
  approx(oldMisinterpretedTotal, 1315.925, 0.01);
  assert.ok(totalSolutionL > oldMisinterpretedTotal * 4);
});

test("imp gal/acre must never be converted using the US gallon factor (3.785411784)", () => {
  const lPerAcre = convertTargetVolumeToLPerAcre(250, "imp_gal_per_acre");
  const usGallonMistake = 250 * 3.785411784;
  assert.notEqual(roundTo(lPerAcre, 4), roundTo(usGallonMistake, 4));
  approx(lPerAcre, 1136.5225, 1e-9);
  approx(usGallonMistake, 946.352946, 1e-9);
});

test("equivalent imp gal/acre and L/acre settings produce exactly the same total solution after conversion", () => {
  const m2 = 3.4 * ACRE_M2;
  const galSetting = convertTargetVolumeToLPerAcre(180, "imp_gal_per_acre"); // 818.2962 L/acre
  const literSetting = convertTargetVolumeToLPerAcre(818.2962, "L_per_acre"); // identity

  const totalFromGal = computeSprayVolumeLPerAcre(m2, galSetting) as number;
  const totalFromLiters = computeSprayVolumeLPerAcre(m2, literSetting) as number;
  approx(totalFromGal, totalFromLiters, 1e-8);
});

test("chemical dose is independent of the Target Spray Volume unit (L/acre vs imp gal/acre)", () => {
  // 2.1302 ha at 900 mL/ha = 1,917.2 mL chemical — a fixed, independent figure.
  const m2 = 2.1302 * 10000;
  const chemical = computeChemicalNeeded(m2, 900, "ml_per_hectare");
  assert.ok(chemical);
  approx(chemical!.ml, 1917.18, 0.01);

  // Switching the robot's carrier-volume unit from L/acre to imp gal/acre
  // must not change this figure by even one mL — it only changes how much
  // carrier water the same dose gets distributed through.
  const chemicalAgain = computeChemicalNeeded(m2, 900, "ml_per_hectare");
  assert.strictEqual(chemical!.ml, chemicalAgain!.ml);
});

test("a 600 L tote holds far less chemical at the correct 250 imp gal/acre than the old, wrong 250 L/acre reading", () => {
  const acres = 5.2637;
  const m2 = acres * ACRE_M2;
  const chemical = computeChemicalNeeded(2.1302 * 10000, 900, "ml_per_hectare");
  assert.ok(chemical);

  const oldTotalL = computeSprayVolumeLPerAcre(m2, 250) as number; // old, wrong reading
  const oldPlan = computeMixPlan(oldTotalL, chemical!.ml, 600);
  assert.ok(oldPlan);
  approx(oldPlan!.chemPerFullBatchMl, 874.1, 1);

  const correctLPerAcre = convertTargetVolumeToLPerAcre(250, "imp_gal_per_acre");
  const correctTotalL = computeSprayVolumeLPerAcre(m2, correctLPerAcre) as number;
  const correctPlan = computeMixPlan(correctTotalL, chemical!.ml, 600);
  assert.ok(correctPlan);

  // Same chemical dose, ~4.5x more carrier volume -> proportionally less
  // concentrated per batch.
  assert.ok(correctPlan!.chemPerFullBatchMl < oldPlan!.chemPerFullBatchMl / 4);
});
