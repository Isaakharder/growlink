// Cheap count-only queries for in-app badges (Mobile Home card + tab bar).
// GrowLink has no push-notification infrastructure yet (see 0127's header
// comment) — this is the deferred-push fallback the product spec asks for:
// clear in-app badges + server-side due/low-stock query support now, with
// real push delivery as a documented next phase.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission } from "../../middleware/requirePermission";
import { todayInOrgTimezone } from "../foodSafety/services/checklistPeriod";

const badgesRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);

badgesRouter.get("/maintenance/badges", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const today = todayInOrgTimezone();

  const [
    overdueResult,
    dueSoonCandidatesResult,
    activeItemsResult,
    outOfStockResult,
    restockPendingResult
  ] = await Promise.all([
    supabase
      .from("maintenance_schedules")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("next_due_date", "is", null)
      .lt("next_due_date", today),
    supabase
      .from("maintenance_schedules")
      .select("next_due_date, warning_days_before_due")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("next_due_date", "is", null)
      .gte("next_due_date", today),
    // Low-stock compares two columns on the same row (quantity_on_hand <=
    // minimum_quantity), which PostgREST's query-string filters can't
    // express directly — loaded and classified in JS instead, same as the
    // Reports tab's own endpoints.
    supabase
      .from("maintenance_inventory_items")
      .select("quantity_on_hand, minimum_quantity")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
    supabase
      .from("maintenance_inventory_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .eq("quantity_on_hand", 0),
    supabase
      .from("maintenance_restock_requests")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", ["requested", "ordered", "partially_received"])
  ]);

  if (overdueResult.error) return sendSafeError(res, 500, "Failed to load maintenance badges.", "Maintenance badges overdue error:", overdueResult.error);
  if (dueSoonCandidatesResult.error) return sendSafeError(res, 500, "Failed to load maintenance badges.", "Maintenance badges due-soon error:", dueSoonCandidatesResult.error);
  if (activeItemsResult.error) return sendSafeError(res, 500, "Failed to load maintenance badges.", "Maintenance badges low-stock error:", activeItemsResult.error);
  if (outOfStockResult.error) return sendSafeError(res, 500, "Failed to load maintenance badges.", "Maintenance badges out-of-stock error:", outOfStockResult.error);
  if (restockPendingResult.error) return sendSafeError(res, 500, "Failed to load maintenance badges.", "Maintenance badges restock error:", restockPendingResult.error);

  const equipmentDueSoon = (dueSoonCandidatesResult.data ?? []).filter((schedule) => {
    const threshold = new Date(schedule.next_due_date as string);
    threshold.setUTCDate(threshold.getUTCDate() - (schedule.warning_days_before_due as number));
    return threshold.toISOString().slice(0, 10) <= today;
  }).length;

  const inventoryLowStock = (activeItemsResult.data ?? []).filter((item) => {
    const qty = Number(item.quantity_on_hand);
    return qty > 0 && item.minimum_quantity !== null && qty <= Number(item.minimum_quantity);
  }).length;

  return res.json({
    equipment_due_soon: equipmentDueSoon,
    equipment_overdue: overdueResult.count ?? 0,
    inventory_low_stock: inventoryLowStock,
    inventory_out_of_stock: outOfStockResult.count ?? 0,
    restock_pending: restockPendingResult.count ?? 0
  });
});

export { badgesRouter };
