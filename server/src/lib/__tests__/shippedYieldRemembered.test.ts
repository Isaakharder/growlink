// Remembered measurements ("Remember for future weeks") in the authoritative
// shipped-yield calculation (no database): precedence over the week's own
// measurement, imported and manual cases, effective-from versions (history is
// never recalculated), forgetting, and rainbow counts vs fruit weights.
// Run: node --require tsx/cjs --test src/lib/__tests__/shippedYieldRemembered.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeShippedYield,
  evaluateSeries,
  rememberedFor,
  type ManualEntryRow,
  type MeasurementDefaultRow,
  type MeasurementRow,
  type PackScopeState,
  type RebuildRange,
  type ShipmentRow
} from "../shippedYield";

const RED = "a3f00000-0000-4000-8000-000000000001";
const TRI = "d91b0000-0000-4000-8000-000000000004";
const HIST = "0c000000-0000-4000-8000-0000000000c1";

const close = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);
const scope: PackScopeState = { status: "available", first: { year: 2026, week: 45 }, last: { year: 2026, week: 48 } };
const rebuild: RebuildRange[] = [{ from: { year: 2026, week: 16 }, to: { year: 2026, week: 43 } }];

function remember(week: number, o: Partial<MeasurementDefaultRow> = {}): MeasurementDefaultRow {
  return {
    pack_source: "docklink", pack_id: RED, color_kind: "single", color_key: "red", crop_type: "pepper", tracking_unit: "kg",
    value_kind: "net_kg", effective_from_iso_year: 2026, effective_from_iso_week: week, forgotten: false, net_kg_per_case: 5, components: null, ...o
  };
}
const forget = (week: number, o: Partial<MeasurementDefaultRow> = {}) => remember(week, { forgotten: true, net_kg_per_case: null, ...o });
const triCounts = (week: number, counts: Record<string, number>, o: Partial<MeasurementDefaultRow> = {}) =>
  remember(week, {
    pack_id: TRI, color_kind: "mixed", color_key: "mixed", value_kind: "counts", net_kg_per_case: null,
    components: Object.entries(counts).map(([color, n]) => ({ color: color as "red", pieces_per_case: n })), ...o
  });
const triWeights = (week: number, weights: Record<string, number>, o: Partial<MeasurementDefaultRow> = {}) =>
  remember(week, {
    pack_id: TRI, color_kind: "mixed", color_key: "mixed", value_kind: "fruit_weights", net_kg_per_case: null,
    components: Object.entries(weights).map(([color, g]) => ({ color: color as "red", fruit_weight_g: g })), ...o
  });

function measured(week: number, kg: number, o: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    iso_year: 2026, iso_week: week, series_key: null, pack_source: "docklink", pack_id: RED, color_kind: "single", color_key: "red",
    crop_type: "pepper", tracking_unit: "kg", net_kg_per_case: kg, components: null, copied_from_iso_year: null, copied_from_iso_week: null, ...o
  };
}
const imported = (week: number, cases: number, o: Partial<ShipmentRow> = {}): ShipmentRow => ({
  iso_year: 2026, iso_week: week, series_key: `s-${week}`, attribution: "pack", pack_id: RED, source_pack_ref: null, pack_name: "Red 5kg",
  pack_code: "RL5", color_key: "red", color_kind: "single", crop_type: "pepper", tracking_unit: "kg", total_cases: cases, ...o
});
let n = 0;
function manual(week: number, cases: number, o: Partial<ManualEntryRow> = {}): ManualEntryRow {
  n += 1;
  return {
    id: `m${n}`, iso_year: 2026, iso_week: week, pack_source: "docklink", pack_id: RED, pack_name: "Red 5kg", pack_code: "RL5",
    color_kind: "single", color_key: "red", crop_type: "pepper", tracking_unit: "kg", cases, invoice_ref: null, ...o
  };
}

const yieldFor = (input: Partial<Parameters<typeof computeShippedYield>[0]>) =>
  computeShippedYield({ range: null, scope: null, shipments: [], measurements: [], legacy: [], rebuildRanges: rebuild, ...input });
const weekOf = (r: ReturnType<typeof computeShippedYield>, week: number) => r.weeks.find((w) => w.isoWeek === week)!;

// ---------------------------------------------------------------------------

test("precedence: the week's own measurement wins; otherwise the remembered weight; otherwise missing", () => {
  const defaults = [remember(20, { net_kg_per_case: 5 })];
  const own = evaluateSeries(imported(30, 100), [measured(30, 4.5)], defaults);
  assert.equal(own.status, "measured");
  close(own.kg, 450);
  const fromDefault = evaluateSeries(imported(30, 100), [], defaults);
  assert.equal(fromDefault.status, "remembered");
  close(fromDefault.kg, 500);
  assert.equal(fromDefault.remembered?.netKg.value, 5);
  assert.deepEqual(fromDefault.remembered?.netKg.from, { year: 2026, week: 20 });
  // Before the week it was remembered from, nothing applies.
  assert.equal(evaluateSeries(imported(19, 100), [], defaults).status, "missing");
  // A week measurement for another classification doesn't block this classification's remembered weight.
  const other = measured(30, 9, { color_key: "yellow" });
  assert.equal(evaluateSeries(imported(30, 100), [other], defaults).status, "remembered");
});

test("applies to manual and imported cases alike, by pack and classification only", () => {
  const defaults = [remember(16, { net_kg_per_case: 5.2 })];
  // Manual weeks (rebuild range): several invoices for the same pack aggregate, then use the remembered weight.
  const manualWeeks = yieldFor({ manual: [manual(16, 40), manual(16, 60), manual(17, 10)], defaults });
  close(weekOf(manualWeeks, 16).kg, 520);
  assert.equal(weekOf(manualWeeks, 16).rememberedCases, 100);
  assert.equal(weekOf(manualWeeks, 16).measuredCases, 100);
  assert.equal(weekOf(manualWeeks, 16).complete, true);
  close(weekOf(manualWeeks, 17).kg, 52);
  // DockLink pack weeks use the same remembered weight.
  const packWeeks = yieldFor({ scope, shipments: [imported(46, 10)], defaults });
  close(weekOf(packWeeks, 46).kg, 52);
  assert.equal(weekOf(packWeeks, 46).rememberedCases, 10);
  // A different pack, pack source or classification never picks it up.
  assert.equal(evaluateSeries(imported(30, 1, { pack_id: TRI }), [], defaults).status, "missing");
  assert.equal(evaluateSeries(imported(30, 1, { pack_source: "historical" }), [], defaults).status, "missing");
  assert.equal(evaluateSeries(imported(30, 1, { color_key: "yellow" }), [], defaults).status, "missing");
  assert.equal(evaluateSeries(imported(30, 1, { tracking_unit: "box" }), [], defaults).status, "attention");
  // Historical packs remember on their own identity.
  const hist = [remember(16, { pack_source: "historical", pack_id: HIST, net_kg_per_case: 4 })];
  const histWeek = yieldFor({ manual: [manual(18, 25, { pack_source: "historical", pack_id: HIST })], defaults: hist });
  close(weekOf(histWeek, 18).kg, 100);
});

test("a one-week override doesn't change the remembered default; clearing it falls back to the default", () => {
  const defaults = [remember(16, { net_kg_per_case: 5 })];
  const entries = [manual(20, 10), manual(21, 10), manual(22, 10)];
  const withOverride = yieldFor({ manual: entries, measurements: [measured(21, 6)], defaults });
  close(weekOf(withOverride, 20).kg, 50);
  close(weekOf(withOverride, 21).kg, 60);
  assert.equal(weekOf(withOverride, 21).rememberedCases, 0);
  close(weekOf(withOverride, 22).kg, 50);
  const cleared = yieldFor({ manual: entries, measurements: [], defaults });
  close(weekOf(cleared, 21).kg, 50);
});

test("changing the default at a week leaves earlier weeks as they were; a later version still takes over", () => {
  const entries = [16, 20, 25, 30, 35, 40].map((w) => manual(w, 10));
  const before = yieldFor({ manual: entries, defaults: [remember(16, { net_kg_per_case: 5 }), remember(35, { net_kg_per_case: 7 })] });
  const after = yieldFor({
    manual: entries,
    defaults: [remember(16, { net_kg_per_case: 5 }), remember(25, { net_kg_per_case: 6 }), remember(35, { net_kg_per_case: 7 })]
  });
  for (const w of [16, 20]) close(weekOf(after, w).kg, weekOf(before, w).kg, `W${w} unchanged`);
  close(weekOf(after, 25).kg, 60);
  close(weekOf(after, 30).kg, 60);
  close(weekOf(after, 35).kg, 70);
  close(weekOf(after, 40).kg, 70);
  const slot = rememberedFor([remember(16), remember(25, { net_kg_per_case: 6 }), remember(35)], imported(30, 1), 2026, 30).netKg;
  assert.deepEqual(slot, { value: 6, from: { year: 2026, week: 25 }, nextChange: { year: 2026, week: 35 } });
  // Remembered across a year boundary.
  close(evaluateSeries(imported(2, 10, { iso_year: 2027 }), [], [remember(40, { net_kg_per_case: 5 })]).kg, 50);
});

test("forgetting at a week stops it from that week on; earlier weeks keep it", () => {
  const entries = [20, 30, 40].map((w) => manual(w, 10));
  const r = yieldFor({ manual: entries, defaults: [remember(16, { net_kg_per_case: 5 }), forget(30)] });
  close(weekOf(r, 20).kg, 50);
  assert.equal(weekOf(r, 30).unmeasuredCases, 10);
  assert.equal(weekOf(r, 30).complete, false);
  assert.equal(weekOf(r, 40).kg, 0);
  assert.equal(rememberedFor([remember(16), forget(30)], imported(30, 1), 2026, 30).netKg.value, null);
  // Remembering again later resumes from there.
  const resumed = yieldFor({ manual: entries, defaults: [remember(16, { net_kg_per_case: 5 }), forget(30), remember(40, { net_kg_per_case: 4 })] });
  close(weekOf(resumed, 40).kg, 40);
  assert.equal(weekOf(resumed, 30).kg, 0);
});

test("rainbow: counts and fruit weights are remembered separately; both are needed for kg", () => {
  const tri = (week: number, cases: number) => manual(week, cases, { pack_id: TRI, pack_name: "Tri-Colour", color_kind: "mixed", color_key: "mixed" });
  const counts = triCounts(16, { red: 5, yellow: 5, orange: 5 });
  // Counts only: still missing (fruit weights change week to week), never zero.
  const countsOnly = yieldFor({ manual: [tri(20, 10)], defaults: [counts] });
  assert.equal(weekOf(countsOnly, 20).unmeasuredCases, 10);
  assert.equal(weekOf(countsOnly, 20).kg, 0);
  // Counts remembered, this week's measurement (full components) wins.
  const week20 = [{ color: "red" as const, pieces_per_case: 5, fruit_weight_g: 200 }, { color: "yellow" as const, pieces_per_case: 5, fruit_weight_g: 180 }];
  const own = yieldFor({
    manual: [tri(20, 10)], defaults: [counts],
    measurements: [measured(20, 0, { pack_id: TRI, color_kind: "mixed", color_key: "mixed", net_kg_per_case: null, components: week20 })]
  });
  close(weekOf(own, 20).kg, (10 * 5 * 200 + 10 * 5 * 180) / 1000);
  // Counts + fruit weights remembered: kg per colour.
  const both = yieldFor({ manual: [tri(20, 10), tri(30, 10)], defaults: [counts, triWeights(16, { red: 200, yellow: 180, orange: 170 }), triWeights(30, { red: 210, yellow: 190, orange: 160 })] });
  const w20 = weekOf(both, 20);
  close(w20.colors.red.kg, 10);
  close(w20.colors.yellow.kg, 9);
  close(w20.colors.orange.kg, 8.5);
  assert.equal(w20.mixedCases, 10);
  assert.equal(w20.rememberedCases, 10);
  // Fruit weights changed from W30; counts kept; W20 unchanged.
  const w30 = weekOf(both, 30);
  close(w30.colors.red.kg, 10.5);
  close(w30.colors.orange.kg, 8);
  // A remembered colour without a remembered fruit weight: not usable.
  const gap = yieldFor({ manual: [tri(20, 10)], defaults: [counts, triWeights(16, { red: 200, yellow: 180 })] });
  assert.equal(weekOf(gap, 20).unmeasuredCases, 10);
  // Forgetting fruit weights keeps the counts remembered.
  const r = rememberedFor([counts, triWeights(16, { red: 200 }), triWeights(25, {}, { forgotten: true, components: null })], tri(30, 1) as never, 2026, 30);
  assert.equal(r.fruitWeights.value, null);
  assert.deepEqual(r.counts.value?.map((c) => c.color), ["red", "yellow", "orange"]);
});
