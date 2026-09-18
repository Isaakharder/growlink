// Restock requests: create (one or more lines), mark-ordered, cancel, and
// per-line receiving (which goes through maintenance_apply_inventory_
// transaction via the maintenance_receive_restock_line RPC — see 0130).

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import { RestockRequestStatus } from "./services/types";
import {
  parseOptionalString, parsePositiveNumber, parseRequiredIdempotencyKey, parseRequiredString,
  MaintenanceValidationError
} from "./services/validation";
import { ensureInventoryItemExists, MaintenanceNotFoundError } from "./services/ensureExists";

const restockRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canAct = requireAnyPermission(["maintenance:edit", "mobile:maintenance"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type RequestLineInput = { item_id: string; requested_quantity: number; notes: string | null };

function validateLine(raw: unknown, index: number): RequestLineInput {
  if (!raw || typeof raw !== "object") throw new MaintenanceValidationError(`Line ${index + 1} is invalid.`);
  const line = raw as Record<string, unknown>;
  return {
    item_id: parseRequiredString(line.item_id, `Line ${index + 1} item`),
    requested_quantity: parsePositiveNumber(line.requested_quantity, `Line ${index + 1} requested quantity`),
    notes: parseOptionalString(line.notes)
  };
}

// ── list / detail ─────────────────────────────────────────────────────────

restockRouter.get("/maintenance/restock/requests", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { status, limit, offset } = req.query;

  const parsedLimit = typeof limit === "string" ? Number(limit) : NaN;
  const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const parsedOffset = typeof offset === "string" ? Number(offset) : NaN;
  const boundedOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;

  let query = supabase
    .from("maintenance_restock_requests")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(boundedOffset, boundedOffset + boundedLimit - 1);

  if (typeof status === "string" && status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load restock requests.", "Maintenance restock list error:", error);
  return res.json(data ?? []);
});

restockRouter.get("/maintenance/restock/requests/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data: request, error } = await supabase
    .from("maintenance_restock_requests")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to load restock request.", "Maintenance restock detail error:", error);
  if (!request) return res.status(404).json({ message: "Restock request not found." });

  const { data: lines, error: linesError } = await supabase
    .from("maintenance_restock_request_lines")
    .select("*, item:maintenance_inventory_items(id, name, part_number)")
    .eq("request_id", id)
    .order("created_at", { ascending: true });

  if (linesError) return sendSafeError(res, 500, "Failed to load restock request lines.", "Maintenance restock lines error:", linesError);

  return res.json({ ...request, lines: lines ?? [] });
});

// ── create ────────────────────────────────────────────────────────────────

restockRouter.post("/maintenance/restock/requests", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let lines: RequestLineInput[];
  let notes: string | null;
  try {
    if (!Array.isArray(body.lines) || body.lines.length === 0) throw new MaintenanceValidationError("At least one part is required.");
    lines = body.lines.map((line, index) => validateLine(line, index));
    notes = parseOptionalString(body.notes);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  const itemRows: { id: string; name: string; unit: string }[] = [];
  try {
    for (const line of lines) {
      await ensureInventoryItemExists(line.item_id, organizationId);
    }
    const { data: items, error: itemsError } = await supabase
      .from("maintenance_inventory_items")
      .select("id, name, unit_of_measure, unit_of_measure_custom_label")
      .eq("organization_id", organizationId)
      .in("id", lines.map((l) => l.item_id));
    if (itemsError) throw itemsError;
    for (const item of items ?? []) {
      itemRows.push({ id: item.id, name: item.name, unit: item.unit_of_measure_custom_label ?? item.unit_of_measure });
    }
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate restock lines.", "Maintenance restock line validation error:", error);
  }

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance restock actor error:", error);
  }

  const { data: request, error: requestError } = await supabase
    .from("maintenance_restock_requests")
    .insert({ organization_id: organizationId, notes, requested_by: userId, requested_by_name_snapshot: actorName })
    .select("*")
    .single();

  if (requestError) return sendSafeError(res, 500, "Failed to create restock request.", "Maintenance restock insert error:", requestError);

  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const { data: insertedLines, error: linesError } = await supabase
    .from("maintenance_restock_request_lines")
    .insert(lines.map((line) => ({
      organization_id: organizationId,
      request_id: request.id,
      item_id: line.item_id,
      item_name_snapshot: itemById.get(line.item_id)?.name ?? "Unknown part",
      unit_snapshot: itemById.get(line.item_id)?.unit ?? "each",
      requested_quantity: line.requested_quantity,
      notes: line.notes
    })))
    .select("*");

  if (linesError) {
    await supabase.from("maintenance_restock_requests").delete().eq("id", request.id);
    return sendSafeError(res, 500, "Failed to create restock request lines.", "Maintenance restock lines insert error:", linesError);
  }

  return res.status(201).json({ ...request, lines: insertedLines ?? [] });
});

// ── status transitions ───────────────────────────────────────────────────

restockRouter.post("/maintenance/restock/requests/:id/mark-ordered", canAct, async (req, res) => {
  const { data, error } = await supabase
    .from("maintenance_restock_requests")
    .update({ status: "ordered" as RestockRequestStatus, ordered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .in("status", ["requested"])
    .select("*")
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to mark request as ordered.", "Maintenance restock mark-ordered error:", error);
  if (!data) return res.status(409).json({ message: "This request cannot be marked as ordered right now." });
  return res.json(data);
});

restockRouter.post("/maintenance/restock/requests/:id/cancel", canAct, async (req, res) => {
  const userId = req.userId;
  const reason = parseOptionalString((req.body as Record<string, unknown> | undefined)?.reason);

  const { data, error } = await supabase
    .from("maintenance_restock_requests")
    .update({
      status: "cancelled" as RestockRequestStatus, cancelled_at: new Date().toISOString(), cancelled_by: userId,
      cancelled_reason: reason, updated_at: new Date().toISOString()
    })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .not("status", "in", "(received,cancelled)")
    .select("*")
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to cancel request.", "Maintenance restock cancel error:", error);
  if (!data) return res.status(409).json({ message: "This request cannot be cancelled right now." });
  return res.json(data);
});

// ── receive a line ────────────────────────────────────────────────────────

restockRouter.post("/maintenance/restock/requests/:id/lines/:lineId/receive", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const requestId = String(req.params.id);
  const lineId = String(req.params.lineId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let receiveQuantity: number;
  let ledgerRequestId: string;
  try {
    receiveQuantity = parsePositiveNumber(body.receive_quantity, "Receive quantity");
    ledgerRequestId = parseRequiredIdempotencyKey(body.request_id);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance restock receive actor error:", error);
  }

  const { data, error } = await supabase.rpc("maintenance_receive_restock_line", {
    p_organization_id: organizationId,
    p_request_id: requestId,
    p_line_id: lineId,
    p_receive_quantity: receiveQuantity,
    p_ledger_request_id: ledgerRequestId,
    p_performed_by: userId,
    p_performed_by_name: actorName
  });

  if (error) {
    if (error.code === "P0002") return res.status(404).json({ message: "Restock request line not found." });
    if (error.code === "23514" || error.code === "22023") return res.status(409).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to receive stock.", "Maintenance restock receive RPC error:", error);
  }

  const result = Array.isArray(data) ? data[0] : data;
  return res.status(201).json(result);
});

export { restockRouter };
