// Run: npm run test:croplink-v2
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAverageFruitWeightG } from "../averageFruitWeight";
import { writeSourceColumn } from "../writeSource";

test("appending kg combines AFW as total grams / total fruit (not the latest day's value)", () => {
  // 1000 kg @ 200 g = 5,000 fruit; 1000 kg @ 250 g = 4,000 fruit → 2,000,000 g / 9,000 = 222.2 g
  const afw = mergeAverageFruitWeightG(1000, 200, 1000, 250)!;
  assert.ok(Math.abs(afw - 2_000_000 / 9_000) < 1e-9);
  assert.notEqual(afw, 250);
  assert.notEqual(afw, 225);
});

test("unequal kg weights by fruit count", () => {
  assert.ok(Math.abs(mergeAverageFruitWeightG(3000, 180, 500, 240)! - (3500 * 1000) / (3000_000 / 180 + 500_000 / 240)) < 1e-9);
});

test("edge cases: empty sides and unknown AFW", () => {
  assert.equal(mergeAverageFruitWeightG(0, null, 800, 210), 210);
  assert.equal(mergeAverageFruitWeightG(1000, 200, 0, null), 200);
  assert.equal(mergeAverageFruitWeightG(1000, null, 500, 210), null);
  assert.equal(mergeAverageFruitWeightG(1000, 200, 500, null), null);
  assert.equal(mergeAverageFruitWeightG(0, null, 0, null), null);
});

test("last_write_source is only written once tracking is enabled (after migration 0141)", () => {
  assert.deepEqual(writeSourceColumn("manual_merge", {}), {});
  assert.deepEqual(writeSourceColumn("manual_merge", { YIELD_WRITE_SOURCE_TRACKING: "true" }), {});
  assert.deepEqual(writeSourceColumn("manual_merge", { YIELD_WRITE_SOURCE_TRACKING: "enabled" }), { last_write_source: "manual_merge" });
});
