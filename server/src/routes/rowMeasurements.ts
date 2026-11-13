// Setup → Map: real row measurements (migration 0157, PREVIEW for review).
//
// Setup → Map is the source of truth for each row's real width and length
// (meters). The baseline is copied exactly from Greenhouse Setup (the row's
// own size, else its section's; missing ones are flagged); the map drawing's
// sizes are never used. Resizing adds a version that applies from a date, and
// new rows exist from the date they're added for, so past and current figures
// keep the size that applied at the time. Rows keep their ids, phase and row
// number. Moving a row on the map changes only greenhouse_map_rows.
import { Router, type Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import { DEFAULT_ORG_TIMEZONE } from "../config/orgTimezone";
import { todayInOrgTimezone } from "./foodSafety/services/checklistPeriod";
import { rowAreaM2, type FootprintSectionInput } from "../utils/varietyAreaFootprints";
import { loadRowMeasurements, measuredArea, measurementOn, rowAvailableFrom } from "../utils/rowMeasurements";

const rowMeasurementsRouter = Router();
const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

const PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FT_PER_M = 1 / 0.3048;
const MAX_ROWS = 2000;

class InputError extends Error {
  constructor(message: string, readonly status = 400, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const round = (n: number | null, d = 4) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

function positive(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new InputError(`${field} must be a number of meters above 0`);
  return n;
}
function wholeOrZero(value: unknown, field: string): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InputError(`${field} must be a whole number of 0 or more`);
  return n;
}
function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new InputError(`${field} is required (YYYY-MM-DD)`);
  return value;
}
function handleError(res: Response, error: unknown, message: string, context: string) {
  if (error instanceof InputError) return res.status(error.status).json({ message: error.message, ...error.body });
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return res.status(409).json({ message: "Some of those row numbers already exist in this phase." });
  if (code === "23514") return res.status(400).json({ message: (error as { message?: string }).message ?? "Those sizes or dates aren't valid." });
  if (code === "42P01" || code === "42883") return res.status(409).json({ message: "Row measurements aren't set up yet (migration 0157)." });
  return sendSafeError(res, 500, message, context, error);
}

/** Rows, their sections, the map drawing and the measurement history of one organization. */
async function loadAll(organizationId: string) {
  const [groups, rows, sections, mapRows, measurements] = await Promise.all([
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase.from("greenhouse_groups").select("id, name, type, status").eq("organization_id", organizationId).order("created_at", { ascending: true }).range(from, to)
    ),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("greenhouse_rows")
        .select("id, group_id, row_number, section_id, width_meters, length_meters, slab_count, plants_per_slab, stems_per_plant")
        .eq("organization_id", organizationId)
        .order("group_id", { ascending: true })
        .order("row_number", { ascending: true })
        .range(from, to)
    ),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase.from("greenhouse_row_sections").select("id, width_meters, length_meters").eq("organization_id", organizationId).range(from, to)
    ),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase.from("greenhouse_map_rows").select("group_id, row_number, width_ft, length_ft").eq("organization_id", organizationId).range(from, to)
    ).catch(() => [] as Array<Record<string, unknown>>),
    loadRowMeasurements(organizationId)
  ]);
  const sectionsById = new Map<string, FootprintSectionInput>(
    sections.map((s) => [String(s.id), { id: String(s.id), width_meters: num(s.width_meters), length_meters: num(s.length_meters) }])
  );
  const drawn = new Map(mapRows.map((m) => [`${m.group_id}:${m.row_number}`, { width_ft: num(m.width_ft), length_ft: num(m.length_ft) }]));
  return { groups, rows, sectionsById, drawn, measurements };
}

// Rows with their measured size today and their history (and the Greenhouse Setup values they came from).
rowMeasurementsRouter.get("/setup/map/measurements", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const { groups, rows, sectionsById, drawn, measurements } = await loadAll(organizationId);
    const today = todayInOrgTimezone(DEFAULT_ORG_TIMEZONE);
    return res.json({
      today,
      timeZone: DEFAULT_ORG_TIMEZONE,
      available: measurements !== null,
      copied: Boolean(measurements && measurements.size),
      groups,
      rows: rows.map((r) => {
        const versions = measurements?.get(String(r.id)) ?? [];
        const current = measurementOn(versions, today);
        const section = r.section_id ? sectionsById.get(String(r.section_id)) : undefined;
        return {
          id: String(r.id),
          group_id: String(r.group_id),
          row_number: Number(r.row_number),
          slab_count: Number(r.slab_count ?? 0),
          plants_per_slab: Number(r.plants_per_slab ?? 0),
          stems_per_plant: num(r.stems_per_plant),
          setup: { width_m: num(r.width_meters), length_m: num(r.length_meters) },
          section: section ? { width_m: section.width_meters, length_m: section.length_meters } : null,
          drawn: drawn.get(`${r.group_id}:${r.row_number}`) ?? null,
          available_from: rowAvailableFrom(versions),
          current: current ? { width_m: current.width_m, length_m: current.length_m, area_m2: measuredArea(current), effective_from: current.effective_from, source: current.source } : null,
          versions
        };
      })
    });
  } catch (error) {
    return handleError(res, error, "Failed to load row measurements.", "Row measurements load error:");
  }
});

// Before/after comparison: Greenhouse Setup today vs the copied measurements, by row and phase, with flags.
rowMeasurementsRouter.get("/setup/map/measurements/report", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const { groups, rows, sectionsById, drawn, measurements } = await loadAll(organizationId);
    const today = todayInOrgTimezone(DEFAULT_ORG_TIMEZONE);
    const groupName = new Map(groups.map((g) => [String(g.id), String(g.name)]));
    const lines = rows.map((r) => {
      const groupId = String(r.group_id);
      const section = r.section_id ? sectionsById.get(String(r.section_id)) : undefined;
      const before = rowAreaM2(
        { group_id: groupId, row_number: Number(r.row_number), section_id: (r.section_id as string | null) ?? null, width_meters: num(r.width_meters), length_meters: num(r.length_meters) },
        sectionsById
      );
      const baseline = (measurements?.get(String(r.id)) ?? []).find((v) => v.effective_from === null) ?? null;
      const now = measurementOn(measurements?.get(String(r.id)), today);
      const after = measuredArea(now);
      const ownW = num(r.width_meters), ownL = num(r.length_meters);
      const d = drawn.get(`${groupId}:${r.row_number}`);
      const flags: string[] = [];
      if (!baseline) flags.push("not copied");
      if (baseline?.source === "missing") flags.push("missing measurement");
      if (baseline?.source === "greenhouse_setup_section") flags.push("copied from section (row has no own size)");
      if (section && ownW && ownL && (ownW !== section.width_meters || ownL !== section.length_meters)) flags.push("row differs from its section (row's own size kept)");
      if (!d) flags.push("not on the map");
      else if (baseline?.width_m && baseline.length_m && d.width_ft && d.length_ft) {
        const off = (a: number, b: number) => Math.abs(a - b) / b > 0.02;
        if (off(d.width_ft, baseline.width_m * FT_PER_M) || off(d.length_ft, baseline.length_m * FT_PER_M)) flags.push("map drawing differs (drawing not used)");
      }
      if (round(before, 6) !== round(after, 6)) flags.push("area changed");
      return {
        phase: groupName.get(groupId) ?? "Phase",
        row_id: String(r.id),
        row_number: Number(r.row_number),
        setup_width_m: ownW,
        setup_length_m: ownL,
        section_width_m: section?.width_meters ?? null,
        section_length_m: section?.length_meters ?? null,
        copied_width_m: baseline?.width_m ?? null,
        copied_length_m: baseline?.length_m ?? null,
        copied_from: baseline?.source ?? null,
        drawn_width_ft: d?.width_ft ?? null,
        drawn_length_ft: d?.length_ft ?? null,
        area_before_m2: round(before),
        area_after_m2: round(after),
        flags
      };
    });
    const phases = groups.map((g) => {
      const mine = lines.filter((l) => l.phase === String(g.name));
      const sum = (k: "area_before_m2" | "area_after_m2") => round(mine.reduce((t, l) => t + (l[k] ?? 0), 0), 2);
      return {
        phase: String(g.name),
        rows: mine.length,
        area_before_m2: sum("area_before_m2"),
        area_after_m2: sum("area_after_m2"),
        missing: mine.filter((l) => l.flags.includes("missing measurement")).length,
        differs_from_section: mine.filter((l) => l.flags.some((f) => f.startsWith("row differs"))).length,
        drawing_differs: mine.filter((l) => l.flags.some((f) => f.startsWith("map drawing differs"))).length,
        not_on_map: mine.filter((l) => l.flags.includes("not on the map")).length,
        area_changed: mine.filter((l) => l.flags.includes("area changed")).length
      };
    });
    const total = {
      rows: lines.length,
      area_before_m2: round(lines.reduce((t, l) => t + (l.area_before_m2 ?? 0), 0), 2),
      area_after_m2: round(lines.reduce((t, l) => t + (l.area_after_m2 ?? 0), 0), 2),
      missing: lines.filter((l) => l.flags.includes("missing measurement")).length,
      area_changed: lines.filter((l) => l.flags.includes("area changed")).length,
      not_copied: lines.filter((l) => l.flags.includes("not copied")).length
    };

    if (req.query.format === "csv") {
      const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const head = ["phase", "row_number", "row_id", "setup_width_m", "setup_length_m", "section_width_m", "section_length_m", "copied_width_m", "copied_length_m", "copied_from", "drawn_width_ft", "drawn_length_ft", "area_before_m2", "area_after_m2", "flags"];
      const body = lines.map((l) => head.map((h) => esc(h === "flags" ? l.flags.join("; ") : (l as Record<string, unknown>)[h])).join(","));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.send([head.join(","), ...body].join("\n") + "\n");
    }
    return res.json({ today, total, phases, rows: lines });
  } catch (error) {
    return handleError(res, error, "Failed to build the measurement report.", "Row measurement report error:");
  }
});

// The switch: copy every row's exact Greenhouse Setup size as its baseline. Safe to run again.
rowMeasurementsRouter.post("/setup/map/measurements/copy", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const { data, error } = await supabase.rpc("copy_row_measurements_from_setup", { p_organization_id: organizationId, p_user_id: req.userId ?? null });
    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to copy the row measurements.", "Row measurement copy error:");
  }
});

// Resize: new sizes for these rows from a date. Earlier dates keep the earlier size.
rowMeasurementsRouter.put("/setup/map/measurements", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const effectiveFrom = parseDate(body.effective_from, "Applies from");
    if (!Array.isArray(body.rows) || body.rows.length === 0) throw new InputError("Choose the rows to resize");
    if (body.rows.length > MAX_ROWS) throw new InputError(`At most ${MAX_ROWS} rows at a time`);
    const asked = (body.rows as Array<Record<string, unknown>>).map((r) => {
      if (typeof r?.row_id !== "string" || !UUID.test(r.row_id)) throw new InputError("Each row needs a row_id");
      return { row_id: r.row_id, width_m: positive(r.width_m, "Width"), length_m: positive(r.length_m, "Length") };
    });
    const { rows, measurements } = await loadAll(organizationId);
    if (measurements === null) throw new InputError("Row measurements aren't set up yet (migration 0157).", 409);
    const known = new Set(rows.map((r) => String(r.id)));
    const unknown = asked.filter((r) => !known.has(r.row_id));
    if (unknown.length) throw new InputError("Some rows aren't in this greenhouse", 400, { unknownRows: unknown.map((r) => r.row_id) });
    const notCopied = asked.filter((r) => !(measurements.get(r.row_id) ?? []).length);
    if (notCopied.length) throw new InputError("Copy the measurements from Greenhouse Setup first", 409, { rowsNotCopied: notCopied.map((r) => r.row_id) });
    // History is append-only: a new size starts after the row's latest one.
    const tooEarly = asked
      .map((r) => ({ row_id: r.row_id, latest: (measurements.get(r.row_id) ?? []).reduce<string | null>((m, v) => (v.effective_from && (!m || v.effective_from > m) ? v.effective_from : m), null) }))
      .filter((r) => r.latest && effectiveFrom <= r.latest);
    if (tooEarly.length) throw new InputError("A new size must apply after the row's latest size", 400, { rowsWithLaterSize: tooEarly });

    const today = todayInOrgTimezone(DEFAULT_ORG_TIMEZONE);
    const { data, error } = await supabase.rpc("record_row_measurements", {
      p_organization_id: organizationId,
      p_rows: asked,
      p_effective_from: effectiveFrom,
      p_today: today,
      p_user_id: req.userId ?? null
    });
    if (error) throw error;
    return res.json({ effective_from: effectiveFrom, today, saved: data });
  } catch (error) {
    return handleError(res, error, "Failed to save the new sizes.", "Row measurement resize error:");
  }
});

// Add rows with real sizes, existing from a date (today, or a later season).
rowMeasurementsRouter.post("/setup/map/rows", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const groupId = typeof body.group_id === "string" && UUID.test(body.group_id) ? body.group_id : "";
    if (!groupId) throw new InputError("Choose a phase");
    const fromRow = Number(body.from_row);
    const toRow = body.to_row === undefined || body.to_row === "" || body.to_row === null ? fromRow : Number(body.to_row);
    if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow < 1 || toRow < fromRow) throw new InputError("Row numbers must be whole numbers, from ≤ to");
    if (toRow - fromRow + 1 > 500) throw new InputError("At most 500 rows at a time");
    const width = positive(body.width_m, "Width");
    const length = positive(body.length_m, "Length");
    const effectiveFrom = parseDate(body.effective_from, "Exists from");
    const slabCount = wholeOrZero(body.slab_count, "Slabs per row");
    const plantsPerSlab = wholeOrZero(body.plants_per_slab, "Plants per slab");
    const stems = body.stems_per_plant === undefined || body.stems_per_plant === "" ? 1 : Number(body.stems_per_plant);
    if (!Number.isFinite(stems) || stems < 0) throw new InputError("Stems per plant must be 0 or more");

    const { groups, rows, measurements } = await loadAll(organizationId);
    if (measurements === null) throw new InputError("Row measurements aren't set up yet (migration 0157).", 409);
    if (!groups.some((g) => String(g.id) === groupId)) throw new InputError("Choose a phase");
    const numbers = Array.from({ length: toRow - fromRow + 1 }, (_, i) => fromRow + i);
    const taken = new Set(rows.filter((r) => String(r.group_id) === groupId).map((r) => Number(r.row_number)));
    const exists = numbers.filter((n) => taken.has(n));
    if (exists.length) throw new InputError("Some of those row numbers already exist in this phase", 409, { existingRows: exists });

    const today = todayInOrgTimezone(DEFAULT_ORG_TIMEZONE);
    const { data, error } = await supabase.rpc("add_measured_rows", {
      p_organization_id: organizationId,
      p_group_id: groupId,
      p_rows: numbers.map((n) => ({ row_number: n, width_m: width, length_m: length, slab_count: slabCount, plants_per_slab: plantsPerSlab, stems_per_plant: stems })),
      p_effective_from: effectiveFrom,
      p_today: today,
      p_user_id: req.userId ?? null
    });
    if (error) throw error;
    return res.status(201).json({ group_id: groupId, rows: numbers, effective_from: effectiveFrom, saved: data });
  } catch (error) {
    return handleError(res, error, "Failed to add the rows.", "Row measurement add rows error:");
  }
});

export { rowMeasurementsRouter };
