// Equipment meter readings: record (via the atomic
// maintenance_record_meter_reading RPC) + paginated history.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import { parseNonNegativeNumber, parseOptionalBoolean, parseOptionalString, MaintenanceValidationError } from "./services/validation";

const metersRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canAct = requireAnyPermission(["maintenance:edit", "mobile:maintenance"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

metersRouter.post("/maintenance/equipment/:id/meter-readings", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const equipmentId = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let value: number;
  let note: string | null;
  let isReset: boolean;
  let resetReason: string | null;
  try {
    value = parseNonNegativeNumber(body.value, "Reading value");
    note = parseOptionalString(body.note);
    isReset = parseOptionalBoolean(body.is_reset);
    resetReason = parseOptionalString(body.reset_reason);
    if (isReset && !resetReason) throw new MaintenanceValidationError("A reason is required when resetting a meter.");
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance meter actor resolution error:", error);
  }

  const { data, error } = await supabase.rpc("maintenance_record_meter_reading", {
    p_organization_id: organizationId,
    p_equipment_id: equipmentId,
    p_value: value,
    p_note: note,
    p_is_reset: isReset,
    p_reset_reason: isReset ? resetReason : null,
    p_recorded_by: userId,
    p_recorded_by_name: actorName
  });

  if (error) {
    if (error.code === "P0002") return res.status(404).json({ message: "Equipment not found." });
    if (error.code === "22023") return res.status(409).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to record meter reading.", "Maintenance meter reading RPC error:", error);
  }

  return res.status(201).json(data);
});

metersRouter.get("/maintenance/equipment/:id/meter-readings", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const equipmentId = String(req.params.id);
  const { limit, offset } = req.query;

  const parsedLimit = typeof limit === "string" ? Number(limit) : NaN;
  const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), MAX_LIMIT) : DEFAULT_LIMIT;

  const parsedOffset = typeof offset === "string" ? Number(offset) : NaN;
  const boundedOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;

  const { data, error } = await supabase
    .from("maintenance_meter_readings")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("equipment_id", equipmentId)
    .order("recorded_at", { ascending: false })
    .order("id", { ascending: false })
    .range(boundedOffset, boundedOffset + boundedLimit - 1);

  if (error) return sendSafeError(res, 500, "Failed to load meter reading history.", "Maintenance meter history error:", error);
  return res.json(data ?? []);
});

export { metersRouter };
