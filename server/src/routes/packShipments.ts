// Weekly pack shipments (DockLink pack export, migration 0143): the weekly
// entry screen's data, its measurements, and GET /shipped-yield — the single
// shipped-yield calculation every screen uses (lib/shippedYield.ts).
//
// Measurements are user data: only these routes write pack_case_measurements,
// and a DockLink sync never does.
import { Router } from "express";
import { supabase } from "../config/supabase";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import { sendSafeError } from "../utils/safeError";
import { isoWeekStart, isoWeeksInYear, weekOrdinal } from "../lib/docklinkPackExport";
import {
  PEPPER_COLORS,
  aggregateManualEntries,
  classifyShipment,
  computeShippedYield,
  evaluateSeries,
  inRebuildRange,
  isPackWeek,
  measurementKey,
  measurementMatches,
  resolveWeekSource,
  type LegacyRow,
  type ManualEntryRow,
  type MeasurementComponent,
  type MeasurementRow,
  type PackScopeState,
  type PackSource,
  type PepperColor,
  type RebuildRange,
  type ShipmentRow,
  type WeekConfirmation,
  type WeekRange,
  type WeekSourceChoice
} from "../lib/shippedYield";

const packShipmentsRouter = Router();
const canView = requireAnyPermission(["cases:view", "cases:edit"]);
const canEdit = requirePermission("cases:edit");

export class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const PAGE = 1000;

/** Reads every row of a query, a page at a time (PostgREST caps a single response at 1000 rows). */
export async function selectAll<T>(build: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }> }): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const SHIPMENT_COLUMNS =
  "iso_year, iso_week, series_key, attribution, pack_id, source_pack_ref, pack_name, pack_code, color_key, color_kind, crop_type, tracking_unit, total_cases, load_count, line_count, absent_from_export";
const MEASUREMENT_COLUMNS =
  "iso_year, iso_week, series_key, pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit, net_kg_per_case, components, copied_from_iso_year, copied_from_iso_week, updated_at";

type SyncStateRow = {
  scope_status: "available" | "pending_first_full_week" | "capture_not_active";
  generated_at: string;
  last_synced_at: string;
  capture_activated_at: string | null;
  transition_iso_year: number | null;
  transition_iso_week: number | null;
  first_iso_year: number | null;
  first_iso_week: number | null;
  last_iso_year: number | null;
  last_iso_week: number | null;
  diagnostics: Record<string, unknown>;
};

export async function loadSyncState(organizationId: string): Promise<SyncStateRow | null> {
  const { data, error } = await supabase
    .from("docklink_pack_sync_state")
    .select("scope_status, generated_at, last_synced_at, capture_activated_at, transition_iso_year, transition_iso_week, first_iso_year, first_iso_week, last_iso_year, last_iso_week, diagnostics")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data as SyncStateRow | null) ?? null;
}

export function toScope(state: SyncStateRow | null): PackScopeState {
  if (!state) return null;
  return {
    status: state.scope_status,
    first: state.first_iso_year !== null && state.first_iso_week !== null ? { year: state.first_iso_year, week: state.first_iso_week } : null,
    last: state.last_iso_year !== null && state.last_iso_week !== null ? { year: state.last_iso_year, week: state.last_iso_week } : null
  };
}

function syncSummary(state: SyncStateRow | null) {
  if (!state) return null;
  const wk = (y: number | null, w: number | null) => (y !== null && w !== null ? { isoYear: y, isoWeek: w } : null);
  return {
    scopeStatus: state.scope_status,
    generatedAt: state.generated_at,
    lastSyncedAt: state.last_synced_at,
    captureActivatedAt: state.capture_activated_at,
    transitionWeek: wk(state.transition_iso_year, state.transition_iso_week),
    firstWeek: wk(state.first_iso_year, state.first_iso_week),
    lastWeek: wk(state.last_iso_year, state.last_iso_week),
    diagnostics: state.diagnostics ?? {}
  };
}

const numeric = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toShipment(r: Record<string, unknown>): ShipmentRow {
  return {
    iso_year: Number(r.iso_year),
    iso_week: Number(r.iso_week),
    series_key: String(r.series_key),
    attribution: r.attribution === "unattributed" ? "unattributed" : "pack",
    pack_id: (r.pack_id as string | null) ?? null,
    source_pack_ref: (r.source_pack_ref as string | null) ?? null,
    pack_name: (r.pack_name as string | null) ?? null,
    pack_code: (r.pack_code as string | null) ?? null,
    color_key: (r.color_key as string | null) ?? null,
    color_kind: (r.color_kind as string | null) ?? null,
    crop_type: (r.crop_type as string | null) ?? null,
    tracking_unit: (r.tracking_unit as string | null) ?? null,
    total_cases: Number(r.total_cases) || 0,
    load_count: Number(r.load_count) || 0
  };
}

function toMeasurement(r: Record<string, unknown>): MeasurementRow {
  const components = Array.isArray(r.components)
    ? (r.components as Array<Record<string, unknown>>).map((c) => ({
        color: c.color as PepperColor,
        pieces_per_case: Number(c.pieces_per_case),
        fruit_weight_g: Number(c.fruit_weight_g)
      }))
    : null;
  return {
    iso_year: Number(r.iso_year),
    iso_week: Number(r.iso_week),
    series_key: r.series_key === null || r.series_key === undefined ? null : String(r.series_key),
    pack_source: r.pack_source === "historical" ? "historical" : "docklink",
    pack_id: String(r.pack_id),
    color_kind: r.color_kind === "mixed" ? "mixed" : "single",
    color_key: (r.color_key as string | null) ?? null,
    crop_type: String(r.crop_type),
    tracking_unit: String(r.tracking_unit),
    net_kg_per_case: numeric(r.net_kg_per_case),
    components,
    copied_from_iso_year: numeric(r.copied_from_iso_year),
    copied_from_iso_week: numeric(r.copied_from_iso_week)
  };
}

export function parseWeekParam(yearRaw: unknown, weekRaw: unknown, label: string): { year: number; week: number } {
  const year = Number(yearRaw);
  const week = Number(weekRaw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new RouteError(400, `${label} ISO year is required`);
  if (!Number.isInteger(week) || week < 1 || week > isoWeeksInYear(year)) throw new RouteError(400, `${label} ISO week must be 1-${isoWeeksInYear(year)}`);
  return { year, week };
}

async function loadShipments(organizationId: string, fromYear: number, toYear: number): Promise<ShipmentRow[]> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase
      .from("docklink_pack_weekly_shipments")
      .select(SHIPMENT_COLUMNS)
      .eq("organization_id", organizationId)
      .gte("iso_year", fromYear)
      .lte("iso_year", toYear)
      .order("iso_year")
      .order("iso_week")
      .order("series_key")
  );
  return rows.map(toShipment);
}

async function loadMeasurements(organizationId: string, fromYear: number, toYear: number): Promise<MeasurementRow[]> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase
      .from("pack_case_measurements")
      .select(MEASUREMENT_COLUMNS)
      .eq("organization_id", organizationId)
      .gte("iso_year", fromYear)
      .lte("iso_year", toYear)
      .order("iso_year")
      .order("iso_week")
      .order("series_key")
  );
  return rows.map(toMeasurement);
}

async function loadLegacy(organizationId: string, fromYear: number | null, toYear: number | null): Promise<LegacyRow[]> {
  const rows = await selectAll<Record<string, unknown>>(() => {
    let q = supabase
      .from("color_case_entries")
      .select("year, week, color, total_cases, case_weight_kg, total_kg, source")
      .eq("organization_id", organizationId);
    if (fromYear !== null) q = q.gte("year", fromYear);
    if (toYear !== null) q = q.lte("year", toYear);
    return q.order("year").order("week").order("color");
  });
  return rows.map((r) => ({
    year: Number(r.year),
    week: Number(r.week),
    color: String(r.color),
    total_cases: Number(r.total_cases) || 0,
    case_weight_kg: Number(r.case_weight_kg) || 0,
    total_kg: Number(r.total_kg) || 0,
    source: (r.source as string | null) ?? null
  }));
}

export const MANUAL_ENTRY_COLUMNS =
  "id, iso_year, iso_week, pack_source, docklink_pack_id, historical_pack_id, pack_name, pack_code, color_kind, color_key, crop_type, tracking_unit, cases, invoice_ref, invoice_ref_key, note, created_at, updated_at";

export type ManualEntryRecord = ManualEntryRow & { invoice_ref_key: string | null; note: string | null; created_at: string; updated_at: string };

export function toManualEntry(r: Record<string, unknown>): ManualEntryRecord {
  const packSource: PackSource = r.pack_source === "historical" ? "historical" : "docklink";
  return {
    id: String(r.id),
    iso_year: Number(r.iso_year),
    iso_week: Number(r.iso_week),
    pack_source: packSource,
    pack_id: String(packSource === "historical" ? r.historical_pack_id : r.docklink_pack_id),
    pack_name: String(r.pack_name),
    pack_code: (r.pack_code as string | null) ?? null,
    color_kind: String(r.color_kind),
    color_key: String(r.color_key ?? ""),
    crop_type: String(r.crop_type),
    tracking_unit: String(r.tracking_unit),
    cases: Number(r.cases) || 0,
    invoice_ref: (r.invoice_ref as string | null) ?? null,
    invoice_ref_key: (r.invoice_ref_key as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at)
  };
}

export async function loadManualEntries(organizationId: string, fromYear: number, toYear: number): Promise<ManualEntryRecord[]> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase
      .from("manual_pack_case_entries")
      .select(MANUAL_ENTRY_COLUMNS)
      .eq("organization_id", organizationId)
      .gte("iso_year", fromYear)
      .lte("iso_year", toYear)
      .order("iso_year")
      .order("iso_week")
      .order("created_at")
      .order("id")
  );
  return rows.map(toManualEntry);
}

export async function loadWeekSources(organizationId: string, fromYear: number, toYear: number): Promise<WeekSourceChoice[]> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase
      .from("case_week_sources")
      .select("iso_year, iso_week, source")
      .eq("organization_id", organizationId)
      .gte("iso_year", fromYear)
      .lte("iso_year", toYear)
      .order("iso_year")
      .order("iso_week")
  );
  return rows.map((r) => ({
    iso_year: Number(r.iso_year),
    iso_week: Number(r.iso_week),
    source: r.source === "legacy_colours" ? "legacy_colours" : "manual_packs"
  }));
}

export type RebuildRangeRecord = RebuildRange & { id: string; note: string | null; created_at: string };

export async function loadRebuildRanges(organizationId: string): Promise<RebuildRangeRecord[]> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase
      .from("case_rebuild_ranges")
      .select("id, from_iso_year, from_iso_week, to_iso_year, to_iso_week, note, created_at")
      .eq("organization_id", organizationId)
      .order("from_iso_year")
      .order("from_iso_week")
      .order("id")
  );
  return rows.map((r) => ({
    id: String(r.id),
    from: { year: Number(r.from_iso_year), week: Number(r.from_iso_week) },
    to: { year: Number(r.to_iso_year), week: Number(r.to_iso_week) },
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at)
  }));
}

export async function loadConfirmations(organizationId: string, fromYear: number, toYear: number): Promise<Array<WeekConfirmation & { confirmed_at: string; note: string | null }>> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase
      .from("case_week_confirmations")
      .select("iso_year, iso_week, confirmed_at, note")
      .eq("organization_id", organizationId)
      .gte("iso_year", fromYear)
      .lte("iso_year", toYear)
      .order("iso_year")
      .order("iso_week")
  );
  return rows.map((r) => ({ iso_year: Number(r.iso_year), iso_week: Number(r.iso_week), confirmed_at: String(r.confirmed_at), note: (r.note as string | null) ?? null }));
}

// ---------------------------------------------------------------------------
// GET /shipped-yield — the authoritative totals
// ---------------------------------------------------------------------------

export async function loadShippedYield(organizationId: string, range: WeekRange) {
  const state = await loadSyncState(organizationId);
  const scope = toScope(state);
  const fromYear = range ? Math.min(range.from.year, range.to.year) : 2000;
  const toYear = range ? Math.max(range.from.year, range.to.year) : 2100;
  // Measurements are loaded with or without a DockLink sync: manual pack weeks use them too.
  const [shipments, measurements, legacy, manual, weekSources, rebuildRanges, confirmations] = await Promise.all([
    state ? loadShipments(organizationId, fromYear, toYear) : Promise.resolve([]),
    loadMeasurements(organizationId, fromYear, toYear),
    loadLegacy(organizationId, range ? fromYear : null, range ? toYear : null),
    loadManualEntries(organizationId, fromYear, toYear),
    loadWeekSources(organizationId, fromYear, toYear),
    loadRebuildRanges(organizationId),
    loadConfirmations(organizationId, fromYear, toYear)
  ]);
  return {
    sync: syncSummary(state),
    ...computeShippedYield({ range, scope, shipments, measurements, legacy, manual, weekSources, rebuildRanges, confirmations })
  };
}

function parseRange(q: Record<string, unknown>): WeekRange {
  const has = (k: string) => q[k] !== undefined && q[k] !== "";
  if (!has("fromYear") && !has("toYear")) return null;
  const from = parseWeekParam(q.fromYear, has("fromWeek") ? q.fromWeek : 1, "fromYear/fromWeek:");
  const toYear = has("toYear") ? q.toYear : q.fromYear;
  const to = parseWeekParam(toYear, has("toWeek") ? q.toWeek : isoWeeksInYear(Number(toYear)), "toYear/toWeek:");
  return { from, to };
}

packShipmentsRouter.get("/shipped-yield", canView, async (req, res) => {
  try {
    const range = parseRange(req.query as Record<string, unknown>);
    return res.json(await loadShippedYield(req.organizationId, range));
  } catch (error) {
    if (error instanceof RouteError) return res.status(error.status).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to load shipped yield.", "shipped-yield error:", error);
  }
});

// ---------------------------------------------------------------------------
// GET /pack-shipments/week — the weekly entry screen
// ---------------------------------------------------------------------------

type CatalogPack = {
  pack_id: string;
  name: string;
  pack_code: string | null;
  description: string | null;
  color_label: string | null;
  color_key: string | null;
  color_kind: string | null;
  display_order: number | null;
  crop_type: string | null;
  tracking_unit: string | null;
  status: string;
  archived_at: string | null;
  in_latest_export: boolean;
};

const isActivePack = (p: CatalogPack) => p.status === "active" && !p.archived_at && p.in_latest_export;

async function findCopySource(organizationId: string, year: number, week: number, needing: ShipmentRow[]) {
  if (needing.length === 0) return null;
  const targetOrd = weekOrdinal(year, week);
  const earlier = (await loadMeasurements(organizationId, year - 1, year)).filter((m) => weekOrdinal(m.iso_year, m.iso_week) < targetOrd);
  const byWeek = new Map<number, MeasurementRow[]>();
  for (const m of earlier) byWeek.set(weekOrdinal(m.iso_year, m.iso_week), [...(byWeek.get(weekOrdinal(m.iso_year, m.iso_week)) ?? []), m]);
  for (const ord of [...byWeek.keys()].sort((a, b) => b - a)) {
    const measurements = byWeek.get(ord)!;
    const matching = needing.filter((row) => measurements.some((m) => measurementMatches(m, row)));
    if (matching.length > 0) {
      return { isoYear: Math.floor(ord / 100), isoWeek: ord % 100, matchingSeries: matching.length };
    }
  }
  return null;
}

/**
 * The pack rows that can take a measurement in a week: DockLink's series in a
 * pack-scope week, otherwise the week's manual entries aggregated per pack and
 * classification (whether or not they currently count — the measurement is
 * kept for when they do).
 */
async function loadMeasurableRows(organizationId: string, year: number, week: number): Promise<{ rows: ShipmentRow[]; packWeek: boolean }> {
  const scope = toScope(await loadSyncState(organizationId));
  if (isPackWeek(scope, year, week)) {
    const rows = (await loadShipments(organizationId, year, year)).filter((s) => s.iso_week === week);
    return { rows, packWeek: true };
  }
  const manual = (await loadManualEntries(organizationId, year, year)).filter((e) => e.iso_week === week);
  return { rows: aggregateManualEntries(manual), packWeek: false };
}

/** Pairs each of a week's entries with entries elsewhere that look like the same invoice line. */
async function findDuplicates(organizationId: string, entries: ManualEntryRecord[]) {
  const keys = [...new Set(entries.map((e) => e.invoice_ref_key).filter((k): k is string => Boolean(k)))];
  const sameInvoice = keys.length
    ? (
        await selectAll<Record<string, unknown>>(() =>
          supabase.from("manual_pack_case_entries").select(MANUAL_ENTRY_COLUMNS).eq("organization_id", organizationId).in("invoice_ref_key", keys).order("id")
        )
      ).map(toManualEntry)
    : [];
  return new Map(
    entries.map((e) => [
      e.id,
      [...sameInvoice, ...entries].filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i).filter((o) => o.id !== e.id && isLikelyDuplicate(e, o))
    ])
  );
}

/**
 * Two entries look like the same invoice line when they have the same
 * invoice reference and pack (in any week), or — without an invoice
 * reference — the same week, pack and cases.
 */
export function isLikelyDuplicate(a: ManualEntryRow & { invoice_ref_key?: string | null }, b: ManualEntryRow & { invoice_ref_key?: string | null }): boolean {
  if (a.pack_source !== b.pack_source || a.pack_id !== b.pack_id) return false;
  const ka = a.invoice_ref_key ?? (a.invoice_ref ? a.invoice_ref.trim().toLowerCase() || null : null);
  const kb = b.invoice_ref_key ?? (b.invoice_ref ? b.invoice_ref.trim().toLowerCase() || null : null);
  if (ka && kb) return ka === kb;
  if (ka || kb) return false;
  return a.iso_year === b.iso_year && a.iso_week === b.iso_week && Number(a.cases) === Number(b.cases);
}

const weekRef = (e: { iso_year: number; iso_week: number }) => ({ isoYear: e.iso_year, isoWeek: e.iso_week });

export function manualEntryView(e: ManualEntryRecord, duplicates: ManualEntryRecord[] = []) {
  return {
    id: e.id,
    isoYear: e.iso_year,
    isoWeek: e.iso_week,
    packSource: e.pack_source,
    packId: e.pack_id,
    packName: e.pack_name,
    packCode: e.pack_code,
    colorKind: e.color_kind,
    colorKey: e.color_key,
    cropType: e.crop_type,
    trackingUnit: e.tracking_unit,
    cases: e.cases,
    invoiceRef: e.invoice_ref,
    note: e.note,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    duplicates: duplicates.map((d) => ({ id: d.id, ...weekRef(d), cases: d.cases, invoiceRef: d.invoice_ref }))
  };
}

async function loadWeek(organizationId: string, year: number, week: number) {
  const state = await loadSyncState(organizationId);
  const scope = toScope(state);

  const [catalogResult, historicalResult, shipmentsAll, measurementsAll, legacy, manualAll, choices, rebuildRanges, confirmations] = await Promise.all([
    supabase
      .from("docklink_packs")
      .select("pack_id, name, pack_code, description, color_label, color_key, color_kind, display_order, crop_type, tracking_unit, status, archived_at, in_latest_export")
      .eq("organization_id", organizationId),
    supabase.from("historical_packs").select("id, name, pack_code, note").eq("organization_id", organizationId),
    state ? loadShipments(organizationId, year, year) : Promise.resolve([] as ShipmentRow[]),
    loadMeasurements(organizationId, year, year),
    loadLegacy(organizationId, year, year),
    loadManualEntries(organizationId, year, year),
    loadWeekSources(organizationId, year, year),
    loadRebuildRanges(organizationId),
    loadConfirmations(organizationId, year, year)
  ]);
  if (catalogResult.error) throw catalogResult.error;
  if (historicalResult.error) throw historicalResult.error;
  const catalog = (catalogResult.data ?? []) as CatalogPack[];
  const catalogById = new Map(catalog.map((p) => [p.pack_id, p]));
  const historicalById = new Map(((historicalResult.data ?? []) as Array<{ id: string; note: string | null }>).map((h) => [h.id, h]));

  const shipments = shipmentsAll.filter((s) => s.iso_week === week);
  const measurements = measurementsAll.filter((m) => m.iso_week === week);
  const legacyRows = legacy.filter((l) => l.week === week);
  const manualEntries = manualAll.filter((e) => e.iso_week === week);
  const choice = choices.find((c) => c.iso_week === week)?.source ?? null;
  const rebuildRange = rebuildRanges.find((r) => inRebuildRange([r], year, week)) ?? null;
  const confirmation = confirmations.find((c) => c.iso_week === week) ?? null;
  const decision = resolveWeekSource({
    scope, year, week, choice, manualEntries: manualEntries.length, legacyRows: legacyRows.length, inRebuildRange: Boolean(rebuildRange)
  });
  const totals =
    computeShippedYield({
      range: { from: { year, week }, to: { year, week } },
      scope,
      shipments,
      measurements,
      legacy: legacyRows,
      manual: manualEntries,
      weekSources: choice ? [{ iso_year: year, iso_week: week, source: choice }] : [],
      rebuildRanges: rebuildRange ? [rebuildRange] : [],
      confirmations: confirmation ? [confirmation] : []
    }).weeks[0] ?? null;

  // Pack rows shown with measurement inputs: DockLink's series in a pack week; the
  // week's manual entries (per pack and classification) otherwise, counted or not.
  const rows = decision.source === "packs" ? shipments : aggregateManualEntries(manualEntries);
  const rowsCount = decision.source !== "legacy";

  const packs: Array<Record<string, unknown>> = [];
  const attention: Array<Record<string, unknown>> = [];
  const nonPepper: Array<Record<string, unknown>> = [];
  const shownPackIds = new Set<string>();

  for (const row of rows) {
    const result = evaluateSeries(row, measurements);
    const isHistorical = row.pack_source === "historical";
    const pack = row.pack_id && !isHistorical ? catalogById.get(row.pack_id) : undefined;
    if (row.pack_id && !isHistorical) shownPackIds.add(row.pack_id);
    const shared = {
      seriesKey: row.origin === "manual" ? null : row.series_key,
      measurementKey: row.pack_id ? measurementKey(row) : null,
      origin: row.origin ?? "import",
      entryCount: row.entry_count ?? null,
      packSource: row.pack_source ?? "docklink",
      packId: row.pack_id,
      name: row.pack_name ?? pack?.name ?? row.source_pack_ref ?? "Unknown pack",
      packCode: row.pack_code ?? pack?.pack_code ?? null,
      cases: row.total_cases
    };
    if (result.status === "non_pepper") {
      if (row.total_cases > 0) nonPepper.push({ ...shared, cropType: row.crop_type, trackingUnit: row.tracking_unit });
      continue;
    }
    if (result.classification.kind === "attention") {
      if (row.total_cases > 0) {
        attention.push({ ...shared, reason: result.classification.reason, sourcePackRef: row.source_pack_ref, colorKind: row.color_kind, colorKey: row.color_key, cropType: row.crop_type, trackingUnit: row.tracking_unit });
      }
      continue;
    }
    packs.push({
      ...shared,
      displayOrder: pack?.display_order ?? null,
      // Current catalogue name/code when they differ from the ship-time ones (renamed packs).
      currentName: pack && pack.name !== shared.name ? pack.name : null,
      currentPackCode: pack && pack.pack_code !== shared.packCode ? pack.pack_code : null,
      description: pack?.description ?? (isHistorical ? historicalById.get(row.pack_id ?? "")?.note ?? null : null),
      packStatus: isHistorical ? "historical" : pack ? (isActivePack(pack) ? "active" : "archived") : "not_in_catalogue",
      colorKind: result.classification.kind,
      colorKey: result.classification.kind === "single" ? result.classification.color : row.color_key,
      colorLabel: pack?.color_label ?? null,
      // Classification at ship time differs from the pack's current catalogue classification.
      reclassifiedSince: Boolean(pack && ((pack.color_kind ?? "") !== (row.color_kind ?? "") || (pack.color_key ?? "") !== (row.color_key ?? "") || (pack.crop_type ?? "") !== (row.crop_type ?? ""))),
      loadCount: row.origin === "manual" ? null : row.load_count ?? null,
      status: result.status,
      counted: rowsCount,
      kg: result.status === "measured" ? result.kg : null,
      kgByColor: result.status === "measured" ? result.kgByColor : null,
      measurement:
        result.measurement && result.status !== "incompatible"
          ? {
              netKgPerCase: result.measurement.net_kg_per_case,
              components: (result.measurement.components ?? []).map((c) => ({ color: c.color, piecesPerCase: c.pieces_per_case, fruitWeightG: c.fruit_weight_g })),
              copiedFrom:
                result.measurement.copied_from_iso_year !== null
                  ? { isoYear: result.measurement.copied_from_iso_year, isoWeek: result.measurement.copied_from_iso_week }
                  : null
            }
          : null
    });
  }

  if (decision.source === "packs") {
    // Active packs with no shipments this week are listed too (nothing to measure).
    for (const pack of catalog) {
      if (!isActivePack(pack) || shownPackIds.has(pack.pack_id)) continue;
      const classification = classifyShipment({ attribution: "pack", color_key: pack.color_key, color_kind: pack.color_kind, crop_type: pack.crop_type, tracking_unit: pack.tracking_unit });
      if (classification.kind === "non_pepper") {
        nonPepper.push({ seriesKey: null, measurementKey: null, origin: "import", entryCount: null, packSource: "docklink", packId: pack.pack_id, name: pack.name, packCode: pack.pack_code, cases: 0, cropType: pack.crop_type, trackingUnit: pack.tracking_unit });
        continue;
      }
      packs.push({
        seriesKey: null,
        measurementKey: null,
        origin: "import",
        entryCount: null,
        packSource: "docklink",
        packId: pack.pack_id,
        name: pack.name,
        packCode: pack.pack_code,
        cases: 0,
        displayOrder: pack.display_order,
        currentName: null,
        currentPackCode: null,
        description: pack.description,
        packStatus: "active",
        colorKind: classification.kind === "attention" ? pack.color_kind : classification.kind,
        colorKey: classification.kind === "single" ? classification.color : pack.color_key,
        colorLabel: pack.color_label,
        reclassifiedSince: false,
        loadCount: 0,
        status: "no_shipments",
        counted: true,
        kg: null,
        kgByColor: null,
        measurement: null
      });
    }
  }
  packs.sort((a, b) => {
    const ao = (a.displayOrder as number | null) ?? Number.MAX_SAFE_INTEGER;
    const bo = (b.displayOrder as number | null) ?? Number.MAX_SAFE_INTEGER;
    return ao !== bo ? ao - bo : String(a.name).localeCompare(String(b.name));
  });

  const needing = rows.filter((row) => {
    const r = evaluateSeries(row, measurements);
    return r.status === "missing" || r.status === "incompatible";
  });
  const duplicates = await findDuplicates(organizationId, manualEntries);
  const owned = isPackWeek(scope, year, week);
  const wk = (y: number, w: number) => `${y}-W${String(w).padStart(2, "0")}`;

  return {
    isoYear: year,
    isoWeek: week,
    weekStart: isoWeekStart(year, week),
    weekEnd: new Date(Date.parse(isoWeekStart(year, week)) + 6 * 86_400_000).toISOString().slice(0, 10),
    sync: syncSummary(state),
    source: decision.source,
    sourceReason: decision.reason,
    needsSourceDecision: decision.needsSourceDecision,
    weekSourceChoice: choice,
    rebuildRange: rebuildRange
      ? { id: rebuildRange.id, from: { isoYear: rebuildRange.from.year, isoWeek: rebuildRange.from.week }, to: { isoYear: rebuildRange.to.year, isoWeek: rebuildRange.to.week } }
      : null,
    manualStatus: totals?.manualStatus ?? null,
    confirmation: confirmation ? { confirmedAt: confirmation.confirmed_at, note: confirmation.note } : null,
    notCounted: totals?.notCounted ?? { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 },
    manualEntryAllowed: !owned,
    manualEntryBlockedReason:
      owned && scope?.first && scope.last
        ? `DockLink pack totals are authoritative for this week (DockLink's pack scope is ${wk(scope.first.year, scope.first.week)} to ${wk(scope.last.year, scope.last.week)}). Correct shipments in DockLink instead.`
        : null,
    packs,
    attention,
    nonPepper,
    manualEntries: manualEntries.map((e) => manualEntryView(e, duplicates.get(e.id) ?? [])),
    legacyRows: legacyRows.map((l) => ({ color: l.color, totalCases: l.total_cases, caseWeightKg: l.case_weight_kg, totalKg: l.total_kg, source: l.source })),
    totals,
    copySource: rows.length > 0 ? await findCopySource(organizationId, year, week, needing) : null
  };
}

packShipmentsRouter.get("/pack-shipments/week", canView, async (req, res) => {
  try {
    const { year, week } = parseWeekParam(req.query.isoYear, req.query.isoWeek, "");
    return res.json(await loadWeek(req.organizationId, year, week));
  } catch (error) {
    if (error instanceof RouteError) return res.status(error.status).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to load pack shipments.", "pack-shipments week error:", error);
  }
});

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/**
 * The row a measurement request refers to: by measurementKey (any week with
 * DockLink series or manual entries), or by seriesKey (DockLink series only).
 */
async function loadRowForMeasurement(organizationId: string, year: number, week: number, body: Record<string, unknown>): Promise<ShipmentRow | null> {
  const key = typeof body.measurementKey === "string" ? body.measurementKey : "";
  const seriesKey = typeof body.seriesKey === "string" ? body.seriesKey : "";
  if (!key && !seriesKey) throw new RouteError(400, "measurementKey is required.");
  const { rows, packWeek } = await loadMeasurableRows(organizationId, year, week);
  if (seriesKey && !key) {
    if (!packWeek) {
      throw new RouteError(409, `ISO ${year}-W${week} isn't a DockLink pack week (it uses legacy colour totals or manual pack entries), so a DockLink series can't be measured.`);
    }
    return rows.find((r) => r.series_key === seriesKey) ?? null;
  }
  return rows.find((r) => r.pack_id !== null && measurementKey(r) === key) ?? null;
}

const positiveNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

export function parseMeasurementBody(body: unknown, kind: "single" | "mixed"): { netKgPerCase: number | null; components: MeasurementComponent[] | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (kind === "single") {
    if (!positiveNumber(b.netKgPerCase)) throw new RouteError(400, "Average net pepper kg per shipping case must be a number greater than 0.");
    if (b.components !== undefined && b.components !== null) throw new RouteError(400, "A single-colour pack takes kg per case, not colour components.");
    return { netKgPerCase: b.netKgPerCase as number, components: null };
  }
  if (b.netKgPerCase !== undefined && b.netKgPerCase !== null) {
    throw new RouteError(400, "A mixed pack takes peppers per case and fruit weight per colour, not kg per case.");
  }
  if (!Array.isArray(b.components) || b.components.length === 0 || b.components.length > PEPPER_COLORS.length) {
    throw new RouteError(400, "Enter at least one colour for a mixed pack.");
  }
  const seen = new Set<string>();
  const components = b.components.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (!(PEPPER_COLORS as readonly string[]).includes(c.color as string)) throw new RouteError(400, `Unknown colour ${JSON.stringify(c.color)}.`);
    if (seen.has(c.color as string)) throw new RouteError(400, `Colour ${c.color} is listed twice.`);
    seen.add(c.color as string);
    if (!positiveNumber(c.piecesPerCase)) throw new RouteError(400, `Peppers per shipping case for ${c.color} must be greater than 0.`);
    if (!positiveNumber(c.fruitWeightG)) throw new RouteError(400, `Average fruit weight (g) for ${c.color} must be greater than 0.`);
    return { color: c.color as PepperColor, pieces_per_case: c.piecesPerCase as number, fruit_weight_g: c.fruitWeightG as number };
  });
  return { netKgPerCase: null, components };
}

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** The measurement identity columns for a row (normalized, as stored). */
function identityFor(row: ShipmentRow, kind: "single" | "mixed") {
  return {
    pack_source: row.pack_source ?? "docklink",
    pack_id: row.pack_id as string,
    color_kind: kind,
    color_key: lower(row.color_key),
    crop_type: lower(row.crop_type),
    tracking_unit: lower(row.tracking_unit)
  };
}

const MEASUREMENT_CONFLICT = "organization_id,iso_year,iso_week,pack_source,pack_id,color_kind,color_key,crop_type,tracking_unit";

packShipmentsRouter.put("/pack-shipments/measurements", canEdit, async (req, res) => {
  try {
    const { year, week } = parseWeekParam(req.body?.isoYear, req.body?.isoWeek, "");
    const row = await loadRowForMeasurement(req.organizationId, year, week, (req.body ?? {}) as Record<string, unknown>);
    if (!row) throw new RouteError(404, "That pack shipment was not found for this week.");
    const classification = classifyShipment(row);
    if (classification.kind !== "single" && classification.kind !== "mixed") {
      throw new RouteError(422, "This shipment's classification can't take a pepper measurement. It's listed under Needs attention.");
    }
    const values = parseMeasurementBody(req.body, classification.kind);
    const { data, error } = await supabase
      .from("pack_case_measurements")
      .upsert(
        {
          organization_id: req.organizationId,
          iso_year: year,
          iso_week: week,
          series_key: row.origin === "manual" ? null : row.series_key,
          ...identityFor(row, classification.kind),
          net_kg_per_case: values.netKgPerCase,
          components: values.components,
          copied_from_iso_year: null,
          copied_from_iso_week: null,
          updated_by: req.userId,
          updated_at: new Date().toISOString()
        },
        { onConflict: MEASUREMENT_CONFLICT }
      )
      .select(MEASUREMENT_COLUMNS)
      .single();
    if (error) throw error;
    return res.json({ measurement: toMeasurement(data as Record<string, unknown>) });
  } catch (error) {
    if (error instanceof RouteError) return res.status(error.status).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to save the measurement.", "pack measurement save error:", error);
  }
});

packShipmentsRouter.delete("/pack-shipments/measurements", canEdit, async (req, res) => {
  try {
    const { year, week } = parseWeekParam(req.query.isoYear, req.query.isoWeek, "");
    const row = await loadRowForMeasurement(req.organizationId, year, week, req.query as Record<string, unknown>);
    if (row && row.pack_id) {
      const kind = classifyShipment(row).kind === "mixed" ? "mixed" : "single";
      const id = identityFor(row, kind);
      const { error } = await supabase
        .from("pack_case_measurements")
        .delete()
        .eq("organization_id", req.organizationId)
        .eq("iso_year", year)
        .eq("iso_week", week)
        .eq("pack_source", id.pack_source)
        .eq("pack_id", id.pack_id)
        .eq("color_kind", id.color_kind)
        .eq("color_key", id.color_key)
        .eq("crop_type", id.crop_type)
        .eq("tracking_unit", id.tracking_unit);
      if (error) throw error;
    }
    return res.status(204).send();
  } catch (error) {
    if (error instanceof RouteError) return res.status(error.status).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to clear the measurement.", "pack measurement delete error:", error);
  }
});

// Copies an earlier week's measurements onto this week's packs that have
// none, for the same pack and ship-time classification. Works for DockLink
// pack weeks and manual weeks alike. Never overwrites an existing
// measurement; each copy records its origin week.
packShipmentsRouter.post("/pack-shipments/measurements/copy", canEdit, async (req, res) => {
  try {
    const target = parseWeekParam(req.body?.isoYear, req.body?.isoWeek, "Target");
    const source = parseWeekParam(req.body?.fromIsoYear, req.body?.fromIsoWeek, "Source");
    if (weekOrdinal(source.year, source.week) >= weekOrdinal(target.year, target.week)) {
      throw new RouteError(400, "Measurements can only be copied from an earlier week.");
    }
    const { rows } = await loadMeasurableRows(req.organizationId, target.year, target.week);
    if (rows.length === 0) {
      throw new RouteError(409, `ISO ${target.year}-W${target.week} has no pack shipments or manual pack entries to measure.`);
    }
    const [targetMeasurements, sourceMeasurements] = await Promise.all([
      loadMeasurements(req.organizationId, target.year, target.year).then((r) => r.filter((m) => m.iso_week === target.week)),
      loadMeasurements(req.organizationId, source.year, source.year).then((r) => r.filter((m) => m.iso_week === source.week))
    ]);

    const copied: Array<{ measurementKey: string; seriesKey: string | null; name: string | null }> = [];
    const skipped: Array<{ measurementKey: string; seriesKey: string | null; name: string | null; reason: string }> = [];
    const inserts: Record<string, unknown>[] = [];
    for (const row of rows) {
      const classification = classifyShipment(row);
      if (classification.kind !== "single" && classification.kind !== "mixed") continue;
      const key = measurementKey(row);
      const seriesKey = row.origin === "manual" ? null : row.series_key;
      if (targetMeasurements.some((m) => measurementMatches(m, row))) {
        skipped.push({ measurementKey: key, seriesKey, name: row.pack_name, reason: "already has a measurement" });
        continue;
      }
      const from = sourceMeasurements.find((m) => measurementMatches(m, row));
      if (!from) {
        skipped.push({ measurementKey: key, seriesKey, name: row.pack_name, reason: "no measurement with the same pack and classification in that week" });
        continue;
      }
      inserts.push({
        organization_id: req.organizationId,
        iso_year: target.year,
        iso_week: target.week,
        series_key: row.origin === "manual" ? null : row.series_key,
        ...identityFor(row, classification.kind),
        net_kg_per_case: from.net_kg_per_case,
        components: from.components,
        copied_from_iso_year: source.year,
        copied_from_iso_week: source.week,
        updated_by: req.userId,
        updated_at: new Date().toISOString()
      });
      copied.push({ measurementKey: key, seriesKey, name: row.pack_name });
    }
    if (inserts.length > 0) {
      // ignoreDuplicates: a measurement saved concurrently is kept, never overwritten.
      const { error } = await supabase.from("pack_case_measurements").upsert(inserts, { onConflict: MEASUREMENT_CONFLICT, ignoreDuplicates: true });
      if (error) throw error;
    }
    return res.json({ copied, skipped, from: { isoYear: source.year, isoWeek: source.week } });
  } catch (error) {
    if (error instanceof RouteError) return res.status(error.status).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to copy measurements.", "pack measurement copy error:", error);
  }
});

export { packShipmentsRouter };
