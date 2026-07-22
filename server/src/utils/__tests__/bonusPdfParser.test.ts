import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBonusPdfFromText } from "../bonusPdfParser";

const PICKING_TEXT = `Period: 2026-07-12 - 2026-07-18
Filter:
Company: First Light
Employee Kg/Hr Paid time #rows
Ramos, Ricardo, Melo 99.2 Kg/Hr 5:23 7.67
Rojas, Jovito, Campos 121.7 Kg/Hr 3:56 4.47
Raya Avila, Rafael 126.9 Kg/Hr 25:25 31.98
Sanchez, Daniel, Rivera 168.7 Kg/Hr 3:51 6.00
Ramos, Isaia, Garcia 180.4 Kg/Hr 46:01 72.01
Galiote Aguilar, Ruben, Rosalio 200.3 Kg/Hr 48:02 70.72
Perez Hernandez, Severiano 202.9 Kg/Hr 54:33 103.75
Cauich, Hermenegildo, Ceh 217.2 Kg/Hr 14:11 23.93
Martinez Avalos, Jose, Carmen 280.0 Kg/Hr 2:20 6.00
Grand Total 184.6 Kg/Hr 203:42 326.54`;

const WP_TEXT = `Period: 2026-07-12 - 2026-07-18
Filter:
Company: First Light
Employee Plants Per Hour Paid time
Ramos, Ricardo, Melo 128 Plants/Hr 47:06
Joseph, Patrick, Larios 131 Plants/Hr 61:31
Sanchez, Daniel, Rivera 155 Plants/Hr 56:39
Miss Miss, Antonio 215 Plants/Hr 49:46
Grand Total 253 Plants/Hr 668:35`;

test("Kg/Hr report is detected as picking_peppers", () => {
  const result = extractBonusPdfFromText(PICKING_TEXT, "WP Rate hrs picking.pdf");
  assert.strictEqual(result.checkType, "picking_peppers");
  assert.strictEqual(result.periodStart, "2026-07-12");
  assert.strictEqual(result.periodEnd, "2026-07-18");
  assert.strictEqual(result.company, "First Light");
  assert.strictEqual(result.rows.length, 9);
});

test("Plants/Hr report is detected as winding_pruning", () => {
  const result = extractBonusPdfFromText(WP_TEXT, "WP Rate hrs.pdf");
  assert.strictEqual(result.checkType, "winding_pruning");
  assert.strictEqual(result.rows.length, 4);
});

test("parses name, speed, and paid-time-to-hours conversion", () => {
  const result = extractBonusPdfFromText(PICKING_TEXT, "picking.pdf");
  const row = result.rows.find((r) => r.rawName === "Ramos, Isaia, Garcia");
  assert.ok(row);
  assert.strictEqual(row!.enteredSpeed, 180.4);
  assert.strictEqual(row!.rawPaidTime, "46:01");
  // 46h 1m -> 46 + 1/60 = 46.0166... rounded to 2dp
  assert.strictEqual(row!.hoursWorked, 46.02);
});

test("trailing #rows column is ignored, not mistaken for paid time", () => {
  const result = extractBonusPdfFromText(PICKING_TEXT, "picking.pdf");
  const row = result.rows.find((r) => r.rawName === "Rojas, Jovito, Campos");
  assert.ok(row);
  assert.strictEqual(row!.rawPaidTime, "3:56");
});

test("Grand Total row is excluded from rows and captured separately", () => {
  const result = extractBonusPdfFromText(PICKING_TEXT, "picking.pdf");
  assert.ok(!result.rows.some((r) => r.rawName.toLowerCase() === "grand total"));
  assert.ok(result.grandTotal);
  assert.strictEqual(result.grandTotal!.enteredSpeed, 184.6);
});

test("header and metadata lines produce no rows", () => {
  const result = extractBonusPdfFromText("Period: 2026-07-12 - 2026-07-18\nFilter:\nCompany: First Light\nEmployee Kg/Hr Paid time #rows", "empty.pdf");
  assert.strictEqual(result.rows.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("No employee rows")));
});
