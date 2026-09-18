// Scheduled maintenance: CRUD (with an ordered checklist), completion, and
// history.
//
// Due-date recurrence math (anchored, not drifting; month-end/leap-year
// safe) lives entirely in TypeScript (./services/dueDateCalc.ts) and is
// computed BEFORE calling the maintenance_complete_schedule RPC, which only
// ever stores already-computed values — mirroring
// pestCalibration/services/dueScheduling.ts's split between TS computation
// and SQL storage.
//
// "Which occurrence is being completed" is never supplied by the client —
// the schedule row's own next_due_date/next_occurrence_index (read here,
// re-checked under a row lock inside the RPC) is the sole source of truth.
// If a race is detected (another request completed the same schedule
// between this handler's read and the RPC's lock), the RPC raises a
// distinguishable error that this handler catches to re-fetch, recompute,
// and retry once automatically — invisible to the caller in the
// overwhelmingly common non-racing case.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import { todayInOrgTimezone } from "../foodSafety/services/checklistPeriod";
import { RECURRENCE_TYPES, RecurrenceType, ScheduleChecklistItemInput } from "./services/types";
import { computeNextOccurrence, parseDateString } from "./services/dueDateCalc";
import {
  parseDateStringField, parseEnum, parseOptionalString, parseOptionalUuid, parsePositiveNumber,
  parseRequiredIdempotencyKey, parseRequiredString, MaintenanceValidationError
} from "./services/validation";
import { ensureEquipmentExists, MaintenanceNotFoundError } from "./services/ensureExists";

const schedulesRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canEdit = requirePermission("maintenance:edit");
const canAct = requireAnyPermission(["maintenance:edit", "mobile:maintenance"]);

type SchedulePayload = {
  equipment_id: string;
  name: string;
  instructions: string | null;
  first_due_date: string;
  recurrence_type: RecurrenceType;
  recurrence_interval: number;
  warning_days_before_due: number;
  checklist_items: ScheduleChecklistItemInput[];
};

function validateChecklistItem(raw: unknown, index: number): ScheduleChecklistItemInput {
  if (!raw || typeof raw !== "object") throw new MaintenanceValidationError(`Checklist item ${index + 1} is invalid.`);
  const item = raw as Record<string, unknown>;
  return {
    label: parseRequiredString(item.label, `Checklist item ${index + 1} label`),
    sort_order: typeof item.sort_order === "number" ? item.sort_order : index
  };
}

function validateSchedulePayload(input: unknown): SchedulePayload {
  if (!input || typeof input !== "object") throw new MaintenanceValidationError("Invalid request body.");
  const body = input as Record<string, unknown>;

  const recurrence_type = parseEnum(body.recurrence_type, RECURRENCE_TYPES, "Recurrence type");
  const recurrence_interval = recurrence_type === "one_time" ? 1 : parsePositiveNumber(body.recurrence_interval, "Recurrence interval");
  if (!Number.isInteger(recurrence_interval)) throw new MaintenanceValidationError("Recurrence interval must be a whole number.");

  const warningDaysRaw = body.warning_days_before_due;
  const warning_days_before_due = warningDaysRaw === undefined || warningDaysRaw === null ? 0 : Number(warningDaysRaw);
  if (!Number.isFinite(warning_days_before_due) || warning_days_before_due < 0) {
    throw new MaintenanceValidationError("Warning days before due must be zero or greater.");
  }

  const checklistInput = Array.isArray(body.checklist_items) ? body.checklist_items : [];

  return {
    equipment_id: parseRequiredString(body.equipment_id, "Equipment"),
    name: parseRequiredString(body.name, "Maintenance name"),
    instructions: parseOptionalString(body.instructions),
    first_due_date: parseDateStringField(body.first_due_date, "first due date"),
    recurrence_type,
    recurrence_interval,
    warning_days_before_due,
    checklist_items: checklistInput.map((item, index) => validateChecklistItem(item, index))
  };
}

async function replaceChecklistItems(scheduleId: string, organizationId: string, items: ScheduleChecklistItemInput[]) {
  const { error: deleteError } = await supabase
    .from("maintenance_schedule_checklist_items")
    .delete()
    .eq("schedule_id", scheduleId);
  if (deleteError) throw deleteError;

  if (items.length === 0) return;

  const { error: insertError } = await supabase
    .from("maintenance_schedule_checklist_items")
    .insert(items.map((item) => ({
      organization_id: organizationId, schedule_id: scheduleId, label: item.label, sort_order: item.sort_order
    })));
  if (insertError) throw insertError;
}

async function loadScheduleWithChecklist(id: string, organizationId: string) {
  const { data: schedule, error } = await supabase
    .from("maintenance_schedules")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!schedule) return null;

  const { data: checklistItems, error: checklistError } = await supabase
    .from("maintenance_schedule_checklist_items")
    .select("*")
    .eq("schedule_id", id)
    .order("sort_order", { ascending: true });
  if (checklistError) throw checklistError;

  return { ...schedule, checklist_items: checklistItems ?? [] };
}

// ── list / detail ─────────────────────────────────────────────────────────

schedulesRouter.get("/maintenance/schedules", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { equipment_id, active } = req.query;

  let query = supabase
    .from("maintenance_schedules")
    .select("*, equipment:maintenance_equipment(id, name, asset_code)")
    .eq("organization_id", organizationId)
    .order("next_due_date", { ascending: true, nullsFirst: false });

  if (typeof equipment_id === "string" && equipment_id) query = query.eq("equipment_id", equipment_id);
  if (typeof active === "string" && (active === "true" || active === "false")) query = query.eq("is_active", active === "true");

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load schedules.", "Maintenance schedules list error:", error);
  return res.json(data ?? []);
});

schedulesRouter.get("/maintenance/schedules/:id", canView, async (req, res) => {
  try {
    const schedule = await loadScheduleWithChecklist(String(req.params.id), req.organizationId);
    if (!schedule) return res.status(404).json({ message: "Schedule not found." });
    return res.json(schedule);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load schedule.", "Maintenance schedule detail error:", error);
  }
});

// ── create ────────────────────────────────────────────────────────────────

schedulesRouter.post("/maintenance/schedules", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: SchedulePayload;
  try {
    payload = validateSchedulePayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  try {
    await ensureEquipmentExists(payload.equipment_id, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate equipment.", "Maintenance schedule equipment error:", error);
  }

  const { checklist_items, ...scheduleFields } = payload;

  const { data: schedule, error } = await supabase
    .from("maintenance_schedules")
    .insert({
      ...scheduleFields,
      organization_id: organizationId,
      next_due_date: scheduleFields.first_due_date,
      next_occurrence_index: 0,
      created_by: req.userId,
      updated_by: req.userId
    })
    .select("*")
    .single();

  if (error) return sendSafeError(res, 500, "Failed to create schedule.", "Maintenance schedule insert error:", error);

  try {
    await replaceChecklistItems(schedule.id, organizationId, checklist_items);
  } catch (error) {
    return sendSafeError(res, 500, "Schedule created, but failed to save its checklist.", "Maintenance schedule checklist insert error:", error);
  }

  return res.status(201).json({ ...schedule, checklist_items: checklist_items });
});

// ── update ────────────────────────────────────────────────────────────────
// Editing the anchor fields (first_due_date/recurrence_type/interval)
// restarts the cadence from the new anchor (next_due_date/next_occurrence_index
// reset to first_due_date/0) — past completions' snapshots are untouched.

schedulesRouter.put("/maintenance/schedules/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);
  let payload: SchedulePayload;
  try {
    payload = validateSchedulePayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  try {
    await ensureEquipmentExists(payload.equipment_id, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate equipment.", "Maintenance schedule equipment error:", error);
  }

  const { checklist_items, ...scheduleFields } = payload;

  const { data: schedule, error } = await supabase
    .from("maintenance_schedules")
    .update({
      ...scheduleFields,
      next_due_date: scheduleFields.first_due_date,
      next_occurrence_index: 0,
      updated_at: new Date().toISOString(),
      updated_by: req.userId
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to update schedule.", "Maintenance schedule update error:", error);
  if (!schedule) return res.status(404).json({ message: "Schedule not found." });

  try {
    await replaceChecklistItems(schedule.id, organizationId, checklist_items);
  } catch (error) {
    return sendSafeError(res, 500, "Schedule updated, but failed to save its checklist.", "Maintenance schedule checklist update error:", error);
  }

  return res.json({ ...schedule, checklist_items });
});

// ── archive / reactivate ─────────────────────────────────────────────────

schedulesRouter.post("/maintenance/schedules/:id/archive", canEdit, async (req, res) => {
  const { data, error } = await supabase
    .from("maintenance_schedules")
    .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .select("id")
    .maybeSingle();
  if (error) return sendSafeError(res, 500, "Failed to archive schedule.", "Maintenance schedule archive error:", error);
  if (!data) return res.status(404).json({ message: "Schedule not found." });
  return res.status(204).send();
});

schedulesRouter.post("/maintenance/schedules/:id/reactivate", canEdit, async (req, res) => {
  const { data, error } = await supabase
    .from("maintenance_schedules")
    .update({ is_active: true, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .select("id")
    .maybeSingle();
  if (error) return sendSafeError(res, 500, "Failed to reactivate schedule.", "Maintenance schedule reactivate error:", error);
  if (!data) return res.status(404).json({ message: "Schedule not found." });
  return res.status(204).send();
});

// ── complete ──────────────────────────────────────────────────────────────

type ChecklistResponseInput = { checklist_item_id: string; checked: boolean };

async function attemptComplete(
  organizationId: string,
  scheduleId: string,
  completionRequestId: string,
  userId: string,
  actorName: string,
  notes: string | null,
  checklistSnapshot: unknown[]
) {
  const { data: schedule, error: scheduleError } = await supabase
    .from("maintenance_schedules")
    .select("*, equipment:maintenance_equipment(current_meter_reading, meter_unit, meter_unit_custom_label)")
    .eq("id", scheduleId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (scheduleError) throw scheduleError;
  if (!schedule) return { status: 404 as const, body: { message: "Schedule not found." } };
  if (!schedule.is_active) return { status: 400 as const, body: { message: "This schedule is inactive." } };

  const today = parseDateString(todayInOrgTimezone());
  const { nextOccurrenceIndex, nextDueDate } = computeNextOccurrence(
    parseDateString(schedule.first_due_date),
    schedule.recurrence_type,
    schedule.recurrence_interval,
    schedule.next_occurrence_index,
    today
  );

  const equipment = schedule.equipment as { current_meter_reading: number | null; meter_unit: string; meter_unit_custom_label: string | null } | null;

  const { data: completion, error: rpcError } = await supabase.rpc("maintenance_complete_schedule", {
    p_organization_id: organizationId,
    p_schedule_id: scheduleId,
    p_completion_request_id: completionRequestId,
    p_expected_occurrence_index: schedule.next_occurrence_index,
    p_next_occurrence_index: nextOccurrenceIndex,
    p_next_due_date: nextDueDate ? `${String(nextDueDate.year).padStart(4, "0")}-${String(nextDueDate.month).padStart(2, "0")}-${String(nextDueDate.day).padStart(2, "0")}` : null,
    p_completed_by: userId,
    p_completed_by_name: actorName,
    p_completed_at: new Date().toISOString(),
    p_meter_reading_value: equipment?.current_meter_reading ?? null,
    p_meter_reading_unit_snapshot: equipment ? (equipment.meter_unit_custom_label ?? equipment.meter_unit) : null,
    p_notes: notes,
    p_checklist_snapshot: checklistSnapshot
  });

  if (rpcError) {
    if (rpcError.code === "GL020") {
      return { status: "retry" as const };
    }
    if (rpcError.code === "P0002") return { status: 404 as const, body: { message: "Schedule not found." } };
    if (rpcError.code === "22023") return { status: 400 as const, body: { message: rpcError.message } };
    throw rpcError;
  }

  return { status: 201 as const, body: completion };
}

schedulesRouter.post("/maintenance/schedules/:id/complete", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const scheduleId = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let completionRequestId: string;
  let notes: string | null;
  let responses: ChecklistResponseInput[];
  try {
    completionRequestId = parseRequiredIdempotencyKey(body.completion_request_id);
    notes = parseOptionalString(body.notes);
    responses = Array.isArray(body.checklist_responses) ? body.checklist_responses : [];
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  const { data: checklistItems, error: checklistError } = await supabase
    .from("maintenance_schedule_checklist_items")
    .select("*")
    .eq("schedule_id", scheduleId)
    .order("sort_order", { ascending: true });
  if (checklistError) return sendSafeError(res, 500, "Failed to load checklist.", "Maintenance schedule complete checklist-load error:", checklistError);

  const checkedByItemId = new Map(responses.filter((r) => r && typeof r === "object").map((r) => [r.checklist_item_id, Boolean(r.checked)]));
  const checklistSnapshot = (checklistItems ?? []).map((item) => ({
    id: item.id,
    label: item.label,
    sort_order: item.sort_order,
    checked: checkedByItemId.get(item.id) ?? false
  }));

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance schedule complete actor error:", error);
  }

  try {
    let result = await attemptComplete(organizationId, scheduleId, completionRequestId, userId, actorName, notes, checklistSnapshot);
    if (result.status === "retry") {
      result = await attemptComplete(organizationId, scheduleId, completionRequestId, userId, actorName, notes, checklistSnapshot);
    }
    if (result.status === "retry") {
      return res.status(409).json({ message: "This maintenance was just completed by someone else. Please refresh and try again." });
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to complete scheduled maintenance.", "Maintenance schedule complete error:", error);
  }
});

// ── history ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

schedulesRouter.get("/maintenance/schedules/:id/history", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const scheduleId = String(req.params.id);
  const { limit, offset } = req.query;

  const parsedLimit = typeof limit === "string" ? Number(limit) : NaN;
  const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const parsedOffset = typeof offset === "string" ? Number(offset) : NaN;
  const boundedOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;

  const { data, error } = await supabase
    .from("maintenance_schedule_completions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("schedule_id", scheduleId)
    .order("completed_at", { ascending: false })
    .order("id", { ascending: false })
    .range(boundedOffset, boundedOffset + boundedLimit - 1);

  if (error) return sendSafeError(res, 500, "Failed to load maintenance history.", "Maintenance schedule history error:", error);
  return res.json(data ?? []);
});

export { schedulesRouter };
