// Paginated read of the inventory transaction ledger — the data source for
// the ad-hoc history view and (filtered by type) the Reports tab's
// "recent receipts" / "recent adjustments" sections.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission } from "../../middleware/requirePermission";
import { InventoryTransactionType } from "./services/types";

const transactionsRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function queryInventoryTransactions(
  organizationId: string,
  filters: { item_id?: string; transaction_types?: InventoryTransactionType[]; from?: string; to?: string; limit?: number; offset?: number }
) {
  const boundedLimit = filters.limit && filters.limit > 0 ? Math.min(Math.floor(filters.limit), MAX_LIMIT) : DEFAULT_LIMIT;
  const boundedOffset = filters.offset && filters.offset >= 0 ? Math.floor(filters.offset) : 0;

  let query = supabase
    .from("maintenance_inventory_transactions")
    .select("*, item:maintenance_inventory_items(id, name, part_number)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(boundedOffset, boundedOffset + boundedLimit - 1);

  if (filters.item_id) query = query.eq("item_id", filters.item_id);
  if (filters.transaction_types && filters.transaction_types.length > 0) query = query.in("transaction_type", filters.transaction_types);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  return query;
}

transactionsRouter.get("/maintenance/inventory/transactions", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { item_id, transaction_type, from, to, limit, offset } = req.query;

  const { data, error } = await queryInventoryTransactions(organizationId, {
    item_id: typeof item_id === "string" ? item_id : undefined,
    transaction_types: typeof transaction_type === "string" ? [transaction_type as InventoryTransactionType] : undefined,
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
    limit: typeof limit === "string" ? Number(limit) : undefined,
    offset: typeof offset === "string" ? Number(offset) : undefined
  });

  if (error) return sendSafeError(res, 500, "Failed to load inventory transactions.", "Maintenance transactions list error:", error);
  return res.json(data ?? []);
});

export { transactionsRouter };
