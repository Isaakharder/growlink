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
