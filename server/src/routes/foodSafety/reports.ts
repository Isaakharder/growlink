import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission } from "../../middleware/requirePermission";

const RECENT_REPORTS_LIMIT = 28;

type LocationRow = {
  id: string;
  name: string;
  area: string;
};

type ReportRow = {
  id: string;
  completed_at: string;
  completed_by_name: string;
  completed_by_initials: string;
  task_count: number;
};

const reportsRouter = Router();

// Mobile-only users (mobile:food_safety without the desktop food_safety:view
// permission) must not reach these routes — reuses the exact same desktop
// view gate as cleaning-locations.
const canView = requireAnyPermission(["food_safety:view", "food_safety:edit"]);

reportsRouter.get("/food-safety/reports", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data: locations, error: locationsError } = await supabase
    .from("food_safety_cleaning_locations")
    .select("id, name, area")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (locationsError) {
    return sendSafeError(res, 500, "Failed to load locations.", "Reports locations fetch error:", locationsError);
  }

  try {
    const cards = await Promise.all(
      ((locations ?? []) as LocationRow[]).map(async (location) => {
        const [countResult, recentResult] = await Promise.all([
          supabase
            .from("food_safety_cleaning_reports")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", organizationId)
            .eq("location_id", location.id),
          supabase
            .from("food_safety_cleaning_reports")
            .select("id, completed_at, completed_by_name, completed_by_initials, task_count")
            .eq("organization_id", organizationId)
            .eq("location_id", location.id)
            .order("completed_at", { ascending: false })
            .limit(RECENT_REPORTS_LIMIT)
        ]);

        if (countResult.error) throw new Error(countResult.error.message);
        if (recentResult.error) throw new Error(recentResult.error.message);

        const reports = (recentResult.data ?? []) as ReportRow[];
        const mostRecent = reports[0] ?? null;

        return {
          id: location.id,
          name: location.name,
          area: location.area,
          totalReports: countResult.count ?? 0,
          mostRecentCompletedAt: mostRecent?.completed_at ?? null,
          mostRecentCompletedByInitials: mostRecent?.completed_by_initials ?? null,
          reports: reports.map((r) => ({
            id: r.id,
            completedAt: r.completed_at,
            completedByName: r.completed_by_name,
            completedByInitials: r.completed_by_initials,
            taskCount: r.task_count
          }))
        };
      })
    );

    return res.json({ locations: cards });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load cleaning reports.", "Reports fetch error:", error);
  }
});

reportsRouter.get("/food-safety/reports/:reportId", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { reportId } = req.params;

  const { data: report, error: reportError } = await supabase
    .from("food_safety_cleaning_reports")
    .select("*")
    .eq("id", reportId)
    .eq("organization_id", organizationId)
    .single();

  if (reportError || !report) {
    return res.status(404).json({ message: "Report not found." });
  }

  const { data: items, error: itemsError } = await supabase
    .from("food_safety_cleaning_report_items")
    .select("*")
    .eq("report_id", reportId)
    .eq("organization_id", organizationId)
    .order("sort_order", { ascending: true });

  if (itemsError) {
    return sendSafeError(res, 500, "Failed to load report details.", "Report items fetch error:", itemsError);
  }

  return res.json({
    id: report.id,
    locationName: report.location_name_snapshot,
    locationArea: report.location_area_snapshot,
    periodSignature: report.period_signature,
    completedAt: report.completed_at,
    completedByName: report.completed_by_name,
    completedByInitials: report.completed_by_initials,
    completedByUserId: report.completed_by_user_id,
    taskCount: report.task_count,
    items: (items ?? []).map((item) => ({
      id: item.id,
      name: item.task_name_snapshot,
      frequency: item.frequency_snapshot,
      responseType: item.response_type_snapshot,
      actionLabel: item.action_label_snapshot,
      responseValue: item.response_value,
      checkedAt: item.checked_at,
      checkedByName: item.checked_by_name,
      checkedByInitials: item.checked_by_initials
    }))
  });
});

export { reportsRouter };
