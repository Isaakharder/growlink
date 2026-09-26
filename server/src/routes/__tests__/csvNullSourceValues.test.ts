// Literal "null" source values. FlowMaster writes the text null for values
// it doesn't have; the engine used to report each one as an unreadable
// number (one "could not parse numeric value" line per cell), which blocked
// the Cadalora Week 39 card although the only file with nulls recorded no
// fruit at all. A "null" is now missing — never zero — and is handled per
// field: it blocks only when kg itself is unknown; otherwise the AFW is
// calculated from what is there, or left blank. Offline: no DB.
import "./testHelpers/offlineSupabase";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./testHelpers/offlineSupabase";
import { supabase } from "../../config/supabase";
import { parseCsvGrid } from "../../utils/csvGridParser";
import { computeFingerprint, computeFingerprintHash } from "../../utils/csvTemplateFingerprint";
import { normalizeCsvWithTemplate, parseNumberValue, type EngineContext } from "../../utils/csvTemplateEngine";
import { buildWeeklyCards, type PendingSourceEntry } from "../../utils/csvWeeklyCards";
import type { ColumnMapping, NormalizedPreview, TemplateConfig, ValueMapping } from "../../utils/csvTemplateTypes";
import { importWeeklyCard, listPendingCsvTemplateWeeklyCards, mergeAppendAverageFruitWeight } from "../csvMappingTemplates";

// The six retained Cadalora Week 39 files, exactly as stored.
const CADALORA_DIR = join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "flowmaster-csv", "cadalora-w39");
const CADALORA_FILES = [
  "lot-2609210437.csv",
  "lot-2609210438.csv",
  "lot-2609220439.csv",
  "lot-2609220440.csv",
  "lot-2609230446.csv",
  "lot-2609240453.csv"
];
const cadalora = (filename: string) => readFileSync(join(CADALORA_DIR, filename), "utf-8");
const EMPTY_LOT = "lot-2609210437.csv";

const HEADER = "LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,MARKET,SIZE1,SIZE2,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS ";
/** One FlowMaster row: per-size WEIGHT/AVG/PCS, then the lot-total group. */
const row = (lot: string, market: string, size: string, weight: string, avg: string, pcs: string, lotTotal = "999.000,180.0,5550") =>
  `${lot},1,Cadalora,21092026,21092026,${market},${size},null,${weight},${avg},${pcs},${lotTotal}`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const gridOf = (text: string) => parseCsvGrid(text, ",").rows;

const SIZES = { SM: "size-sm", MD: "size-md", LG: "size-lg", SXL: "size-sxl", XL: "size-xl", XXL: "size-xxl" };
const SIZE_NAMES = new Map([
  [SIZES.SM, "Small"],
  [SIZES.MD, "Medium"],
  [SIZES.LG, "Large"],
  [SIZES.SXL, "SXL"],
  [SIZES.XL, "XL"],
  [SIZES.XXL, "XXL"]
]);
// Same value mappings as the saved "Latest Mapping" v14.
const VALUE_MAPPINGS: ValueMapping[] = [
  ...Object.entries(SIZES).map(([raw, id]) => ({ sourceField: "size_label" as const, rawValue: raw, action: "map" as const, targetSizeId: id })),
  ...["All Weight", "underweight", "{oversized}", "Doubles", "{undersized}", "Green"].map((raw) => ({
    sourceField: "size_label" as const,
    rawValue: raw,
    action: "ignore" as const
  })),
  { sourceField: "size_label", rawValue: "24ct", action: "distribute" }
];
// Same column layout as v14: the per-size WEIGHT/AVG/PCS group (columns 9-11).
const COLUMN_MAPPINGS: ColumnMapping[] = [
  { field: "variety", columnIndex: 2 },
  { field: "packed_date", dateFormat: "DDMMYYYY", columnIndex: 3 },
  { field: "lot_number", columnIndex: 0 },
  { field: "size_label", columnIndex: 6 },
  { field: "size_weight_kg", columnIndex: 8 },
  { field: "average_fruit_weight_g", columnIndex: 9 },
  { field: "run_number", columnIndex: 1 },
  { field: "piece_count", columnIndex: 10 }
];

function config(extraMappings: ColumnMapping[] = []): TemplateConfig {
  return {
    delimiter: ",",
    encoding: "utf-8",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings: [...COLUMN_MAPPINGS, ...extraMappings],
    fixedCellMappings: [],
    valueMappings: VALUE_MAPPINGS,
    rules: []
  };
}

const CTX: EngineContext = { sizeNameById: SIZE_NAMES, alreadyImportedLotNumbers: new Set() };
const run = (text: string, cfg: TemplateConfig = config()) => normalizeCsvWithTemplate(gridOf(text), cfg, CTX);
const codes = (issues: Array<{ code: string }> | undefined) => (issues ?? []).map((i) => i.code);
const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

function entry(filename: string, preview: NormalizedPreview): PendingSourceEntry {
  return {
    pendingImportId: `pending-${filename}`,
    sourceFileId: `source-${filename}`,
    sourceFilename: filename,
    uploadedAt: "2026-09-26T10:00:00Z",
    templateId: "tpl-v14",
    templateName: "Latest Mapping",
    templateVersion: 14,
    layoutMismatch: false,
    preview
  };
}
const VARIETIES = new Map([["cadalora", { id: "variety-cadalora", name: "Cadalora", areaM2: 10000 }]]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a literal null — bare, quoted or upper-case — is missing, never zero, whatever the blank handling', () => {
  for (const blankHandling of ["zero", "skip", "error"] as const) {
    for (const raw of ["null", " NULL ", "Null"]) {
      assert.deepEqual(parseNumberValue(raw, { decimalSeparator: ".", thousandsSeparator: "", blankHandling }), {
        value: null,
        error: null,
        missing: true
      });
    }
  }
  // The grid parser strips the quotes of "null", so it reaches the engine as null.
  const preview = run(csv(row("2609990001", "Class 1", "LG", '"null"', "164.0", "0")));
  assert.equal(preview.groups[0].rows[0].sizeWeightKg, 0);
  assert.deepEqual(preview.groups[0].rows[0].missingFields, ["size_weight_kg"]);
});

// ---------------------------------------------------------------------------
// Field-aware handling
// ---------------------------------------------------------------------------

test("null Source AFW with valid PCS: AFW is calculated from kg and pieces, and the import is not blocked", () => {
  const preview = run(
    csv(row("2609990001", "Class 1", "LG", "10.000", "null", "50"), row("2609990001", "Class 1", "XL", "30.000", "NULL", "120"))
  );
  const group = preview.groups[0];

  assert.equal(preview.canImport, true);
  assert.deepEqual(preview.validationIssues, []);
  assert.deepEqual(group.averageFruitWeightBasis, { kg: 40, pieces: 170 });
  assert.equal(round3(group.averageFruitWeightG), round3(40000 / 170));

  assert.deepEqual(codes(preview.warnings), ["missing_source_afw"]);
  const warning = preview.warnings![0];
  assert.equal(warning.impact, "none");
  assert.equal(warning.field, "average_fruit_weight_g");
  assert.deepEqual(warning.rowIndexes, [1, 2]);
  assert.equal(
    warning.message,
    'Source AFW is "null" on 2 included rows (rows 2–3, column "AVG" (column 10, the 1st of 2 "AVG" columns)). Valid Piece Count is available, so AFW is calculated from kg and pieces.'
  );
});

test("null PCS with valid AFW: pieces are derived from kg ÷ AFW and the rounding bound is stated", () => {
  const preview = run(
    csv(row("2609990001", "Class 1", "LG", "10.000", "200.0", "null"), row("2609990001", "Class 1", "XL", "30.000", "250.0", "null"))
  );
  const group = preview.groups[0];

  assert.equal(preview.canImport, true);
  // 10 kg / 200 g = 50 pcs, 30 kg / 250 g = 120 pcs.
  assert.equal(group.averageFruitWeightBasis?.pieces, 170);
  assert.equal(round3(group.averageFruitWeightG), round3(40000 / 170));

  assert.deepEqual(codes(preview.warnings), ["missing_piece_count_derived"]);
  // AVG to 0.1 g is off by at most 0.05 g: 0.05 / 200 = 0.025%, rounded up.
  assert.match(preview.warnings![0].message, /^Piece Count is "null" on 2 included rows \(rows 2–3, column "PCS" \(column 11, the 1st of 2 "PCS" columns\)\)/);
  assert.match(preview.warnings![0].message, /up to ±0\.03%\.$/);
});

test("nulls only on ignored rows (doubles, waste, green, underweight) never block the marketable sizes", () => {
  const preview = run(
    csv(
      row("2609990001", "Class 1", "LG", "10.000", "200.0", "50"),
      row("2609990001", "Class 1", "underweight", "null", "null", "null"),
      row("2609990001", "Doubles", "Doubles", "null", "null", "null"),
      row("2609990001", "Green", "Green", "5.000", "null", "null"),
      row("2609990001", "waste", "{oversized}", "null", "null", "3")
    )
  );
  const group = preview.groups[0];

  assert.equal(preview.canImport, true);
  assert.deepEqual(group.sizeKg, { Large: 10 });
  assert.equal(group.averageFruitWeightG, 200);
  assert.equal(group.reconciliation.unexplainedDifference, false);
  assert.deepEqual(codes(preview.warnings), ["missing_values_ignored_rows"]);
  assert.match(preview.warnings![0].message, /on 4 ignored rows \(rows 3–6: underweight, Doubles, Green, \{oversized\}\)\. These rows are not imported/);
});

test("an unknown ignored weight still fails reconciliation when a lot total is mapped — Reconciliation OK is not preserved blindly", () => {
  const withLotTotal = config([{ field: "total_lot_weight", columnIndex: 11 }]);
  const text = (doublesWeight: string) =>
    csv(
      row("2609990001", "Class 1", "LG", "10.000", "200.0", "50", "12.000,190.0,60"),
      row("2609990001", "Doubles", "Doubles", doublesWeight, "null", "10", "12.000,190.0,60")
    );

  assert.equal(run(text("2.000"), withLotTotal).canImport, true);

  const unknown = run(text("null"), withLotTotal);
  assert.equal(unknown.groups[0].reconciliation.unexplainedDifference, true);
  assert.ok(codes(unknown.validationIssues).includes("unexplained_reconciliation_difference"));
  assert.equal(unknown.canImport, false);
});

test("PCS and AFW both missing on included rows: kg is importable, AFW is left blank and says so", () => {
  const preview = run(
    csv(row("2609990001", "Class 1", "LG", "10.000", "null", "null"), row("2609990001", "Class 1", "XL", "30.000", "250.0", "120"))
  );
  const group = preview.groups[0];

  assert.equal(preview.canImport, true);
  assert.equal(group.reconciliation.recognizedSizeKg, 40);
  assert.equal(group.averageFruitWeightG, null);
  assert.equal(group.averageFruitWeightBasis, null);

  const warning = preview.warnings!.find((w) => w.code === "afw_not_calculable")!;
  assert.equal(warning.impact, "afw");
  assert.equal(
    warning.message,
    "Piece Count and AFW are both missing for 1 included size row (row 2, 10.00 kg). Kg can be imported, but AFW cannot be calculated and will be left blank."
  );
});

test("a null Size Weight on an included size keeps the import blocked unless PCS is a literal 0", () => {
  const blocked = run(csv(row("2609990001", "Class 1", "LG", "null", "164.0", "40"), row("2609990001", "Class 1", "XL", "30.000", "250.0", "120")));
  assert.equal(blocked.canImport, false);
  assert.equal(blocked.groups[0].rows[0].sizeWeightKg, null, "null weight is never read as 0 kg");
  const issue = blocked.validationIssues.find((i) => i.code === "missing_size_weight")!;
  assert.equal(issue.impact, "import");
  assert.match(issue.message, /^Size Weight is "null" on 1 included size row \(row 2, column "WEIGHT" \(column 9, the 1st of 2 "WEIGHT" columns\)\)/);

  // A blank PCS that blank-handling turns into 0 is not an exact source value.
  const blankPcs = run(csv(row("2609990001", "Class 1", "LG", "null", "null", "")));
  assert.equal(blankPcs.canImport, false);
  assert.ok(codes(blankPcs.validationIssues).includes("missing_size_weight"));

  // PCS written as 0: no fruit counted, so the row is 0 kg by derivation.
  const zeroPcs = run(csv(row("2609990001", "Class 1", "LG", "null", "null", "0"), row("2609990001", "Class 1", "XL", "30.000", "250.0", "120")));
  assert.equal(zeroPcs.canImport, true);
  assert.equal(zeroPcs.groups[0].rows[0].sizeWeightKg, 0);
  assert.equal(zeroPcs.groups[0].averageFruitWeightG, 250);
  assert.deepEqual(codes(zeroPcs.warnings), ["missing_values_no_fruit"]);
});

test("unreadable values are consolidated into one blocking issue per field", () => {
  const preview = run(
    csv(
      row("2609990001", "Class 1", "SM", "abc", "117.1", "40"),
      row("2609990001", "Class 1", "MD", "abc", "139.9", "40"),
      row("2609990001", "Class 1", "LG", "#REF", "164.0", "40")
    )
  );
  const invalid = preview.validationIssues.filter((i) => i.code === "invalid_numeric_value");
  assert.equal(invalid.length, 1);
  assert.equal(
    invalid[0].message,
    'Size Weight could not be read on 3 rows (rows 2–4, column "WEIGHT" (column 9, the 1st of 2 "WEIGHT" columns)): "abc", "#REF". The import is blocked until the file or mapping is corrected.'
  );
  assert.equal(preview.canImport, false);
});

// ---------------------------------------------------------------------------
// No partial AFW across files
// ---------------------------------------------------------------------------

test("a weekly card never shows an AFW computed from only the files that have one", () => {
  const withAfw = run(cadalora("lot-2609210438.csv"));
  const kgOnly = run(csv(row("2609990002", "Class 1", "LG", "100.000", "null", "null")));
  assert.notEqual(withAfw.groups[0].averageFruitWeightG, null);

  const [card] = buildWeeklyCards("org-1", [entry("lot-2609210438.csv", withAfw), entry("lot-kg-only.csv", kgOnly)], VARIETIES);
  assert.equal(card.mappedKg, 8702.02);
  assert.equal(card.combinedAverageFruitWeightG, null);
  assert.equal(card.canImport, true);
  assert.ok(
    card.warnings.some((w) => w.message.startsWith("Weekly AFW is left blank: lot-kg-only.csv has kg without a calculable AFW")),
    "the blank AFW is explained, naming the file"
  );
});

test("append merge never saves a partial AFW: a side with kg but no AFW makes it blank, a side with no kg is left out", () => {
  // Incoming kg without AFW onto an entry that has one.
  assert.equal(mergeAppendAverageFruitWeight(100, 180, null, 50), null);
  // Incoming AFW onto an entry whose kg has none.
  assert.equal(mergeAppendAverageFruitWeight(100, null, { kg: 15, pieces: 100 }), null);
  // A lot with no fruit (0 kg) changes nothing, in either order.
  assert.equal(mergeAppendAverageFruitWeight(100, 180, null, 0), 180);
  assert.equal(mergeAppendAverageFruitWeight(0, null, { kg: 15, pieces: 100 }), 150);
  assert.equal(mergeAppendAverageFruitWeight(0, null, null, 0), null);
});

// ---------------------------------------------------------------------------
// The real Cadalora Week 39 files
// ---------------------------------------------------------------------------

test("lot-2609210437: one consolidated, filename-specific warning instead of 16 parse errors", () => {
  const preview = run(cadalora(EMPTY_LOT));
  assert.deepEqual(preview.validationIssues, []);
  assert.equal(preview.groups[0].reconciliation.recognizedSizeKg, 0);

  const [card] = buildWeeklyCards("org-1", [entry(EMPTY_LOT, preview)], VARIETIES);
  assert.deepEqual(card.blockingIssues, []);
  assert.equal(card.warnings.length, 1);
  assert.equal(card.warnings[0].sourceFilename, EMPTY_LOT);
  assert.equal(
    card.warnings[0].message,
    'lot-2609210437.csv: Size Weight and Source AFW are "null" on 8 rows (rows 2–9, column "WEIGHT" (column 9, the 1st of 2 "WEIGHT" columns)), and Piece Count is 0 on each of them. No fruit was recorded, so these rows count as 0 kg and do not affect AFW.'
  );
  assert.ok(!JSON.stringify(card).includes("could not parse"));
});

test("the other five Cadalora files are unaffected: no issues and no warnings", () => {
  for (const filename of CADALORA_FILES.filter((f) => f !== EMPTY_LOT)) {
    const preview = run(cadalora(filename));
    assert.deepEqual(preview.validationIssues, [], filename);
    assert.deepEqual(preview.warnings, [], filename);
    assert.notEqual(preview.groups[0].averageFruitWeightG, null, filename);
  }
});

// End to end through the real card listing and import, against an in-memory DB.
const ORG = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "aaaaaaaa-0000-4000-8000-000000000014";
const sourceId = (i: number) => `cccccccc-0000-4000-8000-00000000000${i}`;
const pendingId = (i: number) => `dddddddd-0000-4000-8000-00000000000${i}`;

function cadaloraDb(files: Array<[string, string]>) {
  const fingerprint = computeFingerprint(gridOf(files[0][1]), ",", 0);
  return createFakeDb({
    csv_mapping_templates: [
      {
        id: TEMPLATE_ID,
        template_group_id: "grp-latest",
        organization_id: ORG,
        name: "Latest Mapping",
        version: 14,
        is_current: true,
        is_active: true,
        delimiter: ",",
        encoding: "utf-8",
        header_row_index: 0,
        data_start_row_index: 1,
        data_end_row_index: null,
        skip_row_indexes: [],
        blank_row_behavior: "skip",
        fingerprint,
        fingerprint_hash: computeFingerprintHash(fingerprint),
        column_mappings: COLUMN_MAPPINGS,
        fixed_cell_mappings: [],
        value_mappings: VALUE_MAPPINGS,
        rules: []
      }
    ],
    csv_import_source_files: files.map(([filename, text], i) => ({
      id: sourceId(i),
      organization_id: ORG,
      filename,
      raw_text: text,
      delimiter: ","
    })),
    agent_pending_imports: files.map(([filename], i) => ({
      id: pendingId(i),
      organization_id: ORG,
      source_filename: filename,
      source_file_id: sourceId(i),
      data_source_type: "csv_template",
      csv_mapping_template_id: TEMPLATE_ID,
      needs_template: false,
      uploaded_at: `2026-09-26T10:00:0${i}Z`
    })),
    yield_import_runs: [],
    yield_entries: [],
    yield_entry_daily_breakdown: [],
    csv_source_value_overrides: [],
    yield_sizes: Array.from(SIZE_NAMES, ([id, name]) => ({ id, organization_id: ORG, name })),
    varieties: [{ id: "variety-cadalora", organization_id: ORG, name: "Cadalora", status: "active", area_m2: 10000, case_kg: 5 }]
  });
}

const realFrom = supabase.from.bind(supabase);
function useFake(fake: ReturnType<typeof cadaloraDb>) {
  (supabase as unknown as { from: unknown }).from = fake.from;
}
afterEach(() => {
  (supabase as unknown as { from: unknown }).from = realFrom;
});

test("Cadalora W39, all six files: importable, and the saved entry matches the card exactly (20,279.73 kg, 173.1 g)", async () => {
  const fake = cadaloraDb(CADALORA_FILES.map((f) => [f, cadalora(f)]));
  useFake(fake);

  const { cards } = await listPendingCsvTemplateWeeklyCards(ORG);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.varietyName, "Cadalora");
  assert.deepEqual([card.isoYear, card.isoWeek], [2026, 39]);
  assert.equal(card.sourceFileCount, 6);
  assert.equal(card.mappedKg, 20279.73);
  assert.equal(card.ignoredKg, 678.42);
  assert.equal(card.reconciliationOk, true);
  // Every kg on the card has a PCS basis (the empty lot has no kg), so this
  // AFW covers all six files: 20,279.716 kg over 117,144 pieces.
  assert.equal(round3(card.combinedAverageFruitWeightG), 173.118);
  assert.equal(card.canImport, true);
  assert.deepEqual(card.blockingIssues, []);
  assert.deepEqual(
    card.warnings.map((w) => w.sourceFilename),
    [EMPTY_LOT]
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(card.sizeKg).map(([k, v]) => [k, round3(v)])),
    { Small: 1082.772, Medium: 2484.218, Large: 5211.909, SXL: 3945.769, XL: 7446.736, XXL: 108.312 }
  );

  const result = await importWeeklyCard(ORG, "user-1", card.cardKey);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["imported", "imported", "imported", "imported", "imported", "imported"]
  );
  assert.equal(result.totalKgImported, 20279.73);

  assert.equal(fake.tables.yield_entries.length, 1);
  const saved = fake.tables.yield_entries[0];
  // The exact source kg. The card's 20,279.73 sums each lot's kg rounded to
  // 0.01 first; unrounded, the six files hold 20,279.716 kg.
  assert.equal(round3(saved.total_kg as number), 20279.716);
  assert.equal(round3(saved.average_fruit_weight_g as number), 173.118, "saved AFW equals the card's");
  assert.equal(fake.tables.yield_import_runs.length, 6);
  assert.equal(fake.tables.agent_pending_imports.length, 0);
});

test("kg-only import: a file whose included sizes have neither PCS nor AFW imports its kg with AFW left blank", async () => {
  const kgOnly = csv(row("2609990002", "Class 1", "LG", "100.000", "null", "null"), row("2609990002", "Class 1", "XL", "50.000", "null", "null"));
  const fake = cadaloraDb([
    ["lot-2609210438.csv", cadalora("lot-2609210438.csv")],
    ["lot-2609990002.csv", kgOnly]
  ]);
  useFake(fake);

  const { cards } = await listPendingCsvTemplateWeeklyCards(ORG);
  const card = cards[0];
  assert.equal(card.canImport, true);
  assert.equal(card.combinedAverageFruitWeightG, null);

  await importWeeklyCard(ORG, "user-1", card.cardKey);
  const saved = fake.tables.yield_entries[0];
  assert.equal(Math.round((saved.total_kg as number) * 100) / 100, 8752.02);
  assert.equal(saved.average_fruit_weight_g, null, "no AFW describing only lot 2609210438's kg");
});
