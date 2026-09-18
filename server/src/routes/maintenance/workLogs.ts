// Equipment work logs: what was done, optionally paired with a meter
// reading, via the atomic maintenance_log_equipment_work RPC (0132) — plus
// a merged, newest-first equipment history combining work logs, meter
// readings not already represented by a work log, and scheduled-
// maintenance completions for that equipment.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import {
  parseOptionalNonNegativeNumber, parseOptionalString, parseRequiredIdempotencyKey, parseRequiredString,
  MaintenanceValidationError
} from "./services/validation";
import { mergeEquipmentHistory } from "./services/equipmentHistory";

const workLogsRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canAct = requireAnyPermission(["maintenance:edit", "mobile:maintenance"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 100;

function parseOptionalTimestamp(value: unknown, fieldLabel: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new MaintenanceValidationError(`A valid ${fieldLabel} is required.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MaintenanceValidationError(`A valid ${fieldLabel} is required.`);
  return date.toISOString();
}

// ── create ────────────────────────────────────────────────────────────────

workLogsRouter.post("/maintenance/equipment/:id/work-logs", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const equipmentId = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let requestId: string;
  let workPerformed: string;
  let meterReadingValue: number | null;
  let notes: string | null;
  let performedAt: string | null;
  try {
    requestId = parseRequiredIdempotencyKey(body.request_id);
    workPerformed = parseRequiredString(body.work_performed, "Work performed");
    meterReadingValue = parseOptionalNonNegativeNumber(body.meter_reading_value, "Meter reading");
    notes = parseOptionalString(body.notes);
    performedAt = parseOptionalTimestamp(body.performed_at, "date and time");
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance work log actor resolution error:", error);
  }

  const { data, error } = await supabase.rpc("maintenance_log_equipment_work", {
    p_organization_id: organizationId,
    p_equipment_id: equipmentId,
    p_request_id: requestId,
    p_work_performed: workPerformed,
    p_meter_reading_value: meterReadingValue,
    p_notes: notes,
    p_performed_at: performedAt,
    p_performed_by: userId,
    p_performed_by_name: actorName
  });

  if (error) {
    if (error.code === "P0002") return res.status(404).json({ message: "Equipment not found." });
    if (error.code === "22023") return res.status(409).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to save work log.", "Maintenance work log RPC error:", error);
  }

  return res.status(201).json(data);
});

// ── merged equipment history ────────────────────────────────────────────

workLogsRouter.get("/maintenance/equipment/:id/history", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const equipmentId = String(req.params.id);
  const { limit } = req.query;

  const parsedLimit = typeof limit === "string" ? Number(limit) : NaN;
  const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), MAX_LIMIT) : DEFAULT_HISTORY_LIMIT;

  const [workLogsResult, meterReadingsResult, completionsResult] = await Promise.all([
    supabase
      .from("maintenance_work_logs")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("equipment_id", equipmentId)
      .order("performed_at", { ascending: false })
      .limit(boundedLimit),
    // Excludes readings already represented by a work log entry
    // (related_work_log_id set) — see the migration's dedup note.
    supabase
      .from("maintenance_meter_readings")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("equipment_id", equipmentId)
      .is("related_work_log_id", null)
      .order("recorded_at", { ascending: false })
      .limit(boundedLimit),
    supabase
      .from("maintenance_schedule_completions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("equipment_id", equipmentId)
      .order("completed_at", { ascending: false })
      .limit(boundedLimit)
  ]);

  if (workLogsResult.error) return sendSafeError(res, 500, "Failed to load work log history.", "Maintenance equipment history work-log error:", workLogsResult.error);
  if (meterReadingsResult.error) return sendSafeError(res, 500, "Failed to load meter reading history.", "Maintenance equipment history meter-reading error:", meterReadingsResult.error);
  if (completionsResult.error) return sendSafeError(res, 500, "Failed to load maintenance history.", "Maintenance equipment history completion error:", completionsResult.error);

  const entries = mergeEquipmentHistory(
    workLogsResult.data ?? [],
    meterReadingsResult.data ?? [],
    completionsResult.data ?? [],
    boundedLimit
  );

  return res.json(entries);
});

export { workLogsRouter };
