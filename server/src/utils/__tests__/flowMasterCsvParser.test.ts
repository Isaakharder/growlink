import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlowMasterCsv } from "../flowMasterCsvParser";
import { resolveFileSizes, canonicalizeSizeName, type OrgSizeContext } from "../sizeMapping";
import { normalizeSizeRuleLabel, type SizeRuleRecord } from "../flowMasterSizeRules";
import { resolveCsvRowLabels } from "../flowMasterCsvRuleResolver";

const HEADERS = "LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,SM,MD,LG,SXL,XL,XXL";

function row(...cols: (string | number)[]): string {
  return cols.join(",");
}

test("parses a single CSV row into one FlowMasterParseResult", () => {
  const csv = [HEADERS, row("2604290067", "23042026 11:50:52", "Silverstone", 302, 14601, 25, 35, 72, 198, 1591, 12680)].join("\n");
  const results = parseFlowMasterCsv(csv, "test.csv");

  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.sourceFile, "test.csv");
  assert.strictEqual(r.lotNumber, "2604290067");
  assert.strictEqual(r.varietyName, "Silverstone");
  assert.strictEqual(r.startTime, "2026-04-23 11:50");
  assert.strictEqual(r.startDate, "2026-04-23");
  assert.strictEqual(r.isoYear, 2026);
  assert.strictEqual(r.isoWeek, 17);
  assert.strictEqual(r.averageFruitWeightG, 302);
});

test("totalKg is sum of size columns, not the WEIGHT column", () => {
  const csv = ["LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,SM,MD", row("LOT001", "01012026 09:00:00", "TestVariety", 250, 9999, 300, 200)].join("\n");
  const results = parseFlowMasterCsv(csv, "test.csv");

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].totalKg, 500); // 300 + 200, not 9999
});

test("averageFruitWeightG comes from AVG column", () => {
  const csv = ["LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,XL", row("LOT001", "01012026 09:00:00", "TestVariety", 315, 500, 500)].join("\n");
  const results = parseFlowMasterCsv(csv, "test.csv");

  assert.strictEqual(results[0].averageFruitWeightG, 315);
});

test("maps CSV size labels to GrowLink names", () => {
  const csv = [HEADERS, row("LOT001", "01012026 09:00:00", "Variety", 250, 1000, 10, 20, 30, 40, 50, 60)].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];

  assert.strictEqual(r.sizeKg["Small"], 10);
  assert.strictEqual(r.sizeKg["Medium"], 20);
  assert.strictEqual(r.sizeKg["Large"], 30);
  assert.strictEqual(r.sizeKg["SXL"], 40);
  assert.strictEqual(r.sizeKg["XL"], 50);
  assert.strictEqual(r.sizeKg["XXL"], 60);
  assert.deepStrictEqual(r.unknownSizes, []);
  assert.deepStrictEqual(r.warnings, []);
});

test("skips LOTNUMBER=REPACK case-insensitively", () => {
  const csv = [
    "LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,XL",
    row("REPACK", "01012026 09:00:00", "Silverstone", 300, 100, 100),
    row("repack", "01012026 09:00:00", "Silverstone", 300, 100, 100),
    row("Repack", "01012026 09:00:00", "Silverstone", 300, 100, 100),
    row("LOT001", "01012026 09:00:00", "Silverstone", 300, 100, 100),
  ].join("\n");

  const results = parseFlowMasterCsv(csv, "test.csv");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].lotNumber, "LOT001");
});

test("fans multiple rows into separate results", () => {
  const csv = [
    "LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,XL,XXL",
    row("LOT001", "01012026 09:00:00", "Silverstone", 300, 500, 200, 300),
    row("LOT002", "02012026 10:00:00", "Silverstone", 310, 600, 250, 350),
  ].join("\n");

  const results = parseFlowMasterCsv(csv, "multi.csv");
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].lotNumber, "LOT001");
  assert.strictEqual(results[1].lotNumber, "LOT002");
  assert.strictEqual(results[0].sourceFile, "multi.csv");
  assert.strictEqual(results[1].sourceFile, "multi.csv");
});

test("BEGINDT parsed correctly: DDMMYYYY HH:mm:ss → ISO", () => {
  const csv = ["LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,XL", row("LOT001", "23042026 11:50:52", "Silverstone", 302, 1591, 1591)].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];

  assert.strictEqual(r.startTime, "2026-04-23 11:50");
  assert.strictEqual(r.startDate, "2026-04-23");
  assert.strictEqual(r.isoYear, 2026);
  assert.strictEqual(r.isoWeek, 17);
});

test("reports unknown sizes with warning", () => {
  const csv = ["LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,SUPERSIZE", row("LOT001", "01012026 09:00:00", "TestVariety", 250, 100, 75)].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];

  assert.deepStrictEqual(r.unknownSizes, ["SUPERSIZE"]);
  assert.ok(r.warnings.some((w) => w.includes("SUPERSIZE")));
  assert.strictEqual(r.sizeKg["SUPERSIZE"], 75);
  assert.strictEqual(r.totalKg, 75);
});

test("skips size columns with zero or empty values", () => {
  const csv = ["LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,SM,XL", row("LOT001", "01012026 09:00:00", "Variety", 250, 100, 0, 100)].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];

  assert.ok(!("Small" in r.sizeKg), "zero-kg size should be omitted");
  assert.strictEqual(r.sizeKg["XL"], 100);
  assert.strictEqual(r.totalKg, 100);
});

test("returns empty array for empty CSV", () => {
  assert.deepStrictEqual(parseFlowMasterCsv("", "test.csv"), []);
});

test("returns empty array for header-only CSV", () => {
  assert.deepStrictEqual(parseFlowMasterCsv(HEADERS, "test.csv"), []);
});

test("handles quoted fields in variety name", () => {
  const csv = ['LOTNUMBER,BEGINDT,VARIETY,AVG,WEIGHT,XL', 'LOT001,01012026 09:00:00,"Variety, Special",300,500,500'].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.varietyName, "Variety, Special");
});

test("warns when variety is missing", () => {
  const csv = ["LOTNUMBER,BEGINDT,AVG,WEIGHT,XL", row("LOT001", "01012026 09:00:00", 250, 100, 100)].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.varietyName, null);
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("variety")));
});

// ─── New format (LOTID / SIZE1 / WEIGHT.1 layout) ────────────────────────────

const NF_HEADERS =
  "LOTID,LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,WEIGHT,AVG,PCS,MARKET,SIZE1,SIZE2,WEIGHT.1,AVG.1,PCS";

// Build one new-format row. SIZE2 mirrors SIZE1; other metadata fields are fixed.
function nfRow(
  lotid: string,
  lotnumber: string,
  variety: string,
  begindt: string,
  size1: string,
  weight1: number | string
): string {
  return [lotid, lotnumber, "1", variety, begindt, "23042026 12:05:30", "1000", "302", "3300", "MARKET1", size1, size1, String(weight1), "298", "83"].join(",");
}

test("new format: groups multiple size rows for one lot into a single result", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "2604290067", "Silverstone", "23042026 11:50:52", "S", 25),
    nfRow("LOT_001", "2604290067", "Silverstone", "23042026 11:50:52", "M", 35),
    nfRow("LOT_001", "2604290067", "Silverstone", "23042026 11:50:52", "XL", 1591),
  ].join("\n");

  const results = parseFlowMasterCsv(csv, "real.csv");
  assert.strictEqual(results.length, 1);

  const r = results[0];
  assert.strictEqual(r.lotNumber, "2604290067");
  assert.strictEqual(r.varietyName, "Silverstone");
  assert.strictEqual(r.startTime, "2026-04-23 11:50");
  assert.strictEqual(r.isoYear, 2026);
  assert.strictEqual(r.isoWeek, 17);
  assert.strictEqual(r.sizeKg["Small"], 25);
  assert.strictEqual(r.sizeKg["Medium"], 35);
  assert.strictEqual(r.sizeKg["XL"], 1591);
  assert.strictEqual(r.totalKg, 25 + 35 + 1591);
});

test("new format: S/M/L SIZE1 values map to Small/Medium/Large", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "S", 100),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "M", 200),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "L", 300),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "SXL", 400),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 500),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XXL", 600),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.strictEqual(r.sizeKg["Small"], 100);
  assert.strictEqual(r.sizeKg["Medium"], 200);
  assert.strictEqual(r.sizeKg["Large"], 300);
  assert.strictEqual(r.sizeKg["SXL"], 400);
  assert.strictEqual(r.sizeKg["XL"], 500);
  assert.strictEqual(r.sizeKg["XXL"], 600);
  assert.deepStrictEqual(r.unknownSizes, []);
});

test("new format: totalKg equals sum of WEIGHT.1 values", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "S", 123),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 456),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.strictEqual(r.totalKg, 579);
});

test("new format: averageFruitWeightG is combined kg/pieces from the per-row AVG.1/PCS group, not the lot-level AVG/PCS group", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 100),
  ].join("\n");

  // nfRow sets lot-level AVG=302/PCS=3300 (before MARKET) and per-row
  // AVG.1=298/PCS=83 (after SIZE1). Combined AFW must come from the
  // per-row group: (kg * 1000) / pieces = (100 * 1000) / 83 — a repeat of
  // the lot AVG (302) would be wrong now that FlowMaster's real duplicate
  // WEIGHT/AVG/PCS columns are read positionally instead of by name.
  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.strictEqual(r.averageFruitWeightG, (100 * 1000) / 83);
});

test("new format: averageFruitWeightG combines kg/pieces ACROSS rows in a lot, not per-row", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 100),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XXL", 100),
  ].join("\n");

  // Each row contributes kg=100, PCS=83 (nfRow's fixed per-row PCS) —
  // combined across both rows: (100+100)*1000 / (83+83), same ratio as a
  // single row here, but proves the accumulation is a running kg/pieces
  // total rather than something reset or averaged per row.
  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.strictEqual(r.averageFruitWeightG, (200 * 1000) / 166);
});

test("new format: PCS = 0 for a row falls back to estimating pieces from that row's AVG.1 instead of dividing by zero", () => {
  const headers = "LOTID,LOTNUMBER,VARIETY,BEGINDT,MARKET,SIZE1,WEIGHT,AVG,PCS";
  const dataRow = ["LOT_A", "LOT001", "Variety", "01012026 09:00:00", "Class 1", "XL", "150", "150", "0"].join(",");
  const csv = [headers, dataRow].join("\n");

  // PCS is 0 (missing/unreliable) — fall back to kg/AVG-derived pieces:
  // 150kg * 1000 / 150g = 1000 estimated pieces, so combined AFW is just
  // the AVG value itself in this single-row case, not null.
  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.averageFruitWeightG, 150);
});

test("new format: PCS and AVG both missing for every row leaves averageFruitWeightG null, no divide-by-zero", () => {
  const headers = "LOTID,LOTNUMBER,VARIETY,BEGINDT,MARKET,SIZE1,WEIGHT";
  const dataRow = ["LOT_A", "LOT001", "Variety", "01012026 09:00:00", "Class 1", "XL", "150"].join(",");
  const csv = [headers, dataRow].join("\n");

  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.averageFruitWeightG, null);
  assert.strictEqual(r.sizeKg["XL"], 150);
});

test("new format: LOTID containing REPACK is skipped (case-insensitive, substring)", () => {
  const csv = [
    NF_HEADERS,
    nfRow("REPACK_01", "LOT_SKIP1", "Silverstone", "01012026 09:00:00", "XL", 100),
    nfRow("repack_02", "LOT_SKIP2", "Silverstone", "01012026 09:00:00", "XL", 100),
    nfRow("PREFIX_REPACK_SUFFIX", "LOT_SKIP3", "Silverstone", "01012026 09:00:00", "XL", 100),
    nfRow("LOT_VALID", "LOT_KEEP", "Silverstone", "01012026 09:00:00", "XL", 100),
  ].join("\n");

  const results = parseFlowMasterCsv(csv, "real.csv");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].lotNumber, "LOT_KEEP");
});

test("new format: multiple lots produce separate results", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Silverstone", "01012026 09:00:00", "S", 100),
    nfRow("LOT_001", "LOT001", "Silverstone", "01012026 09:00:00", "XL", 200),
    nfRow("LOT_002", "LOT002", "Redstone", "02012026 10:00:00", "M", 300),
  ].join("\n");

  const results = parseFlowMasterCsv(csv, "real.csv");
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].lotNumber, "LOT001");
  assert.strictEqual(results[0].totalKg, 300);
  assert.strictEqual(results[1].lotNumber, "LOT002");
  assert.strictEqual(results[1].totalKg, 300);
  assert.strictEqual(results[1].sizeKg["Medium"], 300);
});

test("new format: unknown SIZE1 value is reported as warning", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XXXL", 100),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.deepStrictEqual(r.unknownSizes, ["XXXL"]);
  assert.ok(r.warnings.some((w) => w.includes("XXXL")));
  assert.strictEqual(r.sizeKg["XXXL"], 100);
});

test("new format: RUN/ENDDT/PCS/MARKET columns do not appear as sizes", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 500),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  // Only XL should be in sizeKg — no metadata columns
  assert.deepStrictEqual(Object.keys(r.sizeKg), ["XL"]);
  assert.deepStrictEqual(r.unknownSizes, []);
});

test("new format: WEIGHT-after-SIZE1 detected by column position, not header name", () => {
  // Use a header where the per-size weight column is plain "WEIGHT" (not "WEIGHT.1"),
  // but it comes after SIZE1 — the lot-level WEIGHT before SIZE1 must be ignored.
  const headers = "LOTID,LOTNUMBER,VARIETY,BEGINDT,AVG,WEIGHT,SIZE1,WEIGHT";
  // Two WEIGHT columns: index 5 (before SIZE1 at index 6) and index 7 (after SIZE1).
  // The parser must pick index 7, not index 5.
  const dataRow = ["LOT_A", "LOT001", "Variety", "01012026 09:00:00", "300", "9999", "XL", "400"].join(",");
  const csv = [headers, dataRow].join("\n");

  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.sizeKg["XL"], 400); // from WEIGHT at index 7
  assert.strictEqual(r.totalKg, 400);       // NOT 9999
});

test("new format: ignoredSizeLabels silently skips matching SIZE1 values", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "S", 100),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 200),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv", ["S"])[0];
  assert.ok(!("Small" in r.sizeKg), "S should be ignored");
  assert.strictEqual(r.sizeKg["XL"], 200);
  assert.strictEqual(r.totalKg, 200);
  // Ignored sizes must not appear in unknownSizes or warnings
  assert.deepStrictEqual(r.unknownSizes, []);
  assert.ok(!r.warnings.some((w) => w.includes("S")));
});

test("new format: ignoredSizeLabels matching is case-insensitive", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 300),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XXL", 100),
  ].join("\n");

  // Pass lower-case "xl" — should still match SIZE1 value "XL"
  const r = parseFlowMasterCsv(csv, "real.csv", ["xl"])[0];
  assert.ok(!("XL" in r.sizeKg), "XL should be ignored despite case difference in input");
  assert.strictEqual(r.sizeKg["XXL"], 100);
});

// ─── sizeAliases / DEFAULT_SIZE_ALIASES ──────────────────────────────────────

test("new format: X-L maps to SXL via built-in default alias (no settings needed)", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "X-L", 250),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.strictEqual(r.sizeKg["SXL"], 250);
  assert.deepStrictEqual(r.unknownSizes, []);
  assert.ok(!r.warnings.some((w) => w.includes("X-L")));
});

test("new format: {OVERSIZED} silently ignored when in ignoredSizeLabels", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "{OVERSIZED}", 500),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 200),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "real.csv", ["{OVERSIZED}"])[0];
  assert.ok(!("{OVERSIZED}" in r.sizeKg), "{OVERSIZED} should be silently skipped");
  assert.strictEqual(r.sizeKg["XL"], 200);
  assert.strictEqual(r.totalKg, 200);
  assert.deepStrictEqual(r.unknownSizes, []);
  assert.ok(!r.warnings.some((w) => w.includes("OVERSIZED")));
});

test("new format: unknown label still produces warning when not in ignored or aliases", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "MONSTER", 100),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 200),
  ].join("\n");

  // Neither ignored nor aliased — MONSTER must surface as an unknown
  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.deepStrictEqual(r.unknownSizes, ["MONSTER"]);
  assert.ok(r.warnings.some((w) => w.includes("MONSTER")));
  assert.strictEqual(r.sizeKg["MONSTER"], 100);
  assert.strictEqual(r.sizeKg["XL"], 200);
});

test("new format: org-provided sizeAliases map custom labels to GrowLink size names", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "JUMBO", 300),
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 100),
  ].join("\n");

  // Caller specifies JUMBO → XXL via sizeAliases
  const r = parseFlowMasterCsv(csv, "real.csv", [], { JUMBO: "XXL" })[0];
  assert.strictEqual(r.sizeKg["XXL"], 300);
  assert.strictEqual(r.sizeKg["XL"], 100);
  assert.deepStrictEqual(r.unknownSizes, []);
  assert.ok(!r.warnings.some((w) => w.includes("JUMBO")));
});

// ─── Real FlowMaster export shape ─────────────────────────────────────────────
// LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,MARKET,SIZE1,SIZE2,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS
// MARKET/SIZE1/SIZE2 come BEFORE the first (per-row) WEIGHT,AVG,PCS group, and
// the lot-total WEIGHT,AVG,PCS group repeats at the very end — the opposite
// column order from NF_HEADERS above, and neither duplicate is renamed with a
// ".1" suffix in the real export. This is the structure the reported bug was
// filed against: every row's WEIGHT resolved to the same lot total (11118.075)
// because the row-object lookup collapsed both same-named columns into one.

const RF_HEADERS =
  "LOTNUMBER,RUN,VARIETY,BEGINDT,ENDDT,MARKET,SIZE1,SIZE2,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS";
const RF_LOT_TOTAL = { weight: "11118.075", avg: "171.3", pcs: "64922" };

function rfRow(market: string, size1: string, weight: string, avg: string, pcs: string): string {
  return [
    "2608170362", "1", "Cadalora", "17082026", "18082026",
    market, size1, "null",
    weight, avg, pcs,
    RF_LOT_TOTAL.weight, RF_LOT_TOTAL.avg, RF_LOT_TOTAL.pcs,
  ].join(",");
}

const REAL_LOT_CSV = [
  RF_HEADERS,
  rfRow("24ct", "All Weight", "0.000", "0.0", "0"),
  rfRow("Green", "All Weight", "943.702", "171.0", "5519"),
  rfRow("Class 1", "underweight", "0.562", "62.4", "9"),
  rfRow("Class 1", "SM", "34.123", "91.2", "374"),
  rfRow("Class 1", "MD", "468.121", "120.1", "3899"),
  rfRow("Class 1", "LG", "1380.906", "143.7", "9611"),
  rfRow("Class 1", "SXL", "3257.101", "166.3", "19585"),
  rfRow("Class 1", "XL", "4489.312", "194.1", "23124"),
  rfRow("Class 1", "XXL", "353.205", "230.4", "1533"),
  rfRow("Doubles", "All Weight", "191.043", "150.7", "1268"),
  rfRow("waste", "{oversized}", "2.916", "416.6", "7"),
].join("\n");

test("real export shape: the repeated lot-total WEIGHT is never used for any row's kg", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];

  // None of the resolved sizes should equal the lot total (11118.075) — every
  // value must come from that row's own first-group WEIGHT column.
  assert.strictEqual(r.sizeKg["Small"], 34.123);
  assert.strictEqual(r.sizeKg["Medium"], 468.121);
  assert.strictEqual(r.sizeKg["Large"], 1380.906);
  assert.strictEqual(r.sizeKg["SXL"], 3257.101);
  assert.strictEqual(r.sizeKg["XL"], 4489.312);
  assert.strictEqual(r.sizeKg["XXL"], 353.205);
});

test("real export shape: SM through XXL total exactly 9,982.768 kg", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  const mappedTotal =
    r.sizeKg["Small"] + r.sizeKg["Medium"] + r.sizeKg["Large"] +
    r.sizeKg["SXL"] + r.sizeKg["XL"] + r.sizeKg["XXL"];

  assert.strictEqual(Math.round(mappedTotal * 1000) / 1000, 9982.768);
});

test("real export shape: Class 1 rows use SIZE1 (SM/MD/LG/SXL/XL/XXL) for size mapping, ignoring MARKET's grade text", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  // Every Class 1 + standard-code row above mapped straight to a real size —
  // "Class 1" itself never appears as a size or an unknown label.
  assert.ok(!("Class 1" in r.sizeKg));
  assert.ok(!r.unknownSizes.includes("CLASS 1"));
});

test("real export shape: unresolved MARKET values (24ct, Green, Doubles) and the SIZE1 special labels (underweight, {oversized}) all surface as unknown, keyed by the more specific label", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];

  // 24ct's row is 0.000 kg, so it's dropped entirely (nothing to resolve).
  assert.ok(!r.unknownSizes.includes("24CT"));

  // Green/Doubles have SIZE1="All Weight" (no specific size info) — MARKET
  // is the label that needs a rule.
  assert.ok(r.unknownSizes.includes("GREEN"));
  assert.strictEqual(r.sizeKg["GREEN"], 943.702);
  assert.ok(r.unknownSizes.includes("DOUBLES"));
  assert.strictEqual(r.sizeKg["DOUBLES"], 191.043);

  // underweight/{oversized} carry real sub-classification info in SIZE1, so
  // SIZE1 is the label even though their MARKET ("Class 1" / "waste") differs.
  assert.ok(r.unknownSizes.includes("UNDERWEIGHT"));
  assert.strictEqual(r.sizeKg["UNDERWEIGHT"], 0.562);
  assert.ok(r.unknownSizes.includes("{OVERSIZED}"));
  assert.strictEqual(r.sizeKg["{OVERSIZED}"], 2.916);

  for (const label of ["GREEN", "DOUBLES", "UNDERWEIGHT", "{OVERSIZED}"]) {
    assert.ok(
      r.warnings.some((w) => w === `New size found: ${label}. Add this size in GrowLink before importing.`)
    );
  }
});

test("real export shape: zero-kg summary row (24ct, WEIGHT=0.000) contributes nothing and needs no rule", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  assert.ok(!("24CT" in r.sizeKg));
  assert.ok(!r.unknownSizes.includes("24CT"));
  assert.ok(!r.warnings.some((w) => w.includes("24CT")));
});

test("real export shape: averageFruitWeightG is combined from included (SM–XXL) kg and PCS only", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  const includedKg = 34.123 + 468.121 + 1380.906 + 3257.101 + 4489.312 + 353.205;
  const includedPieces = 374 + 3899 + 9611 + 19585 + 23124 + 1533;
  assert.strictEqual(r.averageFruitWeightG, (includedKg * 1000) / includedPieces);
});

test("real export shape: DDMMYYYY date-only BEGINDT (no time) parses correctly and does not warn 'Start time not found'", () => {
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  assert.strictEqual(r.startDate, "2026-08-17");
  assert.strictEqual(r.startTime, "2026-08-17 00:00");
  assert.strictEqual(r.isoYear, 2026);
  assert.ok(!r.warnings.some((w) => w === "Start time not found in CSV."));
});

test("date-only BEGINDT still supports an explicit time when present (unaffected by the date-only fallback)", () => {
  const csv = [RF_HEADERS, rfRow("Class 1", "SM", "10", "100", "100").replace("17082026", "17082026 08:30:00")].join("\n");
  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.startTime, "2026-08-17 08:30");
});

test("real export shape: {oversized} normalizes brace/case/space variants to the same match key as a plain 'oversized' rule", () => {
  // Parsed straight from the CSV, the raw label keeps its original braces —
  // only the *matching* is brace/case/space-insensitive (verified against
  // flowmaster_size_rules' normalizeSizeRuleLabel in the integration test
  // below); this test just confirms the parser's own display label is
  // untouched.
  const r = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  assert.ok(r.unknownSizes.includes("{OVERSIZED}"), "original brace label is preserved for display");
});

// ─── Integration: parser output → flowmaster_size_rules resolution ──────────
// Proves the full pipeline a real upload goes through: raw CSV → parser
// (produces sizeKg/unknownSizes) → resolveFileSizes (applies saved org rules,
// same function pdfImport.ts / agentPendingImports.ts both call). Confirms
// MARKET-derived and SIZE1-derived unknown labels are resolved identically
// through the existing rules engine with no parser-side special casing.

function fakeOrgSizeContext(
  activeSizeNames: string[],
  rules: Array<Omit<SizeRuleRecord, "id"> & { id?: string }>
): OrgSizeContext {
  const activeYieldSizeNameByCanonical = new Map<string, string>();
  const activeSizeNameById = new Map<string, string>();
  activeSizeNames.forEach((name, i) => {
    const id = `size-${i}-${name}`;
    activeYieldSizeNameByCanonical.set(canonicalizeSizeName(name), name);
    activeSizeNameById.set(id, name);
  });

  const rulesByNormalizedLabel = new Map<string, SizeRuleRecord>();
  rules.forEach((r, i) => {
    rulesByNormalizedLabel.set(normalizeSizeRuleLabel(r.rawLabel), { id: r.id ?? `rule-${i}`, ...r });
  });

  return { activeYieldSizeNameByCanonical, activeSizeNameById, rulesByNormalizedLabel };
}

function sizeIdFor(ctx: OrgSizeContext, name: string): string {
  for (const [id, n] of ctx.activeSizeNameById.entries()) {
    if (n === name) return id;
  }
  throw new Error(`No active size id for ${name} in test context`);
}

test("integration: ignored MARKET values (Green, Doubles) ignore the whole row once a saved Ignore rule exists", () => {
  const parsed = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  const baseCtx = fakeOrgSizeContext(["Small", "Medium", "Large", "SXL", "XL", "XXL"], []);
  const ctx: OrgSizeContext = {
    ...baseCtx,
    rulesByNormalizedLabel: new Map([
      ["green", { id: "r1", rawLabel: "Green", action: "ignore", targetSizeId: null, distributeSizeIds: [] }],
      ["doubles", { id: "r2", rawLabel: "Doubles", action: "ignore", targetSizeId: null, distributeSizeIds: [] }],
    ]),
  };

  const resolved = resolveFileSizes(parsed.sizeKg, parsed.unknownSizes, ctx);

  assert.ok(!("GREEN" in resolved.sizeKg));
  assert.ok(!("DOUBLES" in resolved.sizeKg));
  assert.ok(!resolved.unknownSizes.includes("GREEN"));
  assert.ok(!resolved.unknownSizes.includes("DOUBLES"));
  // Ignored rows' kg must not leak into any real size total.
  const total = Object.values(resolved.sizeKg).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 9982.768 - 0.562 - 2.916) < 0.001); // SM–XXL + underweight + oversized (still unresolved), no Green/Doubles
});

test("integration: MARKET Map/Distribute rule (24ct) applies to the row's first WEIGHT value", () => {
  const csvWithNonZero24ct = REAL_LOT_CSV.replace(
    rfRow("24ct", "All Weight", "0.000", "0.0", "0"),
    rfRow("24ct", "All Weight", "500.000", "150.0", "3000")
  );
  const parsed = parseFlowMasterCsv(csvWithNonZero24ct, "lot-2608170362.csv")[0];
  assert.strictEqual(parsed.sizeKg["24CT"], 500);

  const ctx = fakeOrgSizeContext(["Small", "Medium", "Large", "SXL", "XL", "XXL"], [
    { rawLabel: "24ct", action: "distribute", targetSizeId: null, distributeSizeIds: [] },
  ]);
  // Point distribute at XL/XXL specifically (using their real generated ids).
  const distributeRule = ctx.rulesByNormalizedLabel.get("24ct")!;
  distributeRule.distributeSizeIds = [sizeIdFor(ctx, "XL"), sizeIdFor(ctx, "XXL")];

  const resolved = resolveFileSizes(parsed.sizeKg, parsed.unknownSizes, ctx);

  assert.ok(!("24CT" in resolved.sizeKg));
  assert.ok(!resolved.unknownSizes.includes("24CT"));
  // 500kg distributed proportionally to XL (4489.312) / XXL (353.205) existing kg.
  const xlBefore = 4489.312;
  const xxlBefore = 353.205;
  assert.ok(resolved.sizeKg["XL"]! > xlBefore);
  assert.ok(resolved.sizeKg["XXL"]! > xxlBefore);
  const distributedTotal = (resolved.sizeKg["XL"]! - xlBefore) + (resolved.sizeKg["XXL"]! - xxlBefore);
  assert.ok(Math.abs(distributedTotal - 500) < 0.01);
});

test("integration: a specific 24ct MARKET rule resolves independently of a separate, unrelated Green MARKET rule (both pair with SIZE1=All Weight)", () => {
  const csvWithNonZero24ct = REAL_LOT_CSV.replace(
    rfRow("24ct", "All Weight", "0.000", "0.0", "0"),
    rfRow("24ct", "All Weight", "500.000", "150.0", "3000")
  );
  const parsed = parseFlowMasterCsv(csvWithNonZero24ct, "lot-2608170362.csv")[0];

  // 24ct and Green are two DIFFERENT MARKET values that both happen to pair
  // with SIZE1=All Weight — each must resolve via its own specific rule,
  // never conflated into one generic "All Weight" bucket.
  const ctx = fakeOrgSizeContext(["Small", "Medium", "Large", "SXL", "XL", "XXL"], [
    { rawLabel: "24ct", action: "map", targetSizeId: null, distributeSizeIds: [] },
    { rawLabel: "Green", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
  ]);
  ctx.rulesByNormalizedLabel.get("24ct")!.targetSizeId = sizeIdFor(ctx, "XL");

  const resolved = resolveFileSizes(parsed.sizeKg, parsed.unknownSizes, ctx);

  assert.ok(!("24CT" in resolved.sizeKg));
  assert.ok(!("GREEN" in resolved.sizeKg));
  assert.strictEqual(resolved.sizeKg["XL"], 4489.312 + 500); // 24ct mapped into XL
  // Green's 943.702kg is gone (ignored), not folded into XL or anywhere else.
  const total = Object.values(resolved.sizeKg).reduce((a, b) => a + b, 0);
  assert.ok(total < 9982.768 + 500 + 943.702 + 1); // Green's kg excluded from the total
});

test("integration: underweight and {oversized} SIZE1 special-label rules work independently", () => {
  const parsed = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  const ctx = fakeOrgSizeContext(["Small", "Medium", "Large", "SXL", "XL", "XXL"], [
    { rawLabel: "underweight", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { rawLabel: "oversized", action: "map", targetSizeId: null, distributeSizeIds: [] },
  ]);
  const oversizedRule = ctx.rulesByNormalizedLabel.get("oversized")!;
  oversizedRule.targetSizeId = sizeIdFor(ctx, "XXL");

  const resolved = resolveFileSizes(parsed.sizeKg, parsed.unknownSizes, ctx);

  assert.ok(!("UNDERWEIGHT" in resolved.sizeKg));
  assert.ok(!("{OVERSIZED}" in resolved.sizeKg));
  assert.strictEqual(resolved.sizeKg["XXL"], 353.205 + 2.916); // oversized mapped into XXL
  assert.ok(!resolved.unknownSizes.includes("UNDERWEIGHT"));
  assert.ok(!resolved.unknownSizes.includes("{OVERSIZED}"));
});

test("integration: a saved MARKET Ignore rule (waste) suppresses a row whose SIZE1 is a recognized direct code (SM) — must NOT become Small", () => {
  const csv = [
    RF_HEADERS,
    rfRow("Class 1", "SM", "34.123", "91.2", "374"),
    rfRow("waste", "SM", "5.5", "90.0", "60"), // hypothetical: a wasted small pepper
  ].join("\n");

  const parsed = parseFlowMasterCsv(csv, "waste-sm.csv")[0];

  // At raw-parse time the pure parser has no rules access, so both rows'
  // kg provisionally land under "Small" — that's expected/correct for the
  // parser's own pass. csvRowKg preserves each row's raw MARKET/SIZE1 facts
  // so this can be corrected once rules are loaded.
  assert.strictEqual(parsed.sizeKg["Small"], 34.123 + 5.5);
  assert.strictEqual(parsed.csvRowKg.length, 2);

  const ctx = fakeOrgSizeContext(["Small"], [
    { rawLabel: "waste", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
  ]);

  // This mirrors exactly what pdfImport.ts's /pdf-import/preview and
  // agentPendingImports.ts's buildPreviewFile now do before calling
  // resolveFileSizes: re-derive sizeKg/unknownSizes from the raw per-row
  // facts with the org's saved rules factored into MARKET-vs-SIZE1 priority.
  const reResolved = resolveCsvRowLabels(parsed.csvRowKg, [], {}, ctx.rulesByNormalizedLabel);
  const resolved = resolveFileSizes(reResolved.sizeKg, reResolved.unknownSizes, ctx);

  // The waste row's 5.5kg is excluded entirely — never folded into Small.
  assert.strictEqual(resolved.sizeKg["Small"], 34.123);
  assert.ok(!resolved.unknownSizes.includes("WASTE"));
});

test("integration: with NO saved MARKET rule, waste+SM still maps straight to Small (unaffected baseline)", () => {
  const csv = [RF_HEADERS, rfRow("waste", "SM", "5.5", "90.0", "60")].join("\n");
  const parsed = parseFlowMasterCsv(csv, "waste-sm.csv")[0];

  const ctx = fakeOrgSizeContext(["Small"], []); // no rules at all
  const reResolved = resolveCsvRowLabels(parsed.csvRowKg, [], {}, ctx.rulesByNormalizedLabel);
  const resolved = resolveFileSizes(reResolved.sizeKg, reResolved.unknownSizes, ctx);

  assert.strictEqual(resolved.sizeKg["Small"], 5.5);
});

test("integration: a rule saved for '{oversized}' (braces) matches a later file whose SIZE1 has no braces, thanks to normalizeSizeRuleLabel", () => {
  const csv = [RF_HEADERS, rfRow("waste", "OVERSIZED", "5.0", "400", "12")].join("\n"); // no braces this time
  const parsed = parseFlowMasterCsv(csv, "later-file.csv")[0];
  assert.deepStrictEqual(parsed.unknownSizes, ["OVERSIZED"]);

  const ctx = fakeOrgSizeContext(["XXL"], [
    { rawLabel: "{oversized}", action: "map", targetSizeId: null, distributeSizeIds: [] }, // saved WITH braces originally
  ]);
  const rule = ctx.rulesByNormalizedLabel.get(normalizeSizeRuleLabel("{oversized}"))!;
  rule.targetSizeId = sizeIdFor(ctx, "XXL");

  const resolved = resolveFileSizes(parsed.sizeKg, parsed.unknownSizes, ctx);
  assert.strictEqual(resolved.sizeKg["XXL"], 5);
  assert.ok(!resolved.unknownSizes.includes("OVERSIZED"));
});

test("integration: saved rules are reused identically across repeated/later imports of the same labels", () => {
  const ctx = fakeOrgSizeContext(["Small", "Medium", "Large", "SXL", "XL", "XXL"], [
    { rawLabel: "Green", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { rawLabel: "Doubles", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
  ]);

  // Simulate two separate uploads (e.g. two different weeks' files) reusing
  // the SAME saved rules without any reconfiguration in between.
  const firstImport = parseFlowMasterCsv(REAL_LOT_CSV, "week1.csv")[0];
  const secondImport = parseFlowMasterCsv(REAL_LOT_CSV.replace("2608170362", "2608170399"), "week2.csv")[0];

  const resolvedFirst = resolveFileSizes(firstImport.sizeKg, firstImport.unknownSizes, ctx);
  const resolvedSecond = resolveFileSizes(secondImport.sizeKg, secondImport.unknownSizes, ctx);

  for (const resolved of [resolvedFirst, resolvedSecond]) {
    assert.ok(!("GREEN" in resolved.sizeKg));
    assert.ok(!("DOUBLES" in resolved.sizeKg));
    assert.ok(!resolved.unknownSizes.includes("GREEN"));
    assert.ok(!resolved.unknownSizes.includes("DOUBLES"));
  }
});

test("integration: once resolveFileSizes resolves a label via a saved rule, it no longer appears in unknownSizes/sizeMappingStatus.unmapped (no stale 'New size found')", () => {
  const parsed = parseFlowMasterCsv(REAL_LOT_CSV, "lot-2608170362.csv")[0];
  // Parser's own raw warnings still contain the "New size found" strings —
  // callers (pdfImport.ts, agentPendingImports.ts) are responsible for
  // stripping those before re-adding resolveFileSizes' own warnings, exactly
  // as both route files now do.
  assert.ok(parsed.warnings.some((w) => w.startsWith("New size found: GREEN")));

  const ctx = fakeOrgSizeContext(["Small", "Medium", "Large", "SXL", "XL", "XXL"], [
    { rawLabel: "Green", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { rawLabel: "Doubles", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { rawLabel: "underweight", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
    { rawLabel: "oversized", action: "ignore", targetSizeId: null, distributeSizeIds: [] },
  ]);

  const resolved = resolveFileSizes(parsed.sizeKg, parsed.unknownSizes, ctx);

  // Once resolved, none of the previously-unknown labels remain unmapped —
  // the caller-facing "New size found" warning (regenerated from
  // sizeMappingStatus.unmapped, see sizeMapping.ts) will not be re-emitted
  // for any of them.
  assert.deepStrictEqual(resolved.unknownSizes, []);
  assert.strictEqual(resolved.sizeMappingStatus.unmappedCount, 0);
  assert.ok(!resolved.sizeWarnings.some((w) => w.includes("GREEN")));
  assert.ok(!resolved.sizeWarnings.some((w) => w.includes("DOUBLES")));
});

// ─── Zero values / missing optional fields — no duplicate totals, no divide-by-zero ───

test("zero-kg rows across the whole file produce totalKg = null and averageFruitWeightG = null without throwing", () => {
  const csv = [
    RF_HEADERS,
    rfRow("24ct", "All Weight", "0.000", "0.0", "0"),
    rfRow("Class 1", "SM", "0", "0", "0"),
  ].join("\n");

  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.deepStrictEqual(r.sizeKg, {});
  assert.strictEqual(r.totalKg, null);
  assert.strictEqual(r.averageFruitWeightG, null);
});

test("missing AVG/PCS columns entirely (old-format-style headers) does not throw and leaves averageFruitWeightG null for new-format rows lacking them", () => {
  const headers = "LOTID,LOTNUMBER,VARIETY,BEGINDT,MARKET,SIZE1,WEIGHT";
  const dataRow = ["LOT_A", "LOT001", "Variety", "01012026 09:00:00", "Class 1", "SM", "50"].join(",");
  const csv = [headers, dataRow].join("\n");

  const r = parseFlowMasterCsv(csv, "test.csv")[0];
  assert.strictEqual(r.sizeKg["Small"], 50);
  assert.strictEqual(r.averageFruitWeightG, null);
});
