import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolateMultiplier, computeLinearAdjustment, type LinearAdjustmentSettings } from "../bonusMultiplier";

const PICKING_SPEC_SETTINGS: LinearAdjustmentSettings = {
  standardValue: 1.2,
  valueStep: 0.2,
  speedChangePerStep: 10,
  minAdjustment: -50,
  maxAdjustment: 75
};

const PRUNING_SPEC_SETTINGS: LinearAdjustmentSettings = {
  standardValue: 5,
  valueStep: 1,
  speedChangePerStep: 10,
  minAdjustment: -100,
  maxAdjustment: 100
};

test("exact configured points return their own multiplier", () => {
  const points = [
    { reference_value: 0.5, multiplier: 0.67 },
    { reference_value: 1.0, multiplier: 1.0 },
    { reference_value: 2.0, multiplier: 1.33 }
  ];
  assert.strictEqual(interpolateMultiplier(points, 1.0), 1.0);
  assert.strictEqual(interpolateMultiplier(points, 2.0), 1.33);
});

test("interpolates linearly between the two nearest points", () => {
  const points = [
    { reference_value: 1.0, multiplier: 1.0 },
    { reference_value: 2.0, multiplier: 1.33 }
  ];
  // 1.5 is halfway between 1.0 and 2.0 -> multiplier halfway between 1.00 and 1.33
  const result = interpolateMultiplier(points, 1.5);
  assert.ok(Math.abs(result - 1.165) < 0.0005, `expected ~1.165, got ${result}`);
});

test("clamps to the lowest multiplier below the lowest configured point", () => {
  const points = [
    { reference_value: 1.0, multiplier: 1.0 },
    { reference_value: 2.0, multiplier: 1.33 }
  ];
  assert.strictEqual(interpolateMultiplier(points, 0.1), 1.0);
});

test("clamps to the highest multiplier above the highest configured point", () => {
  const points = [
    { reference_value: 1.0, multiplier: 1.0 },
    { reference_value: 2.0, multiplier: 1.33 }
  ];
  assert.strictEqual(interpolateMultiplier(points, 5), 1.33);
});

test("no configured points defaults to a 1.0 multiplier (no adjustment)", () => {
  assert.strictEqual(interpolateMultiplier([], 1.5), 1);
});

test("adjusted threshold rounds to a whole number: base 150 x 1.33 = 200", () => {
  const adjusted = Math.round(150 * 1.33);
  assert.strictEqual(adjusted, 200);
});

test("adjusted threshold rounds to a whole number: base 150 x 0.67 rounds cleanly", () => {
  const adjusted = Math.round(150 * 0.67);
  assert.ok(adjusted === 100 || adjusted === 101, `expected ~100, got ${adjusted}`);
});

// ── Picking linear (absolute kg/hr) adjustment ───────────────────────────────

test("linear adjustment at 1.8 kg/m^2: +0.6 diff, 3 steps, +30 kg/hr, base 150 -> 180", () => {
  const { rawAdjustment, finalAdjustment } = computeLinearAdjustment(PICKING_SPEC_SETTINGS, 1.8);
  assert.strictEqual(rawAdjustment, 30);
  assert.strictEqual(finalAdjustment, 30);
  assert.strictEqual(Math.round(150 + finalAdjustment), 180);
});

test("linear adjustment at 0.8 kg/m^2: -0.4 diff, -2 steps, -20 kg/hr, base 150 -> 130", () => {
  const { rawAdjustment, finalAdjustment } = computeLinearAdjustment(PICKING_SPEC_SETTINGS, 0.8);
  assert.strictEqual(rawAdjustment, -20);
  assert.strictEqual(finalAdjustment, -20);
  assert.strictEqual(Math.round(150 + finalAdjustment), 130);
});

test("linear adjustment at the standard crop load produces zero adjustment", () => {
  const { rawAdjustment, finalAdjustment } = computeLinearAdjustment(PICKING_SPEC_SETTINGS, 1.2);
  assert.strictEqual(rawAdjustment, 0);
  assert.strictEqual(finalAdjustment, 0);
});

test("linear adjustment clamps to the maximum adjustment for very high crop load", () => {
  // (10 - 1.2) / 0.2 * 10 = 440, far above the +75 cap
  const { rawAdjustment, finalAdjustment } = computeLinearAdjustment(PICKING_SPEC_SETTINGS, 10);
  assert.strictEqual(rawAdjustment, 440);
  assert.strictEqual(finalAdjustment, 75);
});

test("linear adjustment clamps to the minimum adjustment for very low crop load", () => {
  // (0 - 1.2) / 0.2 * 10 = -60, below the -50 floor
  const { rawAdjustment, finalAdjustment } = computeLinearAdjustment(PICKING_SPEC_SETTINGS, 0);
  assert.strictEqual(rawAdjustment, -60);
  assert.strictEqual(finalAdjustment, -50);
});

test("linear adjustment applies the same absolute offset to every tier, not a percentage", () => {
  const { finalAdjustment } = computeLinearAdjustment(PICKING_SPEC_SETTINGS, 1.8); // +30
  assert.strictEqual(Math.round(150 + finalAdjustment), 180);
  assert.strictEqual(Math.round(200 + finalAdjustment), 230);
  assert.strictEqual(Math.round(250 + finalAdjustment), 280);
});

// ── Winding/Pruning linear (absolute heads/hr) adjustment ────────────────────

test("fruit set adjustment at standard (5 sets/m^2): 600 stays 600 heads/hr", () => {
  const { finalAdjustment } = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, 5);
  assert.strictEqual(finalAdjustment, 0);
  assert.strictEqual(Math.round(600 + finalAdjustment), 600);
});

test("fruit set adjustment at 6 sets/m^2: 600 becomes 610 heads/hr", () => {
  const { rawAdjustment, finalAdjustment } = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, 6);
  assert.strictEqual(rawAdjustment, 10);
  assert.strictEqual(finalAdjustment, 10);
  assert.strictEqual(Math.round(600 + finalAdjustment), 610);
});

test("fruit set adjustment at 7 sets/m^2: 600 becomes 620 heads/hr", () => {
  const { finalAdjustment } = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, 7);
  assert.strictEqual(finalAdjustment, 20);
  assert.strictEqual(Math.round(600 + finalAdjustment), 620);
});

test("fruit set adjustment at 4 sets/m^2: 600 becomes 590 heads/hr", () => {
  const { finalAdjustment } = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, 4);
  assert.strictEqual(finalAdjustment, -10);
  assert.strictEqual(Math.round(600 + finalAdjustment), 590);
});

test("fruit set adjustment at 3 sets/m^2: 600 becomes 580 heads/hr", () => {
  const { finalAdjustment } = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, 3);
  assert.strictEqual(finalAdjustment, -20);
  assert.strictEqual(Math.round(600 + finalAdjustment), 580);
});

test("fruit set adjustment clamps at the configured min/max", () => {
  const high = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, 25); // (25-5)/1*10 = 200, above +100 cap
  assert.strictEqual(high.finalAdjustment, 100);
  const low = computeLinearAdjustment(PRUNING_SPEC_SETTINGS, -10); // (-10-5)/1*10 = -150, below -100 floor
  assert.strictEqual(low.finalAdjustment, -100);
});
