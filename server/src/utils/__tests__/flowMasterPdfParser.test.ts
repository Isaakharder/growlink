import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseFlowMasterPdf } from "../flowMasterPdfParser";

const FIXTURE = path.resolve(__dirname, "..", "..", "..", "test-fixtures", "WEEK 18 2.pdf");

test("parses variety, dates, and ISO week", async () => {
  const result = await parseFlowMasterPdf(FIXTURE);

  assert.strictEqual(result.sourceFile, "WEEK 18 2.pdf");
  assert.strictEqual(result.varietyName, "Silverstone");
  assert.strictEqual(result.startTime, "2026-04-29 10:01");
  assert.strictEqual(result.startDate, "2026-04-29");
  assert.strictEqual(result.isoYear, 2026);
  assert.strictEqual(result.isoWeek, 18);
});

test("parses total kg and average fruit weight", async () => {
  const result = await parseFlowMasterPdf(FIXTURE);

  assert.strictEqual(result.totalKg, 14602);
  assert.strictEqual(result.averageFruitWeightG, 302);
});

test("parses size kg breakdown", async () => {
  const result = await parseFlowMasterPdf(FIXTURE);

  assert.strictEqual(result.sizeKg["Small"], 25);
  assert.strictEqual(result.sizeKg["Medium"], 35);
  assert.strictEqual(result.sizeKg["Large"], 72);
  assert.strictEqual(result.sizeKg["SXL"], 198);
  assert.strictEqual(result.sizeKg["XL"], 1591);
  assert.strictEqual(result.sizeKg["XXL"], 12680);
});

test("no unknown sizes and no warnings for clean PDF", async () => {
  const result = await parseFlowMasterPdf(FIXTURE);

  assert.deepStrictEqual(result.unknownSizes, []);
  assert.deepStrictEqual(result.warnings, []);
});
