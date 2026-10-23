// The one authoritative shipped-yield calculation (shipped cases and kg by
// pepper colour, per ISO week). Used, through GET /api/shipped-yield, by the
// Cases tab, the Dashboard, Yield Analytics and the iOS workspace, so every
// screen shows the same numbers. Pure: callers load the rows.
//
// Source per week — never both:
//   * a week inside DockLink's authoritative pack scope (sync state
//     "available", first_week..last_week) uses pack shipments, with kg from
//     the measurements entered in GrowLink;
//   * every other week uses the legacy colour totals (color_case_entries:
//     DockLink colour sync and manual entries), with their stored kg.
//
// Pack weeks:
//   * single-colour pack: kg = cases × net kg per shipping case
//   * mixed/rainbow pack, per colour: kg = cases × peppers per shipping case
//     × fruit weight g ÷ 1000; the pack's total kg is the sum of its colours
//     and its cases are counted once
//   * a measurement applies only to the series and ship-time classification
//     it was entered against; missing measurements stay missing (never 0)
//   * unattributed shipments and unsupported classifications are counted as
//     needing attention, never guessed into a colour
//   * non-pepper products are reported separately and never enter pepper totals

import { weekOrdinal, type ScopeStatus } from "./docklinkPackExport";

export const PEPPER_COLORS = ["red", "orange", "yellow", "green"] as const;
export type PepperColor = (typeof PEPPER_COLORS)[number];
const isPepperColor = (v: unknown): v is PepperColor => typeof v === "string" && (PEPPER_COLORS as readonly string[]).includes(v);

export type WeekRef = { year: number; week: number };
export type WeekRange = { from: WeekRef; to: WeekRef } | null;

export type PackScopeState = {
  status: ScopeStatus;
  first: WeekRef | null;
  last: WeekRef | null;
} | null;

export type ShipmentRow = {
  iso_year: number;
  iso_week: number;
  series_key: string;
  attribution: "pack" | "unattributed";
  pack_id: string | null;
  source_pack_ref: string | null;
  pack_name: string | null;
  pack_code: string | null;
  color_key: string | null;
  color_kind: string | null;
  crop_type: string | null;
  tracking_unit: string | null;
  total_cases: number;
  /** Informational only (shown on the weekly screen); not used in any calculation. */
  load_count?: number;
};

export type MeasurementComponent = { color: PepperColor; pieces_per_case: number; fruit_weight_g: number };

export type MeasurementRow = {
  iso_year: number;
  iso_week: number;
  series_key: string;
  pack_id: string;
  color_kind: "single" | "mixed";
  color_key: string | null;
  crop_type: string;
  tracking_unit: string;
  net_kg_per_case: number | null;
  components: MeasurementComponent[] | null;
  copied_from_iso_year: number | null;
  copied_from_iso_week: number | null;
};

export type LegacyRow = {
  year: number;
  week: number;
  color: string;
  total_cases: number;
  case_weight_kg: number;
  total_kg: number;
  source: string | null;
};

// ---------------------------------------------------------------------------
// Classification of one shipment series (by its OWN ship-time fields)
// ---------------------------------------------------------------------------

export type AttentionReason = "unattributed" | "unsupported_colour" | "unsupported_kind" | "unsupported_unit" | "unknown_crop";

export type Classification =
  | { kind: "single"; color: PepperColor }
  | { kind: "mixed" }
  | { kind: "non_pepper" }
  | { kind: "attention"; reason: AttentionReason };

const norm = (v: string | null | undefined) => (typeof v === "string" ? v.trim().toLowerCase() : "");

export function classifyShipment(row: Pick<ShipmentRow, "attribution" | "color_key" | "color_kind" | "crop_type" | "tracking_unit">): Classification {
  if (row.attribution === "unattributed") return { kind: "attention", reason: "unattributed" };
  const crop = norm(row.crop_type);
  if (!crop) return { kind: "attention", reason: "unknown_crop" };
  if (crop !== "pepper") return { kind: "non_pepper" };
  if (norm(row.tracking_unit) !== "kg") return { kind: "attention", reason: "unsupported_unit" };
  const colorKind = norm(row.color_kind);
  if (colorKind === "single") {
    const color = norm(row.color_key);
    return isPepperColor(color) ? { kind: "single", color } : { kind: "attention", reason: "unsupported_colour" };
  }
  if (colorKind === "mixed") return { kind: "mixed" };
  return { kind: "attention", reason: "unsupported_kind" };
}

/** True when `m` was entered against exactly this series' ship-time classification. */
export function measurementMatches(m: MeasurementRow, row: ShipmentRow): boolean {
  return (
    m.series_key === row.series_key &&
    m.pack_id === row.pack_id &&
    norm(m.color_kind) === norm(row.color_kind) &&
    norm(m.color_key) === norm(row.color_key) &&
    norm(m.crop_type) === norm(row.crop_type) &&
    norm(m.tracking_unit) === norm(row.tracking_unit)
  );
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function measurementUsable(m: MeasurementRow): boolean {
  if (m.color_kind === "single") return positive(m.net_kg_per_case) && m.components === null;
  return (
    Array.isArray(m.components) &&
    m.components.length > 0 &&
    m.components.every((c) => isPepperColor(c.color) && positive(c.pieces_per_case) && positive(c.fruit_weight_g))
  );
}

export type SeriesStatus = "measured" | "missing" | "incompatible" | "attention" | "non_pepper" | "zero";

export type SeriesResult = {
  row: ShipmentRow;
  classification: Classification;
  status: SeriesStatus;
  measurement: MeasurementRow | null;
  kgByColor: Partial<Record<PepperColor, number>>;
  kg: number;
};

/** kg for one series in one week, given every measurement for that week. */
export function evaluateSeries(row: ShipmentRow, weekMeasurements: MeasurementRow[]): SeriesResult {
  const classification = classifyShipment(row);
  const cases = Number(row.total_cases) || 0;
  const base = { row, classification, kgByColor: {}, kg: 0 };

  if (classification.kind === "non_pepper") return { ...base, status: "non_pepper", measurement: null };
  if (classification.kind === "attention") return { ...base, status: cases > 0 ? "attention" : "zero", measurement: null };

  const sameSeries = weekMeasurements.filter((m) => m.series_key === row.series_key);
  const measurement = sameSeries.find((m) => measurementMatches(m, row)) ?? null;
  if (cases === 0) return { ...base, status: "zero", measurement };
  if (!measurement) {
    return { ...base, status: sameSeries.length > 0 ? "incompatible" : "missing", measurement: sameSeries[0] ?? null };
  }
  if (!measurementUsable(measurement)) return { ...base, status: "missing", measurement };

  if (classification.kind === "single") {
    const kg = cases * (measurement.net_kg_per_case as number);
    return { ...base, status: "measured", measurement, kgByColor: { [classification.color]: kg }, kg };
  }

  const kgByColor: Partial<Record<PepperColor, number>> = {};
  let kg = 0;
  for (const c of measurement.components ?? []) {
    const colorKg = (cases * c.pieces_per_case * c.fruit_weight_g) / 1000;
    kgByColor[c.color] = (kgByColor[c.color] ?? 0) + colorKg;
    kg += colorKg;
  }
  return { ...base, status: "measured", measurement, kgByColor, kg };
}

// ---------------------------------------------------------------------------
// Weekly and range totals
// ---------------------------------------------------------------------------

export type ColorTotals = Record<PepperColor, { kg: number; cases: number }>;

export type NonPepperTotal = { cropType: string; trackingUnit: string | null; cases: number };

export type WeekTotals = {
  isoYear: number;
  isoWeek: number;
  source: "packs" | "legacy";
  /** kg per colour (rainbow components included) and single-colour/legacy cases per colour. */
  colors: ColorTotals;
  /** Rainbow/mixed cases — counted once, not per colour. */
  mixedCases: number;
  /** All pepper shipping cases this week, each counted once. */
  shippedCases: number;
  measuredCases: number;
  /** Cases of supported packs with no usable measurement (missing or entered against another classification). */
  unmeasuredCases: number;
  /** Unattributed shipments and unsupported classifications. */
  attentionCases: number;
  kg: number;
  complete: boolean;
  nonPepper: NonPepperTotal[];
  /** Legacy colour rows for this week ignored because pack totals are authoritative. */
  supersededLegacyRows: number;
};

export type ShippedYieldTotals = Omit<WeekTotals, "isoYear" | "isoWeek" | "source" | "supersededLegacyRows"> & {
  weekCount: number;
  packWeeks: number;
  legacyWeeks: number;
};

export type ShippedYieldResult = {
  range: WeekRange;
  scope: PackScopeState;
  weeks: WeekTotals[];
  totals: ShippedYieldTotals;
};

const emptyColors = (): ColorTotals => ({ red: { kg: 0, cases: 0 }, orange: { kg: 0, cases: 0 }, yellow: { kg: 0, cases: 0 }, green: { kg: 0, cases: 0 } });

export function isPackWeek(scope: PackScopeState, year: number, week: number): boolean {
  if (!scope || scope.status !== "available" || !scope.first || !scope.last) return false;
  const ord = weekOrdinal(year, week);
  return ord >= weekOrdinal(scope.first.year, scope.first.week) && ord <= weekOrdinal(scope.last.year, scope.last.week);
}

export function inRange(range: WeekRange, year: number, week: number): boolean {
  if (!range) return true;
  const ord = weekOrdinal(year, week);
  const a = weekOrdinal(range.from.year, range.from.week);
  const b = weekOrdinal(range.to.year, range.to.week);
  return ord >= Math.min(a, b) && ord <= Math.max(a, b);
}

function addNonPepper(list: NonPepperTotal[], cropType: string, trackingUnit: string | null, cases: number) {
  const existing = list.find((n) => n.cropType === cropType && n.trackingUnit === trackingUnit);
  if (existing) existing.cases += cases;
  else list.push({ cropType, trackingUnit, cases });
}

function packWeekTotals(year: number, week: number, rows: ShipmentRow[], measurements: MeasurementRow[], supersededLegacyRows: number): WeekTotals {
  const totals: WeekTotals = {
    isoYear: year, isoWeek: week, source: "packs", colors: emptyColors(), mixedCases: 0, shippedCases: 0,
    measuredCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 0, complete: true, nonPepper: [], supersededLegacyRows
  };
  for (const row of rows) {
    const cases = Number(row.total_cases) || 0;
    const result = evaluateSeries(row, measurements);
    if (result.status === "non_pepper") {
      if (cases > 0) addNonPepper(totals.nonPepper, norm(row.crop_type), row.tracking_unit, cases);
      continue;
    }
    if (result.status === "zero") continue;
    totals.shippedCases += cases;
    if (result.classification.kind === "single") totals.colors[result.classification.color].cases += cases;
    if (result.classification.kind === "mixed") totals.mixedCases += cases;
    if (result.status === "attention") totals.attentionCases += cases;
    else if (result.status === "measured") totals.measuredCases += cases;
    else totals.unmeasuredCases += cases;
    for (const color of PEPPER_COLORS) {
      const kg = result.kgByColor[color] ?? 0;
      totals.colors[color].kg += kg;
      totals.kg += kg;
    }
  }
  totals.complete = totals.unmeasuredCases === 0 && totals.attentionCases === 0;
  return totals;
}

function legacyWeekTotals(year: number, week: number, rows: LegacyRow[]): WeekTotals {
  const totals: WeekTotals = {
    isoYear: year, isoWeek: week, source: "legacy", colors: emptyColors(), mixedCases: 0, shippedCases: 0,
    measuredCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 0, complete: true, nonPepper: [], supersededLegacyRows: 0
  };
  for (const row of rows) {
    const color = norm(row.color);
    const cases = Number(row.total_cases) || 0;
    if (!isPepperColor(color) || cases <= 0) continue;
    totals.shippedCases += cases;
    totals.colors[color].cases += cases;
    // Legacy weeks keep the kg stored when they were synced or entered.
    if (positive(Number(row.case_weight_kg))) {
      const kg = Number(row.total_kg) || 0;
      totals.colors[color].kg += kg;
      totals.kg += kg;
      totals.measuredCases += cases;
    } else {
      totals.unmeasuredCases += cases;
    }
  }
  totals.complete = totals.unmeasuredCases === 0;
  return totals;
}

export function computeShippedYield(input: {
  range: WeekRange;
  scope: PackScopeState;
  shipments: ShipmentRow[];
  measurements: MeasurementRow[];
  legacy: LegacyRow[];
}): ShippedYieldResult {
  const { range, scope } = input;
  const weekKeys = new Map<number, WeekRef>();
  const shipmentsByWeek = new Map<number, ShipmentRow[]>();
  const measurementsByWeek = new Map<number, MeasurementRow[]>();
  const legacyByWeek = new Map<number, LegacyRow[]>();

  for (const s of input.shipments) {
    if (!inRange(range, s.iso_year, s.iso_week) || !isPackWeek(scope, s.iso_year, s.iso_week)) continue; // pack rows outside the current scope are not used
    const ord = weekOrdinal(s.iso_year, s.iso_week);
    weekKeys.set(ord, { year: s.iso_year, week: s.iso_week });
    shipmentsByWeek.set(ord, [...(shipmentsByWeek.get(ord) ?? []), s]);
  }
  for (const m of input.measurements) {
    const ord = weekOrdinal(m.iso_year, m.iso_week);
    measurementsByWeek.set(ord, [...(measurementsByWeek.get(ord) ?? []), m]);
  }
  for (const l of input.legacy) {
    if (!inRange(range, l.year, l.week)) continue;
    const ord = weekOrdinal(l.year, l.week);
    weekKeys.set(ord, { year: l.year, week: l.week });
    legacyByWeek.set(ord, [...(legacyByWeek.get(ord) ?? []), l]);
  }

  const weeks: WeekTotals[] = [];
  for (const [ord, ref] of [...weekKeys.entries()].sort((a, b) => a[0] - b[0])) {
    const legacyRows = legacyByWeek.get(ord) ?? [];
    weeks.push(
      isPackWeek(scope, ref.year, ref.week)
        ? packWeekTotals(ref.year, ref.week, shipmentsByWeek.get(ord) ?? [], measurementsByWeek.get(ord) ?? [], legacyRows.length)
        : legacyWeekTotals(ref.year, ref.week, legacyRows)
    );
  }

  const totals: ShippedYieldTotals = {
    colors: emptyColors(), mixedCases: 0, shippedCases: 0, measuredCases: 0, unmeasuredCases: 0, attentionCases: 0,
    kg: 0, complete: true, nonPepper: [], weekCount: weeks.length, packWeeks: 0, legacyWeeks: 0
  };
  for (const w of weeks) {
    if (w.source === "packs") totals.packWeeks += 1;
    else totals.legacyWeeks += 1;
    for (const color of PEPPER_COLORS) {
      totals.colors[color].kg += w.colors[color].kg;
      totals.colors[color].cases += w.colors[color].cases;
    }
    totals.mixedCases += w.mixedCases;
    totals.shippedCases += w.shippedCases;
    totals.measuredCases += w.measuredCases;
    totals.unmeasuredCases += w.unmeasuredCases;
    totals.attentionCases += w.attentionCases;
    totals.kg += w.kg;
    for (const n of w.nonPepper) addNonPepper(totals.nonPepper, n.cropType, n.trackingUnit, n.cases);
  }
  totals.complete = totals.unmeasuredCases === 0 && totals.attentionCases === 0;

  return { range, scope, weeks, totals };
}
