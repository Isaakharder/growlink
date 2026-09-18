// Reports tab: read-only, mobile-friendly views built on top of the
// inventory/ledger data already exposed by inventory.ts and transactions.ts.
// Restock-request-history and stock-count-history are served directly by
// restock.ts's and stockCounts.ts's own list endpoints — no duplication here.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission } from "../../middleware/requirePermission";
import { computeStockStatus } from "./inventory";
import { queryInventoryTransactions } from "./transactions";

const reportsRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);

async function loadActiveItemsWithStockStatus(organizationId: string) {
  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .select("*, part_type:maintenance_part_types(id, name), location:maintenance_locations(id, name)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((item) => ({
    ...item,
    stock_status: computeStockStatus(Number(item.quantity_on_hand), item.minimum_quantity === null ? null : Number(item.minimum_quantity))
  }));
}

reportsRouter.get("/maintenance/reports/inventory-by-location", canView, async (req, res) => {
  try {
    const items = await loadActiveItemsWithStockStatus(req.organizationId);
    return res.json(items);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load inventory report.", "Maintenance report inventory-by-location error:", error);
  }
});

reportsRouter.get("/maintenance/reports/low-stock", canView, async (req, res) => {
  try {
    const items = (await loadActiveItemsWithStockStatus(req.organizationId)).filter((i) => i.stock_status === "low_stock");
    return res.json(items);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load low-stock report.", "Maintenance report low-stock error:", error);
  }
});

reportsRouter.get("/maintenance/reports/out-of-stock", canView, async (req, res) => {
  try {
    const items = (await loadActiveItemsWithStockStatus(req.organizationId)).filter((i) => i.stock_status === "out_of_stock");
    return res.json(items);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load out-of-stock report.", "Maintenance report out-of-stock error:", error);
  }
});

reportsRouter.get("/maintenance/reports/recent-receipts", canView, async (req, res) => {
  const { data, error } = await queryInventoryTransactions(req.organizationId, {
    transaction_types: ["receive", "restock_receipt"],
    limit: 50
  });
  if (error) return sendSafeError(res, 500, "Failed to load recent receipts.", "Maintenance report recent-receipts error:", error);
  return res.json(data ?? []);
});

reportsRouter.get("/maintenance/reports/recent-adjustments", canView, async (req, res) => {
  const { data, error } = await queryInventoryTransactions(req.organizationId, {
    transaction_types: ["add", "remove", "manual_adjustment", "stock_count_correction"],
    limit: 50
  });
  if (error) return sendSafeError(res, 500, "Failed to load recent adjustments.", "Maintenance report recent-adjustments error:", error);
  return res.json(data ?? []);
});

export { reportsRouter };
