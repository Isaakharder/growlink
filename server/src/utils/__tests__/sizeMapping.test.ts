import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeSizeName, classifySizeMapping, resolveFileSizes, type OrgSizeContext } from "../sizeMapping";
import type { SizeRuleRecord } from "../flowMasterSizeRules";

function activeSizesCtx(sizes: Array<{ id: string; name: string }>): OrgSizeContext {
  const activeYieldSizeNameByCanonical = new Map<string, string>();
  const activeSizeNameById = new Map<string, string>();
  for (const size of sizes) {
    // Same canonicalization loadOrgSizeContext uses in production.
    activeYieldSizeNameByCanonical.set(canonicalizeSizeName(size.name), size.name);
    activeSizeNameById.set(size.id, size.name);
  }
  return { activeYieldSizeNameByCanonical, activeSizeNameById, rulesByNormalizedLabel: new Map() };
}

function withRules(ctx: OrgSizeContext, rules: SizeRuleRecord[]): OrgSizeContext {
  const rulesByNormalizedLabel = new Map<string, SizeRuleRecord>();
  for (const rule of rules) {
    rulesByNormalizedLabel.set(rule.rawLabel.trim().toLowerCase(), rule);
  }
  return { ...ctx, rulesByNormalizedLabel };
}

// ── classifySizeMapping (no rules involved — pure name-canonicalization) ──

test("known PDF short-code sizes map to their active GrowLink names", () => {
  const ctx = activeSizesCtx([
    { id: "s1", name: "Small" },
    { id: "s2", name: "Medium" },
    { id: "s3", name: "Large" }
  ]);

  const result = classifySizeMapping(
    { Small: 100, Medium: 200, Large: 300 },
    [],
    ctx.activeYieldSizeNameByCanonical
  );

  assert.strictEqual(result.sizeMappingStatus.mappedCount, 3);
  assert.strictEqual(result.sizeMappingStatus.unmappedCount, 0);
  assert.deepStrictEqual(result.unknownSizes, []);
});

test("one unrecognized size label stays unmapped and produces a 'New size found' warning", () => {
  const ctx = activeSizesCtx([{ id: "s1", name: "Small" }]);

  const result = classifySizeMapping({ Small: 100, Double: 40 }, ["Double"], ctx.activeYieldSizeNameByCanonical);

  assert.strictEqual(result.sizeMappingStatus.mappedCount, 1);
  assert.strictEqual(result.sizeMappingStatus.unmappedCount, 1);
  assert.deepStrictEqual(result.unknownSizes, ["Double"]);
  assert.ok(result.sizeWarnings.some((w) => w === "New size found: Double. Add this size in GrowLink before importing."));
});

// ── resolveFileSizes (rules + classification, the actual preview/import path) ──

test("existing known sizes continue to import normally alongside several unresolved unknown sizes", () => {
  // Mirrors the reported bug: Small/Medium/Large/SXL/XL/XXL already configured,
  // plus five brand-new FlowMaster labels with no saved rule yet.
  const ctx = activeSizesCtx([
    { id: "s1", name: "Small" },
    { id: "s2", name: "Medium" },
    { id: "s3", name: "Large" },
    { id: "s4", name: "SXL" },
    { id: "s5", name: "XL" },
    { id: "s6", name: "XXL" }
  ]);

  const sizeKg = {
    Small: 13,
    Medium: 114,
    Large: 280,
    SXL: 559,
    XL: 181,
    XXL: 37,
    Double: 8,
    "all weight": 0,
    "Class 1": 1185,
    Green: 34,
    "24 ct": 0
  };
  const unknownSizes = ["Double", "all weight", "Class 1", "Green", "24 ct"];

  const result = resolveFileSizes(sizeKg, unknownSizes, ctx);

  // The 6 known sizes are unaffected — still mapped, kg untouched.
  assert.strictEqual(result.sizeMappingStatus.mappedCount, 6);
  for (const [name, kg] of Object.entries({ Small: 13, Medium: 114, Large: 280, SXL: 559, XL: 181, XXL: 37 })) {
    assert.strictEqual(result.sizeKg[name], kg);
  }

  // All 5 new labels have no saved rule yet, so all 5 remain unknown.
  assert.deepStrictEqual(result.unknownSizes.sort(), unknownSizes.slice().sort());
  assert.strictEqual(result.sizeMappingStatus.unmappedCount, 5);
});

test("configuring rules for every unknown label (create/map/ignore/distribute) clears them all and known sizes stay correct", () => {
  const ctx = activeSizesCtx([
    { id: "s3", name: "Large" },
    { id: "s4", name: "SXL" },
    { id: "s5", name: "XL" },
    { id: "s6", name: "XXL" },
    { id: "s7", name: "Green" } // newly "created" size for the Green label
  ]);

  const rules: SizeRuleRecord[] = [
    { id: "r1", rawLabel: "Double", action: "map", targetSizeId: "s3", distributeSizeIds: [] },
    { id: "r2", rawLabel: "all weight", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { id: "r3", rawLabel: "Class 1", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { id: "r4", rawLabel: "Green", action: "create", targetSizeId: "s7", distributeSizeIds: [] },
    { id: "r5", rawLabel: "24 ct", action: "distribute", targetSizeId: null, distributeSizeIds: ["s4", "s5", "s6"] }
  ];
  const ruledCtx = withRules(ctx, rules);

  const sizeKg = {
    Large: 500,
    SXL: 200,
    XL: 600,
    XXL: 200,
    Double: 40,
    "all weight": 10,
    "Class 1": 300,
    Green: 25,
    "24 ct": 100
  };
  const unknownSizes = ["Double", "all weight", "Class 1", "Green", "24 ct"];

  const result = resolveFileSizes(sizeKg, unknownSizes, ruledCtx);

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.strictEqual(result.sizeMappingStatus.unmappedCount, 0);

  // map: Double folded into Large.
  assert.strictEqual(result.sizeKg.Large, 540);
  // ignore: "all weight" and "Class 1" excluded entirely.
  assert.strictEqual(result.sizeKg["all weight"], undefined);
  assert.strictEqual(result.sizeKg["Class 1"], undefined);
  // create: Green kept under its own (newly created) active size name.
  assert.strictEqual(result.sizeKg.Green, 25);
  // distribute: "24 ct"'s 100kg split 20/60/20 by SXL/XL/XXL's existing kg.
  assert.strictEqual(result.sizeKg.SXL, 220);
  assert.strictEqual(result.sizeKg.XL, 660);
  assert.strictEqual(result.sizeKg.XXL, 220);

  // Total imported kg is preserved: only "all weight" (10) and "Class 1" (300)
  // were actually dropped (by design — they're not real sizes); nothing else
  // was gained or lost.
  const totalBefore = Object.values(sizeKg).reduce((a, b) => a + b, 0);
  const totalAfter = Object.values(result.sizeKg).reduce((a, b) => a + b, 0);
  assert.strictEqual(totalAfter, totalBefore - 10 - 300);
});

test("unknown sizes spread across multiple files each resolve independently against the same org rules", () => {
  const ctx = activeSizesCtx([{ id: "s3", name: "Large" }]);
  const rules: SizeRuleRecord[] = [
    { id: "r1", rawLabel: "Double", action: "map", targetSizeId: "s3", distributeSizeIds: [] }
  ];
  const ruledCtx = withRules(ctx, rules);

  // File A only has "Double" (resolved by rule).
  const fileA = resolveFileSizes({ Large: 100, Double: 20 }, ["Double"], ruledCtx);
  assert.deepStrictEqual(fileA.unknownSizes, []);
  assert.strictEqual(fileA.sizeKg.Large, 120);

  // File B has "Double" (resolved) AND "Green" (no rule yet, stays unknown) —
  // resolving file A must not have mutated the shared context or file B's input.
  const fileB = resolveFileSizes({ Large: 50, Double: 10, Green: 5 }, ["Double", "Green"], ruledCtx);
  assert.deepStrictEqual(fileB.unknownSizes, ["Green"]);
  assert.strictEqual(fileB.sizeKg.Large, 60);
  assert.strictEqual(fileB.sizeKg.Green, 5);
});
