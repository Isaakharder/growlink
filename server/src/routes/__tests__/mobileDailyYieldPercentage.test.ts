import test from "node:test";
import assert from "node:assert/strict";
import { calculateSampleMetrics, parseBinFillPercent } from "../mobileDailyYieldSampleMath";

test("accepts bin fill percentages above 100", () => {
  assert.equal(parseBinFillPercent(100), 100);
  assert.equal(parseBinFillPercent(125), 125);
  assert.equal(parseBinFillPercent(150), 150);
  assert.equal(parseBinFillPercent(200), 200);
  assert.equal(parseBinFillPercent(350.5), 350.5);
});

test("rejects negative or invalid bin fill percentages", () => {
  assert.throws(() => parseBinFillPercent(-0.1), /0 or greater/);
  assert.throws(() => parseBinFillPercent("not-a-number"), /required/);
});

test("calculates 150 percent as 1.5x full bin and does not clamp", () => {
  const result = calculateSampleMetrics(150, 100, 100);
  assert.equal(result.calculatedSampleKg, 150);
  assert.equal(result.calculatedKgPerStem, 1.5);
});

test("calculates 200 percent correctly", () => {
  const result = calculateSampleMetrics(200, 80, 40);
  assert.equal(result.calculatedSampleKg, 160);
  assert.equal(result.calculatedKgPerStem, 4);
});

test("editing an existing sample from below 100 to above 100 increases computed values", () => {
  const beforeEdit = calculateSampleMetrics(75, 96, 48);
  const afterEdit = calculateSampleMetrics(150, 96, 48);

  assert.equal(beforeEdit.calculatedSampleKg, 72);
  assert.equal(afterEdit.calculatedSampleKg, 144);
  assert.ok(afterEdit.calculatedSampleKg > beforeEdit.calculatedSampleKg);
  assert.ok(afterEdit.calculatedKgPerStem > beforeEdit.calculatedKgPerStem);
});

test("existing values at or below 100 remain unchanged", () => {
  const fullBin = calculateSampleMetrics(100, 110, 55);
  const partialBin = calculateSampleMetrics(80, 110, 55);

  assert.equal(fullBin.calculatedSampleKg, 110);
  assert.equal(fullBin.calculatedKgPerStem, 2);
  assert.equal(partialBin.calculatedSampleKg, 88);
  assert.equal(partialBin.calculatedKgPerStem, 1.6);
});
