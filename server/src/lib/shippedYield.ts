// The one authoritative shipped-yield calculation (shipped cases and kg by
// pepper colour, per ISO week). Used, through GET /api/shipped-yield, by the
// Cases tab, the Dashboard, Yield Analytics and the iOS workspace, so every
// screen shows the same numbers. Pure: callers load the rows.
//
// Exactly one source counts for each week (resolveWeekSource); the others are
// reported as not counted, never added:
//   1. "packs"  — inside DockLink's validated authoritative pack scope (sync
//      state "available", first_week..last_week inclusive; nothing when the
//      scope is pending or capture is not active): DockLink pack shipments.
//      Manual pack entries and colour totals for the week are not counted.
//   2. "manual" — inside a historical rebuild range (case_rebuild_ranges),
//      whether or not anything has been entered yet; colour totals never
//      count there, so a colour sync can't bring them back;
//   3. otherwise the week's explicit choice (case_week_sources), if any:
//      "manual" (manual pack entries) or "legacy" (colour totals);
//   4. otherwise manual pack entries if the week has any and no colour totals;
//   5. otherwise colour totals (color_case_entries: DockLink colour sync and
//      older manual colour entries), with their stored kg. A week with both
//      manual entries and colour totals but no choice counts colour totals and
//      is flagged as needing a decision.
//
// A manual week with no entries is "not entered yet" (incomplete, never a
// silent zero) unless the week is confirmed complete (case_week_confirmations),
// which makes it a confirmed zero-shipment week.
//
// Pack weeks and manual weeks use the same per-pack calculation:
//   * single-colour pack: kg = cases × net kg per shipping case
//   * mixed/rainbow pack, per colour: kg = cases × peppers per shipping case
//     × fruit weight g ÷ 1000; the pack's total kg is the sum of its colours
//     and its cases are counted once
//   * one measurement per week, pack and ship-time classification serves
//     imported and manual cases alike (not keyed by DockLink's series_key);
//     missing measurements stay missing (never 0)
//   * a week with no measurement of its own uses the remembered measurement
//     (pack_measurement_defaults, migration 0146) in effect for that week, if
//     any: the latest version taking effect at or before the week. A week's
//     own measurement always wins. Rainbow packs remember peppers per case and
//     fruit weights separately; both are needed for a remembered kg
//   * unattributed shipments and unsupported classifications are counted as
//     needing attention, never guessed into a colour
//   * non-pepper products are reported separately and never enter pepper totals

import { isoWeeksInYear, weekOrdinal, type ScopeStatus } from "./docklinkPackExport";

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

export type PackSource = "docklink" | "historical";

export type ShipmentRow = {
  iso_year: number;
  iso_week: number;
  series_key: string;
  attribution: "pack" | "unattributed";
  /** Where pack_id comes from; DockLink when absent. */
  pack_source?: PackSource;
  /** "import" (DockLink pack export) or "manual" (manual pack entries, aggregated); import when absent. */
  origin?: "import" | "manual";
  /** Manual rows: how many entries were aggregated into this row. */
  entry_count?: number;
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
  /** Informational only (the series it was first entered against); never used for matching. */
  series_key: string | null;
  pack_source?: PackSource;
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

/** What a remembered measurement holds: kg per case (single colour), or a rainbow pack's per-colour counts or fruit weights. */
export type DefaultValueKind = "net_kg" | "counts" | "fruit_weights";

export type DefaultComponent = { color: PepperColor; pieces_per_case?: number; fruit_weight_g?: number };

/** One version of a remembered measurement, in effect from its week until the next version (a forgotten version holds no value). */
export type MeasurementDefaultRow = {
  pack_source?: PackSource;
  pack_id: string;
  color_kind: "single" | "mixed";
  color_key: string | null;
  crop_type: string;
  tracking_unit: string;
  value_kind: DefaultValueKind;
  effective_from_iso_year: number;
  effective_from_iso_week: number;
  forgotten: boolean;
  net_kg_per_case: number | null;
  components: DefaultComponent[] | null;
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

/** One manual pack entry (one invoice line), with the classification it was entered against. */
export type ManualEntryRow = {
  id: string;
  iso_year: number;
  iso_week: number;
  pack_source: PackSource;
  pack_id: string;
  pack_name: string;
  pack_code: string | null;
  color_kind: string;
  color_key: string;
  crop_type: string;
  tracking_unit: string;
  cases: number;
  invoice_ref: string | null;
};

export type WeekSourceChoice = { iso_year: number; iso_week: number; source: "manual_packs" | "legacy_colours" };

/** An explicit span of ISO weeks rebuilt from manual pack entries (inclusive). */
export type RebuildRange = { from: WeekRef; to: WeekRef };

/** A manual week confirmed complete: every invoice entered, possibly none. */
export type WeekConfirmation = { iso_year: number; iso_week: number };

/** Whether a manual week's entries are done: none yet, some entered, or confirmed complete (possibly zero). */
export type ManualWeekStatus = "not_entered" | "entered" | "confirmed";

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

type PackIdentity = { pack_source?: PackSource; pack_id: string | null };
type ClassifiedIdentity = PackIdentity & Pick<ShipmentRow, "color_kind" | "color_key" | "crop_type" | "tracking_unit">;

/** The pack a row or measurement belongs to, independent of classification. */
export function packIdentity(r: PackIdentity): string {
  return `${r.pack_source ?? "docklink"}:${r.pack_id ?? ""}`;
}

/**
 * Identity of a weekly measurement: the pack plus its ship-time
 * classification. Imported series and manual entries with the same identity
 * in the same week share one measurement.
 */
export function measurementKey(r: ClassifiedIdentity): string {
  return [packIdentity(r), norm(r.color_kind), norm(r.color_key), norm(r.crop_type), norm(r.tracking_unit)].join("|");
}

/** True when `m` was entered for this row's pack and exact ship-time classification. */
export function measurementMatches(m: MeasurementRow, row: ShipmentRow): boolean {
  return row.pack_id !== null && measurementKey(m) === measurementKey(row);
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

// ---------------------------------------------------------------------------
// Remembered measurements (defaults for future weeks)
// ---------------------------------------------------------------------------

/** A remembered value in effect for a week: the value (null when none, or forgotten), the week its version took effect, and the week a later version takes over. */
export type RememberedSlot<T> = { value: T | null; from: WeekRef | null; nextChange: WeekRef | null };

export type RememberedValues = {
  netKg: RememberedSlot<number>;
  counts: RememberedSlot<Array<{ color: PepperColor; pieces_per_case: number }>>;
  fruitWeights: RememberedSlot<Array<{ color: PepperColor; fruit_weight_g: number }>>;
};

const effectiveOrd = (d: MeasurementDefaultRow) => weekOrdinal(d.effective_from_iso_year, d.effective_from_iso_week);

function rememberedSlot<T>(versions: MeasurementDefaultRow[], ord: number, value: (d: MeasurementDefaultRow) => T | null): RememberedSlot<T> {
  let current: MeasurementDefaultRow | null = null;
  let next: MeasurementDefaultRow | null = null;
  for (const d of versions) {
    const o = effectiveOrd(d);
    if (o <= ord) {
      if (!current || o > effectiveOrd(current)) current = d;
    } else if (!next || o < effectiveOrd(next)) next = d;
  }
  const v = current && !current.forgotten ? value(current) : null;
  return {
    value: v,
    from: v !== null && current ? { year: current.effective_from_iso_year, week: current.effective_from_iso_week } : null,
    nextChange: next ? { year: next.effective_from_iso_year, week: next.effective_from_iso_week } : null
  };
}

/**
 * The remembered values in effect for a row's pack and classification in a
 * week: for each value kind, the latest version taking effect at or before
 * the week (none when that version was forgotten).
 */
export function rememberedFor(defaults: MeasurementDefaultRow[], row: ClassifiedIdentity, year: number, week: number): RememberedValues {
  const key = measurementKey(row);
  const ord = weekOrdinal(year, week);
  const mine = defaults.filter((d) => measurementKey(d) === key);
  const of = (kind: DefaultValueKind) => mine.filter((d) => d.value_kind === kind);
  return {
    netKg: rememberedSlot(of("net_kg"), ord, (d) => (positive(d.net_kg_per_case) ? d.net_kg_per_case : null)),
    counts: rememberedSlot(of("counts"), ord, (d) => {
      const list = (d.components ?? []).filter((c) => isPepperColor(c.color) && positive(c.pieces_per_case));
      return list.length > 0 ? list.map((c) => ({ color: c.color, pieces_per_case: c.pieces_per_case as number })) : null;
    }),
    fruitWeights: rememberedSlot(of("fruit_weights"), ord, (d) => {
      const list = (d.components ?? []).filter((c) => isPepperColor(c.color) && positive(c.fruit_weight_g));
      return list.length > 0 ? list.map((c) => ({ color: c.color, fruit_weight_g: c.fruit_weight_g as number })) : null;
    })
  };
}

/**
 * The measurement a row uses from remembered values, when they are complete:
 * kg per case for a single-colour pack; for a rainbow pack, remembered counts
 * plus a remembered fruit weight for every counted colour.
 */
export function rememberedMeasurement(row: ShipmentRow, remembered: RememberedValues): MeasurementRow | null {
  if (!row.pack_id) return null;
  const classification = classifyShipment(row);
  const identity = {
    iso_year: row.iso_year, iso_week: row.iso_week, series_key: null, pack_source: row.pack_source ?? "docklink", pack_id: row.pack_id,
    color_key: norm(row.color_key), crop_type: norm(row.crop_type), tracking_unit: norm(row.tracking_unit),
    copied_from_iso_year: null, copied_from_iso_week: null
  };
  if (classification.kind === "single") {
    return remembered.netKg.value !== null ? { ...identity, color_kind: "single", net_kg_per_case: remembered.netKg.value, components: null } : null;
  }
  if (classification.kind !== "mixed" || !remembered.counts.value || !remembered.fruitWeights.value) return null;
  const weights = new Map(remembered.fruitWeights.value.map((w) => [w.color, w.fruit_weight_g]));
  if (!remembered.counts.value.every((c) => weights.has(c.color))) return null;
  return {
    ...identity,
    color_kind: "mixed",
    net_kg_per_case: null,
    components: remembered.counts.value.map((c) => ({ color: c.color, pieces_per_case: c.pieces_per_case, fruit_weight_g: weights.get(c.color) as number }))
  };
}

/** "remembered": the week has no measurement of its own; kg comes from the remembered measurement in effect. */
export type SeriesStatus = "measured" | "remembered" | "missing" | "incompatible" | "attention" | "non_pepper" | "zero";

export type SeriesResult = {
  row: ShipmentRow;
  classification: Classification;
  status: SeriesStatus;
  /** The week's own measurement, or (status "remembered") the remembered measurement used. */
  measurement: MeasurementRow | null;
  /** Remembered values in effect for the row's week (single and mixed packs). */
  remembered: RememberedValues | null;
  kgByColor: Partial<Record<PepperColor, number>>;
  kg: number;
};

/**
 * kg for one series in one week, given every measurement for that week and
 * the organization's remembered measurements (every version). The week's own
 * measurement for the row's pack and classification wins; otherwise a
 * complete remembered measurement in effect for the week is used.
 */
export function evaluateSeries(row: ShipmentRow, weekMeasurements: MeasurementRow[], defaults: MeasurementDefaultRow[] = []): SeriesResult {
  const classification = classifyShipment(row);
  const cases = Number(row.total_cases) || 0;
  const base = { row, classification, kgByColor: {}, kg: 0, remembered: null };

  if (classification.kind === "non_pepper") return { ...base, status: "non_pepper", measurement: null };
  if (classification.kind === "attention") return { ...base, status: cases > 0 ? "attention" : "zero", measurement: null };

  const remembered = row.pack_id ? rememberedFor(defaults, row, row.iso_year, row.iso_week) : null;
  const own = weekMeasurements.find((m) => measurementMatches(m, row)) ?? null;
  const measurement = own ?? (remembered ? rememberedMeasurement(row, remembered) : null);
  if (cases === 0) return { ...base, remembered, status: "zero", measurement };
  if (!measurement) {
    // "incompatible": this pack has a measurement this week, but for another ship-time classification.
    const samePack = weekMeasurements.filter((m) => packIdentity(m) === packIdentity(row));
    return { ...base, remembered, status: samePack.length > 0 ? "incompatible" : "missing", measurement: samePack[0] ?? null };
  }
  if (!measurementUsable(measurement)) return { ...base, remembered, status: "missing", measurement };
  const status = own ? "measured" : "remembered";

  if (classification.kind === "single") {
    const kg = cases * (measurement.net_kg_per_case as number);
    return { ...base, remembered, status, measurement, kgByColor: { [classification.color]: kg }, kg };
  }

  const kgByColor: Partial<Record<PepperColor, number>> = {};
  let kg = 0;
  for (const c of measurement.components ?? []) {
    const colorKg = (cases * c.pieces_per_case * c.fruit_weight_g) / 1000;
    kgByColor[c.color] = (kgByColor[c.color] ?? 0) + colorKg;
    kg += colorKg;
  }
  return { ...base, remembered, status, measurement, kgByColor, kg };
}

// ---------------------------------------------------------------------------
// Weekly and range totals
// ---------------------------------------------------------------------------

export type ColorTotals = Record<PepperColor, { kg: number; cases: number }>;

export type NonPepperTotal = { cropType: string; trackingUnit: string | null; cases: number };

/** Which data counts for a week: DockLink pack shipments, manual pack entries, or colour totals. */
export type WeekSource = "packs" | "manual" | "legacy";

export type WeekSourceReason =
  | "docklink_scope" // inside DockLink's authoritative pack scope
  | "rebuild_range" // inside a historical rebuild range
  | "chosen_manual" // explicit case_week_sources choice
  | "chosen_legacy" // explicit case_week_sources choice
  | "manual_only" // manual pack entries and no colour totals
  | "legacy_only" // colour totals (or nothing) and no manual pack entries
  | "undecided"; // both exist and no choice yet: colour totals count, flagged

/** Data that exists for a week but is not counted, because another source is authoritative. */
export type NotCounted = {
  manualCases: number;
  manualEntries: number;
  legacyCases: number;
  legacyRows: number;
};

export type WeekTotals = {
  isoYear: number;
  isoWeek: number;
  source: WeekSource;
  sourceReason: WeekSourceReason;
  /** Manual pack entries and colour totals both exist and no source was chosen (colour totals count meanwhile). */
  needsSourceDecision: boolean;
  /** Inside a historical rebuild range. */
  inRebuildRange: boolean;
  /** Manual weeks only (null otherwise): not entered yet, entered, or confirmed complete (a confirmed 0 is a real zero). */
  manualStatus: ManualWeekStatus | null;
  /** kg per colour (rainbow components included) and single-colour/legacy cases per colour. */
  colors: ColorTotals;
  /** Rainbow/mixed cases — counted once, not per colour. */
  mixedCases: number;
  /** All pepper shipping cases this week, each counted once. */
  shippedCases: number;
  /** Cases with usable kg: from the week's own measurement or a remembered one. */
  measuredCases: number;
  /** Of measuredCases, those using a remembered measurement. */
  rememberedCases: number;
  /** Cases of supported packs with no usable measurement (missing or entered against another classification). */
  unmeasuredCases: number;
  /** Unattributed shipments and unsupported classifications. */
  attentionCases: number;
  kg: number;
  complete: boolean;
  nonPepper: NonPepperTotal[];
  notCounted: NotCounted;
  /** Colour rows for this week that are not counted (kept for older clients; equals notCounted.legacyRows). */
  supersededLegacyRows: number;
};

export type ShippedYieldTotals = Omit<
  WeekTotals,
  "isoYear" | "isoWeek" | "source" | "sourceReason" | "needsSourceDecision" | "inRebuildRange" | "manualStatus" | "notCounted" | "supersededLegacyRows"
> & {
  weekCount: number;
  packWeeks: number;
  manualWeeks: number;
  legacyWeeks: number;
  /** Weeks with both manual pack entries and colour totals and no source chosen. */
  weeksNeedingSourceDecision: number;
  /** Weeks whose manual pack entries are not counted (DockLink scope, or colour totals chosen). */
  weeksWithUncountedManualEntries: number;
  /** Manual weeks with no entries and no confirmation: their shipments are unknown, not zero. */
  weeksNotEntered: number;
  /** Manual weeks confirmed complete (including confirmed zero-shipment weeks). */
  weeksConfirmed: number;
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

/** True when the week is inside any rebuild range. */
export function inRebuildRange(ranges: RebuildRange[] | undefined, year: number, week: number): boolean {
  const ord = weekOrdinal(year, week);
  return (ranges ?? []).some((r) => ord >= weekOrdinal(r.from.year, r.from.week) && ord <= weekOrdinal(r.to.year, r.to.week));
}

/** Every ISO week from `from` to `to` inclusive. */
export function weeksBetween(from: WeekRef, to: WeekRef): WeekRef[] {
  const out: WeekRef[] = [];
  let { year, week } = from;
  const last = weekOrdinal(to.year, to.week);
  while (weekOrdinal(year, week) <= last) {
    out.push({ year, week });
    if (week >= isoWeeksInYear(year)) {
      year += 1;
      week = 1;
    } else week += 1;
  }
  return out;
}

export function inRange(range: WeekRange, year: number, week: number): boolean {
  if (!range) return true;
  const ord = weekOrdinal(year, week);
  const a = weekOrdinal(range.from.year, range.from.week);
  const b = weekOrdinal(range.to.year, range.to.week);
  return ord >= Math.min(a, b) && ord <= Math.max(a, b);
}

/** The single source that counts for a week, and why (see the header comment). */
export function resolveWeekSource(input: {
  scope: PackScopeState;
  year: number;
  week: number;
  choice: WeekSourceChoice["source"] | null;
  manualEntries: number;
  legacyRows: number;
  inRebuildRange?: boolean;
}): { source: WeekSource; reason: WeekSourceReason; needsSourceDecision: boolean } {
  if (isPackWeek(input.scope, input.year, input.week)) return { source: "packs", reason: "docklink_scope", needsSourceDecision: false };
  if (input.inRebuildRange) return { source: "manual", reason: "rebuild_range", needsSourceDecision: false };
  if (input.choice === "manual_packs") return { source: "manual", reason: "chosen_manual", needsSourceDecision: false };
  if (input.choice === "legacy_colours") return { source: "legacy", reason: "chosen_legacy", needsSourceDecision: false };
  if (input.manualEntries > 0 && input.legacyRows === 0) return { source: "manual", reason: "manual_only", needsSourceDecision: false };
  if (input.manualEntries > 0) return { source: "legacy", reason: "undecided", needsSourceDecision: true };
  return { source: "legacy", reason: "legacy_only", needsSourceDecision: false };
}

/**
 * Manual entries for one week, aggregated into one row per pack and
 * classification (several invoices for the same pack add up). Evaluated by the
 * same per-pack calculation as DockLink's imported series.
 */
export function aggregateManualEntries(entries: ManualEntryRow[]): ShipmentRow[] {
  const byKey = new Map<string, ShipmentRow>();
  for (const e of entries) {
    const row: ShipmentRow = {
      iso_year: e.iso_year,
      iso_week: e.iso_week,
      series_key: "",
      attribution: "pack",
      pack_source: e.pack_source,
      origin: "manual",
      entry_count: 0,
      pack_id: e.pack_id,
      source_pack_ref: null,
      pack_name: e.pack_name,
      pack_code: e.pack_code,
      color_key: e.color_key,
      color_kind: e.color_kind,
      crop_type: e.crop_type,
      tracking_unit: e.tracking_unit,
      total_cases: 0
    };
    const key = measurementKey(row);
    const existing = byKey.get(key) ?? { ...row, series_key: `manual|${key}` };
    existing.total_cases += Number(e.cases) || 0;
    existing.entry_count = (existing.entry_count ?? 0) + 1;
    byKey.set(key, existing);
  }
  return [...byKey.values()];
}

function addNonPepper(list: NonPepperTotal[], cropType: string, trackingUnit: string | null, cases: number) {
  const existing = list.find((n) => n.cropType === cropType && n.trackingUnit === trackingUnit);
  if (existing) existing.cases += cases;
  else list.push({ cropType, trackingUnit, cases });
}

type WeekHeader = Pick<WeekTotals, "isoYear" | "isoWeek" | "source" | "sourceReason" | "needsSourceDecision" | "inRebuildRange" | "manualStatus" | "notCounted">;

function emptyWeek(header: WeekHeader): WeekTotals {
  return {
    ...header, colors: emptyColors(), mixedCases: 0, shippedCases: 0, measuredCases: 0, rememberedCases: 0, unmeasuredCases: 0,
    attentionCases: 0, kg: 0, complete: true, nonPepper: [], supersededLegacyRows: header.notCounted.legacyRows
  };
}

/** Pack-based totals: DockLink pack shipments or aggregated manual pack entries. */
function packRowsTotals(header: WeekHeader, rows: ShipmentRow[], measurements: MeasurementRow[], defaults: MeasurementDefaultRow[]): WeekTotals {
  const totals = emptyWeek(header);
  for (const row of rows) {
    const cases = Number(row.total_cases) || 0;
    const result = evaluateSeries(row, measurements, defaults);
    if (result.status === "non_pepper") {
      if (cases > 0) addNonPepper(totals.nonPepper, norm(row.crop_type), row.tracking_unit, cases);
      continue;
    }
    if (result.status === "zero") continue;
    totals.shippedCases += cases;
    if (result.classification.kind === "single") totals.colors[result.classification.color].cases += cases;
    if (result.classification.kind === "mixed") totals.mixedCases += cases;
    if (result.status === "attention") totals.attentionCases += cases;
    else if (result.status === "measured" || result.status === "remembered") {
      totals.measuredCases += cases;
      if (result.status === "remembered") totals.rememberedCases += cases;
    } else totals.unmeasuredCases += cases;
    for (const color of PEPPER_COLORS) {
      const kg = result.kgByColor[color] ?? 0;
      totals.colors[color].kg += kg;
      totals.kg += kg;
    }
  }
  totals.complete = totals.unmeasuredCases === 0 && totals.attentionCases === 0;
  return totals;
}

function legacyWeekTotals(header: WeekHeader, rows: LegacyRow[]): WeekTotals {
  const totals = emptyWeek(header);
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

const legacyPepperCases = (rows: LegacyRow[]) =>
  rows.reduce((sum, r) => sum + (isPepperColor(norm(r.color)) && Number(r.total_cases) > 0 ? Number(r.total_cases) : 0), 0);

function pushTo<T>(map: Map<number, T[]>, ord: number, item: T) {
  const list = map.get(ord);
  if (list) list.push(item);
  else map.set(ord, [item]);
}

export function computeShippedYield(input: {
  range: WeekRange;
  scope: PackScopeState;
  shipments: ShipmentRow[];
  measurements: MeasurementRow[];
  /** The organization's remembered measurements (every version; each week uses the one in effect). */
  defaults?: MeasurementDefaultRow[];
  legacy: LegacyRow[];
  manual?: ManualEntryRow[];
  weekSources?: WeekSourceChoice[];
  rebuildRanges?: RebuildRange[];
  confirmations?: WeekConfirmation[];
}): ShippedYieldResult {
  const { range, scope } = input;
  const weekKeys = new Map<number, WeekRef>();
  const shipmentsByWeek = new Map<number, ShipmentRow[]>();
  const measurementsByWeek = new Map<number, MeasurementRow[]>();
  const legacyByWeek = new Map<number, LegacyRow[]>();
  const manualByWeek = new Map<number, ManualEntryRow[]>();
  const choiceByWeek = new Map<number, WeekSourceChoice["source"]>();

  for (const s of input.shipments) {
    if (!inRange(range, s.iso_year, s.iso_week) || !isPackWeek(scope, s.iso_year, s.iso_week)) continue; // pack rows outside the current scope are not used
    const ord = weekOrdinal(s.iso_year, s.iso_week);
    weekKeys.set(ord, { year: s.iso_year, week: s.iso_week });
    pushTo(shipmentsByWeek, ord, s);
  }
  for (const m of input.measurements) pushTo(measurementsByWeek, weekOrdinal(m.iso_year, m.iso_week), m);
  for (const l of input.legacy) {
    if (!inRange(range, l.year, l.week)) continue;
    const ord = weekOrdinal(l.year, l.week);
    weekKeys.set(ord, { year: l.year, week: l.week });
    pushTo(legacyByWeek, ord, l);
  }
  for (const e of input.manual ?? []) {
    if (!inRange(range, e.iso_year, e.iso_week)) continue;
    const ord = weekOrdinal(e.iso_year, e.iso_week);
    weekKeys.set(ord, { year: e.iso_year, week: e.iso_week });
    pushTo(manualByWeek, ord, e);
  }
  for (const c of input.weekSources ?? []) {
    const ord = weekOrdinal(c.iso_year, c.iso_week);
    choiceByWeek.set(ord, c.source);
    // A week kept on manual entries is listed even with none left, so it reads "not entered yet", not absent.
    if (c.source === "manual_packs" && inRange(range, c.iso_year, c.iso_week)) weekKeys.set(ord, { year: c.iso_year, week: c.iso_week });
  }
  const confirmed = new Set((input.confirmations ?? []).map((c) => weekOrdinal(c.iso_year, c.iso_week)));
  // Every week of a rebuild range is listed (clipped to the requested range), entered or not.
  for (const r of input.rebuildRanges ?? []) {
    let from = r.from;
    let to = r.to;
    if (range) {
      const lo = weekOrdinal(range.from.year, range.from.week) <= weekOrdinal(range.to.year, range.to.week) ? range.from : range.to;
      const hi = lo === range.from ? range.to : range.from;
      if (weekOrdinal(lo.year, lo.week) > weekOrdinal(from.year, from.week)) from = lo;
      if (weekOrdinal(hi.year, hi.week) < weekOrdinal(to.year, to.week)) to = hi;
    }
    for (const w of weeksBetween(from, to)) weekKeys.set(weekOrdinal(w.year, w.week), w);
  }

  const weeks: WeekTotals[] = [];
  for (const [ord, ref] of [...weekKeys.entries()].sort((a, b) => a[0] - b[0])) {
    const legacyRows = legacyByWeek.get(ord) ?? [];
    const manualEntries = manualByWeek.get(ord) ?? [];
    const rebuild = inRebuildRange(input.rebuildRanges, ref.year, ref.week);
    const decision = resolveWeekSource({
      scope, year: ref.year, week: ref.week, choice: choiceByWeek.get(ord) ?? null,
      manualEntries: manualEntries.length, legacyRows: legacyRows.length, inRebuildRange: rebuild
    });
    const manualStatus: ManualWeekStatus | null =
      decision.source !== "manual" ? null : confirmed.has(ord) ? "confirmed" : manualEntries.length > 0 ? "entered" : "not_entered";
    const manualCases = manualEntries.reduce((sum, e) => sum + (Number(e.cases) || 0), 0);
    const notCounted: NotCounted = {
      manualCases: decision.source === "manual" ? 0 : manualCases,
      manualEntries: decision.source === "manual" ? 0 : manualEntries.length,
      legacyCases: decision.source === "legacy" ? 0 : legacyPepperCases(legacyRows),
      legacyRows: decision.source === "legacy" ? 0 : legacyRows.length
    };
    const header: WeekHeader = {
      isoYear: ref.year, isoWeek: ref.week, source: decision.source, sourceReason: decision.reason,
      needsSourceDecision: decision.needsSourceDecision, inRebuildRange: rebuild, manualStatus, notCounted
    };
    const measurements = measurementsByWeek.get(ord) ?? [];
    const defaults = input.defaults ?? [];
    const week =
      decision.source === "packs"
        ? packRowsTotals(header, shipmentsByWeek.get(ord) ?? [], measurements, defaults)
        : decision.source === "manual"
          ? packRowsTotals(header, aggregateManualEntries(manualEntries), measurements, defaults)
          : legacyWeekTotals(header, legacyRows);
    // Shipments of a week not entered yet are unknown: incomplete, never a confirmed zero.
    if (manualStatus === "not_entered") week.complete = false;
    weeks.push(week);
  }

  const totals: ShippedYieldTotals = {
    colors: emptyColors(), mixedCases: 0, shippedCases: 0, measuredCases: 0, rememberedCases: 0, unmeasuredCases: 0, attentionCases: 0,
    kg: 0, complete: true, nonPepper: [], weekCount: weeks.length, packWeeks: 0, manualWeeks: 0, legacyWeeks: 0,
    weeksNeedingSourceDecision: 0, weeksWithUncountedManualEntries: 0, weeksNotEntered: 0, weeksConfirmed: 0
  };
  for (const w of weeks) {
    if (w.source === "packs") totals.packWeeks += 1;
    else if (w.source === "manual") totals.manualWeeks += 1;
    else totals.legacyWeeks += 1;
    if (w.needsSourceDecision) totals.weeksNeedingSourceDecision += 1;
    if (w.notCounted.manualEntries > 0) totals.weeksWithUncountedManualEntries += 1;
    if (w.manualStatus === "not_entered") totals.weeksNotEntered += 1;
    if (w.manualStatus === "confirmed") totals.weeksConfirmed += 1;
    for (const color of PEPPER_COLORS) {
      totals.colors[color].kg += w.colors[color].kg;
      totals.colors[color].cases += w.colors[color].cases;
    }
    totals.mixedCases += w.mixedCases;
    totals.shippedCases += w.shippedCases;
    totals.measuredCases += w.measuredCases;
    totals.rememberedCases += w.rememberedCases;
    totals.unmeasuredCases += w.unmeasuredCases;
    totals.attentionCases += w.attentionCases;
    totals.kg += w.kg;
    for (const n of w.nonPepper) addNonPepper(totals.nonPepper, n.cropType, n.trackingUnit, n.cases);
  }
  totals.complete = totals.unmeasuredCases === 0 && totals.attentionCases === 0 && totals.weeksNotEntered === 0;

  return { range, scope, weeks, totals };
}
