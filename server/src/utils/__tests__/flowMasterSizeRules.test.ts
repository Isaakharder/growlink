import { test } from "node:test";
import assert from "node:assert/strict";
import { applySizeRules, normalizeSizeRuleLabel, type SizeRuleRecord } from "../flowMasterSizeRules";

function rule(overrides: Partial<SizeRuleRecord> & { id: string; rawLabel: string }): SizeRuleRecord {
  return {
    action: "create",
    targetSizeId: null,
    distributeSizeIds: [],
    ...overrides
  };
}

test("label with no saved rule stays unknown and its kg is untouched", () => {
  const sizeKg = { Small: 100, Double: 50 };
  const result = applySizeRules(sizeKg, ["Double"], new Map(), new Map());

  assert.deepStrictEqual(result.unknownSizes, ["Double"]);
  assert.strictEqual(result.sizeKg.Double, 50);
  assert.strictEqual(result.sizeKg.Small, 100);
});

test("'create'/'map' rule folds the label's kg into the target size and clears unknown", () => {
  const sizeKg = { Large: 500, Double: 50 };
  const rules = new Map([
    ["double", rule({ id: "r1", rawLabel: "Double", action: "map", targetSizeId: "size-large" })]
  ]);
  const activeSizeNameById = new Map([["size-large", "Large"]]);

  const result = applySizeRules(sizeKg, ["Double"], rules, activeSizeNameById);

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.strictEqual(result.sizeKg.Double, undefined);
  assert.strictEqual(result.sizeKg.Large, 550);
});

test("'create' rule behaves identically to 'map' — folds into the newly created size", () => {
  const sizeKg = { Green: 30 };
  const rules = new Map([
    ["green", rule({ id: "r1", rawLabel: "Green", action: "create", targetSizeId: "size-green" })]
  ]);
  const activeSizeNameById = new Map([["size-green", "Green"]]);

  const result = applySizeRules(sizeKg, ["Green"], rules, activeSizeNameById);

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.strictEqual(result.sizeKg.Green, 30);
});

test("'ignore' rule drops the label's kg entirely — total shrinks, no double counting", () => {
  const sizeKg = { Small: 100, Medium: 200, "Class 1": 300 };
  const rules = new Map([
    ["class 1", rule({ id: "r1", rawLabel: "Class 1", action: "ignore" })]
  ]);

  const result = applySizeRules(sizeKg, ["Class 1"], rules, new Map());

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.strictEqual(result.sizeKg["Class 1"], undefined);
  assert.strictEqual(result.sizeKg.Small, 100);
  assert.strictEqual(result.sizeKg.Medium, 200);
  const totalKg = Object.values(result.sizeKg).reduce((a, b) => a + b, 0);
  assert.strictEqual(totalKg, 300); // 100 + 200, "Class 1"'s 300 excluded
  assert.ok(result.notes.some((n) => n.includes("Class 1") && n.includes("ignored")));
});

test("'distribute' rule splits kg proportionally by each destination's existing kg, preserving total exactly", () => {
  const sizeKg = { SXL: 200, XL: 600, XXL: 200, "24 ct": 100 };
  const rules = new Map([
    [
      "24 ct",
      rule({
        id: "r1",
        rawLabel: "24 ct",
        action: "distribute",
        distributeSizeIds: ["id-sxl", "id-xl", "id-xxl"]
      })
    ]
  ]);
  const activeSizeNameById = new Map([
    ["id-sxl", "SXL"],
    ["id-xl", "XL"],
    ["id-xxl", "XXL"]
  ]);

  const result = applySizeRules(sizeKg, ["24 ct"], rules, activeSizeNameById);

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.strictEqual(result.sizeKg["24 ct"], undefined);
  // 20% / 60% / 20% split of 100kg => +20 / +60 / +20
  assert.strictEqual(result.sizeKg.SXL, 220);
  assert.strictEqual(result.sizeKg.XL, 660);
  assert.strictEqual(result.sizeKg.XXL, 220);

  const totalBefore = 200 + 600 + 200 + 100;
  const totalAfter = Object.values(result.sizeKg).reduce((a, b) => a + b, 0);
  assert.strictEqual(totalAfter, totalBefore);
});

test("'distribute' rounding residual lands on the last destination so the total is never off by a cent", () => {
  // 10kg split 3 ways by equal weight (no existing destination kg) => 3.33/3.33/3.34
  const sizeKg = { "Odd Size": 10 };
  const rules = new Map([
    [
      "odd size",
      rule({
        id: "r1",
        rawLabel: "Odd Size",
        action: "distribute",
        distributeSizeIds: ["id-a", "id-b", "id-c"]
      })
    ]
  ]);
  const activeSizeNameById = new Map([
    ["id-a", "A"],
    ["id-b", "B"],
    ["id-c", "C"]
  ]);

  const result = applySizeRules(sizeKg, ["Odd Size"], rules, activeSizeNameById);

  const total = (result.sizeKg.A ?? 0) + (result.sizeKg.B ?? 0) + (result.sizeKg.C ?? 0);
  assert.strictEqual(total, 10);
  assert.strictEqual(result.sizeKg.A, 3.33);
  assert.strictEqual(result.sizeKg.B, 3.33);
  assert.strictEqual(result.sizeKg.C, 3.34);
});

test("distribute rule with zero destination kg splits evenly instead of dividing by zero", () => {
  const sizeKg = { "Weird Pack": 90 };
  const rules = new Map([
    [
      "weird pack",
      rule({
        id: "r1",
        rawLabel: "Weird Pack",
        action: "distribute",
        distributeSizeIds: ["id-a", "id-b", "id-c"]
      })
    ]
  ]);
  const activeSizeNameById = new Map([
    ["id-a", "A"],
    ["id-b", "B"],
    ["id-c", "C"]
  ]);

  const result = applySizeRules(sizeKg, ["Weird Pack"], rules, activeSizeNameById);

  assert.strictEqual(result.sizeKg.A, 30);
  assert.strictEqual(result.sizeKg.B, 30);
  assert.strictEqual(result.sizeKg.C, 30);
});

test("several unknown labels in one file resolve independently by their own rule", () => {
  // Mirrors the reported example: Double, all weight, Class 1, Green, 24 ct.
  const sizeKg = {
    Large: 500,
    Double: 40,
    "all weight": 10,
    "Class 1": 300,
    Green: 25,
    "24 ct": 100
  };
  const unknownSizes = ["Double", "all weight", "Class 1", "Green", "24 ct"];

  const rules = new Map([
    ["double", rule({ id: "r1", rawLabel: "Double", action: "map", targetSizeId: "id-large" })],
    ["class 1", rule({ id: "r2", rawLabel: "Class 1", action: "ignore" })],
    [
      "24 ct",
      rule({ id: "r3", rawLabel: "24 ct", action: "distribute", distributeSizeIds: ["id-large"] })
    ]
    // "all weight" and "Green" intentionally left without a saved rule.
  ]);
  const activeSizeNameById = new Map([["id-large", "Large"]]);

  const result = applySizeRules(sizeKg, unknownSizes, rules, activeSizeNameById);

  assert.deepStrictEqual(result.unknownSizes.sort(), ["Green", "all weight"].sort());
  assert.strictEqual(result.sizeKg["Class 1"], undefined);
  assert.strictEqual(result.sizeKg.Double, undefined);
  assert.strictEqual(result.sizeKg["24 ct"], undefined);
  // Large starts at 500, +40 (Double), +100 (all of 24ct, only destination) = 640
  assert.strictEqual(result.sizeKg.Large, 640);
  assert.strictEqual(result.sizeKg["all weight"], 10);
  assert.strictEqual(result.sizeKg.Green, 25);
});

// ─── normalizeSizeRuleLabel ───────────────────────────────────────────────

test("normalizeSizeRuleLabel strips braces, collapses whitespace, and lowercases so label variants share one match key", () => {
  assert.strictEqual(normalizeSizeRuleLabel("{oversized}"), "oversized");
  assert.strictEqual(normalizeSizeRuleLabel("OVERSIZED"), "oversized");
  assert.strictEqual(normalizeSizeRuleLabel("  Oversized  "), "oversized");
  assert.strictEqual(normalizeSizeRuleLabel("{ Oversized }"), "oversized");
  assert.strictEqual(normalizeSizeRuleLabel("Class   1"), "class 1");
});

test("a rule saved with braces resolves an unknownSizes label that has no braces (and vice versa)", () => {
  const rules = new Map([
    [normalizeSizeRuleLabel("{oversized}"), rule({ id: "r1", rawLabel: "{oversized}", action: "ignore" })]
  ]);

  const result = applySizeRules({ OVERSIZED: 5 }, ["OVERSIZED"], rules, new Map());

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.strictEqual(result.sizeKg.OVERSIZED, undefined);
});

test("rule pointing at a deleted/inactive size falls back to unknown with a warning note", () => {
  const sizeKg = { Double: 40 };
  const rules = new Map([
    ["double", rule({ id: "r1", rawLabel: "Double", action: "map", targetSizeId: "deleted-id" })]
  ]);

  const result = applySizeRules(sizeKg, ["Double"], rules, new Map());

  assert.deepStrictEqual(result.unknownSizes, ["Double"]);
  assert.strictEqual(result.sizeKg.Double, 40);
  assert.ok(result.notes.some((n) => n.includes("no longer exists")));
});
