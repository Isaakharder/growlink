// Average fruit weight regression: the value shown in Source details, on
// the weekly card, in the import payload and in the saved yield entry must
// all be the same canonical figure (total mapped kg x 1000 / total pieces).
//
// Background: the "Latest Mapping" template (v9-v11) mapped AFW and Piece
// Count to columns 12/13 — the SECOND, lot-total WEIGHT/AVG/PCS group of a
// FlowMaster export — instead of 9/10. Source details showed the lot AVG
// (192.3 g) via a kg-weighted mean of AVG cells, while the card summed the
// lot PCS once per size row (6 x 2224) and showed 31.5 g. Offline: no DB.
import "./testHelpers/offlineSupabase";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvGrid } from "../../utils/csvGridParser";
import { normalizeCsvWithTemplate, type EngineContext } from "../../utils/csvTemplateEngine";
import { buildWeeklyCards, type PendingSourceEntry } from "../../utils/csvWeeklyCards";
import type { ColumnMapping, NormalizedPreview, TemplateConfig, ValueMapping } from "../../utils/csvTemplateTypes";
import { mergeAppendAverageFruitWeight, _internal_groupsMatch as groupsMatch } from "../csvMappingTemplates";

const FIXTURES_DIR = join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "flowmaster-csv");
// The real lot-2609220442.csv, byte-identical to the retained upload
// (its SHA-256 equals csv_import_source_files.file_hash).
const LOT_2609220442 = readFileSync(join(FIXTURES_DIR, "lot-2609220442.csv"), "utf-8");

const ORG = "org-1";
const SIZE_NAMES: Record<string, string> = { sm: "Small", md: "Medium", lg: "Large", sxl: "SXL", xl: "XL", xxl: "XXL" };
const CTX: EngineContext = { sizeNameById: new Map(Object.entries(SIZE_NAMES)), alreadyImportedLotNumbers: new Set() };
const VARIETIES = new Map([["0699", { id: "variety-0699", name: "0699", areaM2: 1000 }]]);

const VALUE_MAPPINGS: ValueMapping[] = [
  { sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "sm" },
  { sourceField: "size_label", rawValue: "MD", action: "map", targetSizeId: "md" },
  { sourceField: "size_label", rawValue: "LG", action: "map", targetSizeId: "lg" },
  { sourceField: "size_label", rawValue: "SXL", action: "map", targetSizeId: "sxl" },
  { sourceField: "size_label", rawValue: "XL", action: "map", targetSizeId: "xl" },
  { sourceField: "size_label", rawValue: "XXL", action: "map", targetSizeId: "xxl" },
  { sourceField: "size_label", rawValue: "underweight", action: "ignore" },
  { sourceField: "size_label", rawValue: "Doubles", action: "ignore" },
  { sourceField: "size_label", rawValue: "{undersized}", action: "ignore" },
  { sourceField: "size_label", rawValue: "{oversized}", action: "ignore" }
];

function config(afwColumn: number, pcsColumn: number, extra: Partial<TemplateConfig> = {}): TemplateConfig {
  // Same column layout as the saved "Latest Mapping" v11, parameterised on
  // which AVG/PCS columns are mapped.
  const columnMappings: ColumnMapping[] = [
    { columnIndex: 2, field: "variety" },
    { columnIndex: 3, field: "packed_date", dateFormat: "DDMMYYYY" },
    { columnIndex: 0, field: "lot_number" },
    { columnIndex: 6, field: "size_label" },
    { columnIndex: 8, field: "size_weight_kg" },
    { columnIndex: afwColumn, field: "average_fruit_weight_g" },
    { columnIndex: 1, field: "run_number" },
    { columnIndex: pcsColumn, field: "piece_count" }
  ];
  return {
    delimiter: ",",
    encoding: "utf-8",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings,
    fixedCellMappings: [],
    valueMappings: VALUE_MAPPINGS,
    rules: [],
    ...extra
  };
}

function runGrid(grid: string[][], cfg: TemplateConfig): NormalizedPreview {
  return normalizeCsvWithTemplate(grid, cfg, CTX);
}

function entry(id: string, preview: NormalizedPreview): PendingSourceEntry {
  return {
    pendingImportId: `pending-${id}`,
    sourceFileId: `source-${id}`,
    sourceFilename: `lot-${id}.csv`,
    uploadedAt: "2026-09-26T10:43:50Z",
    templateId: "tpl",
    templateName: "Latest Mapping",
    templateVersion: 12,
    layoutMismatch: false,
    preview
  };
}

const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** A minimal single-source grid whose canonical AFW is exactly 192.3 g. */
function grid192(): string[][] {
  return [
    ["LOTNUMBER", "RUN", "VARIETY", "BEGINDT", "ENDDT", "MARKET", "SIZE1", "SIZE2", "WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS"],
    // 19.23 kg / 100 pcs and 38.46 kg / 200 pcs -> 57.69 kg x 1000 / 300 = 192.3 g
    ["2609990001", "1", "0699", "22092026", "22092026", "Class 1", "LG", "null", "19.230", "192.3", "100", "60.000", "190.0", "316"],
    ["2609990001", "1", "0699", "22092026", "22092026", "Class 1", "XL", "null", "38.460", "192.3", "200", "60.000", "190.0", "316"],
    ["2609990001", "1", "0699", "22092026", "22092026", "waste", "{oversized}", "null", "2.310", "440.0", "16", "60.000", "190.0", "316"]
  ];
}

// ---------------------------------------------------------------------------
// 1. One source with AFW 192.3 produces 192.3 everywhere
// ---------------------------------------------------------------------------

test("one source with AFW 192.3 g shows 192.3 in source details, the weekly card, the import payload and the saved entry", () => {
  const preview = runGrid(grid192(), config(9, 10));
  assert.equal(preview.groups.length, 1);
  const group = preview.groups[0];

  // Preview group (what the client sends back as approvedGroup).
  assert.equal(round1(group.averageFruitWeightG), 192.3);

  const [card] = buildWeeklyCards(ORG, [entry("1", preview)], VARIETIES);
  // Source details row and pending summary card.
  assert.equal(round1(card.sources[0].averageFruitWeightG), 192.3);
  assert.equal(round1(card.combinedAverageFruitWeightG), 192.3);

  // Import payload: approvedGroup carries 192.3 and matches a fresh re-parse.
  const fresh = runGrid(grid192(), config(9, 10)).groups[0];
  assert.equal(groupsMatch(fresh, group), true);

  // Saved yield entry: create writes group.averageFruitWeightG; append into
  // an entry with no AFW yet writes the same value.
  assert.equal(round1(fresh.averageFruitWeightG), 192.3);
  assert.equal(round1(mergeAppendAverageFruitWeight(0, null, fresh.averageFruitWeightBasis)), 192.3);
});

test("the real lot-2609220442 with the per-size AVG/PCS group: source details, card and saved AFW agree (192.6 g)", () => {
  const grid = parseCsvGrid(LOT_2609220442, ",").rows;
  const preview = runGrid(grid, config(9, 10));
  const group = preview.groups[0];

  // SM-XXL: 420.948 kg over 2186 pcs.
  assert.equal(group.reconciliation.recognizedSizeKg, 420.95);
  assert.equal(Math.round((group.averageFruitWeightBasis?.kg ?? 0) * 1000) / 1000, 420.948);
  assert.equal(group.averageFruitWeightBasis?.pieces, 2186);
  assert.equal(round1(group.averageFruitWeightG), 192.6);

  const [card] = buildWeeklyCards(ORG, [entry("2609220442", preview)], VARIETIES);
  assert.equal(round1(card.sources[0].averageFruitWeightG), 192.6);
  assert.equal(round1(card.combinedAverageFruitWeightG), 192.6);
  assert.equal(card.canImport, true);
});

// ---------------------------------------------------------------------------
// 2. Duplicate WEIGHT/AVG/PCS headers do not select the wrong group
// ---------------------------------------------------------------------------

test("duplicate headers: the lot-total AVG/PCS group (the live Latest Mapping v11 layout) never yields 31.5 g — it blocks with an explanation", () => {
  const grid = parseCsvGrid(LOT_2609220442, ",").rows;
  const preview = runGrid(grid, config(12, 13));
  const group = preview.groups[0];

  // Before this fix: source details 192.3 (lot AVG), card 31.5 (6 x 2224 pcs).
  assert.equal(group.averageFruitWeightG, null);
  assert.equal(group.averageFruitWeightBasis, null);
  const issue = preview.validationIssues.find((i) => i.code === "possible_lot_total_fruit_column");
  assert.ok(issue, "expected a lot-total column issue");
  assert.match(issue.message, /Piece Count/);
  assert.match(issue.message, /2224/);
  assert.equal(preview.canImport, false);

  const [card] = buildWeeklyCards(ORG, [entry("2609220442", preview)], VARIETIES);
  assert.equal(card.combinedAverageFruitWeightG, null);
  assert.equal(card.sources[0].averageFruitWeightG, null);
  assert.equal(card.canImport, false);

  // kg is unaffected by the AFW columns.
  assert.equal(group.reconciliation.recognizedSizeKg, 420.95);
});

test("duplicate headers: per-size values are read from the mapped first group; second-group values never leak into rows", () => {
  const grid = parseCsvGrid(LOT_2609220442, ",").rows;
  const group = runGrid(grid, config(9, 10)).groups[0];
  const xl = group.rows.find((r) => r.sizeLabelRaw === "XL");
  assert.equal(xl?.sizeWeightKg, 222.494);
  assert.equal(xl?.averageFruitWeightG, 220.3);
  assert.equal(xl?.pieceCount, 1010);
  for (const row of group.rows) {
    assert.notEqual(row.pieceCount, 2224);
    assert.notEqual(row.sizeWeightKg, 427.618);
  }
});

test("duplicate headers: a lot-total AVG used as the fallback (PCS unmapped) is also caught", () => {
  const grid = parseCsvGrid(LOT_2609220442, ",").rows;
  const cfg = config(12, 10);
  cfg.columnMappings = cfg.columnMappings.filter((m) => m.field !== "piece_count");
  const preview = runGrid(grid, cfg);
  assert.equal(preview.groups[0].averageFruitWeightG, null);
  const issue = preview.validationIssues.find((i) => i.code === "possible_lot_total_fruit_column");
  assert.match(issue?.message ?? "", /Average Fruit Weight g/);
});

test("duplicate headers: a lot-total AVG is harmless when a valid per-size PCS provides every row's pieces", () => {
  const grid = parseCsvGrid(LOT_2609220442, ",").rows;
  const preview = runGrid(grid, config(12, 10));
  assert.equal(round1(preview.groups[0].averageFruitWeightG), 192.6);
  assert.ok(!preview.validationIssues.some((i) => i.code === "possible_lot_total_fruit_column"));
});

// ---------------------------------------------------------------------------
// 3. Multiple valid rows/files aggregate by the canonical rule
// ---------------------------------------------------------------------------

test("multiple rows: AFW is total kg x 1000 / total pieces, not a simple or kg-weighted mean of AVG cells", () => {
  const grid = [
    grid192()[0],
    // 10 kg / 100 pcs (100 g) and 30 kg / 150 pcs (200 g)
    ["2609990002", "1", "0699", "22092026", "22092026", "Class 1", "LG", "null", "10.000", "100.0", "100", "40.000", "160.0", "250"],
    ["2609990002", "1", "0699", "22092026", "22092026", "Class 1", "XL", "null", "30.000", "200.0", "150", "40.000", "160.0", "250"]
  ];
  const group = runGrid(grid, config(9, 10)).groups[0];
  // Canonical: 40 kg x 1000 / 250 = 160 g. Simple mean would be 150 g,
  // kg-weighted mean of AVG would be 175 g.
  assert.equal(group.averageFruitWeightG, 160);
});

test("multiple files: the weekly card AFW is PCS-weighted across sources, matching a single combined calculation", () => {
  const a = runGrid(grid192(), config(9, 10)); // 57.69 kg / 300 pcs
  const bGrid = [
    grid192()[0],
    ["2609990003", "1", "0699", "23092026", "23092026", "Class 1", "LG", "null", "15.000", "150.0", "100", "15.000", "150.0", "100"]
  ];
  const b = runGrid(bGrid, config(9, 10)); // 15 kg / 100 pcs

  const cards = buildWeeklyCards(ORG, [entry("a", a), entry("b", b)], VARIETIES);
  assert.equal(cards.length, 1);
  const expected = ((57.69 + 15) * 1000) / (300 + 100);
  assert.ok(Math.abs((cards[0].combinedAverageFruitWeightG ?? 0) - expected) < 1e-9);
  // Not the mean of the two sources' AFWs (192.3 and 150).
  assert.notEqual(round1(cards[0].combinedAverageFruitWeightG), round1((192.3 + 150) / 2));
});

test("appending a second import into the same entry merges AFW by pieces, not by overwriting with the last source", () => {
  const a = runGrid(grid192(), config(9, 10)).groups[0]; // 57.69 kg / 300 pcs
  const afterFirst = mergeAppendAverageFruitWeight(0, null, a.averageFruitWeightBasis);
  const afterSecond = mergeAppendAverageFruitWeight(57.69, afterFirst, { kg: 15, pieces: 100 });
  const expected = ((57.69 + 15) * 1000) / 400;
  assert.ok(Math.abs((afterSecond ?? 0) - expected) < 1e-9);
});

test("append merge keeps the existing AFW when the incoming group has none, and ignores an existing entry without one", () => {
  assert.equal(mergeAppendAverageFruitWeight(100, 180, null), 180);
  assert.equal(mergeAppendAverageFruitWeight(100, null, { kg: 15, pieces: 100 }), 150);
  assert.equal(mergeAppendAverageFruitWeight(0, null, null), null);
});

// ---------------------------------------------------------------------------
// 4. Missing or invalid PCS never silently produces a misleading AFW
// ---------------------------------------------------------------------------

test("missing PCS on a weighted row with no AVG fallback gives no AFW rather than a partial one", () => {
  const grid = [
    grid192()[0],
    ["2609990004", "1", "0699", "22092026", "22092026", "Class 1", "LG", "null", "10.000", "", "100", "", "", ""],
    ["2609990004", "1", "0699", "22092026", "22092026", "Class 1", "XL", "null", "30.000", "", "", "", "", ""]
  ];
  const group = runGrid(grid, config(9, 10)).groups[0];
  assert.equal(group.averageFruitWeightG, null);
  assert.equal(group.averageFruitWeightBasis, null);

  const [card] = buildWeeklyCards(ORG, [entry("4", runGrid(grid, config(9, 10)))], VARIETIES);
  assert.equal(card.combinedAverageFruitWeightG, null);
});

test("zero PCS falls back to the row's own AVG (kg x 1000 / AVG pieces), matching the FlowMaster parser", () => {
  const grid = [
    grid192()[0],
    ["2609990005", "1", "0699", "22092026", "22092026", "Class 1", "LG", "null", "10.000", "100.0", "100", "", "", ""],
    ["2609990005", "1", "0699", "22092026", "22092026", "Class 1", "XL", "null", "30.000", "200.0", "0", "", "", ""]
  ];
  const group = runGrid(grid, config(9, 10)).groups[0];
  // 100 pcs + 30000/200 = 150 pcs -> 40 kg x 1000 / 250 = 160 g
  assert.equal(group.averageFruitWeightG, 160);
});

test("unparseable PCS is a blocking parse error and never counted as pieces", () => {
  const grid = [
    grid192()[0],
    ["2609990006", "1", "0699", "22092026", "22092026", "Class 1", "LG", "null", "10.000", "", "abc", "", "", ""]
  ];
  const preview = runGrid(grid, config(9, 10));
  assert.equal(preview.groups[0].averageFruitWeightG, null);
  assert.ok(preview.validationIssues.some((i) => i.code === "invalid_numeric_value"));
  assert.equal(preview.canImport, false);
});

test("a template with no AVG/PCS mapped at all has no AFW (null, not 0)", () => {
  const cfg = config(9, 10);
  cfg.columnMappings = cfg.columnMappings.filter((m) => m.field !== "piece_count" && m.field !== "average_fruit_weight_g");
  const preview = runGrid(grid192(), cfg);
  assert.equal(preview.groups[0].averageFruitWeightG, null);
  assert.equal(preview.canImport, true);
});

// ---------------------------------------------------------------------------
// Import payload integrity
// ---------------------------------------------------------------------------

test("an approved group whose AFW differs from the fresh re-parse is rejected as stale", () => {
  const fresh = runGrid(grid192(), config(9, 10)).groups[0];
  assert.equal(groupsMatch(fresh, { ...fresh, averageFruitWeightG: 31.5 }), false);
  assert.equal(groupsMatch(fresh, { ...fresh, averageFruitWeightG: null }), false);
  assert.equal(groupsMatch(fresh, { ...fresh }), true);
});

// ---------------------------------------------------------------------------
// 9. Existing templates and pending imports remain compatible
// ---------------------------------------------------------------------------

test("existing template configs load unchanged: kg totals are identical, only the AFW figure changes", () => {
  const grid = parseCsvGrid(LOT_2609220442, ",").rows;
  const legacy = runGrid(grid, config(12, 13)).groups[0];
  const corrected = runGrid(grid, config(9, 10)).groups[0];
  assert.deepEqual(legacy.sizeKg, corrected.sizeKg);
  assert.deepEqual(legacy.reconciliation, corrected.reconciliation);
});

test("an approved group from an older client (no averageFruitWeightBasis field) is still accepted when its AFW matches", () => {
  const fresh = runGrid(grid192(), config(9, 10)).groups[0];
  const { averageFruitWeightBasis: _omit, ...olderShape } = fresh;
  assert.equal(groupsMatch(fresh, olderShape as typeof fresh), true);
});
