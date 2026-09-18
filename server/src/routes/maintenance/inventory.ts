// Inventory items: CRUD (list with computed stock-status, low/out-of-stock
// filtering) and the ad-hoc quantity-change endpoint for manual
// receive/add/remove/adjust. Restock receiving and stock-count corrections
// go through their own dedicated flows (restock.ts / stockCounts.ts) rather
// than this generic endpoint — see DIRECT_INVENTORY_TRANSACTION_TYPES.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import {
  DIRECT_INVENTORY_TRANSACTION_TYPES, DISCRETE_UNITS_OF_MEASURE, InventoryTransactionType,
  StockStatus, UNITS_OF_MEASURE, UnitOfMeasure
} from "./services/types";
import {
  parseEnum, parseIntegerQuantity, parseNonNegativeNumber, parseOptionalNonNegativeNumber,
  parseOptionalString, parseRequiredIdempotencyKey, parseRequiredString, MaintenanceValidationError
} from "./services/validation";
import { ensurePartTypeExists, ensureLocationExists, MaintenanceNotFoundError } from "./services/ensureExists";

const inventoryRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canEdit = requirePermission("maintenance:edit");
const canAct = requireAnyPermission(["maintenance:edit", "mobile:maintenance"]);

type InventoryItemPayload = {
  name: string;
  part_number: string | null;
  part_type_id: string | null;
  location_id: string;
  unit_of_measure: UnitOfMeasure;
  unit_of_measure_custom_label: string | null;
  minimum_quantity: number | null;
  suggested_reorder_quantity: number | null;
  supplier: string | null;
  supplier_part_number: string | null;
  cost: number | null;
  notes: string | null;
};

function validateInventoryItemPayload(input: unknown): InventoryItemPayload {
  if (!input || typeof input !== "object") throw new MaintenanceValidationError("Invalid request body.");
  const body = input as Record<string, unknown>;

  const unit_of_measure = parseEnum(body.unit_of_measure, UNITS_OF_MEASURE, "Unit of measure");
  const unit_of_measure_custom_label = parseOptionalString(body.unit_of_measure_custom_label);
  if (unit_of_measure === "custom" && !unit_of_measure_custom_label) {
    throw new MaintenanceValidationError("A custom unit label is required.");
  }
  if (unit_of_measure !== "custom" && unit_of_measure_custom_label) {
    throw new MaintenanceValidationError("A custom unit label is only valid when the unit of measure is Custom.");
  }

  return {
    name: parseRequiredString(body.name, "Part name"),
    part_number: parseOptionalString(body.part_number),
    part_type_id: typeof body.part_type_id === "string" && body.part_type_id ? body.part_type_id : null,
    location_id: parseRequiredString(body.location_id, "Location"),
    unit_of_measure,
    unit_of_measure_custom_label: unit_of_measure === "custom" ? unit_of_measure_custom_label : null,
    minimum_quantity: parseOptionalNonNegativeNumber(body.minimum_quantity, "Minimum quantity"),
    suggested_reorder_quantity: parseOptionalNonNegativeNumber(body.suggested_reorder_quantity, "Suggested reorder quantity"),
    supplier: parseOptionalString(body.supplier),
    supplier_part_number: parseOptionalString(body.supplier_part_number),
    cost: parseOptionalNonNegativeNumber(body.cost, "Cost"),
    notes: parseOptionalString(body.notes)
  };
}

async function validateReferences(payload: InventoryItemPayload, organizationId: string) {
  if (payload.part_type_id) await ensurePartTypeExists(payload.part_type_id, organizationId);
  await ensureLocationExists(payload.location_id, organizationId);
}

export function computeStockStatus(quantityOnHand: number, minimumQuantity: number | null): StockStatus {
  if (quantityOnHand <= 0) return "out_of_stock";
  if (minimumQuantity !== null && quantityOnHand <= minimumQuantity) return "low_stock";
  return "in_stock";
}

// ── list ──────────────────────────────────────────────────────────────────

inventoryRouter.get("/maintenance/inventory/items", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { search, location_id, part_type_id, stock_status, active } = req.query;

  let query = supabase
    .from("maintenance_inventory_items")
    .select("*, part_type:maintenance_part_types(id, name), location:maintenance_locations(id, name)")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (typeof search === "string" && search.trim()) {
    const term = search.trim();
    query = query.or(`name.ilike.%${term}%,part_number.ilike.%${term}%`);
  }
  if (typeof location_id === "string" && location_id) query = query.eq("location_id", location_id);
  if (typeof part_type_id === "string" && part_type_id) query = query.eq("part_type_id", part_type_id);
  if (typeof active === "string" && (active === "true" || active === "false")) query = query.eq("is_active", active === "true");

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load inventory.", "Maintenance inventory list error:", error);

  let items = (data ?? []).map((item) => ({
    ...item,
    stock_status: computeStockStatus(Number(item.quantity_on_hand), item.minimum_quantity === null ? null : Number(item.minimum_quantity))
  }));

  if (typeof stock_status === "string" && ["in_stock", "low_stock", "out_of_stock"].includes(stock_status)) {
    items = items.filter((item) => item.stock_status === stock_status);
  }

  return res.json(items);
});

inventoryRouter.get("/maintenance/inventory/items/:id", canView, async (req, res) => {
  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .select("*, part_type:maintenance_part_types(id, name), location:maintenance_locations(id, name)")
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to load inventory item.", "Maintenance inventory detail error:", error);
  if (!data) return res.status(404).json({ message: "Inventory item not found." });

  return res.json({
    ...data,
    stock_status: computeStockStatus(Number(data.quantity_on_hand), data.minimum_quantity === null ? null : Number(data.minimum_quantity))
  });
});

// ── create / update ───────────────────────────────────────────────────────

inventoryRouter.post("/maintenance/inventory/items", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: InventoryItemPayload;
  try {
    payload = validateInventoryItemPayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  try {
    await validateReferences(payload, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate inventory references.", "Maintenance inventory reference error:", error);
  }

  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .insert({ ...payload, organization_id: organizationId, created_by: req.userId, updated_by: req.userId })
    .select("*")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") return res.status(409).json({ message: "This part number is already in use." });
    return sendSafeError(res, 500, "Failed to create inventory item.", "Maintenance inventory insert error:", error);
  }
  return res.status(201).json(data);
});

inventoryRouter.put("/maintenance/inventory/items/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);
  let payload: InventoryItemPayload;
  try {
    payload = validateInventoryItemPayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
  }

  try {
    await validateReferences(payload, organizationId);
  } catch (error) {
    if (error instanceof MaintenanceNotFoundError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate inventory references.", "Maintenance inventory reference error:", error);
  }

  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .update({ ...payload, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") return res.status(409).json({ message: "This part number is already in use." });
    return sendSafeError(res, 500, "Failed to update inventory item.", "Maintenance inventory update error:", error);
  }
  if (!data) return res.status(404).json({ message: "Inventory item not found." });
  return res.json(data);
});

inventoryRouter.post("/maintenance/inventory/items/:id/deactivate", canEdit, async (req, res) => {
  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .select("id")
    .maybeSingle();
  if (error) return sendSafeError(res, 500, "Failed to deactivate inventory item.", "Maintenance inventory deactivate error:", error);
  if (!data) return res.status(404).json({ message: "Inventory item not found." });
  return res.status(204).send();
});

inventoryRouter.post("/maintenance/inventory/items/:id/activate", canEdit, async (req, res) => {
  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .update({ is_active: true, updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", req.params.id)
    .eq("organization_id", req.organizationId)
    .select("id")
    .maybeSingle();
  if (error) return sendSafeError(res, 500, "Failed to reactivate inventory item.", "Maintenance inventory activate error:", error);
  if (!data) return res.status(404).json({ message: "Inventory item not found." });
  return res.status(204).send();
});

// ── ad-hoc quantity change (receive / add / remove / manual_adjustment) ──

inventoryRouter.post("/maintenance/inventory/items/:id/transactions", canAct, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const itemId = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) return res.status(401).json({ message: "Authentication is required." });

  let transactionType: InventoryTransactionType;
  let quantity: number;
  let reason: string | null;
  let requestId: string;
  try {
    transactionType = parseEnum(body.transaction_type, DIRECT_INVENTORY_TRANSACTION_TYPES, "Transaction type");
    reason = parseOptionalString(body.reason);
    requestId = parseRequiredIdempotencyKey(body.request_id);

    const { data: item, error: itemError } = await supabase
      .from("maintenance_inventory_items")
      .select("unit_of_measure")
      .eq("id", itemId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (itemError) throw itemError;
    if (!item) return res.status(404).json({ message: "Inventory item not found." });

    const magnitude = DISCRETE_UNITS_OF_MEASURE.includes(item.unit_of_measure as UnitOfMeasure)
      ? parseIntegerQuantity(body.quantity, "Quantity")
      : parseNonNegativeNumber(body.quantity, "Quantity");

    if (magnitude <= 0) throw new MaintenanceValidationError("Quantity must be greater than zero.");
    quantity = transactionType === "remove" ? -magnitude : magnitude;
  } catch (error) {
    if (error instanceof MaintenanceValidationError) return res.status(400).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to validate transaction.", "Maintenance inventory transaction validation error:", error);
  }

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Maintenance inventory transaction actor error:", error);
  }

  const { data, error } = await supabase.rpc("maintenance_apply_inventory_transaction", {
    p_organization_id: organizationId,
    p_item_id: itemId,
    p_transaction_type: transactionType,
    p_quantity_change: quantity,
    p_reason: reason,
    p_request_id: requestId,
    p_performed_by: userId,
    p_performed_by_name: actorName
  });

  if (error) {
    if (error.code === "P0002") return res.status(404).json({ message: "Inventory item not found." });
    if (error.code === "23514") return res.status(409).json({ message: error.message });
    return sendSafeError(res, 500, "Failed to record inventory transaction.", "Maintenance inventory transaction RPC error:", error);
  }

  const result = Array.isArray(data) ? data[0] : data;
  return res.status(201).json(result);
});

export { inventoryRouter, validateInventoryItemPayload };
