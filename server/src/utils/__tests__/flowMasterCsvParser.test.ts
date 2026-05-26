import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlowMasterCsv } from "../flowMasterCsvParser";

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

test("new format: AVG column provides averageFruitWeightG", () => {
  const csv = [
    NF_HEADERS,
    nfRow("LOT_001", "LOT001", "Variety", "01012026 09:00:00", "XL", 100),
  ].join("\n");

  // nfRow helper sets AVG = 302 in every row
  const r = parseFlowMasterCsv(csv, "real.csv")[0];
  assert.strictEqual(r.averageFruitWeightG, 302);
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
