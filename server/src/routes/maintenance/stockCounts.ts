// Stock-count sessions: create by location (snapshotting every active item
// there), draft entry of counted quantities, confirm (idempotent, conflict-
// detecting, applies corrections through the ledger), and cancel.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import { parseNonNegativeNumber, parseOptionalString, parseRequiredString } from "./services/validation";
import { ensureLocationExists, MaintenanceNotFoundError } from "./services/ensureExists";

const stockCountsRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canAct = requireAnyPermission(["maintenance:edit", "mobile:maintenance"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ── list / detail ─────────────────────────────────────────────────────────

stockCountsRouter.get("/maintenance/stock-counts/sessions", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { status, location_id, limit, offset } = req.query;

  const parsedLimit = typeof limit === "string" ? Number(limit) : NaN;
  const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const parsedOffset = typeof offset === "string" ? Number(offset) : NaN;
  const boundedOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;

  let query = supabase
    .from("maintenance_stock_count_sessions")
    .select("*")
    .eq("organization_id", organizationId)
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .range(boundedOffset, boundedOffset + boundedLimit - 1);

  if (typeof status === "string" && status) query = query.eq("status", status);
  if (typeof location_id === "string" && location_id) query = query.eq("location_id", location_id);

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load stock count sessions.", "Maintenance stock-count list error:", error);
  return res.json(data ?? []);
});

stockCountsRouter.get("/maintenance/stock-counts/sessions/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data: session, error } = await supabase
    .from("maintenance_stock_count_sessions")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to load stock count session.", "Maintenance stock-count detail error:", error);
  if (!session) return res.status(404).json({ message: "Stock count session not found." });

  const { data: lines, error: linesError } = await supabase
    .from("maintenance_stock_count_lines")
    .select("*")
    .eq("session_id", id)
    .order("item_name_snapshot", { ascending: true });

  if (linesError) return sendSafeError(res, 500, "Failed to load stock count lines.", "Maintenance stock-count lines error:", linesError);

  const linesWithVariance = (lines ?? []).map((line) => ({
    ...line,
    variance: line.counted_quantity === null ? null : Number(line.counted_quantity) - Number(line.expected_quantity)
  }));

  return res.json({ ...session, lines: linesWithVariance });
});

// ── create ────────────────────────────────────────────────────────────────

stockCountsRouter.post("/maintenance/stock-counts/sessions", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let locationId: string;
  try {
    locationId = parseRequiredString(body.location_id, "Location");
    await ensureLocationExists(locationId, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  const { data: location, error: locationError } = await supabase
    .from("maintenance_locations")
    .select("name")
    .eq("id", locationId)
    .single();
  if (locationError) return sendSafeError(res, 500, "Failed to load location.", "Maintenance stock-count location error:", locationError);

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance stock-count actor error:", error);
  }

  const { data, error } = await supabase.rpc("maintenance_create_stock_count_session", {
    p_organization_id: organizationId,
    p_location_id: locationId,
    p_location_name: location.name,
    p_started_by: userId,
    p_started_by_name: actorName
  });

  if (error) return sendSafeError(res, 500, "Failed to start stock count.", "Maintenance stock-count create RPC error:", error);

  const session = Array.isArray(data) ? data[0] : data;

  const { data: lines, error: linesError } = await supabase
    .from("maintenance_stock_count_lines")
    .select("*")
    .eq("session_id", session.id)
    .order("item_name_snapshot", { ascending: true });
  if (linesError) return sendSafeError(res, 500, "Stock count started, but failed to load its lines.", "Maintenance stock-count lines-load error:", linesError);

  return res.status(201).json({ ...session, lines: lines ?? [] });
});

// ── enter a counted quantity (draft only — blocked by DB trigger otherwise) ─

stockCountsRouter.put("/maintenance/stock-counts/sessions/:id/lines/:lineId", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const lineId = String(req.params.lineId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  let countedQuantity: number;
  let notes: string | null;
  try {
    countedQuantity = parseNonNegativeNumber(body.counted_quantity, "Counted quantity");
    notes = parseOptionalString(body.notes);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  const { data, error } = await supabase
    .from("maintenance_stock_count_lines")
    .update({ counted_quantity: countedQuantity, notes, counted_at: new Date().toISOString(), counted_by: userId, updated_at: new Date().toISOString() })
    .eq("id", lineId)
    .eq("session_id", req.params.id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "42501") return res.status(409).json({ message: (error as { message: string }).message });
    return sendSafeError(res, 500, "Failed to save counted quantity.", "Maintenance stock-count line update error:", error);
  }
  if (!data) return res.status(404).json({ message: "Stock count line not found." });
  return res.json(data);
});

// ── confirm / cancel ──────────────────────────────────────────────────────

stockCountsRouter.post("/maintenance/stock-counts/sessions/:id/confirm", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const sessionId = String(req.params.id);

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance stock-count confirm actor error:", error);
  }

  const { data, error } = await supabase.rpc("maintenance_confirm_stock_count_session", {
    p_organization_id: organizationId,
    p_session_id: sessionId,
    p_confirmed_by: userId,
    p_confirmed_by_name: actorName
  });

  if (error) {
    if (error.code === "P0002") return res.status(404).json({ message: "Stock count session not found." });
    if (typeof error.message === "string" && error.message.startsWith("CONFLICT:")) {
      let conflicts: unknown = [];
      try {
        conflicts = JSON.parse(error.message.slice("CONFLICT:".length));
      } catch {
        conflicts = [];
      }
      return res.status(409).json({ message: "Some items changed since this count started. Review the conflicts and start a new count.", conflicts });
    }
    if (error.code === "22023") return res.status(409).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to confirm stock count.", "Maintenance stock-count confirm RPC error:", error);
  }

  const session = Array.isArray(data) ? data[0] : data;
  return res.json(session);
});

stockCountsRouter.post("/maintenance/stock-counts/sessions/:id/cancel", canAct, async (req, res) => {
  const userId = req.userId;
  const reason = parseOptionalString((req.body as Record<string, unknown> | undefined)?.reason);

  const { data, error } = await supabase
    .from("maintenance_stock_count_sessions")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: userId, cancelled_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to cancel stock count.", "Maintenance stock-count cancel error:", error);
  if (!data) return res.status(409).json({ message: "This stock count cannot be cancelled right now." });
  return res.json(data);
});

export { stockCountsRouter };
