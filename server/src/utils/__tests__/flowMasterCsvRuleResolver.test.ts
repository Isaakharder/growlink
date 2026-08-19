import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCsvRowLabels } from "../flowMasterCsvRuleResolver";
import { normalizeSizeRuleLabel, type SizeRuleRecord } from "../flowMasterSizeRules";
import { type CsvRowKg } from "../flowMasterPdfParser";

function csvRow(overrides: Partial<CsvRowKg> & { marketLabel: string; size1Label: string; kg: number }): CsvRowKg {
  return { avg: null, pcs: null, ...overrides };
}

function rulesMap(rules: Array<Omit<SizeRuleRecord, "id"> & { id?: string }>): Map<string, SizeRuleRecord> {
  const map = new Map<string, SizeRuleRecord>();
  rules.forEach((r, i) => {
    map.set(normalizeSizeRuleLabel(r.rawLabel), { id: r.id ?? `rule-${i}`, ...r });
  });
  return map;
}

// ─── The reported requirement: a MARKET Ignore rule must suppress a row
// even when SIZE1 is already a recognized direct size code. ───────────────

test("a saved Ignore rule on MARKET suppresses a row whose SIZE1 is a recognized direct size code (waste + SM must NOT become Small)", () => {
  const rows: CsvRowKg[] = [
    csvRow({ marketLabel: "WASTE", size1Label: "SM", kg: 25 }),
    csvRow({ marketLabel: "CLASS 1", size1Label: "SM", kg: 34.123 }),
  ];
  const rules = rulesMap([{ rawLabel: "waste", action: "ignore", targetSizeId: null, distributeSizeIds: [] }]);

  const result = resolveCsvRowLabels(rows, [], {}, rules);

  // The waste row's kg is filed under "WASTE" (unresolved at this stage —
  // the actual ignore is applied later by applySizeRules/resolveFileSizes),
  // never merged into "Small".
  assert.strictEqual(result.sizeKg["WASTE"], 25);
  assert.ok(result.unknownSizes.includes("WASTE"));
  assert.strictEqual(result.sizeKg["Small"], 34.123); // only the Class 1 row's kg
});

test("with NO saved rule for MARKET=waste, SIZE1=SM still maps directly to Small (unchanged default hierarchy)", () => {
  const rows: CsvRowKg[] = [csvRow({ marketLabel: "WASTE", size1Label: "SM", kg: 25 })];

  const result = resolveCsvRowLabels(rows, [], {}, new Map());

  assert.strictEqual(result.sizeKg["Small"], 25);
  assert.ok(!("WASTE" in result.sizeKg));
  assert.deepStrictEqual(result.unknownSizes, []);
});

test("a saved Map rule on MARKET redirects a row's kg away from its SIZE1 direct code once flagged unresolved (application happens downstream)", () => {
  // resolveCsvRowLabels only decides WHICH label wins (MARKET here, since it
  // has a rule) — it doesn't apply map/distribute itself, so the row's kg is
  // filed under "WASTE", still pending the shared applySizeRules engine.
  const rows: CsvRowKg[] = [csvRow({ marketLabel: "WASTE", size1Label: "XL", kg: 10 })];
  const rules = rulesMap([
    { rawLabel: "waste", action: "map", targetSizeId: "some-size-id", distributeSizeIds: [] },
  ]);

  const result = resolveCsvRowLabels(rows, [], {}, rules);

  assert.strictEqual(result.sizeKg["WASTE"], 10);
  assert.ok(!("XL" in result.sizeKg));
  assert.ok(result.unknownSizes.includes("WASTE"));
});

test("a saved rule for a DIFFERENT market (Green) does not affect a waste+SM row with no rule of its own", () => {
  const rows: CsvRowKg[] = [csvRow({ marketLabel: "WASTE", size1Label: "SM", kg: 25 })];
  const rules = rulesMap([{ rawLabel: "green", action: "ignore", targetSizeId: null, distributeSizeIds: [] }]);

  const result = resolveCsvRowLabels(rows, [], {}, rules);

  // "waste" itself has no rule, so SIZE1's direct code still wins.
  assert.strictEqual(result.sizeKg["Small"], 25);
  assert.ok(!("WASTE" in result.sizeKg));
});

test("legacy ignoredSizeLabels on MARKET also takes priority over a direct SIZE1 code, same as a saved rule would", () => {
  const rows: CsvRowKg[] = [csvRow({ marketLabel: "WASTE", size1Label: "SM", kg: 25 })];

  const result = resolveCsvRowLabels(rows, ["WASTE"], {}, new Map());

  // ignoredSizeLabels resolves AND applies immediately (unlike flowmaster_size_rules,
  // this mechanism is fully known at this stage) — the row is dropped entirely.
  assert.ok(!("WASTE" in result.sizeKg));
  assert.ok(!("Small" in result.sizeKg));
  assert.deepStrictEqual(result.unknownSizes, []);
});

// ─── Baseline hierarchy behavior, unaffected by the fix above ─────────────

test("MARKET=24ct + SIZE1=All Weight resolves via MARKET when 24ct has a rule, not a generic All Weight default", () => {
  const rows: CsvRowKg[] = [csvRow({ marketLabel: "24CT", size1Label: "ALL WEIGHT", kg: 500 })];
  const rules = rulesMap([{ rawLabel: "24ct", action: "distribute", targetSizeId: null, distributeSizeIds: ["id-xl"] }]);

  const result = resolveCsvRowLabels(rows, [], {}, rules);

  assert.strictEqual(result.sizeKg["24CT"], 500);
  assert.ok(result.unknownSizes.includes("24CT"));
});

test("Class 1 + SM/MD/LG/SXL/XL/XXL always map directly when MARKET has no rule at all", () => {
  const rows: CsvRowKg[] = [
    csvRow({ marketLabel: "CLASS 1", size1Label: "SM", kg: 34.123 }),
    csvRow({ marketLabel: "CLASS 1", size1Label: "XXL", kg: 353.205 }),
  ];

  const result = resolveCsvRowLabels(rows, [], {}, new Map());

  assert.strictEqual(result.sizeKg["Small"], 34.123);
  assert.strictEqual(result.sizeKg["XXL"], 353.205);
  assert.deepStrictEqual(result.unknownSizes, []);
});

test("zero-kg and non-finite rows are skipped without throwing", () => {
  const rows: CsvRowKg[] = [
    csvRow({ marketLabel: "CLASS 1", size1Label: "SM", kg: 0 }),
    csvRow({ marketLabel: "CLASS 1", size1Label: "MD", kg: Number.NaN }),
    csvRow({ marketLabel: "CLASS 1", size1Label: "LG", kg: 10 }),
  ];

  const result = resolveCsvRowLabels(rows, [], {}, new Map());

  assert.deepStrictEqual(result.sizeKg, { Large: 10 });
  assert.deepStrictEqual(result.unknownSizes, []);
});

test("empty row list produces empty output without throwing", () => {
  const result = resolveCsvRowLabels([], [], {}, new Map());
  assert.deepStrictEqual(result.sizeKg, {});
  assert.deepStrictEqual(result.unknownSizes, []);
});
