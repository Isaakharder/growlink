// Manual pack case entries (migration 0144): reconstructing shipment history
// per Product Pack from invoices, including weeks before DockLink's pack
// capture started.
//
// Manual entries are user data: only these routes write
// manual_pack_case_entries, historical_packs and case_week_sources, and no
// DockLink sync ever does. Their cases go through the same shipped-yield
// calculation (lib/shippedYield.ts) as DockLink's pack shipments, with the
// same weekly measurements.
import { Router } from "express";
import { supabase } from "../config/supabase";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import { sendSafeError } from "../utils/safeError";
import { isDocklinkOwnedWeek, type PackSource } from "../lib/shippedYield";
import {
  MANUAL_ENTRY_COLUMNS,
  RouteError,
  isLikelyDuplicate,
  loadSyncState,
  manualEntryView,
  parseWeekParam,
  selectAll,
  toManualEntry,
  toScope,
  type ManualEntryRecord
} from "./packShipments";

const manualPackEntriesRouter = Router();
const canView = requireAnyPermission(["cases:view", "cases:edit"]);
const canEdit = requirePermission("cases:edit");

const PEPPER_COLOR_KEYS = ["red", "orange", "yellow", "green"];
const CROP_TYPES = ["pepper", "cucumber", "tomato", "other"];
const TRACKING_UNITS = ["kg", "case", "piece", "lb"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 50;
const MAX_CASES = 1_000_000;

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

function respondError(res: import("express").Response, error: unknown, clientMessage: string, logContext: string) {
  if (error instanceof RouteError) return res.status(error.status).json({ message: error.message, ...((error as RouteError & { details?: object }).details ?? {}) });
  return sendSafeError(res, 500, clientMessage, logContext, error);
}

function routeError(status: number, message: string, details?: object): RouteError {
  return Object.assign(new RouteError(status, message), { details });
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw routeError(400, `${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw routeError(400, `${label} must be ${max} characters or fewer.`);
  return trimmed || null;
}

function parseCases(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_CASES) {
    throw routeError(400, `Shipped cases must be a number greater than 0 (at most ${MAX_CASES.toLocaleString()}).`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Packs available for manual entry
// ---------------------------------------------------------------------------

type PackSnapshot = {
  pack_source: PackSource;
  docklink_pack_id: string | null;
  historical_pack_id: string | null;
  pack_name: string;
  pack_code: string | null;
  color_kind: "single" | "mixed" | "none";
  color_key: string;
  crop_type: string;
  tracking_unit: string;
};

function normalizeKind(kind: unknown, key: unknown): { color_kind: PackSnapshot["color_kind"]; color_key: string } {
  const k = lower(kind);
  const c = lower(key);
  if (k === "single" && PEPPER_COLOR_KEYS.includes(c)) return { color_kind: "single", color_key: c };
  if (k === "mixed") return { color_kind: "mixed", color_key: "mixed" };
  // A colour GrowLink doesn't track keeps its key so the entry is listed under Needs attention.
  if (k === "single") return { color_kind: "single", color_key: c };
  return { color_kind: "none", color_key: "" };
}

/** The pack as it is now, captured onto the entry (later pack edits never reclassify the entry). */
async function resolvePack(organizationId: string, packSource: unknown, packId: unknown): Promise<PackSnapshot> {
  if (packSource !== "docklink" && packSource !== "historical") throw routeError(400, "packSource must be docklink or historical.");
  if (typeof packId !== "string" || !packId.trim()) throw routeError(400, "packId is required.");
  if (packSource === "docklink") {
    const { data, error } = await supabase
      .from("docklink_packs")
      .select("pack_id, name, pack_code, color_kind, color_key, crop_type, tracking_unit")
      .eq("organization_id", organizationId)
      .eq("pack_id", packId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw routeError(404, "That DockLink pack isn't in GrowLink's copy of the DockLink catalogue. Sync DockLink packs, or use a historical pack.");
    const p = data as Record<string, unknown>;
    return {
      pack_source: "docklink",
      docklink_pack_id: String(p.pack_id),
      historical_pack_id: null,
      pack_name: String(p.name),
      pack_code: (p.pack_code as string | null) ?? null,
      ...normalizeKind(p.color_kind, p.color_key),
      crop_type: lower(p.crop_type),
      tracking_unit: lower(p.tracking_unit)
    };
  }
  if (!UUID.test(packId)) throw routeError(404, "That historical pack was not found.");
  const { data, error } = await supabase
    .from("historical_packs")
    .select("id, name, pack_code, color_kind, color_key, crop_type, tracking_unit")
    .eq("organization_id", organizationId)
    .eq("id", packId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw routeError(404, "That historical pack was not found.");
  const h = data as Record<string, unknown>;
  return {
    pack_source: "historical",
    docklink_pack_id: null,
    historical_pack_id: String(h.id),
    pack_name: String(h.name),
    pack_code: (h.pack_code as string | null) ?? null,
    color_kind: h.color_kind as PackSnapshot["color_kind"],
    color_key: String(h.color_key ?? ""),
    crop_type: String(h.crop_type),
    tracking_unit: String(h.tracking_unit)
  };
}

manualPackEntriesRouter.get("/manual-pack-entries/packs", canView, async (req, res) => {
  try {
    const [docklink, historical, usage] = await Promise.all([
      selectAll<Record<string, unknown>>(() =>
        supabase
          .from("docklink_packs")
          .select("pack_id, name, pack_code, description, color_label, color_key, color_kind, display_order, crop_type, tracking_unit, status, archived_at, in_latest_export")
          .eq("organization_id", req.organizationId)
          .order("display_order")
          .order("name")
          .order("pack_id")
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase
          .from("historical_packs")
          .select("id, name, pack_code, color_kind, color_key, crop_type, tracking_unit, note, created_at")
          .eq("organization_id", req.organizationId)
          .order("name")
          .order("id")
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("manual_pack_case_entries").select("historical_pack_id").eq("organization_id", req.organizationId).not("historical_pack_id", "is", null).order("id")
      )
    ]);
    const used = new Map<string, number>();
    for (const u of usage) used.set(String(u.historical_pack_id), (used.get(String(u.historical_pack_id)) ?? 0) + 1);
    return res.json({
      docklink: docklink.map((p) => ({
        packSource: "docklink",
        packId: p.pack_id,
        name: p.name,
        packCode: p.pack_code,
        description: p.description,
        ...normalizeKindView(p.color_kind, p.color_key),
        cropType: lower(p.crop_type) || null,
        trackingUnit: lower(p.tracking_unit) || null,
        displayOrder: p.display_order === null ? null : Number(p.display_order),
        // active | archived | not_in_docklink (no longer listed in DockLink's export)
        status: p.status === "active" && !p.archived_at && p.in_latest_export ? "active" : p.in_latest_export ? "archived" : "not_in_docklink"
      })),
      historical: historical.map((h) => ({
        packSource: "historical",
        packId: h.id,
        name: h.name,
        packCode: h.pack_code,
        description: h.note,
        colorKind: h.color_kind,
        colorKey: h.color_key,
        cropType: h.crop_type,
        trackingUnit: h.tracking_unit,
        displayOrder: null,
        status: "historical",
        entryCount: used.get(String(h.id)) ?? 0
      }))
    });
  } catch (error) {
    return respondError(res, error, "Failed to load packs.", "manual pack list error:");
  }
});

function normalizeKindView(kind: unknown, key: unknown) {
  const n = normalizeKind(kind, key);
  return { colorKind: n.color_kind, colorKey: n.color_key };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

async function assertWeekOpenForManual(organizationId: string, year: number, week: number) {
  const scope = toScope(await loadSyncState(organizationId));
  if (isDocklinkOwnedWeek(scope, year, week)) {
    throw routeError(
      409,
      `DockLink pack totals are authoritative from ${scope?.first?.year}-W${String(scope?.first?.week).padStart(2, "0")} on, so ${year}-W${String(week).padStart(2, "0")} can't take manual pack entries. Correct the shipment in DockLink instead.`,
      { code: "docklink_owned_week" }
    );
  }
}

async function weekLegacy(organizationId: string, year: number, week: number) {
  const { data, error } = await supabase
    .from("color_case_entries")
    .select("color, total_cases")
    .eq("organization_id", organizationId)
    .eq("year", year)
    .eq("week", week);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ color: string; total_cases: number }>;
  return { rows: rows.length, cases: rows.reduce((s, r) => s + (Number(r.total_cases) || 0), 0) };
}

async function weekChoice(organizationId: string, year: number, week: number): Promise<"manual_packs" | "legacy_colours" | null> {
  const { data, error } = await supabase
    .from("case_week_sources")
    .select("source")
    .eq("organization_id", organizationId)
    .eq("iso_year", year)
    .eq("iso_week", week)
    .maybeSingle();
  if (error) throw error;
  return ((data as { source?: string } | null)?.source as "manual_packs" | "legacy_colours" | undefined) ?? null;
}

async function setWeekChoice(organizationId: string, userId: string | undefined, year: number, week: number, source: "manual_packs" | "legacy_colours") {
  const { error } = await supabase
    .from("case_week_sources")
    .upsert({ organization_id: organizationId, iso_year: year, iso_week: week, source, chosen_by: userId ?? null, chosen_at: new Date().toISOString() }, { onConflict: "organization_id,iso_year,iso_week" });
  if (error) throw error;
}

function parseWeekSource(value: unknown): "manual_packs" | "legacy_colours" | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "manual_packs" || value === "legacy_colours") return value;
  throw routeError(400, "weekSource must be manual_packs or legacy_colours.");
}

/**
 * The week's source after saving manual entries into it. An explicit choice
 * is kept (or replaced by one sent with the request). Without one, a week
 * with colour totals needs the user to choose; a week without colour totals
 * records "manual_packs", so colour totals synced later never silently
 * replace the entered history.
 */
async function decideWeekSource(organizationId: string, year: number, week: number, requested: "manual_packs" | "legacy_colours" | null) {
  if (requested) return { set: requested };
  const existing = await weekChoice(organizationId, year, week);
  if (existing) return { set: null as null, existing };
  const legacy = await weekLegacy(organizationId, year, week);
  if (legacy.rows > 0) {
    throw routeError(
      409,
      `${year}-W${String(week).padStart(2, "0")} already has colour totals (${legacy.cases.toLocaleString()} cases). Choose whether manual pack entries or colour totals count for this week.`,
      { code: "week_source_required", legacyRows: legacy.rows, legacyCases: legacy.cases }
    );
  }
  return { set: "manual_packs" as const };
}

/** Existing entries that look like the same invoice lines as `candidates` (see isLikelyDuplicate). */
async function findExistingDuplicates(organizationId: string, candidates: Array<ManualEntryRecord | (Omit<ManualEntryRecord, "id"> & { id: string })>, excludeId?: string) {
  const keys = [...new Set(candidates.map((c) => c.invoice_ref_key).filter((k): k is string => Boolean(k)))];
  const weeks = [...new Set(candidates.filter((c) => !c.invoice_ref_key).map((c) => `${c.iso_year}-${c.iso_week}`))];
  const pools: ManualEntryRecord[] = [];
  if (keys.length) {
    pools.push(
      ...(await selectAll<Record<string, unknown>>(() =>
        supabase.from("manual_pack_case_entries").select(MANUAL_ENTRY_COLUMNS).eq("organization_id", organizationId).in("invoice_ref_key", keys).order("id")
      )).map(toManualEntry)
    );
  }
  for (const w of weeks) {
    const [y, wk] = w.split("-").map(Number);
    pools.push(
      ...(await selectAll<Record<string, unknown>>(() =>
        supabase.from("manual_pack_case_entries").select(MANUAL_ENTRY_COLUMNS).eq("organization_id", organizationId).eq("iso_year", y).eq("iso_week", wk).order("id")
      )).map(toManualEntry)
    );
  }
  const found: Array<{ line: number; existing: ReturnType<typeof manualEntryView> }> = [];
  candidates.forEach((c, line) => {
    for (const e of pools) {
      if (e.id === excludeId || e.id === c.id) continue;
      if (isLikelyDuplicate(c, e) && !found.some((f) => f.line === line && f.existing.id === e.id)) found.push({ line, existing: manualEntryView(e) });
    }
  });
  return found;
}

const invoiceKey = (ref: string | null) => (ref ? ref.trim().toLowerCase() || null : null);

function entryInsert(organizationId: string, userId: string | undefined, year: number, week: number, pack: PackSnapshot, cases: number, invoiceRef: string | null, note: string | null) {
  return {
    organization_id: organizationId,
    iso_year: year,
    iso_week: week,
    ...pack,
    cases,
    invoice_ref: invoiceRef,
    note,
    created_by: userId ?? null,
    updated_by: userId ?? null
  };
}

const asCandidate = (row: ReturnType<typeof entryInsert>, id: string): ManualEntryRecord => ({
  id,
  iso_year: row.iso_year,
  iso_week: row.iso_week,
  pack_source: row.pack_source,
  pack_id: (row.pack_source === "historical" ? row.historical_pack_id : row.docklink_pack_id) as string,
  pack_name: row.pack_name,
  pack_code: row.pack_code,
  color_kind: row.color_kind,
  color_key: row.color_key,
  crop_type: row.crop_type,
  tracking_unit: row.tracking_unit,
  cases: row.cases,
  invoice_ref: row.invoice_ref,
  invoice_ref_key: invoiceKey(row.invoice_ref),
  note: row.note,
  created_at: "",
  updated_at: ""
});

manualPackEntriesRouter.get("/manual-pack-entries", canView, async (req, res) => {
  try {
    const { year } = parseWeekParam(req.query.isoYear, req.query.isoWeek ?? 1, "");
    const week = req.query.isoWeek === undefined || req.query.isoWeek === "" ? null : parseWeekParam(req.query.isoYear, req.query.isoWeek, "").week;
    const rows = await selectAll<Record<string, unknown>>(() => {
      let q = supabase.from("manual_pack_case_entries").select(MANUAL_ENTRY_COLUMNS).eq("organization_id", req.organizationId).eq("iso_year", year);
      if (week !== null) q = q.eq("iso_week", week);
      return q.order("iso_week").order("created_at").order("id");
    });
    const entries = rows.map(toManualEntry);
    return res.json({ entries: entries.map((e) => manualEntryView(e, entries.filter((o) => o.id !== e.id && isLikelyDuplicate(e, o)))) });
  } catch (error) {
    return respondError(res, error, "Failed to load manual pack entries.", "manual pack entries list error:");
  }
});

// One invoice (or one batch) for one ISO week: several pack lines, each its own entry.
manualPackEntriesRouter.post("/manual-pack-entries", canEdit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { year, week } = parseWeekParam(body.isoYear, body.isoWeek, "");
    await assertWeekOpenForManual(req.organizationId, year, week);
    const invoiceRef = optionalText(body.invoiceRef, "Invoice reference", 100);
    const note = optionalText(body.note, "Note", 500);
    if (!Array.isArray(body.lines) || body.lines.length === 0) throw routeError(400, "Add at least one pack with shipped cases.");
    if (body.lines.length > MAX_LINES) throw routeError(400, `At most ${MAX_LINES} packs per save.`);

    const inserts: Array<ReturnType<typeof entryInsert>> = [];
    const seen = new Set<string>();
    for (const [i, raw] of (body.lines as unknown[]).entries()) {
      const line = (raw ?? {}) as Record<string, unknown>;
      const key = `${line.packSource}:${line.packId}`;
      if (seen.has(key)) throw routeError(400, `Line ${i + 1}: that pack is already on this entry — combine the cases into one line.`);
      seen.add(key);
      const cases = parseCases(line.cases);
      const pack = await resolvePack(req.organizationId, line.packSource, line.packId);
      inserts.push(entryInsert(req.organizationId, req.userId, year, week, pack, cases, invoiceRef, note));
    }

    if (body.confirmDuplicates !== true) {
      const duplicates = await findExistingDuplicates(req.organizationId, inserts.map((r, i) => asCandidate(r, `new-${i}`)));
      if (duplicates.length > 0) {
        throw routeError(409, "Some of these lines look like entries that already exist. Check them, then save again to confirm.", {
          code: "possible_duplicates",
          duplicates
        });
      }
    }

    const decision = await decideWeekSource(req.organizationId, year, week, parseWeekSource(body.weekSource));
    // Entries first: if recording the week's source then fails, the entries are flagged as
    // needing a decision rather than a source choice existing without its entries.
    const { data, error } = await supabase.from("manual_pack_case_entries").insert(inserts).select(MANUAL_ENTRY_COLUMNS);
    if (error) throw error;
    if (decision.set) await setWeekChoice(req.organizationId, req.userId, year, week, decision.set);
    const created = ((data ?? []) as Record<string, unknown>[]).map(toManualEntry);
    return res.status(201).json({ entries: created.map((e) => manualEntryView(e)), weekSource: decision.set ?? decision.existing ?? null });
  } catch (error) {
    return respondError(res, error, "Failed to save manual pack entries.", "manual pack entries create error:");
  }
});

async function loadEntry(organizationId: string, id: string): Promise<ManualEntryRecord> {
  if (!UUID.test(id)) throw routeError(404, "That entry was not found.");
  const { data, error } = await supabase.from("manual_pack_case_entries").select(MANUAL_ENTRY_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw routeError(404, "That entry was not found.");
  return toManualEntry(data as Record<string, unknown>);
}

/** After a week loses entries: a "manual_packs" choice with no entries left is removed, so colour totals count again. */
async function releaseEmptyManualWeek(organizationId: string, year: number, week: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("manual_pack_case_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("iso_year", year)
    .eq("iso_week", week)
    .limit(1);
  if (error) throw error;
  if ((data as unknown[] | null)?.length) return false;
  if ((await weekChoice(organizationId, year, week)) !== "manual_packs") return false;
  const del = await supabase.from("case_week_sources").delete().eq("organization_id", organizationId).eq("iso_year", year).eq("iso_week", week).eq("source", "manual_packs");
  if (del.error) throw del.error;
  return true;
}

manualPackEntriesRouter.put("/manual-pack-entries/:id", canEdit, async (req, res) => {
  try {
    const existing = await loadEntry(req.organizationId, String(req.params.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { year, week } = parseWeekParam(body.isoYear ?? existing.iso_year, body.isoWeek ?? existing.iso_week, "");
    const weekChanged = year !== existing.iso_year || week !== existing.iso_week;
    if (weekChanged) await assertWeekOpenForManual(req.organizationId, year, week);
    const packSource = body.packSource ?? existing.pack_source;
    const packId = body.packId ?? existing.pack_id;
    const packChanged = packSource !== existing.pack_source || packId !== existing.pack_id;
    // The classification captured at entry time is kept unless the entry is moved to another pack.
    const pack: PackSnapshot = packChanged
      ? await resolvePack(req.organizationId, packSource, packId)
      : {
          pack_source: existing.pack_source,
          docklink_pack_id: existing.pack_source === "docklink" ? existing.pack_id : null,
          historical_pack_id: existing.pack_source === "historical" ? existing.pack_id : null,
          pack_name: existing.pack_name,
          pack_code: existing.pack_code,
          color_kind: existing.color_kind as PackSnapshot["color_kind"],
          color_key: existing.color_key,
          crop_type: existing.crop_type,
          tracking_unit: existing.tracking_unit
        };
    const cases = body.cases === undefined ? existing.cases : parseCases(body.cases);
    const invoiceRef = body.invoiceRef === undefined ? existing.invoice_ref : optionalText(body.invoiceRef, "Invoice reference", 100);
    const note = body.note === undefined ? existing.note : optionalText(body.note, "Note", 500);
    const row = entryInsert(req.organizationId, req.userId, year, week, pack, cases, invoiceRef, note);

    if (body.confirmDuplicates !== true) {
      const duplicates = await findExistingDuplicates(req.organizationId, [asCandidate(row, existing.id)], existing.id);
      if (duplicates.length > 0) {
        throw routeError(409, "This entry looks like one that already exists. Check it, then save again to confirm.", { code: "possible_duplicates", duplicates });
      }
    }
    const decision = weekChanged ? await decideWeekSource(req.organizationId, year, week, parseWeekSource(body.weekSource)) : { set: parseWeekSource(body.weekSource) };

    const { created_by: _createdBy, organization_id: _org, ...update } = row;
    const { data, error } = await supabase
      .from("manual_pack_case_entries")
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq("organization_id", req.organizationId)
      .eq("id", existing.id)
      .select(MANUAL_ENTRY_COLUMNS)
      .single();
    if (error) throw error;
    if (decision.set) await setWeekChoice(req.organizationId, req.userId, year, week, decision.set);
    const releasedPreviousWeek = weekChanged ? await releaseEmptyManualWeek(req.organizationId, existing.iso_year, existing.iso_week) : false;
    return res.json({ entry: manualEntryView(toManualEntry(data as Record<string, unknown>)), releasedPreviousWeek });
  } catch (error) {
    return respondError(res, error, "Failed to update the manual pack entry.", "manual pack entry update error:");
  }
});

manualPackEntriesRouter.delete("/manual-pack-entries/:id", canEdit, async (req, res) => {
  try {
    const existing = await loadEntry(req.organizationId, String(req.params.id));
    const { error } = await supabase.from("manual_pack_case_entries").delete().eq("organization_id", req.organizationId).eq("id", existing.id);
    if (error) throw error;
    const releasedWeekSource = await releaseEmptyManualWeek(req.organizationId, existing.iso_year, existing.iso_week);
    return res.json({ deleted: existing.id, releasedWeekSource });
  } catch (error) {
    return respondError(res, error, "Failed to delete the manual pack entry.", "manual pack entry delete error:");
  }
});

// ---------------------------------------------------------------------------
// Explicit week source
// ---------------------------------------------------------------------------

manualPackEntriesRouter.put("/case-week-sources", canEdit, async (req, res) => {
  try {
    const { year, week } = parseWeekParam(req.body?.isoYear, req.body?.isoWeek, "");
    await assertWeekOpenForManual(req.organizationId, year, week);
    const source = parseWeekSource(req.body?.source);
    if (!source) throw routeError(400, "source must be manual_packs or legacy_colours.");
    await setWeekChoice(req.organizationId, req.userId, year, week, source);
    return res.json({ isoYear: year, isoWeek: week, source });
  } catch (error) {
    return respondError(res, error, "Failed to set the week's source.", "case week source error:");
  }
});

manualPackEntriesRouter.delete("/case-week-sources", canEdit, async (req, res) => {
  try {
    const { year, week } = parseWeekParam(req.query.isoYear, req.query.isoWeek, "");
    const { error } = await supabase.from("case_week_sources").delete().eq("organization_id", req.organizationId).eq("iso_year", year).eq("iso_week", week);
    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    return respondError(res, error, "Failed to clear the week's source.", "case week source delete error:");
  }
});

// ---------------------------------------------------------------------------
// Historical packs
// ---------------------------------------------------------------------------

function parseHistoricalClassification(body: Record<string, unknown>) {
  const colorKind = lower(body.colorKind);
  if (!["single", "mixed", "none"].includes(colorKind)) throw routeError(400, "Colour type must be single colour, mixed/rainbow or no colour.");
  const colorKey = colorKind === "single" ? lower(body.colorKey) : colorKind === "mixed" ? "mixed" : "";
  if (colorKind === "single" && !PEPPER_COLOR_KEYS.includes(colorKey)) throw routeError(400, "Choose the pack's colour: red, orange, yellow or green.");
  const cropType = lower(body.cropType);
  if (!CROP_TYPES.includes(cropType)) throw routeError(400, `Crop type must be one of ${CROP_TYPES.join(", ")}.`);
  const trackingUnit = lower(body.trackingUnit);
  if (!TRACKING_UNITS.includes(trackingUnit)) throw routeError(400, `Tracking unit must be one of ${TRACKING_UNITS.join(", ")}.`);
  return { color_kind: colorKind, color_key: colorKey, crop_type: cropType, tracking_unit: trackingUnit };
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw routeError(400, "Pack name is required.");
  if (value.trim().length > 120) throw routeError(400, "Pack name must be 120 characters or fewer.");
  return value.trim();
}

async function historicalUsage(organizationId: string, id: string): Promise<number> {
  const rows = await selectAll<Record<string, unknown>>(() =>
    supabase.from("manual_pack_case_entries").select("id").eq("organization_id", organizationId).eq("historical_pack_id", id).order("id")
  );
  return rows.length;
}

manualPackEntriesRouter.post("/historical-packs", canEdit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { data, error } = await supabase
      .from("historical_packs")
      .insert({
        organization_id: req.organizationId,
        name: parseName(body.name),
        pack_code: optionalText(body.packCode, "Pack code", 60),
        note: optionalText(body.note, "Note", 500),
        ...parseHistoricalClassification(body),
        created_by: req.userId ?? null
      })
      .select("id, name, pack_code, color_kind, color_key, crop_type, tracking_unit, note")
      .single();
    if (error) throw error;
    return res.status(201).json({ pack: data });
  } catch (error) {
    return respondError(res, error, "Failed to save the historical pack.", "historical pack create error:");
  }
});

manualPackEntriesRouter.put("/historical-packs/:id", canEdit, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw routeError(404, "That historical pack was not found.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { data: current, error: loadError } = await supabase
      .from("historical_packs")
      .select("id, color_kind, color_key, crop_type, tracking_unit")
      .eq("organization_id", req.organizationId)
      .eq("id", id)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!current) throw routeError(404, "That historical pack was not found.");
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) update.name = parseName(body.name);
    if (body.packCode !== undefined) update.pack_code = optionalText(body.packCode, "Pack code", 60);
    if (body.note !== undefined) update.note = optionalText(body.note, "Note", 500);
    if (body.colorKind !== undefined || body.cropType !== undefined || body.trackingUnit !== undefined || body.colorKey !== undefined) {
      const c = current as Record<string, unknown>;
      const next = parseHistoricalClassification({
        colorKind: body.colorKind ?? c.color_kind,
        colorKey: body.colorKey ?? c.color_key,
        cropType: body.cropType ?? c.crop_type,
        trackingUnit: body.trackingUnit ?? c.tracking_unit
      });
      const changed = next.color_kind !== c.color_kind || next.color_key !== c.color_key || next.crop_type !== c.crop_type || next.tracking_unit !== c.tracking_unit;
      if (changed) {
        const used = await historicalUsage(req.organizationId, id);
        if (used > 0) {
          throw routeError(409, `This pack is used by ${used} entr${used === 1 ? "y" : "ies"}, so its colour, crop and unit are fixed. Create a new historical pack and move the entries to it instead.`);
        }
        Object.assign(update, next);
      }
    }
    const { data, error } = await supabase
      .from("historical_packs")
      .update(update)
      .eq("organization_id", req.organizationId)
      .eq("id", id)
      .select("id, name, pack_code, color_kind, color_key, crop_type, tracking_unit, note")
      .single();
    if (error) throw error;
    return res.json({ pack: data });
  } catch (error) {
    return respondError(res, error, "Failed to update the historical pack.", "historical pack update error:");
  }
});

manualPackEntriesRouter.delete("/historical-packs/:id", canEdit, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) throw routeError(404, "That historical pack was not found.");
    const used = await historicalUsage(req.organizationId, id);
    if (used > 0) throw routeError(409, `This pack is used by ${used} entr${used === 1 ? "y" : "ies"}. Delete or move them first.`);
    const { data, error } = await supabase.from("historical_packs").delete().eq("organization_id", req.organizationId).eq("id", id).select("id");
    if (error) throw error;
    if (!(data as unknown[] | null)?.length) throw routeError(404, "That historical pack was not found.");
    return res.status(204).send();
  } catch (error) {
    return respondError(res, error, "Failed to delete the historical pack.", "historical pack delete error:");
  }
});

export { manualPackEntriesRouter };
