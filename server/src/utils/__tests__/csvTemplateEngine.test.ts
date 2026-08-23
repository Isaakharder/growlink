import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCsvWithTemplate,
  validateNormalizedPreview,
  parseDateValue,
  parseNumberValue,
  distributeKgAcrossSizes,
  getIsoWeekYear,
  type EngineContext
} from "../csvTemplateEngine";
import type {
  ColumnMapping,
  FixedCellMapping,
  TemplateConfig,
  ValueMapping,
  ConditionalRowRule
} from "../csvTemplateTypes";

function baseLayout(overrides: Partial<TemplateConfig> = {}): TemplateConfig {
  return {
    delimiter: ",",
    encoding: "utf-8",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings: [],
    fixedCellMappings: [],
    valueMappings: [],
    rules: [],
    ...overrides
  };
}

function ctx(sizeNames: Record<string, string> = {}, alreadyImported: string[] = []): EngineContext {
  return {
    sizeNameById: new Map(Object.entries(sizeNames)),
    alreadyImportedLotNumbers: new Set(alreadyImported)
  };
}

// ---------------------------------------------------------------------------
// FlowMaster-shaped fixture — the real lot 2608170362 (Aug 17 2026,
// Cadalora) shape used by flowMasterCsvParser.test.ts, exercised here
// through the NEW generic engine to prove structural parity: SM-XXL must
// still total exactly 9982.768 kg, MARKET must still outrank a direct
// SIZE1 code, and the second (lot-total) WEIGHT/AVG/PCS columns must never
// be used as a row's own values.
// ---------------------------------------------------------------------------

const FM_HEADER = ["LOTNUMBER", "RUN", "VARIETY", "BEGINDT", "ENDDT", "MARKET", "SIZE1", "SIZE2", "WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS"];

const FM_ROWS = [
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "24ct", "All Weight", "null", "0.000", "0.0", "0", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Green", "All Weight", "null", "943.702", "171.0", "5519", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "underweight", "null", "0.562", "62.4", "9", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "SM", "null", "34.123", "91.2", "374", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "MD", "null", "468.121", "120.1", "3899", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "LG", "null", "1380.906", "143.7", "9611", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "SXL", "null", "3257.101", "166.3", "19585", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "XL", "null", "4489.312", "194.1", "23124", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "XXL", "null", "353.205", "230.4", "1533", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "Doubles", "All Weight", "null", "191.043", "150.7", "1268", "11118.075", "171.3", "64922"],
  ["2608170362", "1", "Cadalora", "17082026", "18082026", "waste", "{oversized}", "null", "2.916", "416.6", "7", "11118.075", "171.3", "64922"]
];

function fmGrid(): string[][] {
  return [FM_HEADER, ...FM_ROWS];
}

const FM_COLUMN_MAPPINGS: ColumnMapping[] = [
  { columnIndex: 0, field: "lot_number" },
  { columnIndex: 1, field: "run_number" },
  { columnIndex: 2, field: "variety" },
  { columnIndex: 3, field: "packed_date", dateFormat: "DDMMYYYY" },
  { columnIndex: 5, field: "market_grade" },
  { columnIndex: 6, field: "size_label" },
  { columnIndex: 8, field: "size_weight_kg" },
  { columnIndex: 9, field: "average_fruit_weight_g" },
  { columnIndex: 10, field: "piece_count" }
  // columns 11/12/13 (the second WEIGHT/AVG/PCS — lot-level totals) are
  // deliberately left unmapped, matching the real FlowMaster template.
];

const FM_SIZE_IDS = { small: "size-sm", medium: "size-md", large: "size-lg", sxl: "size-sxl", xl: "size-xl", xxl: "size-xxl" };
const FM_SIZE_ID_TO_NAME: Record<string, string> = {
  "size-sm": "Small",
  "size-md": "Medium",
  "size-lg": "Large",
  "size-sxl": "SXL",
  "size-xl": "XL",
  "size-xxl": "XXL"
};

const FM_VALUE_MAPPINGS: ValueMapping[] = [
  { sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: FM_SIZE_IDS.small },
  { sourceField: "size_label", rawValue: "MD", action: "map", targetSizeId: FM_SIZE_IDS.medium },
  { sourceField: "size_label", rawValue: "LG", action: "map", targetSizeId: FM_SIZE_IDS.large },
  { sourceField: "size_label", rawValue: "SXL", action: "map", targetSizeId: FM_SIZE_IDS.sxl },
  { sourceField: "size_label", rawValue: "XL", action: "map", targetSizeId: FM_SIZE_IDS.xl },
  { sourceField: "size_label", rawValue: "XXL", action: "map", targetSizeId: FM_SIZE_IDS.xxl }
];

const DISTRIBUTE_ALL_SIZES = [FM_SIZE_IDS.small, FM_SIZE_IDS.medium, FM_SIZE_IDS.large, FM_SIZE_IDS.sxl, FM_SIZE_IDS.xl, FM_SIZE_IDS.xxl];

const FM_RULES: ConditionalRowRule[] = [
  { id: "r-24ct", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "24ct" }], action: "distribute", distributeSizeIds: DISTRIBUTE_ALL_SIZES },
  { id: "r-green-allweight", priority: 2, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "Green" }, { field: "size_label", operator: "equals", value: "All Weight" }], action: "ignore" },
  { id: "r-doubles", priority: 3, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "Doubles" }], action: "ignore" },
  { id: "r-waste", priority: 4, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "waste" }], action: "ignore" },
  { id: "r-underweight", priority: 5, conditionLogic: "AND", conditions: [{ field: "size_label", operator: "equals", value: "underweight" }], action: "ignore" }
];

function fmTemplate(): TemplateConfig {
  return baseLayout({
    columnMappings: FM_COLUMN_MAPPINGS,
    valueMappings: FM_VALUE_MAPPINGS,
    rules: FM_RULES
  });
}

test("FlowMaster-shaped fixture: SM-XXL totals exactly 9982.768 kg, matching the pinned parser's verified total", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  assert.equal(preview.groups.length, 1);

  const group = preview.groups[0];
  // Class 1 SM+MD+LG+SXL+XL+XXL = 34.123+468.121+1380.906+3257.101+4489.312+353.205 = 9982.768 kg.
  assert.equal(group.reconciliation.directMappedKg, 9982.77 /* rounded to 2dp by the engine */);
});

test("FlowMaster-shaped fixture: the second (lot-total) WEIGHT column is never used as a row's size weight", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];

  // 11118.075 is the repeated lot-total figure in column 11 (unmapped). If
  // it ever leaked into a row's sizeWeightKg, rawRowWeightKg would be some
  // multiple of it — instead every row uses its own column-8 value.
  assert.notEqual(group.reconciliation.rawRowWeightKg, 11118.08);
  for (const row of group.rows) {
    assert.notEqual(row.sizeWeightKg, 11118.075);
  }
});

test("FlowMaster-shaped fixture: MARKET rules outrank a direct SIZE1 code (Green+All Weight ignored, not folded into a size)", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];
  const greenRow = group.rows.find((r) => r.marketGradeRaw === "Green");
  assert.equal(greenRow?.action, "ignored");
  assert.equal(greenRow?.matchedRuleId, "r-green-allweight");
});

test("FlowMaster-shaped fixture: waste+{oversized} is ignored via the MARKET rule, not misread as a real size", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];
  const wasteRow = group.rows.find((r) => r.sizeLabelRaw === "{oversized}");
  assert.equal(wasteRow?.action, "ignored");
  assert.ok(!group.unresolvedSizeLabels.includes("{oversized}"));
});

test("FlowMaster-shaped fixture: BEGINDT (DDMMYYYY) is the authoritative packed date, and derives year/week", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];
  assert.equal(group.packedDate, "2026-08-17");
  const derived = getIsoWeekYear("2026-08-17");
  assert.equal(group.isoYear, derived?.isoYear);
  assert.equal(group.isoWeek, derived?.isoWeek);
});

test("FlowMaster-shaped fixture: AFW is calculated from included kg and pieces, excluding ignored/subtotal rows", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];

  // kg-weighted average of AVG (col 9) over every "included" row only.
  const includedRows = group.rows.filter((r) => r.action === "included");
  let numerator = 0;
  let denominator = 0;
  for (const r of includedRows) {
    if (r.averageFruitWeightG !== null && r.sizeWeightKg !== null && r.sizeWeightKg > 0) {
      numerator += r.averageFruitWeightG * r.sizeWeightKg;
      denominator += r.sizeWeightKg;
    }
  }
  const expected = numerator / denominator;
  assert.ok(Math.abs((group.averageFruitWeightG ?? 0) - expected) < 1e-9);
});

test("FlowMaster-shaped fixture: distributing the 24ct row (0 kg) across all sizes never errors and adds zero everywhere", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];
  // directMappedKg (9982.77) plus distributedKg (0, since the 24ct row is 0kg) should equal recognizedSizeKg.
  assert.equal(group.reconciliation.distributedKg, 0);
  assert.equal(group.reconciliation.recognizedSizeKg, group.reconciliation.directMappedKg);
});

test("FlowMaster-shaped fixture: duplicate header positions are distinguished — mapping column 6 (first-position size label) resolves correctly even though the header text alone is ambiguous with nothing at position 11-13", () => {
  const preview = normalizeCsvWithTemplate(fmGrid(), fmTemplate(), ctx(FM_SIZE_ID_TO_NAME));
  const group = preview.groups[0];
  const smRow = group.rows.find((r) => r.sizeLabelRaw === "SM");
  assert.equal(smRow?.resolvedSizeName, "Small");
  assert.equal(smRow?.sizeWeightKg, 34.123);
});

// ---------------------------------------------------------------------------
// Column mapping / fixed-cell mapping / header & data-row selection
// ---------------------------------------------------------------------------

test("column mapping: a column's values flow into the mapped field for every row", () => {
  const grid = [
    ["Size", "Kg"],
    ["Small", "10"],
    ["Large", "20"]
  ];
  const template = baseLayout({
    columnMappings: [
      { columnIndex: 0, field: "size_label" },
      { columnIndex: 1, field: "size_weight_kg" }
    ],
    valueMappings: [
      { sourceField: "size_label", rawValue: "Small", action: "map", targetSizeId: "s1" },
      { sourceField: "size_label", rawValue: "Large", action: "map", targetSizeId: "s2" }
    ]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small", s2: "Large" }));
  assert.equal(preview.groups.length, 1);
  assert.equal(preview.groups[0].sizeKg["Small"], 10);
  assert.equal(preview.groups[0].sizeKg["Large"], 20);
});

test("fixed-cell mapping: a single cell's value applies to every data row (report-style CSV)", () => {
  // Variety/date appear once above the table, not repeated per row.
  const grid = [
    ["Variety:", "Cadalora"],
    ["Date:", "15082026"],
    ["Size", "Kg"],
    ["SM", "5"],
    ["MD", "7"]
  ];
  const template = baseLayout({
    headerRowIndex: 2,
    dataStartRowIndex: 3,
    columnMappings: [
      { columnIndex: 0, field: "size_label" },
      { columnIndex: 1, field: "size_weight_kg" }
    ],
    fixedCellMappings: [
      { rowIndex: 0, columnIndex: 1, field: "variety" },
      { rowIndex: 1, columnIndex: 1, field: "packed_date", dateFormat: "DDMMYYYY" }
    ],
    valueMappings: [
      { sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" },
      { sourceField: "size_label", rawValue: "MD", action: "map", targetSizeId: "s2" }
    ]
  });

  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small", s2: "Medium" }));
  assert.equal(preview.groups.length, 1);
  assert.equal(preview.groups[0].varietyRaw, "Cadalora");
  assert.equal(preview.groups[0].packedDate, "2026-08-15");
  assert.equal(preview.groups[0].sizeKg["Small"], 5);
  assert.equal(preview.groups[0].sizeKg["Medium"], 7);
});

test("header-row selection: the configured header row is always excluded from data rows, even mid-file", () => {
  const grid = [
    ["Junk export title"],
    ["Size", "Kg"],
    ["SM", "5"]
  ];
  const template = baseLayout({
    headerRowIndex: 1,
    dataStartRowIndex: 2,
    columnMappings: [
      { columnIndex: 0, field: "size_label" },
      { columnIndex: 1, field: "size_weight_kg" }
    ],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small" }));
  assert.equal(preview.groups[0].sizeKg["Small"], 5);
  // The header row's own cells ("Size"/"Kg") must never appear as a data row.
  assert.ok(!preview.groups.some((g) => g.rows.some((r) => r.sizeLabelRaw === "Size")));
});

test("data-start-row selection: rows before dataStartRowIndex are excluded even if they look like data", () => {
  const grid = [
    ["Size", "Kg"],
    ["SM", "999"], // looks like data but is BEFORE dataStartRowIndex — must be excluded
    ["MD", "7"]
  ];
  const template = baseLayout({
    headerRowIndex: 0,
    dataStartRowIndex: 2,
    columnMappings: [
      { columnIndex: 0, field: "size_label" },
      { columnIndex: 1, field: "size_weight_kg" }
    ],
    valueMappings: [
      { sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" },
      { sourceField: "size_label", rawValue: "MD", action: "map", targetSizeId: "s2" }
    ]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small", s2: "Medium" }));
  assert.equal(preview.groups[0].sizeKg["Small"], undefined);
  assert.equal(preview.groups[0].sizeKg["Medium"], 7);
});

// ---------------------------------------------------------------------------
// Packed-date parsing — every supported configured format.
// ---------------------------------------------------------------------------

test("parseDateValue: every supported named format parses 5 August 2026 correctly", () => {
  assert.equal(parseDateValue("05082026", "DDMMYYYY"), "2026-08-05");
  assert.equal(parseDateValue("20260805", "YYYYMMDD"), "2026-08-05");
  assert.equal(parseDateValue("08052026", "MMDDYYYY"), "2026-08-05");
  assert.equal(parseDateValue("2026-08-05", "YYYY-MM-DD"), "2026-08-05");
  assert.equal(parseDateValue("05/08/2026", "DD/MM/YYYY"), "2026-08-05");
  assert.equal(parseDateValue("08/05/2026", "MM/DD/YYYY"), "2026-08-05");
});

test("parseDateValue: CUSTOM format uses an explicit safe D/M/Y token pattern, not eval/regex-from-string", () => {
  assert.equal(parseDateValue("05.08.2026", "CUSTOM", "DD.MM.YYYY"), "2026-08-05");
  assert.equal(parseDateValue("2026.08.05", "CUSTOM", "YYYY.MM.DD"), "2026-08-05");
});

test("parseDateValue rejects impossible calendar dates and mismatched-length input", () => {
  assert.equal(parseDateValue("31022026", "DDMMYYYY"), null); // Feb 31 doesn't exist
  assert.equal(parseDateValue("2026-08", "YYYY-MM-DD"), null); // too short
  assert.equal(parseDateValue("", "DDMMYYYY"), null);
});

test("getIsoWeekYear computes ISO 8601 week/year, including a year-boundary case", () => {
  assert.deepEqual(getIsoWeekYear("2026-08-17"), { isoYear: 2026, isoWeek: 34 });
  // 2025-12-29 is a Monday in ISO week 1 of 2026 by the ISO 8601 rule.
  assert.deepEqual(getIsoWeekYear("2025-12-29"), { isoYear: 2026, isoWeek: 1 });
});

// ---------------------------------------------------------------------------
// Numeric separator handling
// ---------------------------------------------------------------------------

test("parseNumberValue: European format (comma decimal, dot thousands)", () => {
  const result = parseNumberValue("1.234,56", { decimalSeparator: ",", thousandsSeparator: ".", blankHandling: "zero" });
  assert.equal(result.value, 1234.56);
  assert.equal(result.error, null);
});

test("parseNumberValue: US format (dot decimal, comma thousands)", () => {
  const result = parseNumberValue("1,234.56", { decimalSeparator: ".", thousandsSeparator: ",", blankHandling: "zero" });
  assert.equal(result.value, 1234.56);
});

test("parseNumberValue: unit conversion factor (lbs -> kg)", () => {
  const result = parseNumberValue("10", { decimalSeparator: ".", thousandsSeparator: "", unitConversionFactor: 0.45359237, blankHandling: "zero" });
  assert.ok(Math.abs((result.value ?? 0) - 4.5359237) < 1e-9);
});

test("parseNumberValue: blank handling — zero/skip/error", () => {
  assert.equal(parseNumberValue("", { decimalSeparator: ".", thousandsSeparator: "", blankHandling: "zero" }).value, 0);
  assert.equal(parseNumberValue("", { decimalSeparator: ".", thousandsSeparator: "", blankHandling: "skip" }).value, null);
  const errored = parseNumberValue("", { decimalSeparator: ".", thousandsSeparator: "", blankHandling: "error" });
  assert.equal(errored.value, null);
  assert.ok(errored.error);
});

test("parseNumberValue: unparseable text produces an error, not a silent zero", () => {
  const result = parseNumberValue("N/A", { decimalSeparator: ".", thousandsSeparator: "", blankHandling: "zero" });
  assert.equal(result.value, null);
  assert.ok(result.error?.includes("N/A"));
});

// ---------------------------------------------------------------------------
// Direct size mapping / conditional rules / ignore / subtotal / distribute
// ---------------------------------------------------------------------------

function sizeGrid(rows: Array<[string, string, string]>): string[][] {
  return [["Market", "Size", "Kg"], ...rows];
}

function sizeTemplate(extra: Partial<TemplateConfig> = {}): TemplateConfig {
  return baseLayout({
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" }
    ],
    ...extra
  });
}

test("direct size mapping: an unqualified value_mapping resolves a row to a real size", () => {
  const grid = sizeGrid([["Class 1", "SM", "10"]]);
  const template = sizeTemplate({
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small" }));
  assert.equal(preview.groups[0].sizeKg["Small"], 10);
});

test("conditional multi-field rule (AND): MARKET=Class 1 AND SIZE1=XL maps to XL, but MARKET=Green AND SIZE1=XL does not", () => {
  const grid = sizeGrid([
    ["Class 1", "XL", "10"],
    ["Green", "XL", "5"]
  ]);
  const template = sizeTemplate({
    rules: [{ id: "r1", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "Class 1" }, { field: "size_label", operator: "equals", value: "XL" }], action: "map_to_size", targetSizeId: "s1" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "XL" }));
  const group = preview.groups[0];
  const class1Row = group.rows.find((r) => r.marketGradeRaw === "Class 1");
  const greenRow = group.rows.find((r) => r.marketGradeRaw === "Green");
  assert.equal(class1Row?.action, "included");
  assert.equal(class1Row?.resolvedSizeName, "XL");
  assert.equal(greenRow?.action, "unresolved");
});

test("conditional rule with OR logic matches if either condition is true", () => {
  const grid = sizeGrid([
    ["Doubles", "SM", "3"],
    ["Class 1", "REPACK", "4"]
  ]);
  const template = sizeTemplate({
    rules: [{ id: "r1", priority: 1, conditionLogic: "OR", conditions: [{ field: "market_grade", operator: "equals", value: "Doubles" }, { field: "size_label", operator: "equals", value: "REPACK" }], action: "ignore" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx());
  const group = preview.groups[0];
  assert.ok(group.rows.every((r) => r.action === "ignored"));
});

test("ignore rule: matching rows contribute to ignoredKg, not recognizedSizeKg", () => {
  const grid = sizeGrid([["waste", "junk", "8"]]);
  const template = sizeTemplate({
    rules: [{ id: "r1", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "waste" }], action: "ignore" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx());
  assert.equal(preview.groups[0].reconciliation.ignoredKg, 8);
  assert.equal(preview.groups[0].reconciliation.recognizedSizeKg, 0);
});

test("subtotal exclusion: a row treated as a subtotal never contributes to recognizedSizeKg or rawRowWeightKg", () => {
  const grid = sizeGrid([
    ["Class 1", "SM", "10"],
    ["Class 1", "MD", "15"],
    ["Class 1", "TOTAL", "25"] // subtotal row — same kg as its components, must not double count
  ]);
  const template = sizeTemplate({
    valueMappings: [
      { sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" },
      { sourceField: "size_label", rawValue: "MD", action: "map", targetSizeId: "s2" },
      { sourceField: "size_label", rawValue: "TOTAL", action: "subtotal" }
    ]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small", s2: "Medium" }));
  const group = preview.groups[0];
  assert.equal(group.reconciliation.recognizedSizeKg, 25); // 10 + 15, NOT 50
  assert.equal(group.reconciliation.subtotalKg, 25);
  assert.equal(group.reconciliation.rawRowWeightKg, 25); // subtotal excluded here too
});

test("reconciliation catches double counting: a subtotal row present alongside its full components does not inflate the final imported kg", () => {
  const grid = [
    ["Market", "Size", "Kg", "LotTotal", "Variety", "Date"],
    ["Class 1", "SM", "10", "25", "Cadalora", "15082026"],
    ["Class 1", "MD", "15", "25", "Cadalora", "15082026"],
    ["Class 1", "TOTAL", "25", "25", "Cadalora", "15082026"]
  ];
  const template = baseLayout({
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" },
      { columnIndex: 3, field: "total_lot_weight" },
      { columnIndex: 4, field: "variety" },
      { columnIndex: 5, field: "packed_date", dateFormat: "DDMMYYYY" }
    ],
    valueMappings: [
      { sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" },
      { sourceField: "size_label", rawValue: "MD", action: "map", targetSizeId: "s2" },
      { sourceField: "size_label", rawValue: "TOTAL", action: "subtotal" }
    ]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small", s2: "Medium" }));
  const group = preview.groups[0];
  assert.equal(group.reconciliation.recognizedSizeKg, 25);
  assert.equal(group.reconciliation.lotTotalKg, 25);
  assert.equal(group.reconciliation.difference, 0);
  assert.equal(group.reconciliation.unexplainedDifference, false);
  assert.equal(preview.canImport, true);
});

test("distribution preserves the exact source total with the rounding residual on the last destination", () => {
  const shares = distributeKgAcrossSizes(10, ["Small", "Medium", "Large"], {});
  const sum = Object.values(shares).reduce((a, b) => a + b, 0);
  assert.equal(sum, 10);
  assert.deepEqual(shares, { Small: 3.33, Medium: 3.33, Large: 3.34 });
});

test("distribution weights by the current accumulated kg for each destination when weights exist", () => {
  const shares = distributeKgAcrossSizes(30, ["Small", "Large"], { Small: 10, Large: 30 });
  // Small:Large weight ratio is 1:3 -> 7.5/22.5, rounded with residual on the last.
  assert.equal(shares.Small + shares.Large, 30);
  assert.equal(shares.Small, 7.5);
  assert.equal(shares.Large, 22.5);
});

test("distribute rule (multi-field): MARKET=24ct distributes to configured destination sizes, preserving the row's total kg", () => {
  const grid = sizeGrid([
    ["Class 1", "SM", "10"],
    ["24ct", "All Weight", "6"]
  ]);
  const template = sizeTemplate({
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" }],
    rules: [{ id: "r1", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "24ct" }], action: "distribute", distributeSizeIds: ["s1", "s2"] }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small", s2: "Large" }));
  const group = preview.groups[0];
  // 6kg distributed weighted by current Small=10/Large=0 -> all-Small basis is zero-sum for Large, falls back to even split since Large has 0 weight and Small already has weight — verify total preserved regardless of exact split.
  assert.equal(group.reconciliation.distributedKg, 6);
  assert.equal(group.reconciliation.recognizedSizeKg, 16);
});

// ---------------------------------------------------------------------------
// Unresolved values / validation blockers
// ---------------------------------------------------------------------------

test("unresolved values block import: an unmapped size label with no rule produces a validation issue and canImport=false", () => {
  const grid = sizeGrid([["Class 1", "MYSTERY", "10"]]);
  const template = sizeTemplate();
  const preview = normalizeCsvWithTemplate(grid, template, ctx());
  assert.equal(preview.canImport, false);
  assert.ok(preview.validationIssues.some((i) => i.code === "unresolved_size_label"));
});

test("validation: size_weight_kg not mapped at all blocks import even with otherwise-valid data", () => {
  const grid = [["Size"], ["SM"]];
  const template = baseLayout({ columnMappings: [{ columnIndex: 0, field: "size_label" }] });
  const preview = normalizeCsvWithTemplate(grid, template, ctx());
  assert.ok(preview.validationIssues.some((i) => i.code === "size_weight_not_mapped"));
  assert.equal(preview.canImport, false);
});

test("validation: recognized kg of zero while raw non-ignored kg exists is blocked (no mapped preview can show zero kg while recognized rows exist)", () => {
  const grid = sizeGrid([["Class 1", "UNKNOWN_SIZE", "50"]]);
  const template = sizeTemplate(); // no value mapping for UNKNOWN_SIZE at all
  const preview = normalizeCsvWithTemplate(grid, template, ctx());
  const group = preview.groups[0];
  assert.equal(group.reconciliation.recognizedSizeKg, 0);
  assert.ok(preview.validationIssues.some((i) => i.code === "recognized_kg_zero" || i.code === "unresolved_size_label"));
  assert.equal(preview.canImport, false);
});

test("validation: duplicate raw kg (lot already imported) blocks import", () => {
  const lotGrid = [
    ["Market", "Lot", "Kg"],
    ["Class 1", "LOT-1", "10"]
  ];
  const lotTemplate = baseLayout({
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "lot_number" },
      { columnIndex: 2, field: "size_weight_kg" }
    ]
  });
  const preview = normalizeCsvWithTemplate(lotGrid, lotTemplate, ctx({}, ["LOT-1"]));
  assert.ok(preview.validationIssues.some((i) => i.code === "duplicate_raw_kg"));
  assert.equal(preview.canImport, false);
});

test("validation: invalid numeric value affecting totals blocks import", () => {
  const grid = sizeGrid([["Class 1", "SM", "not-a-number"]]);
  const template = sizeTemplate({
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small" }));
  assert.ok(preview.validationIssues.some((i) => i.code === "invalid_numeric_value"));
  assert.equal(preview.canImport, false);
});

test("validation: unexplained reconciliation difference (lot total doesn't match sum of rows) blocks import", () => {
  const grid = [
    ["Market", "Size", "Kg", "LotTotal"],
    ["Class 1", "SM", "10", "999"] // lot total wildly disagrees with the single row
  ];
  const template = baseLayout({
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" },
      { columnIndex: 3, field: "total_lot_weight" }
    ],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small" }));
  assert.ok(preview.validationIssues.some((i) => i.code === "unexplained_reconciliation_difference"));
  assert.equal(preview.canImport, false);
});

test("validation: an explained difference (lot total accounted for by ignored kg) does NOT block import", () => {
  const grid = [
    ["Market", "Size", "Kg", "LotTotal", "Variety", "Date"],
    ["Class 1", "SM", "10", "18", "Cadalora", "15082026"],
    ["waste", "junk", "8", "18", "Cadalora", "15082026"]
  ];
  const template = baseLayout({
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" },
      { columnIndex: 3, field: "total_lot_weight" },
      { columnIndex: 4, field: "variety" },
      { columnIndex: 5, field: "packed_date", dateFormat: "DDMMYYYY" }
    ],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: "s1" }],
    rules: [{ id: "r1", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "waste" }], action: "ignore" }]
  });
  const preview = normalizeCsvWithTemplate(grid, template, ctx({ s1: "Small" }));
  const group = preview.groups[0];
  assert.equal(group.reconciliation.recognizedSizeKg, 10);
  assert.equal(group.reconciliation.ignoredKg, 8);
  assert.equal(group.reconciliation.difference, 0);
  assert.equal(preview.canImport, true);
});

test("validateNormalizedPreview is a standalone pure function usable outside the full engine run", () => {
  const issues = validateNormalizedPreview([], baseLayout(), { alreadyImportedLotNumbers: new Set() });
  assert.ok(issues.some((i) => i.code === "size_weight_not_mapped"));
});
