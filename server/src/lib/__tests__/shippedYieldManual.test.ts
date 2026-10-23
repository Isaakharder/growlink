// Manual pack entries in the authoritative shipped-yield calculation (no database):
// source precedence per week, shared measurements, no double counting.
// Run: node --require tsx/cjs --test src/lib/__tests__/shippedYieldManual.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateManualEntries,
  computeShippedYield,
  evaluateSeries,
  isDocklinkOwnedWeek,
  measurementKey,
  resolveWeekSource,
  type LegacyRow,
  type ManualEntryRow,
  type MeasurementRow,
  type PackScopeState,
  type ShipmentRow
} from "../shippedYield";

const RED = "a3f00000-0000-4000-8000-000000000001";
const TRI = "d91b0000-0000-4000-8000-000000000004";
const OLD = "0c000000-0000-4000-8000-0000000000c1";

const scope: PackScopeState = { status: "available", first: { year: 2026, week: 45 }, last: { year: 2026, week: 48 } };
const close = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);

let n = 0;
function manual(o: Partial<ManualEntryRow> & { iso_week: number; cases: number }): ManualEntryRow {
  n += 1;
  return {
    id: `m${n}`, iso_year: 2026, pack_source: "docklink", pack_id: RED, pack_name: "Red 5kg", pack_code: "RL5",
    color_kind: "single", color_key: "red", crop_type: "pepper", tracking_unit: "kg", invoice_ref: null, ...o
  };
}
const triManual = (week: number, cases: number, invoice: string | null = null) =>
  manual({ iso_week: week, cases, pack_id: TRI, pack_name: "Tri-Colour 3pk", pack_code: "TC3", color_kind: "mixed", color_key: "mixed", invoice_ref: invoice });

function single(week: number, kg: number, o: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    iso_year: 2026, iso_week: week, series_key: null, pack_source: "docklink", pack_id: RED, color_kind: "single", color_key: "red",
    crop_type: "pepper", tracking_unit: "kg", net_kg_per_case: kg, components: null, copied_from_iso_year: null, copied_from_iso_week: null, ...o
  };
}
const RAINBOW = [
  { color: "red" as const, pieces_per_case: 15, fruit_weight_g: 180 },
  { color: "yellow" as const, pieces_per_case: 15, fruit_weight_g: 175 },
  { color: "orange" as const, pieces_per_case: 15, fruit_weight_g: 170 }
];
const rainbow = (week: number): MeasurementRow => ({
  ...single(week, 0), pack_id: TRI, color_kind: "mixed", color_key: "mixed", net_kg_per_case: null, components: RAINBOW
});
const legacy = (week: number, color: string, cases: number, weight = 5.15): LegacyRow => ({
  year: 2026, week, color, total_cases: cases, case_weight_kg: weight, total_kg: cases * weight, source: "docklink"
});
const imported = (week: number, cases: number, seriesKey = "s-red-5kg"): ShipmentRow => ({
  iso_year: 2026, iso_week: week, series_key: seriesKey, attribution: "pack", pack_id: RED, source_pack_ref: null, pack_name: "Red 5kg",
  pack_code: "RL5", color_key: "red", color_kind: "single", crop_type: "pepper", tracking_unit: "kg", total_cases: cases
});

// ---------------------------------------------------------------------------

test("source precedence: DockLink scope, then the week's explicit choice, then manual-only, then colour totals", () => {
  const r = (o: Partial<Parameters<typeof resolveWeekSource>[0]>) =>
    resolveWeekSource({ scope, year: 2026, week: 40, choice: null, manualEntries: 0, legacyRows: 0, ...o });
  assert.deepEqual(r({ week: 46, manualEntries: 3, legacyRows: 2, choice: "manual_packs" }), { source: "packs", reason: "docklink_scope", needsSourceDecision: false });
  assert.deepEqual(r({ choice: "manual_packs", legacyRows: 4 }), { source: "manual", reason: "chosen_manual", needsSourceDecision: false });
  assert.deepEqual(r({ choice: "legacy_colours", manualEntries: 4 }), { source: "legacy", reason: "chosen_legacy", needsSourceDecision: false });
  assert.deepEqual(r({ manualEntries: 2 }), { source: "manual", reason: "manual_only", needsSourceDecision: false });
  assert.deepEqual(r({ manualEntries: 2, legacyRows: 1 }), { source: "legacy", reason: "undecided", needsSourceDecision: true });
  assert.deepEqual(r({ legacyRows: 1 }), { source: "legacy", reason: "legacy_only", needsSourceDecision: false });
  // Transition week (44) is not DockLink's: manual history may replace its colour totals.
  assert.deepEqual(r({ week: 44, manualEntries: 1, legacyRows: 2, choice: "manual_packs" }).source, "manual");
});

test("DockLink-owned weeks: from the announced first pack week on, available or pending; never before it", () => {
  assert.equal(isDocklinkOwnedWeek(scope, 2026, 44), false);
  assert.equal(isDocklinkOwnedWeek(scope, 2026, 45), true);
  assert.equal(isDocklinkOwnedWeek(scope, 2027, 2), true, "beyond last_week is still DockLink's");
  assert.equal(isDocklinkOwnedWeek({ ...scope, status: "pending_first_full_week" }, 2026, 45), true);
  assert.equal(isDocklinkOwnedWeek({ status: "capture_not_active", first: null, last: null }, 2026, 45), false);
  assert.equal(isDocklinkOwnedWeek(null, 2026, 45), false);
});

test("several invoices for the same week and pack add up, and use the week's average net kg per case", () => {
  const result = computeShippedYield({
    range: null, scope, shipments: [], legacy: [],
    manual: [manual({ iso_week: 30, cases: 400, invoice_ref: "INV-1001" }), manual({ iso_week: 30, cases: 250, invoice_ref: "INV-1002" })],
    measurements: [single(30, 5.12)]
  });
  const w = result.weeks[0];
  assert.equal(w.source, "manual");
  assert.equal(w.shippedCases, 650);
  close(w.kg, 650 * 5.12);
  close(w.colors.red.kg, 650 * 5.12);
  assert.equal(w.colors.red.cases, 650);
  assert.equal(w.complete, true);
});

test("manual rainbow pack: kg per colour = cases × peppers per shipping case × fruit weight ÷ 1000; cases counted once", () => {
  const w = computeShippedYield({
    range: null, scope, shipments: [], legacy: [], manual: [triManual(30, 300, "INV-7"), triManual(30, 320, "INV-8")], measurements: [rainbow(30)]
  }).weeks[0];
  assert.equal(w.mixedCases, 620);
  assert.equal(w.shippedCases, 620);
  close(w.colors.red.kg, (620 * 15 * 180) / 1000);
  close(w.colors.yellow.kg, (620 * 15 * 175) / 1000);
  close(w.colors.orange.kg, (620 * 15 * 170) / 1000);
  close(w.kg, (620 * 15 * (180 + 175 + 170)) / 1000);
});

test("manual and imported cases use the same calculation and the same measurement for the same pack and classification", () => {
  const m = single(47, 5.12, { series_key: "s-red-5kg" });
  const importedResult = evaluateSeries(imported(47, 100), [m]);
  const [manualRow] = aggregateManualEntries([manual({ iso_week: 47, cases: 100 })]);
  const manualResult = evaluateSeries(manualRow, [m]);
  assert.equal(importedResult.status, "measured");
  assert.equal(manualResult.status, "measured");
  close(manualResult.kg, importedResult.kg);
  assert.equal(measurementKey(manualRow), measurementKey(imported(47, 1)));
  // A measurement entered from the manual side (no series key) applies to DockLink's series too.
  close(evaluateSeries(imported(47, 100, "a-renamed-series-key"), [single(47, 5.12)]).kg, 512, "series_key changes don't orphan measurements");
});

test("a historical pack never shares a measurement with a DockLink pack, even with the same id text", () => {
  const [row] = aggregateManualEntries([manual({ iso_week: 30, cases: 10, pack_source: "historical", pack_id: RED })]);
  assert.equal(evaluateSeries(row, [single(30, 5)]).status, "missing");
  assert.equal(evaluateSeries(row, [single(30, 5, { pack_source: "historical" })]).status, "measured");
});

test("missing measurements stay missing for manual entries too (never 0 kg, week incomplete)", () => {
  const w = computeShippedYield({ range: null, scope, shipments: [], legacy: [], manual: [manual({ iso_week: 30, cases: 100 }), triManual(30, 50)], measurements: [single(30, 5)] }).weeks[0];
  assert.equal(w.kg, 500);
  assert.equal(w.unmeasuredCases, 50);
  assert.equal(w.complete, false);
});

test("no double counting: a manual week replaces its colour totals; DockLink weeks ignore manual entries; both are reported, never added", () => {
  const result = computeShippedYield({
    range: null,
    scope,
    shipments: [imported(46, 1720)],
    measurements: [single(30, 5), single(46, 5)],
    legacy: [legacy(30, "red", 999), legacy(30, "yellow", 1), legacy(46, "red", 1700)],
    manual: [manual({ iso_week: 30, cases: 600 }), manual({ iso_week: 46, cases: 77 })],
    weekSources: [{ iso_year: 2026, iso_week: 30, source: "manual_packs" }]
  });
  const [w30, w46] = result.weeks;
  assert.equal(w30.source, "manual");
  assert.equal(w30.shippedCases, 600, "colour totals for the week are not added");
  assert.deepEqual(w30.notCounted, { manualCases: 0, manualEntries: 0, legacyCases: 1000, legacyRows: 2 });
  assert.equal(w46.source, "packs");
  assert.equal(w46.shippedCases, 1720, "manual entries in a DockLink week are not added");
  assert.deepEqual(w46.notCounted, { manualCases: 77, manualEntries: 1, legacyCases: 1700, legacyRows: 1 });
  assert.equal(result.totals.shippedCases, 2320);
  assert.equal(result.totals.manualWeeks, 1);
  assert.equal(result.totals.packWeeks, 1);
  assert.equal(result.totals.weeksWithUncountedManualEntries, 1);
});

test("both manual entries and colour totals without a choice: colour totals count and the week is flagged", () => {
  const result = computeShippedYield({
    range: null, scope, shipments: [], measurements: [single(31, 5)],
    legacy: [legacy(31, "red", 900)], manual: [manual({ iso_week: 31, cases: 880 })]
  });
  const w = result.weeks[0];
  assert.equal(w.source, "legacy");
  assert.equal(w.needsSourceDecision, true);
  assert.equal(w.shippedCases, 900);
  assert.deepEqual(w.notCounted, { manualCases: 880, manualEntries: 1, legacyCases: 0, legacyRows: 0 });
  assert.equal(result.totals.weeksNeedingSourceDecision, 1);
});

test("colour totals chosen explicitly: manual entries are kept but not counted", () => {
  const w = computeShippedYield({
    range: null, scope, shipments: [], measurements: [], legacy: [legacy(32, "red", 900)], manual: [manual({ iso_week: 32, cases: 10 })],
    weekSources: [{ iso_year: 2026, iso_week: 32, source: "legacy_colours" }]
  }).weeks[0];
  assert.equal(w.source, "legacy");
  assert.equal(w.needsSourceDecision, false);
  assert.equal(w.shippedCases, 900);
  assert.equal(w.notCounted.manualCases, 10);
});

test("manual weeks before DockLink's capture need no DockLink sync at all", () => {
  const result = computeShippedYield({ range: null, scope: null, shipments: [], legacy: [], manual: [manual({ iso_week: 12, iso_year: 2025, cases: 40 })], measurements: [{ ...single(12, 5), iso_year: 2025 }] });
  assert.equal(result.weeks[0].source, "manual");
  close(result.totals.kg, 200);
});

test("non-pepper and colourless manual packs are kept out of pepper totals", () => {
  const w = computeShippedYield({
    range: null, scope, shipments: [], measurements: [], legacy: [],
    manual: [
      manual({ iso_week: 33, cases: 12, pack_id: "cuke", pack_name: "Mini Cukes", color_kind: "none", color_key: "", crop_type: "cucumber", tracking_unit: "piece" }),
      manual({ iso_week: 33, cases: 5, pack_id: "bulk", pack_name: "Bulk no colour", color_kind: "none", color_key: "" })
    ]
  }).weeks[0];
  assert.deepEqual(w.nonPepper, [{ cropType: "cucumber", trackingUnit: "piece", cases: 12 }]);
  assert.equal(w.attentionCases, 5);
  assert.equal(w.kg, 0);
});

test("week range filters manual entries like every other source", () => {
  const result = computeShippedYield({
    range: { from: { year: 2026, week: 30 }, to: { year: 2026, week: 30 } }, scope, shipments: [], legacy: [], measurements: [],
    manual: [manual({ iso_week: 29, cases: 1 }), manual({ iso_week: 30, cases: 2 }), manual({ iso_week: 31, cases: 4 })]
  });
  assert.deepEqual(result.weeks.map((w) => `${w.isoWeek}:${w.shippedCases}`), ["30:2"]);
});

test("aggregation keeps different classifications of one pack apart", () => {
  const rows = aggregateManualEntries([
    manual({ iso_week: 30, cases: 10 }),
    manual({ iso_week: 30, cases: 5 }),
    manual({ iso_week: 30, cases: 7, color_key: "orange" }),
    manual({ iso_week: 30, cases: 3, pack_source: "historical", pack_id: OLD })
  ]);
  assert.deepEqual(rows.map((r) => `${r.pack_source}:${r.pack_id}:${r.color_key}:${r.total_cases}:${r.entry_count}`).sort(), [
    `docklink:${RED}:orange:7:1`,
    `docklink:${RED}:red:15:2`,
    `historical:${OLD}:red:3:1`
  ]);
});
