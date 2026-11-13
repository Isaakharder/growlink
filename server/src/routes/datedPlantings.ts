// Dated plantings (migration 0156, PREVIEW for review): a planting is one
// variety on a set of rows from its planting date to its optional pull-out
// date. Add planting → choose variety → set dates → Link rows → Save rows.
//
// Nothing is ended or replaced silently. Saving rows that another planting
// occupies at an overlapping time (or indefinitely, when it has no pull-out
// date) is refused with 409 and the list of rows and plantings, so the person
// can leave those rows out or set the other planting's pull-out date
// themselves. The database (0156's triggers) backs this up against
// concurrent saves.
//
// "Today" is the organization's local date. GET /dated-plantings/on answers
// "what is in the ground on date D", which is what live reports would read
// for today and historical reports for their own date.
//
// This router never reads or writes greenhouse_variety_assignments.
import { Router, type Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import { fetchAll, isoDate, loadPlantsGreenhouse } from "./plantings";

const datedPlantingsRouter = Router();
const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;

class InputError extends Error {
  constructor(message: string, readonly status = 400, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

type RowRef = { group_id: string; row_number: number };
type PlantingRecord = { id: string; variety_id: string; planting_date: string; pull_out_date: string | null; notes: string | null };
export type RowConflict = {
  group_id: string;
  row_number: number;
  planting_id: string;
  variety_id: string;
  variety_name: string;
  planting_date: string;
  pull_out_date: string | null;
};

const rowKey = (r: RowRef) => `${r.group_id}:${r.row_number}`;

function parseDate(value: unknown, field: string, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InputError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new InputError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

function parseRows(value: unknown): RowRef[] {
  if (!Array.isArray(value)) throw new InputError("rows must be a list");
  if (value.length > MAX_ROWS) throw new InputError(`At most ${MAX_ROWS} rows`);
  const seen = new Map<string, RowRef>();
  for (const raw of value) {
    const r = raw as Record<string, unknown>;
    const group_id = typeof r?.group_id === "string" ? r.group_id : "";
    const row_number = Number(r?.row_number);
    if (!UUID.test(group_id) || !Number.isInteger(row_number) || row_number < 1) {
      throw new InputError("Each row needs a group_id and a row_number of 1 or more");
    }
    seen.set(rowKey({ group_id, row_number }), { group_id, row_number });
  }
  return Array.from(seen.values());
}

/** Two date ranges overlap; both ends are inclusive and a missing pull-out date runs on indefinitely. */
export function rangesOverlap(aStart: string, aEnd: string | null, bStart: string, bEnd: string | null): boolean {
  return aStart <= (bEnd ?? "9999-12-31") && bStart <= (aEnd ?? "9999-12-31");
}

function toPlanting(row: Record<string, unknown>): PlantingRecord {
  return {
    id: String(row.id),
    variety_id: String(row.variety_id),
    planting_date: isoDate(row.planting_date) as string,
    pull_out_date: isoDate(row.pull_out_date),
    notes: (row.notes as string | null) ?? null
  };
}

async function loadPlanting(id: string, organizationId: string): Promise<PlantingRecord> {
  if (!UUID.test(id)) throw new InputError("Planting not found", 404);
  const { data, error } = await supabase
    .from("plantings")
    .select("id, variety_id, planting_date, pull_out_date, notes")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new InputError("Planting not found", 404);
  return toPlanting(data as Record<string, unknown>);
}

async function loadAll(organizationId: string) {
  const [plantings, rows] = await Promise.all([
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("plantings")
        .select("id, variety_id, planting_date, pull_out_date, notes")
        .eq("organization_id", organizationId)
        .order("planting_date", { ascending: true })
        .range(from, to)
    ),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("planting_rows")
        .select("planting_id, group_id, row_number")
        .eq("organization_id", organizationId)
        .order("group_id", { ascending: true })
        .order("row_number", { ascending: true })
        .range(from, to)
    )
  ]);
  return {
    plantings: plantings.map(toPlanting),
    rows: rows.map((r) => ({ planting_id: String(r.planting_id), group_id: String(r.group_id), row_number: Number(r.row_number) }))
  };
}

/** The rows, of those asked for, that another planting occupies at an overlapping time. */
async function findConflicts(
  organizationId: string,
  planting: { id: string | null; planting_date: string; pull_out_date: string | null },
  rows: RowRef[]
): Promise<RowConflict[]> {
  if (rows.length === 0) return [];
  const wanted = new Set(rows.map(rowKey));
  const all = await loadAll(organizationId);
  const others = new Map(all.plantings.filter((p) => p.id !== planting.id).map((p) => [p.id, p]));
  const overlapping = new Map(
    [...others].filter(([, p]) => rangesOverlap(planting.planting_date, planting.pull_out_date, p.planting_date, p.pull_out_date))
  );
  if (overlapping.size === 0) return [];
  const { data: varieties, error } = await supabase.from("varieties").select("id, name").eq("organization_id", organizationId);
  if (error) throw error;
  const names = new Map((varieties ?? []).map((v: { id: string; name: string }) => [v.id, v.name]));
  return all.rows
    .filter((r) => overlapping.has(r.planting_id) && wanted.has(rowKey(r)))
    .map((r) => {
      const other = overlapping.get(r.planting_id)!;
      return {
        group_id: r.group_id,
        row_number: r.row_number,
        planting_id: other.id,
        variety_id: other.variety_id,
        variety_name: names.get(other.variety_id) ?? "Unknown variety",
        planting_date: other.planting_date,
        pull_out_date: other.pull_out_date
      };
    });
}

function handleError(res: Response, error: unknown, message: string, context: string) {
  if (error instanceof InputError) return res.status(error.status).json({ message: error.message, ...error.body });
  const code = (error as { code?: string } | null)?.code;
  if (code === "23P01") return res.status(409).json({ message: "Another save changed these rows at the same time. Try again.", conflicts: [] });
  if (code === "23514" || code === "22007" || code === "22008") return res.status(400).json({ message: "Those dates or rows aren't valid." });
  return sendSafeError(res, 500, message, context, error);
}

// Everything the Plants page needs: the greenhouse and every dated planting with its rows.
datedPlantingsRouter.get("/crop-planner/dated-plantings", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const [greenhouse, all] = await Promise.all([loadPlantsGreenhouse(organizationId), loadAll(organizationId)]);
    const rowsByPlanting = new Map<string, RowRef[]>();
    for (const r of all.rows) rowsByPlanting.set(r.planting_id, [...(rowsByPlanting.get(r.planting_id) ?? []), { group_id: r.group_id, row_number: r.row_number }]);
    return res.json({ ...greenhouse, plantings: all.plantings.map((p) => ({ ...p, rows: rowsByPlanting.get(p.id) ?? [] })) });
  } catch (error) {
    return handleError(res, error, "Failed to load plantings.", "Dated plantings load error:");
  }
});

// What is in the ground on a date (default: the organization's today), with totals per variety.
datedPlantingsRouter.get("/crop-planner/dated-plantings/on", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const greenhouse = await loadPlantsGreenhouse(organizationId);
    const date = parseDate(req.query.date, "date", false) ?? greenhouse.today;
    const { data, error } = await supabase.rpc("plantings_on", { p_organization_id: organizationId, p_date: date });
    if (error) throw error;
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      planting_id: String(r.planting_id),
      variety_id: String(r.variety_id),
      group_id: String(r.group_id),
      row_number: Number(r.row_number)
    }));
    const setup = new Map(greenhouse.rows.map((r) => [rowKey(r), r]));
    const byVariety = new Map<string, { variety_id: string; rows: number; m2: number; plants: number; heads: number; rows_missing_inputs: number }>();
    for (const r of rows) {
      const t = byVariety.get(r.variety_id) ?? { variety_id: r.variety_id, rows: 0, m2: 0, plants: 0, heads: 0, rows_missing_inputs: 0 };
      byVariety.set(r.variety_id, t);
      t.rows += 1;
      const s = setup.get(rowKey(r));
      const plants = s && s.slab_count > 0 && s.plants_per_slab > 0 ? s.slab_count * s.plants_per_slab : null;
      if (!s || s.area_m2 === null || plants === null || !s.stems_per_plant) t.rows_missing_inputs += 1;
      if (s?.area_m2) t.m2 += s.area_m2;
      if (plants !== null) {
        t.plants += plants;
        if (s?.stems_per_plant) t.heads += plants * s.stems_per_plant;
      }
    }
    return res.json({ date, today: greenhouse.today, rows, totals: [...byVariety.values()] });
  } catch (error) {
    return handleError(res, error, "Failed to load what is planted.", "Dated plantings on-date error:");
  }
});

// Add planting: variety, planting date, optional pull-out date. No rows yet.
datedPlantingsRouter.post("/crop-planner/dated-plantings", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const varietyId = typeof body.variety_id === "string" ? body.variety_id : "";
    if (!UUID.test(varietyId)) throw new InputError("Choose a variety");
    const plantingDate = parseDate(body.planting_date, "planting_date", true) as string;
    const pullOutDate = parseDate(body.pull_out_date, "pull_out_date", false);
    if (pullOutDate && pullOutDate < plantingDate) throw new InputError("The pull-out date can't be before the planting date");
    const { data: variety, error: varietyError } = await supabase.from("varieties").select("id").eq("id", varietyId).eq("organization_id", organizationId).maybeSingle();
    if (varietyError) throw varietyError;
    if (!variety) throw new InputError("Choose a variety");
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null;
    const { data, error } = await supabase
      .from("plantings")
      .insert({ organization_id: organizationId, variety_id: varietyId, planting_date: plantingDate, pull_out_date: pullOutDate, notes, created_by: req.userId ?? null, updated_by: req.userId ?? null })
      .select("id, variety_id, planting_date, pull_out_date, notes")
      .single();
    if (error) throw error;
    return res.status(201).json({ ...toPlanting(data as Record<string, unknown>), rows: [] });
  } catch (error) {
    return handleError(res, error, "Failed to add the planting.", "Dated planting create error:");
  }
});

// Change a planting's dates. Refused (409, with the rows) if the new dates overlap another planting on any of its rows.
datedPlantingsRouter.put("/crop-planner/dated-plantings/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const current = await loadPlanting(String(req.params.id), organizationId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const plantingDate = "planting_date" in body ? (parseDate(body.planting_date, "planting_date", true) as string) : current.planting_date;
    const pullOutDate = "pull_out_date" in body ? parseDate(body.pull_out_date, "pull_out_date", false) : current.pull_out_date;
    if (pullOutDate && pullOutDate < plantingDate) throw new InputError("The pull-out date can't be before the planting date");
    const notes = "notes" in body ? (typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null) : current.notes;

    const { data: ownRows, error: rowsError } = await supabase.from("planting_rows").select("group_id, row_number").eq("organization_id", organizationId).eq("planting_id", current.id);
    if (rowsError) throw rowsError;
    const conflicts = await findConflicts(organizationId, { id: current.id, planting_date: plantingDate, pull_out_date: pullOutDate }, (ownRows ?? []) as RowRef[]);
    if (conflicts.length) throw new InputError("These dates overlap another planting on some of this planting's rows", 409, { conflicts });

    const { data, error } = await supabase
      .from("plantings")
      .update({ planting_date: plantingDate, pull_out_date: pullOutDate, notes, updated_by: req.userId ?? null, updated_at: new Date().toISOString() })
      .eq("id", current.id)
      .eq("organization_id", organizationId)
      .select("id, variety_id, planting_date, pull_out_date, notes")
      .single();
    if (error) throw error;
    return res.json(toPlanting(data as Record<string, unknown>));
  } catch (error) {
    return handleError(res, error, "Failed to update the planting.", "Dated planting update error:");
  }
});

// Link rows → Save rows: replace the planting's rows with this selection, all or nothing.
datedPlantingsRouter.put("/crop-planner/dated-plantings/:id/rows", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const planting = await loadPlanting(String(req.params.id), organizationId);
    const rows = parseRows((req.body ?? {}).rows);

    const greenhouse = await loadPlantsGreenhouse(organizationId);
    const setupKeys = new Set(greenhouse.rows.map(rowKey));
    const notInSetup = rows.filter((r) => !setupKeys.has(rowKey(r)));
    if (notInSetup.length) throw new InputError("Some rows aren't in Greenhouse Setup", 400, { rowsNotInSetup: notInSetup });

    const conflicts = await findConflicts(organizationId, planting, rows);
    if (conflicts.length) throw new InputError("Some rows already have a planting at that time", 409, { conflicts });

    const { data, error } = await supabase.rpc("set_planting_rows", {
      p_organization_id: organizationId,
      p_planting_id: planting.id,
      p_rows: rows,
      p_user_id: req.userId ?? null
    });
    if (error) {
      if ((error as { code?: string }).code === "23P01") {
        // Someone saved overlapping rows between our check and our save: list them now.
        const late = await findConflicts(organizationId, planting, rows);
        return res.status(409).json({ message: "Some rows already have a planting at that time", conflicts: late });
      }
      throw error;
    }
    return res.json({ id: planting.id, rows, saved: data });
  } catch (error) {
    return handleError(res, error, "Failed to save the rows.", "Dated planting rows error:");
  }
});

datedPlantingsRouter.delete("/crop-planner/dated-plantings/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const planting = await loadPlanting(String(req.params.id), organizationId);
    const { error } = await supabase.from("plantings").delete().eq("id", planting.id).eq("organization_id", organizationId);
    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "Failed to delete the planting.", "Dated planting delete error:");
  }
});

export { datedPlantingsRouter };
