// Exercises the ACTUAL function both live routes use to build a pending
// import's preview (buildPreviewFile, exported from agentPendingImports.ts)
// — not just the pure CSV parser in isolation. Constructs PendingImportRow
// fixtures the way real rows look in the database (including rows with
// intentionally WRONG stored columns, simulating a row queued before the
// duplicate-header/date-parsing fix shipped) and proves buildPreviewFile
// still returns the correct date/week/size breakdown once raw CSV text is
// available to re-parse from — this is the mechanism that lets an
// already-queued pending import self-correct once the fix is deployed,
// which the stored-columns-only design could never do.
//
// dotenv/config is required first because agentPendingImports.ts imports
// ../config/supabase, which throws at module load if SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY aren't set — createClient() itself makes no
// network call, so this stays a pure, offline test.
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPreviewFile,
  type PendingImportRow,
  type BuildPreviewContext,
} from "../agentPendingImports";
import { canonicalizeSizeName } from "../../utils/sizeMapping";
import type { SizeRuleRecord } from "../../utils/flowMasterSizeRules";

// ─── The exact three fixture files from the reported live bug ────────────

const LOT_362_CSV = [
  "LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,MARKET,SIZE1,SIZE2,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS",
  "2608170362,1,Cadalora,17082026,18082026,24ct,All Weight,null,0.000,0.0,0,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Green,All Weight,null,943.702,171.0,5519,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,underweight,null,0.562,62.4,9,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,SM,null,34.123,91.2,374,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,MD,null,468.121,120.1,3899,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,LG,null,1380.906,143.7,9611,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,SXL,null,3257.101,166.3,19585,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,XL,null,4489.312,194.1,23124,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Class 1,XXL,null,353.205,230.4,1533,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,Doubles,All Weight,null,191.043,150.7,1268,11118.075,171.3,64922",
  "2608170362,1,Cadalora,17082026,18082026,waste,{oversized},null,2.916,416.6,7,11118.075,171.3,64922",
].join("\n");

const LOT_363_CSV = [
  "LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,MARKET,SIZE1,SIZE2,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS",
  "2608180363,1,Cadalora,18082026,19082026,24ct,All Weight,null,0.000,0.0,0,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Green,All Weight,null,724.675,170.1,4260,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,underweight,null,0.854,61.0,14,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,SM,null,32.513,89.3,364,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,MD,null,599.873,119.6,5016,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,LG,null,2334.673,143.7,16251,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,SXL,null,5965.757,167.6,35586,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,XL,null,6639.618,196.1,33858,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Class 1,XXL,null,558.544,232.2,2405,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,Doubles,All Weight,null,322.871,153.9,2098,17179.378,172.0,99852",
  "2608180363,1,Cadalora,18082026,19082026,waste,{oversized},null,1.848,462.0,4,17179.378,172.0,99852",
].join("\n");

const LOT_364_CSV = [
  "LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,MARKET,SIZE1,SIZE2,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS",
  "2608190364,1,Cadalora,19082026,19082026,24ct,All Weight,null,0.000,0.0,0,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Green,All Weight,null,54.119,169.7,319,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,underweight,null,0.310,62.0,5,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,SM,null,9.437,89.9,105,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,MD,null,283.177,123.0,2303,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,LG,null,847.496,145.9,5810,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,SXL,null,1882.527,167.9,11213,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,XL,null,2270.658,196.7,11543,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Class 1,XXL,null,80.897,237.9,340,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,Doubles,All Weight,null,104.984,158.8,661,5533.605,171.3,32299",
  "2608190364,1,Cadalora,19082026,19082026,waste,{oversized},null,0.427,427.0,1,5533.605,171.3,32299",
].join("\n");

function fakeCtx(activeSizeNames: string[], rules: SizeRuleRecord[] = []): BuildPreviewContext {
  const activeYieldSizeNameByCanonical = new Map<string, string>();
  const activeSizeNameById = new Map<string, string>();
  activeSizeNames.forEach((name, i) => {
    activeYieldSizeNameByCanonical.set(canonicalizeSizeName(name), name);
    activeSizeNameById.set(`size-${i}`, name);
  });
  const rulesByNormalizedLabel = new Map<string, SizeRuleRecord>();
  for (const rule of rules) {
    rulesByNormalizedLabel.set(rule.rawLabel.trim().toLowerCase(), rule);
  }
  return {
    activeVarietyByName: new Map([["Cadalora", { id: "variety-1", name: "Cadalora" }]]),
    activeVarietyById: new Map([["variety-1", { id: "variety-1", name: "Cadalora" }]]),
    sizeContext: { activeYieldSizeNameByCanonical, activeSizeNameById, rulesByNormalizedLabel },
    csvSettings: { ignoredSizeLabels: [], sizeAliases: {} },
    existingEntryKeySet: new Set(),
    alreadyImportedLots: new Set(),
  };
}

// A row exactly as the OLD (pre-fix) parser would have queued it: lot total
// repeated as every size's kg, BEGINDT unparsed, no ISO week, the stale
// "Start time not found" warning baked in — but WITH raw_payload.csv_text
// present, simulating that this row was queued after the raw-text-capture
// change but is being *reviewed* with the (now fixed) parser.
function staleRow(lotNumber: string, sourceFilename: string, csvText: string): PendingImportRow {
  return {
    id: `pending-${lotNumber}`,
    lot_number: lotNumber,
    variety_name: "Cadalora",
    source_filename: sourceFilename,
    start_time: null,
    iso_year: null,
    iso_week: null,
    average_fruit_weight_g: null,
    size_kg: {
      Small: 11118.075, Medium: 11118.075, Large: 11118.075,
      SXL: 11118.075, XL: 11118.075, XXL: 11118.075,
    },
    parsed_total_kg: 66708.45,
    warnings: [`Could not parse BEGINDT: "17082026".`, "Start time not found in CSV."],
    unknown_sizes: [],
    raw_payload: { csv_text: csvText },
    needs_template: false,
    data_source_type: "flowmaster",
    override_variety_id: null,
  };
}

const ACTIVE_SIZES = ["Small", "Medium", "Large", "SXL", "XL", "XXL"];

test("lot-2608170362.csv: buildPreviewFile re-derives the correct packed date, ISO week/year and per-size kg from a stale stored row once csv_text is available", () => {
  const row = staleRow("2608170362", "lot-2608170362.csv", LOT_362_CSV);
  const result = buildPreviewFile(row, fakeCtx(ACTIVE_SIZES));

  assert.strictEqual(result.startDate, "2026-08-17");
  assert.strictEqual(result.isoYear, 2026);
  assert.strictEqual(result.isoWeek, 34);

  assert.strictEqual(result.sizeBreakdown["Small"], 34.123);
  assert.strictEqual(result.sizeBreakdown["Medium"], 468.121);
  assert.strictEqual(result.sizeBreakdown["Large"], 1380.906);
  assert.strictEqual(result.sizeBreakdown["SXL"], 3257.101);
  assert.strictEqual(result.sizeBreakdown["XL"], 4489.312);
  assert.strictEqual(result.sizeBreakdown["XXL"], 353.205);

  const mappedTotal =
    result.sizeBreakdown["Small"] + result.sizeBreakdown["Medium"] + result.sizeBreakdown["Large"] +
    result.sizeBreakdown["SXL"] + result.sizeBreakdown["XL"] + result.sizeBreakdown["XXL"];
  assert.strictEqual(Math.round(mappedTotal * 1000) / 1000, 9982.768);

  // None of the sizes should equal the lot total (11118.075) — that was the
  // exact bug: every size showing the repeated second WEIGHT column.
  for (const size of ACTIVE_SIZES) {
    assert.notStrictEqual(result.sizeBreakdown[size], 11118.075);
  }
});

test("lot-2608170362.csv: no stale 'Start time not found' or 'Could not parse BEGINDT' warning once re-parsed", () => {
  const row = staleRow("2608170362", "lot-2608170362.csv", LOT_362_CSV);
  const result = buildPreviewFile(row, fakeCtx(ACTIVE_SIZES));

  assert.ok(!result.warnings.some((w) => w === "Start time not found in CSV."));
  assert.ok(!result.warnings.some((w) => w.startsWith("Could not parse BEGINDT")));
});

test("all three files (Aug 17/18/19) each retain their own distinct packed date and correct per-size totals while all landing in Week 34, 2026", () => {
  const files: Array<{ lot: string; filename: string; csv: string; expectedDate: string; expectedMappedTotal: number }> = [
    { lot: "2608170362", filename: "lot-2608170362.csv", csv: LOT_362_CSV, expectedDate: "2026-08-17", expectedMappedTotal: 9982.768 },
    { lot: "2608180363", filename: "lot-2608180363.csv", csv: LOT_363_CSV, expectedDate: "2026-08-18", expectedMappedTotal: 32.513 + 599.873 + 2334.673 + 5965.757 + 6639.618 + 558.544 },
    { lot: "2608190364", filename: "lot-2608190364.csv", csv: LOT_364_CSV, expectedDate: "2026-08-19", expectedMappedTotal: 9.437 + 283.177 + 847.496 + 1882.527 + 2270.658 + 80.897 },
  ];

  const results = files.map((f) => buildPreviewFile(staleRow(f.lot, f.filename, f.csv), fakeCtx(ACTIVE_SIZES)));

  results.forEach((result, i) => {
    const f = files[i];
    assert.strictEqual(result.startDate, f.expectedDate);
    assert.strictEqual(result.isoYear, 2026);
    assert.strictEqual(result.isoWeek, 34);

    const mappedTotal = ACTIVE_SIZES.reduce((sum, size) => sum + (result.sizeBreakdown[size] ?? 0), 0);
    assert.strictEqual(Math.round(mappedTotal * 1000) / 1000, Math.round(f.expectedMappedTotal * 1000) / 1000);
  });

  // Every file kept its own distinct date — none collapsed onto another.
  const uniqueDates = new Set(results.map((r) => r.startDate));
  assert.strictEqual(uniqueDates.size, 3);
});

test("MARKET Ignore rule for 'waste' resolves cleanly on re-parse with no contradictory 'New size found' warning left over", () => {
  const rules: SizeRuleRecord[] = [
    { id: "r1", rawLabel: "waste", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { id: "r2", rawLabel: "Green", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { id: "r3", rawLabel: "Doubles", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { id: "r4", rawLabel: "underweight", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { id: "r5", rawLabel: "24ct", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
  ];
  const row = staleRow("2608170362", "lot-2608170362.csv", LOT_362_CSV);
  const result = buildPreviewFile(row, fakeCtx(ACTIVE_SIZES, rules));

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.ok(!result.warnings.some((w) => w.startsWith("New size found:")));
  // Only the SM-XXL mapped kg remains — Green/Doubles/underweight/waste/24ct excluded.
  const total = Object.values(result.sizeBreakdown).reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.round(total * 1000) / 1000, 9982.768);
});

test("a row queued with NO raw_payload.csv_text (uploaded before raw-text capture existed) falls back to the stored columns without throwing", () => {
  const row: PendingImportRow = {
    ...staleRow("2608170362", "lot-2608170362.csv", LOT_362_CSV),
    raw_payload: {}, // no csv_text — original bytes genuinely unrecoverable
  };
  const result = buildPreviewFile(row, fakeCtx(ACTIVE_SIZES));

  // Falls back to whatever was stored — still wrong, but this documents the
  // known, unavoidable limitation for rows queued before this fix existed:
  // re-uploading the source file is the only way to correct them.
  assert.strictEqual(result.isoWeek, null);
  assert.strictEqual(result.sizeBreakdown["Small"], 11118.075);
});
