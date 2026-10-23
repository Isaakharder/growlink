// The authoritative shipped-yield calculation (no database).
// Run: node --require tsx/cjs --test src/lib/__tests__/shippedYield.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyShipment,
  computeShippedYield,
  evaluateSeries,
  type LegacyRow,
  type MeasurementRow,
  type PackScopeState,
  type ShipmentRow
} from "../shippedYield";

const RED = "pack-red";
const TRI = "pack-tri";

const scope = (first = 45, last = 48, status: "available" | "pending_first_full_week" | "capture_not_active" = "available"): PackScopeState => ({
  status,
  first: { year: 2026, week: first },
  last: { year: 2026, week: last }
});

function ship(o: Partial<ShipmentRow> & { iso_week: number; series_key: string; total_cases: number }): ShipmentRow {
  return {
    iso_year: 2026, attribution: "pack", pack_id: RED, source_pack_ref: null, pack_name: "Red 5kg", pack_code: "RL5",
    color_key: "red", color_kind: "single", crop_type: "pepper", tracking_unit: "kg", ...o
  };
}
const tri = (week: number, cases: number) =>
  ship({ iso_week: week, series_key: "s-tri", pack_id: TRI, pack_name: "Tri-Colour 3pk", pack_code: "TC3", color_key: "mixed", color_kind: "mixed", total_cases: cases });

function single(week: number, seriesKey: string, kg: number, o: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    iso_year: 2026, iso_week: week, series_key: seriesKey, pack_id: RED, color_kind: "single", color_key: "red", crop_type: "pepper", tracking_unit: "kg",
    net_kg_per_case: kg, components: null, copied_from_iso_year: null, copied_from_iso_week: null, ...o
  };
}
function mixed(week: number, components: MeasurementRow["components"], o: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    iso_year: 2026, iso_week: week, series_key: "s-tri", pack_id: TRI, color_kind: "mixed", color_key: "mixed", crop_type: "pepper", tracking_unit: "kg",
    net_kg_per_case: null, components, copied_from_iso_year: null, copied_from_iso_week: null, ...o
  };
}
const legacy = (week: number, color: string, cases: number, weight: number, source = "docklink"): LegacyRow => ({
  year: 2026, week, color, total_cases: cases, case_weight_kg: weight, total_kg: cases * weight, source
});

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} != ${b}`);

// ---------------------------------------------------------------------------

test("single-colour pack: kg = shipped cases × average net kg per shipping case", () => {
  const r = evaluateSeries(ship({ iso_week: 47, series_key: "s-red", total_cases: 1840 }), [single(47, "s-red", 5.12)]);
  assert.equal(r.status, "measured");
  close(r.kg, 1840 * 5.12);
  close(r.kgByColor.red!, 1840 * 5.12);
});

test("rainbow pack: each colour's kg = cases × peppers per shipping case × fruit weight g ÷ 1000; total is the sum", () => {
  // 620 shipping cases, each holding 15 retail 3-packs: 15 of each colour per case.
  const r = evaluateSeries(tri(47, 620), [
    mixed(47, [
      { color: "red", pieces_per_case: 15, fruit_weight_g: 180 },
      { color: "yellow", pieces_per_case: 15, fruit_weight_g: 175 },
      { color: "orange", pieces_per_case: 15, fruit_weight_g: 170 }
    ])
  ]);
  assert.equal(r.status, "measured");
  close(r.kgByColor.red!, (620 * 15 * 180) / 1000);
  close(r.kgByColor.yellow!, (620 * 15 * 175) / 1000);
  close(r.kgByColor.orange!, (620 * 15 * 170) / 1000);
  close(r.kg, (620 * 15 * (180 + 175 + 170)) / 1000);
});

test("a rainbow pack's cases are counted once in the week, not once per colour", () => {
  const result = computeShippedYield({
    range: null,
    scope: scope(),
    shipments: [ship({ iso_week: 47, series_key: "s-red", total_cases: 100 }), tri(47, 620)],
    measurements: [single(47, "s-red", 5), mixed(47, [{ color: "red", pieces_per_case: 15, fruit_weight_g: 180 }, { color: "yellow", pieces_per_case: 15, fruit_weight_g: 175 }])],
    legacy: []
  });
  const w = result.weeks[0];
  assert.equal(w.shippedCases, 720);
  assert.equal(w.mixedCases, 620);
  assert.equal(w.colors.red.cases, 100, "colour cases are single-colour cases only");
  close(w.colors.red.kg, 100 * 5 + (620 * 15 * 180) / 1000);
  close(w.colors.yellow.kg, (620 * 15 * 175) / 1000);
  close(w.kg, w.colors.red.kg + w.colors.yellow.kg);
  assert.equal(w.complete, true);
});

test("missing measurements stay missing: no kg, counted as unmeasured, total labelled incomplete", () => {
  const result = computeShippedYield({
    range: null, scope: scope(),
    shipments: [ship({ iso_week: 47, series_key: "s-red", total_cases: 100 }), tri(47, 50)],
    measurements: [single(47, "s-red", 5)],
    legacy: []
  });
  const w = result.weeks[0];
  assert.equal(w.kg, 500);
  assert.equal(w.measuredCases, 100);
  assert.equal(w.unmeasuredCases, 50);
  assert.equal(w.complete, false);
  assert.equal(result.totals.complete, false);
});

test("a rainbow measurement with a component missing its fruit weight is not usable", () => {
  const r = evaluateSeries(tri(47, 10), [mixed(47, [{ color: "red", pieces_per_case: 15, fruit_weight_g: 0 }])]);
  assert.equal(r.status, "missing");
  assert.equal(r.kg, 0);
});

test("reclassified pack: a measurement entered against another ship-time classification is never applied", () => {
  // Same series key, but the measurement was entered while the series was red; it is now orange.
  const now = ship({ iso_week: 47, series_key: "s-sweet", color_key: "orange", total_cases: 80 });
  const r = evaluateSeries(now, [single(47, "s-sweet", 0.25, { color_key: "red" })]);
  assert.equal(r.status, "incompatible");
  assert.equal(r.kg, 0);
  // A different series of the same pack (its red shipments) keeps its own measurement.
  const red = evaluateSeries(ship({ iso_week: 47, series_key: "s-sweet-red", total_cases: 40 }), [single(47, "s-sweet-red", 0.25)]);
  assert.equal(red.status, "measured");
  close(red.kg, 10);
});

test("a single-colour measurement cannot be applied to a mixed series and vice versa", () => {
  const r = evaluateSeries(tri(47, 10), [single(47, "s-tri", 5, { pack_id: TRI })]);
  assert.equal(r.status, "incompatible");
});

test("classification uses the shipment's own ship-time fields", () => {
  assert.deepEqual(classifyShipment({ attribution: "unattributed", color_key: "red", color_kind: "single", crop_type: "pepper", tracking_unit: "kg" }), { kind: "attention", reason: "unattributed" });
  assert.deepEqual(classifyShipment({ attribution: "pack", color_key: "purple", color_kind: "single", crop_type: "pepper", tracking_unit: "kg" }), { kind: "attention", reason: "unsupported_colour" });
  assert.deepEqual(classifyShipment({ attribution: "pack", color_key: null, color_kind: "none", crop_type: "pepper", tracking_unit: "kg" }), { kind: "attention", reason: "unsupported_kind" });
  assert.deepEqual(classifyShipment({ attribution: "pack", color_key: "red", color_kind: "single", crop_type: "pepper", tracking_unit: "units" }), { kind: "attention", reason: "unsupported_unit" });
  assert.deepEqual(classifyShipment({ attribution: "pack", color_key: null, color_kind: null, crop_type: null, tracking_unit: null }), { kind: "attention", reason: "unknown_crop" });
  assert.deepEqual(classifyShipment({ attribution: "pack", color_key: null, color_kind: "none", crop_type: "Herb", tracking_unit: "units" }), { kind: "non_pepper" });
  assert.deepEqual(classifyShipment({ attribution: "pack", color_key: " RED ", color_kind: "Single", crop_type: "Pepper", tracking_unit: "KG" }), { kind: "single", color: "red" });
});

test("unattributed and unsupported shipments need attention: counted as shipped cases, never given a colour or kg", () => {
  const result = computeShippedYield({
    range: null, scope: scope(),
    shipments: [
      ship({ iso_week: 47, series_key: "s-red", total_cases: 100 }),
      ship({ iso_week: 47, series_key: "s-un", attribution: "unattributed", pack_id: null, source_pack_ref: "pallet:7", color_key: null, color_kind: null, crop_type: null, tracking_unit: null, total_cases: 45 }),
      ship({ iso_week: 47, series_key: "s-purple", color_key: "purple", total_cases: 30 })
    ],
    measurements: [single(47, "s-red", 5)],
    legacy: []
  });
  const w = result.weeks[0];
  assert.equal(w.attentionCases, 75);
  assert.equal(w.shippedCases, 175);
  assert.equal(w.kg, 500);
  assert.equal(w.colors.red.cases, 100);
  assert.equal(w.complete, false);
});

test("non-pepper products are kept separate and never enter pepper cases or kg", () => {
  const w = computeShippedYield({
    range: null, scope: scope(),
    shipments: [ship({ iso_week: 47, series_key: "s-red", total_cases: 100 }), ship({ iso_week: 47, series_key: "s-basil", pack_id: "basil", color_key: null, color_kind: "none", crop_type: "herb", tracking_unit: "units", total_cases: 200 })],
    measurements: [single(47, "s-red", 5)],
    legacy: []
  }).weeks[0];
  assert.equal(w.shippedCases, 100);
  assert.deepEqual(w.nonPepper, [{ cropType: "herb", trackingUnit: "units", cases: 200 }]);
  assert.equal(w.complete, true);
});

test("explicit zero and voided series contribute nothing and need no measurement", () => {
  const w = computeShippedYield({ range: null, scope: scope(), shipments: [ship({ iso_week: 48, series_key: "s-red", total_cases: 0 })], measurements: [], legacy: [] }).weeks[0];
  assert.deepEqual([w.shippedCases, w.unmeasuredCases, w.kg, w.complete], [0, 0, 0, true]);
});

// ---------------------------------------------------------------------------
// Cutover: one source per week, never both
// ---------------------------------------------------------------------------

test("cutover: legacy colour totals before the first covered week, pack totals within scope, never both for one week", () => {
  const result = computeShippedYield({
    range: null,
    scope: scope(45, 48),
    shipments: [ship({ iso_week: 45, series_key: "s-red", total_cases: 1500 })],
    measurements: [single(45, "s-red", 5)],
    legacy: [
      legacy(44, "red", 1400, 5.15), // transition week: colour totals
      legacy(45, "red", 1500, 5.15), // DockLink still writes colour rows for pack weeks — must not be added
      legacy(45, "yellow", 10, 5, "manual") // a manual entry for a pack week — kept, superseded
    ]
  });
  assert.deepEqual(result.weeks.map((w) => [w.isoWeek, w.source]), [[44, "legacy"], [45, "packs"]]);
  const w45 = result.weeks[1];
  assert.equal(w45.shippedCases, 1500, "not 3010");
  assert.equal(w45.kg, 7500);
  assert.equal(w45.supersededLegacyRows, 2);
  close(result.weeks[0].kg, 1400 * 5.15, "legacy weeks keep their stored kg");
  assert.equal(result.totals.packWeeks, 1);
  assert.equal(result.totals.legacyWeeks, 1);
});

test("pending or not-active scope: every week uses legacy colour totals; stored pack rows are ignored", () => {
  for (const status of ["pending_first_full_week", "capture_not_active"] as const) {
    const result = computeShippedYield({
      range: null, scope: scope(45, 48, status),
      shipments: [ship({ iso_week: 45, series_key: "s-red", total_cases: 1500 })],
      measurements: [single(45, "s-red", 5)],
      legacy: [legacy(45, "red", 1490, 5.15)]
    });
    assert.deepEqual(result.weeks.map((w) => [w.isoWeek, w.source, w.shippedCases]), [[45, "legacy", 1490]]);
  }
});

test("moving coverage boundary: when first_week moves later, the uncovered week falls back to legacy (and back again)", () => {
  const input = {
    range: null,
    shipments: [ship({ iso_week: 45, series_key: "s-red", total_cases: 1500 }), ship({ iso_week: 46, series_key: "s-red", total_cases: 1700 })],
    measurements: [single(45, "s-red", 5), single(46, "s-red", 5)],
    legacy: [legacy(45, "red", 1500, 5.15), legacy(46, "red", 1700, 5.15)]
  };
  const before = computeShippedYield({ ...input, scope: scope(45, 48) });
  assert.deepEqual(before.weeks.map((w) => w.source), ["packs", "packs"]);
  const moved = computeShippedYield({ ...input, scope: scope(46, 48) });
  assert.deepEqual(moved.weeks.map((w) => [w.isoWeek, w.source]), [[45, "legacy"], [46, "packs"]]);
  close(moved.totals.kg, 1500 * 5.15 + 1700 * 5);
  const back = computeShippedYield({ ...input, scope: scope(45, 48) });
  assert.deepEqual(back.totals, before.totals);
});

test("legacy rows with no case weight are unmeasured, not 0 kg", () => {
  const w = computeShippedYield({ range: null, scope: null, shipments: [], measurements: [], legacy: [legacy(30, "red", 100, 0, "manual")] }).weeks[0];
  assert.deepEqual([w.shippedCases, w.measuredCases, w.unmeasuredCases, w.kg, w.complete], [100, 0, 100, 0, false]);
});

test("range scoping: only weeks in the selected ISO range are counted, across a year boundary", () => {
  const result = computeShippedYield({
    range: { from: { year: 2026, week: 46 }, to: { year: 2026, week: 47 } },
    scope: scope(),
    shipments: [45, 46, 47, 48].map((w) => ship({ iso_week: w, series_key: "s-red", total_cases: 100 })),
    measurements: [45, 46, 47, 48].map((w) => single(w, "s-red", 5)),
    legacy: [legacy(40, "red", 999, 5)]
  });
  assert.deepEqual(result.weeks.map((w) => w.isoWeek), [46, 47]);
  assert.equal(result.totals.kg, 1000);

  const yearBoundary = computeShippedYield({
    range: { from: { year: 2025, week: 52 }, to: { year: 2026, week: 2 } },
    scope: null, shipments: [], measurements: [],
    legacy: [{ ...legacy(52, "red", 1, 5), year: 2025 }, legacy(1, "red", 2, 5), legacy(3, "red", 4, 5)]
  });
  assert.equal(yearBoundary.totals.shippedCases, 3);
});

test("range totals are exactly the sum of the weeks (one calculation for every screen)", () => {
  const result = computeShippedYield({
    range: null, scope: scope(45, 48),
    shipments: [ship({ iso_week: 45, series_key: "s-red", total_cases: 10 }), tri(46, 20), ship({ iso_week: 47, series_key: "s-red", total_cases: 30 })],
    measurements: [single(45, "s-red", 5), mixed(46, [{ color: "green", pieces_per_case: 10, fruit_weight_g: 200 }])],
    legacy: [legacy(44, "orange", 7, 5)]
  });
  const sum = (f: (w: (typeof result.weeks)[number]) => number) => result.weeks.reduce((s, w) => s + f(w), 0);
  close(result.totals.kg, sum((w) => w.kg));
  assert.equal(result.totals.shippedCases, sum((w) => w.shippedCases));
  assert.equal(result.totals.unmeasuredCases, sum((w) => w.unmeasuredCases));
  for (const c of ["red", "orange", "yellow", "green"] as const) close(result.totals.colors[c].kg, sum((w) => w.colors[c].kg), c);
  assert.equal(result.totals.unmeasuredCases, 30);
});
