// Crop Planner (migration 0154): draft plans for a season, used to work out
// how many seeds and slabs to order. A plan is separate from the live
// greenhouse: this router never reads or writes greenhouse_variety_assignments.
//
// One planting and one slab assignment per row per plan. Assigning rows that
// already have an assignment is refused (409, listing them) unless the
// request says what to do with them: skip them and add only the unassigned
// rows, or reassign them. Nothing is overwritten silently. The database's
// unique keys back this up against concurrent saves.
import { Router, type Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import { loadOrganizationProducts } from "../utils/organizationProducts";

const cropPlannerRouter = Router();

// Planning uses the Greenhouse Setup permissions, as Products and Varieties do.
const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

const PAGE = 1000;
const MAX_ROWS_PER_REQUEST = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type RowRef = { group_id: string; row_number: number };
const rowKey = (row: RowRef) => `${row.group_id}:${row.row_number}`;

/** Every row of a query, paged: PostgREST caps a response at 1,000 rows. */
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

function text(value: unknown, field: string, max: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new InputError(`${field} is required`);
  if (result.length > max) throw new InputError(`${field} must be ${max} characters or fewer`);
  return result;
}

function parseRows(value: unknown): RowRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new InputError("rows must list at least one row");
  if (value.length > MAX_ROWS_PER_REQUEST) throw new InputError(`At most ${MAX_ROWS_PER_REQUEST} rows per request`);
  const seen = new Map<string, RowRef>();
  for (const raw of value) {
    const row = raw as Record<string, unknown>;
    const group_id = typeof row?.group_id === "string" ? row.group_id : "";
    const row_number = Number(row?.row_number);
    if (!UUID.test(group_id) || !Number.isInteger(row_number) || row_number < 1) {
      throw new InputError("Each row needs a group_id and a row_number of 1 or more");
    }
    seen.set(rowKey({ group_id, row_number }), { group_id, row_number });
  }
  return Array.from(seen.values());
}

function parseOnAssigned(value: unknown): "skip" | "reassign" | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "skip" || value === "reassign") return value;
  throw new InputError("on_assigned must be skip or reassign");
}

function positiveIntOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InputError(`${field} must be a whole number of 1 or more`);
  return parsed;
}

async function loadPlan(planId: string, organizationId: string) {
  if (!UUID.test(planId)) throw new InputError("Plan not found.", 404);
  const { data, error } = await supabase
    .from("crop_plans")
    .select("*")
    .eq("id", planId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new InputError("Plan not found.", 404);
  return data as { id: string; season: string; name: string };
}

/** The rows must exist in this organization's Greenhouse Setup. */
async function assertRowsInGreenhouse(organizationId: string, rows: RowRef[]) {
  const groupIds = Array.from(new Set(rows.map((row) => row.group_id)));
  const existing = await fetchAll<RowRef>((from, to) =>
    supabase
      .from("greenhouse_rows")
      .select("group_id, row_number")
      .eq("organization_id", organizationId)
      .in("group_id", groupIds)
      .order("row_number", { ascending: true })
      .range(from, to)
  );
  const known = new Set(existing.map(rowKey));
  const missing = rows.filter((row) => !known.has(rowKey(row)));
  if (missing.length > 0) {
    throw new InputError(`${missing.length} selected row${missing.length === 1 ? " is" : "s are"} not in this organization's Greenhouse Setup.`);
  }
}

function handleError(res: Response, error: unknown, clientMessage: string, logContext: string) {
  if (error instanceof InputError) return res.status(error.status).json({ message: error.message });
  const code = (error as { code?: string } | null)?.code;
  if (code === "23514") return res.status(400).json({ message: (error as { message?: string }).message ?? clientMessage });
  return sendSafeError(res, 500, clientMessage, logContext, error);
}

type AssignmentTable = "crop_plan_row_plantings" | "crop_plan_row_slabs";
type AssignmentColumn = "variety_id" | "slab_type_id";

/**
 * Assigns rows of a plan to a variety (planting) or slab type, one per row.
 * Rows already assigned to something are refused unless onAssigned says to
 * skip them or reassign them; rows already assigned to the same value are
 * left as they are.
 */
async function assignRows(
  res: Response,
  table: AssignmentTable,
  column: AssignmentColumn,
  organizationId: string,
  planId: string,
  rows: RowRef[],
  value: string,
  onAssigned: "skip" | "reassign" | null
) {
  const existing = await fetchAll<RowRef & Record<AssignmentColumn, string>>((from, to) =>
    supabase
      .from(table)
      .select(`group_id, row_number, ${column}`)
      .eq("organization_id", organizationId)
      .eq("plan_id", planId)
      .order("row_number", { ascending: true })
      .range(from, to)
  );
  const current = new Map(existing.map((row) => [rowKey(row), row[column]]));
  const already = rows.filter((row) => current.get(rowKey(row)) === value);
  const conflicts = rows.filter((row) => current.has(rowKey(row)) && current.get(rowKey(row)) !== value);
  const unassigned = rows.filter((row) => !current.has(rowKey(row)));

  if (conflicts.length > 0 && onAssigned === null) {
    return res.status(409).json({
      message: `${conflicts.length} of the selected rows already ${conflicts.length === 1 ? "has an assignment" : "have assignments"}. Add only the unassigned rows, or reassign them.`,
      conflicts: conflicts.map((row) => ({ ...row, [column]: current.get(rowKey(row)) }))
    });
  }

  const toWrite = onAssigned === "reassign" ? [...unassigned, ...conflicts] : unassigned;
  const now = new Date().toISOString();
  for (let i = 0; i < toWrite.length; i += 500) {
    const batch = toWrite.slice(i, i + 500).map((row) => ({
      plan_id: planId,
      organization_id: organizationId,
      group_id: row.group_id,
      row_number: row.row_number,
      [column]: value,
      updated_at: now
    }));
    // Reassign replaces the row's assignment; otherwise an insert, which the
    // unique key refuses if another save assigned the row in the meantime.
    const { error } =
      onAssigned === "reassign"
        ? await supabase.from(table).upsert(batch, { onConflict: "plan_id,group_id,row_number" })
        : await supabase.from(table).insert(batch);
    if (error?.code === "23505") {
      return res.status(409).json({ message: "Some of these rows were assigned by another save. Reload the plan and try again.", conflicts: [] });
    }
    if (error) throw error;
  }

  await supabase.from("crop_plans").update({ updated_at: now }).eq("id", planId).eq("organization_id", organizationId);
  return res.json({
    assigned: toWrite.length,
    reassigned: onAssigned === "reassign" ? conflicts.length : 0,
    skipped: onAssigned === "skip" ? conflicts.length : 0,
    unchanged: already.length
  });
}

async function removeRows(res: Response, table: AssignmentTable | "crop_plan_row_layouts", organizationId: string, planId: string, rows: RowRef[]) {
  let removed = 0;
  const byGroup = new Map<string, number[]>();
  for (const row of rows) byGroup.set(row.group_id, [...(byGroup.get(row.group_id) ?? []), row.row_number]);
  for (const [groupId, numbers] of byGroup) {
    const { data, error } = await supabase
      .from(table)
      .delete()
      .eq("organization_id", organizationId)
      .eq("plan_id", planId)
      .eq("group_id", groupId)
      .in("row_number", numbers)
      .select("id");
    if (error) throw error;
    removed += (data ?? []).length;
  }
  return res.json({ removed });
}

// ── Plans ─────────────────────────────────────────────────────────────────────

cropPlannerRouter.get("/crop-planner/plans", canView, async (req, res) => {
  const { data, error } = await supabase
    .from("crop_plans")
    .select("id, season, name, notes, status, created_at, updated_at")
    .eq("organization_id", req.organizationId)
    .order("season", { ascending: false })
    .order("name", { ascending: true });
  if (error) return sendSafeError(res, 500, "Failed to load crop plans.", "Crop plans fetch error:", error);
  return res.json(data ?? []);
});

cropPlannerRouter.post("/crop-planner/plans", canEdit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const season = text(body.season, "season", 40);
    const name = text(body.name, "name", 120);
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const { data, error } = await supabase
      .from("crop_plans")
      .insert({ organization_id: req.organizationId, season, name, notes, created_by: req.userId ?? null })
      .select("id, season, name, notes, status, created_at, updated_at")
      .single();
    if (error?.code === "23505") return res.status(409).json({ message: `There is already a ${season} plan named ${name}.` });
    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create crop plan.", "Crop plan insert error:");
  }
});

cropPlannerRouter.put("/crop-planner/plans/:id", canEdit, async (req, res) => {
  try {
    await loadPlan(String(req.params.id), req.organizationId as string);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const season = text(body.season, "season", 40);
    const name = text(body.name, "name", 120);
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const { data, error } = await supabase
      .from("crop_plans")
      .update({ season, name, notes, updated_at: new Date().toISOString() })
      .eq("id", String(req.params.id))
      .eq("organization_id", req.organizationId)
      .select("id, season, name, notes, status, created_at, updated_at")
      .single();
    if (error?.code === "23505") return res.status(409).json({ message: `There is already a ${season} plan named ${name}.` });
    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update crop plan.", "Crop plan update error:");
  }
});

cropPlannerRouter.delete("/crop-planner/plans/:id", canEdit, async (req, res) => {
  try {
    await loadPlan(String(req.params.id), req.organizationId as string);
    const { error } = await supabase.from("crop_plans").delete().eq("id", String(req.params.id)).eq("organization_id", req.organizationId);
    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "Failed to delete crop plan.", "Crop plan delete error:");
  }
});

// Everything the planner page needs for one plan: the plan's assignments,
// layout inputs and oversow, plus the greenhouse (groups and rows with their
// layouts), the organization's varieties, crops and slab types.
cropPlannerRouter.get("/crop-planner/plans/:id", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    const byPlan = (table: string, columns: string) =>
      fetchAll((from, to) =>
        supabase.from(table).select(columns).eq("organization_id", organizationId).eq("plan_id", plan.id).order("row_number", { ascending: true }).range(from, to)
      );
    const [plantings, slabs, layouts, groups, rows, varieties, slabTypes, oversowResult, products] = await Promise.all([
      byPlan("crop_plan_row_plantings", "group_id, row_number, variety_id"),
      byPlan("crop_plan_row_slabs", "group_id, row_number, slab_type_id"),
      byPlan("crop_plan_row_layouts", "group_id, row_number, slabs_per_trough, troughs_per_row, plants_per_slab"),
      fetchAll((from, to) =>
        supabase.from("greenhouse_groups").select("id, type, name, status").eq("organization_id", organizationId).order("created_at", { ascending: true }).range(from, to)
      ),
      fetchAll((from, to) =>
        supabase
          .from("greenhouse_rows")
          .select("group_id, row_number, slab_count, plants_per_slab, stems_per_plant")
          .eq("organization_id", organizationId)
          .order("group_id", { ascending: true })
          .order("row_number", { ascending: true })
          .range(from, to)
      ),
      fetchAll((from, to) =>
        supabase.from("varieties").select("id, name, color, status, product_code").eq("organization_id", organizationId).order("name", { ascending: true }).range(from, to)
      ),
      fetchAll((from, to) =>
        supabase.from("crop_plan_slab_types").select("id, name, status").eq("organization_id", organizationId).order("name", { ascending: true }).range(from, to)
      ),
      supabase.from("crop_plan_varieties").select("variety_id, oversow_pct").eq("organization_id", organizationId).eq("plan_id", plan.id),
      loadOrganizationProducts(organizationId)
    ]);
    if (oversowResult.error) throw oversowResult.error;
    return res.json({
      plan,
      plantings,
      slabs,
      layouts,
      oversow: (oversowResult.data ?? []).map((row) => ({ variety_id: row.variety_id, oversow_pct: Number(row.oversow_pct) })),
      greenhouse: {
        groups,
        rows: (rows as Array<Record<string, unknown>>).map((row) => ({
          group_id: row.group_id,
          row_number: Number(row.row_number),
          slab_count: Number(row.slab_count ?? 0),
          plants_per_slab: Number(row.plants_per_slab ?? 0),
          stems_per_plant: Number(row.stems_per_plant ?? 1)
        }))
      },
      varieties,
      slabTypes,
      products: products.map((p) => ({ code: p.code, name: p.name, status: p.status }))
    });
  } catch (error) {
    return handleError(res, error, "Failed to load crop plan.", "Crop plan detail error:");
  }
});

// ── Planting (variety per row) ────────────────────────────────────────────────

cropPlannerRouter.post("/crop-planner/plans/:id/plantings", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rows = parseRows(body.rows);
    const onAssigned = parseOnAssigned(body.on_assigned);
    const varietyId = typeof body.variety_id === "string" ? body.variety_id : "";
    if (!UUID.test(varietyId)) throw new InputError("variety_id is required");

    const { data: variety, error: varietyError } = await supabase
      .from("varieties")
      .select("id, product_code")
      .eq("id", varietyId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (varietyError) throw varietyError;
    if (!variety) throw new InputError("Selected variety was not found");
    const product = (await loadOrganizationProducts(organizationId)).find((p) => p.code === (variety as { product_code: string }).product_code);
    if (!product || product.status !== "active") throw new InputError(`${product?.name ?? "This crop"} is not enabled for your organization`);

    await assertRowsInGreenhouse(organizationId, rows);
    return await assignRows(res, "crop_plan_row_plantings", "variety_id", organizationId, plan.id, rows, varietyId, onAssigned);
  } catch (error) {
    return handleError(res, error, "Failed to save planting.", "Crop plan planting error:");
  }
});

cropPlannerRouter.post("/crop-planner/plans/:id/plantings/remove", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    return await removeRows(res, "crop_plan_row_plantings", organizationId, plan.id, parseRows((req.body ?? {}).rows));
  } catch (error) {
    return handleError(res, error, "Failed to remove planting.", "Crop plan planting remove error:");
  }
});

// ── Slabs (slab type per row) ─────────────────────────────────────────────────

cropPlannerRouter.post("/crop-planner/plans/:id/slabs", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rows = parseRows(body.rows);
    const onAssigned = parseOnAssigned(body.on_assigned);
    const slabTypeId = typeof body.slab_type_id === "string" ? body.slab_type_id : "";
    if (!UUID.test(slabTypeId)) throw new InputError("slab_type_id is required");
    const { data: slabType, error } = await supabase
      .from("crop_plan_slab_types")
      .select("id, status")
      .eq("id", slabTypeId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!slabType) throw new InputError("Selected slab type was not found");
    if ((slabType as { status: string }).status !== "active") throw new InputError("That slab type is retired");

    await assertRowsInGreenhouse(organizationId, rows);
    return await assignRows(res, "crop_plan_row_slabs", "slab_type_id", organizationId, plan.id, rows, slabTypeId, onAssigned);
  } catch (error) {
    return handleError(res, error, "Failed to save slab assignment.", "Crop plan slab error:");
  }
});

cropPlannerRouter.post("/crop-planner/plans/:id/slabs/remove", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    return await removeRows(res, "crop_plan_row_slabs", organizationId, plan.id, parseRows((req.body ?? {}).rows));
  } catch (error) {
    return handleError(res, error, "Failed to remove slab assignment.", "Crop plan slab remove error:");
  }
});

// ── Layout inputs (overrides of a row's planting layout) ─────────────────────

cropPlannerRouter.put("/crop-planner/plans/:id/layouts", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rows = parseRows(body.rows);
    const slabsPerTrough = positiveIntOrNull(body.slabs_per_trough, "Slabs per trough");
    const troughsPerRow = positiveIntOrNull(body.troughs_per_row, "Troughs per row");
    const plantsPerSlab = positiveIntOrNull(body.plants_per_slab, "Plants per slab");
    if ((slabsPerTrough === null) !== (troughsPerRow === null)) {
      throw new InputError("Enter both slabs per trough and troughs per row, or neither");
    }
    await assertRowsInGreenhouse(organizationId, rows);

    // No inputs: the rows go back to their Greenhouse Setup layout.
    if (slabsPerTrough === null && plantsPerSlab === null) {
      return await removeRows(res, "crop_plan_row_layouts", organizationId, plan.id, rows);
    }
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("crop_plan_row_layouts").upsert(
        rows.slice(i, i + 500).map((row) => ({
          plan_id: plan.id,
          organization_id: organizationId,
          group_id: row.group_id,
          row_number: row.row_number,
          slabs_per_trough: slabsPerTrough,
          troughs_per_row: troughsPerRow,
          plants_per_slab: plantsPerSlab,
          updated_at: now
        })),
        { onConflict: "plan_id,group_id,row_number" }
      );
      if (error) throw error;
    }
    return res.json({ updated: rows.length });
  } catch (error) {
    return handleError(res, error, "Failed to save layout inputs.", "Crop plan layout error:");
  }
});

// ── Oversow per variety ───────────────────────────────────────────────────────

cropPlannerRouter.put("/crop-planner/plans/:id/varieties/:varietyId", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const plan = await loadPlan(String(req.params.id), organizationId);
    const varietyId = String(req.params.varietyId);
    if (!UUID.test(varietyId)) throw new InputError("Selected variety was not found");
    const pct = Number((req.body ?? {}).oversow_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1000 || Math.round(pct * 100) !== pct * 100) {
      throw new InputError("Oversow must be a percentage from 0 to 1000, with at most two decimals");
    }
    const { data, error } = await supabase
      .from("crop_plan_varieties")
      .upsert(
        { plan_id: plan.id, organization_id: organizationId, variety_id: varietyId, oversow_pct: pct, updated_at: new Date().toISOString() },
        { onConflict: "plan_id,variety_id" }
      )
      .select("variety_id, oversow_pct")
      .single();
    if (error?.code === "23514" || error?.code === "23503") throw new InputError("Selected variety was not found");
    if (error) throw error;
    return res.json({ variety_id: data.variety_id, oversow_pct: Number(data.oversow_pct) });
  } catch (error) {
    return handleError(res, error, "Failed to save oversow.", "Crop plan oversow error:");
  }
});

// ── Slab types ────────────────────────────────────────────────────────────────

cropPlannerRouter.get("/crop-planner/slab-types", canView, async (req, res) => {
  const { data, error } = await supabase
    .from("crop_plan_slab_types")
    .select("id, name, status")
    .eq("organization_id", req.organizationId)
    .order("name", { ascending: true });
  if (error) return sendSafeError(res, 500, "Failed to load slab types.", "Slab types fetch error:", error);
  return res.json(data ?? []);
});

cropPlannerRouter.post("/crop-planner/slab-types", canEdit, async (req, res) => {
  try {
    const name = text((req.body ?? {}).name, "name", 120);
    const { data, error } = await supabase
      .from("crop_plan_slab_types")
      .insert({ organization_id: req.organizationId, name })
      .select("id, name, status")
      .single();
    if (error?.code === "23505") return res.status(409).json({ message: `There is already a slab type named ${name}.` });
    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create slab type.", "Slab type insert error:");
  }
});

cropPlannerRouter.put("/crop-planner/slab-types/:id", canEdit, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = text(body.name, "name", 120);
    const status = body.status === "inactive" ? "inactive" : "active";
    const { data, error } = await supabase
      .from("crop_plan_slab_types")
      .update({ name, status, updated_at: new Date().toISOString() })
      .eq("id", String(req.params.id))
      .eq("organization_id", req.organizationId)
      .select("id, name, status")
      .maybeSingle();
    if (error?.code === "23505") return res.status(409).json({ message: `There is already a slab type named ${name}.` });
    if (error) throw error;
    if (!data) return res.status(404).json({ message: "Slab type not found." });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update slab type.", "Slab type update error:");
  }
});

export { cropPlannerRouter };
