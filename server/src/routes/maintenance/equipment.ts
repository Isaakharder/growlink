// Maintenance Equipment: CRUD, list (with due-status + due-soon/overdue
// summary), detail.
//
// QR token issuance/regeneration lives in ./qr.ts. Meter readings live in
// ./meters.ts. Scheduled maintenance CRUD/completion lives in ./schedules.ts
// — equipment detail assembles all of these via a shared loader so the
// mobile detail page can render everything from one request.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { EQUIPMENT_STATUSES, EquipmentStatus, METER_UNITS, MeterUnit } from "./services/types";
import { parseOptionalString, parseRequiredString, parseEnum, MaintenanceValidationError } from "./services/validation";
import { ensureCategoryExists, ensureLocationExists, MaintenanceNotFoundError } from "./services/ensureExists";
import { todayInOrgTimezone } from "../foodSafety/services/checklistPeriod";
import { compareDateStrings } from "./services/dueDateCalc";

const equipmentRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canEdit = requirePermission("maintenance:edit");

type EquipmentPayload = {
  name: string;
  asset_code: string;
  category_id: string;
  location_id: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  description: string | null;
  meter_unit: MeterUnit;
  meter_unit_custom_label: string | null;
};

function validateEquipmentPayload(input: unknown): EquipmentPayload {
  if (!input || typeof input !== "object") throw new MaintenanceValidationError("Invalid request body.");
  const body = input as Record<string, unknown>;

  const meter_unit = parseEnum(body.meter_unit, METER_UNITS, "Meter unit");
  const meter_unit_custom_label = parseOptionalString(body.meter_unit_custom_label);
  if (meter_unit === "custom" && !meter_unit_custom_label) {
    throw new MaintenanceValidationError("A custom meter unit label is required.");
  }
  if (meter_unit !== "custom" && meter_unit_custom_label) {
    throw new MaintenanceValidationError("A custom meter unit label is only valid when the meter unit is Custom.");
  }

  return {
    name: parseRequiredString(body.name, "Equipment name"),
    asset_code: parseRequiredString(body.asset_code, "Asset code"),
    category_id: parseRequiredString(body.category_id, "Category"),
    location_id: parseRequiredString(body.location_id, "Location"),
    make: parseOptionalString(body.make),
    model: parseOptionalString(body.model),
    serial_number: parseOptionalString(body.serial_number),
    description: parseOptionalString(body.description),
    meter_unit,
    meter_unit_custom_label: meter_unit === "custom" ? meter_unit_custom_label : null
  };
}

async function validateReferences(payload: EquipmentPayload, organizationId: string) {
  await ensureCategoryExists(payload.category_id, organizationId);
  await ensureLocationExists(payload.location_id, organizationId);
}

// Aggregates each equipment's due status from its active schedules: overdue
// if ANY active schedule is past due, due_soon if none overdue but any is
// within its own warning window, ok otherwise (including no schedules at
// all). One batched query per page of equipment, not one query per row.
async function loadDueStatusByEquipmentId(equipmentIds: string[], organizationId: string) {
  const dueStatusByEquipmentId = new Map<string, "overdue" | "due_soon" | "ok">();
  if (equipmentIds.length === 0) return dueStatusByEquipmentId;

  const { data: schedules, error } = await supabase
    .from("maintenance_schedules")
    .select("equipment_id, next_due_date, warning_days_before_due")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .not("next_due_date", "is", null)
    .in("equipment_id", equipmentIds);

  if (error) throw error;

  const today = todayInOrgTimezone();

  for (const schedule of schedules ?? []) {
    const equipmentId = schedule.equipment_id as string;
    const nextDueDate = schedule.next_due_date as string;
    const warningDays = schedule.warning_days_before_due as number;

    let status: "overdue" | "due_soon" | "ok" = "ok";
    if (compareDateStrings(nextDueDate, today) < 0) {
      status = "overdue";
    } else {
      const warningThreshold = new Date(nextDueDate);
      warningThreshold.setUTCDate(warningThreshold.getUTCDate() - warningDays);
      const thresholdStr = warningThreshold.toISOString().slice(0, 10);
      if (compareDateStrings(thresholdStr, today) <= 0) status = "due_soon";
    }

    const existing = dueStatusByEquipmentId.get(equipmentId);
    if (status === "overdue" || (status === "due_soon" && existing !== "overdue") || !existing) {
      dueStatusByEquipmentId.set(equipmentId, status);
    }
  }

  return dueStatusByEquipmentId;
}

// ── list ──────────────────────────────────────────────────────────────────

equipmentRouter.get("/maintenance/equipment", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { search, category_id, location_id, status } = req.query;

  let query = supabase
    .from("maintenance_equipment")
    .select("*, category:maintenance_categories(id, name), location:maintenance_locations(id, name)")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (typeof search === "string" && search.trim()) {
    const term = search.trim();
    query = query.or(`name.ilike.%${term}%,asset_code.ilike.%${term}%`);
  }
  if (typeof category_id === "string" && category_id) query = query.eq("category_id", category_id);
  if (typeof location_id === "string" && location_id) query = query.eq("location_id", location_id);
  if (typeof status === "string" && EQUIPMENT_STATUSES.includes(status as EquipmentStatus)) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load equipment.", "Maintenance equipment list error:", error);

  const equipment = data ?? [];
  let dueStatusByEquipmentId: Map<string, "overdue" | "due_soon" | "ok">;
  try {
    dueStatusByEquipmentId = await loadDueStatusByEquipmentId(equipment.map((e) => e.id as string), organizationId);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load equipment due status.", "Maintenance equipment due-status error:", error);
  }

  return res.json(equipment.map((e) => ({ ...e, due_status: dueStatusByEquipmentId.get(e.id as string) ?? "ok" })));
});

equipmentRouter.get("/maintenance/equipment/due-summary", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data: schedules, error } = await supabase
    .from("maintenance_schedules")
    .select("id, equipment_id, name, next_due_date, warning_days_before_due, equipment:maintenance_equipment(id, name, asset_code, status)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .not("next_due_date", "is", null)
    .order("next_due_date", { ascending: true });

  if (error) return sendSafeError(res, 500, "Failed to load due-maintenance summary.", "Maintenance due-summary error:", error);

  const today = todayInOrgTimezone();
  const overdue: unknown[] = [];
  const dueSoon: unknown[] = [];

  for (const schedule of schedules ?? []) {
    const nextDueDate = schedule.next_due_date as string;
    if (compareDateStrings(nextDueDate, today) < 0) {
      overdue.push(schedule);
      continue;
    }
    const warningThreshold = new Date(nextDueDate);
    warningThreshold.setUTCDate(warningThreshold.getUTCDate() - (schedule.warning_days_before_due as number));
    const thresholdStr = warningThreshold.toISOString().slice(0, 10);
    if (compareDateStrings(thresholdStr, today) <= 0) dueSoon.push(schedule);
  }

  return res.json({ overdue, due_soon: dueSoon });
});

// ── detail ────────────────────────────────────────────────────────────────

equipmentRouter.get("/maintenance/equipment/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data: equipment, error } = await supabase
    .from("maintenance_equipment")
    .select("*, category:maintenance_categories(id, name), location:maintenance_locations(id, name)")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to load equipment.", "Maintenance equipment detail error:", error);
  if (!equipment) return res.status(404).json({ message: "Equipment not found." });

  const { data: schedules, error: schedulesError } = await supabase
    .from("maintenance_schedules")
    .select("*")
    .eq("equipment_id", id)
    .eq("organization_id", organizationId)
    .order("next_due_date", { ascending: true, nullsFirst: false });

  if (schedulesError) return sendSafeError(res, 500, "Failed to load maintenance schedules.", "Maintenance equipment schedules error:", schedulesError);

  return res.json({ ...equipment, schedules: schedules ?? [] });
});

// ── create ────────────────────────────────────────────────────────────────

equipmentRouter.post("/maintenance/equipment", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: EquipmentPayload;
  try {
    payload = validateEquipmentPayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  try {
    await validateReferences(payload, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate equipment references.", "Maintenance equipment reference error:", error);
  }

  const { data, error } = await supabase
    .from("maintenance_equipment")
    .insert({ ...payload, organization_id: organizationId, created_by: req.userId, updated_by: req.userId })
    .select("*")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return res.status(409).json({ message: "This asset code is already in use." });
    }
    return sendSafeError(res, 500, "Failed to create equipment.", "Maintenance equipment insert error:", error);
  }
  return res.status(201).json(data);
});

// ── update ────────────────────────────────────────────────────────────────

equipmentRouter.put("/maintenance/equipment/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);
  let payload: EquipmentPayload;
  try {
    payload = validateEquipmentPayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  try {
    await validateReferences(payload, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate equipment references.", "Maintenance equipment reference error:", error);
  }

  const { data, error } = await supabase
    .from("maintenance_equipment")
    .update({ ...payload, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return res.status(409).json({ message: "This asset code is already in use." });
    }
    return sendSafeError(res, 500, "Failed to update equipment.", "Maintenance equipment update error:", error);
  }
  if (!data) return res.status(404).json({ message: "Equipment not found." });
  return res.json(data);
});

// ── status transition ────────────────────────────────────────────────────

equipmentRouter.post("/maintenance/equipment/:id/status", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  let status: EquipmentStatus;
  try {
    status = parseEnum((req.body as Record<string, unknown> | undefined)?.status, EQUIPMENT_STATUSES, "Status");
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid status." });
  }

  const { data, error } = await supabase
    .from("maintenance_equipment")
    .update({ status, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, status")
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to update equipment status.", "Maintenance equipment status error:", error);
  if (!data) return res.status(404).json({ message: "Equipment not found." });
  return res.json(data);
});

export { equipmentRouter, validateEquipmentPayload };
