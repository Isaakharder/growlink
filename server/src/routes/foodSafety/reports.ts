import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { zonedTimeToUtc } from "../../utils/zonedTime";
import { DEFAULT_ORG_TIMEZONE } from "../../config/orgTimezone";
import { buildTaskColumnsAndValues, type ReportItemRow, type ReportRow, type TaskRow } from "../../utils/foodSafetyReportCard";
import { resolveActor } from "./services/actorIdentity";

const RECENT_REPORTS_LIMIT = 28;

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Inclusive [start_date, end_date] in the organization timezone, expressed
// as a UTC instant range — start_date's midnight through the instant right
// before the day after end_date. Reuses the same civil-time -> UTC
// conversion the Logs Backfill generator relies on for the same reason:
// two dates typed by an office user must map to real day boundaries in
// America/Toronto, not UTC.
function dateRangeToUtcBounds(startDate: string, endDate: string): { startUtc: string; endUtcExclusive: string } {
  const [startY, startM, startD] = startDate.split("-").map(Number);
  const [endY, endM, endD] = endDate.split("-").map(Number);
  const startUtc = zonedTimeToUtc(startY, startM, startD, 0, 0, DEFAULT_ORG_TIMEZONE);
  const endDayStartUtc = zonedTimeToUtc(endY, endM, endD, 0, 0, DEFAULT_ORG_TIMEZONE);
  const endUtcExclusive = new Date(endDayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc: startUtc.toISOString(), endUtcExclusive: endUtcExclusive.toISOString() };
}

type LocationRow = {
  id: string;
  name: string;
  area: string;
  notes: string | null;
  is_active: boolean;
};

// Parses a checklist_signature (see reportGeneration.ts's buildChecklistSignature)
// back into a single checklist id, when it unambiguously names exactly one --
// null for legacy/backfill reports (no checklist at all) or the rare
// multi-checklist combined-report case. Used only to look up that checklist's
// attempt_number for display in the delete-confirmation modal; the deletion
// RPC (food_safety_delete_report, migration 0102) does its own, authoritative
// parsing in SQL and is not affected by anything here.
function deriveSingleChecklistId(signature: string | null): string | null {
  if (!signature || signature.startsWith("legacy:") || signature.startsWith("backfill:")) return null;
  const ids = signature.split("|");
  return ids.length === 1 ? ids[0] : null;
}

const reportsRouter = Router();

// Mobile-only users (mobile:food_safety without the desktop food_safety:view
// permission) must not reach these routes — reuses the exact same desktop
// view gate as cleaning-locations.
const canView = requireAnyPermission(["food_safety:view", "food_safety:edit"]);
const canDeleteReports = requirePermission("food_safety:delete_reports");

reportsRouter.get("/food-safety/reports", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const locationIdParam = typeof req.query.location_id === "string" ? req.query.location_id.trim() : "";
  const startDateParam = isIsoDate(req.query.start_date) ? req.query.start_date : null;
  const endDateParam = isIsoDate(req.query.end_date) ? req.query.end_date : null;
  // Both ends of the range are required together — a single stray param is
  // treated as no filter rather than guessing an open-ended bound.
  const dateRange = startDateParam && endDateParam ? dateRangeToUtcBounds(startDateParam, endDateParam) : null;
  // The location-picker list page only needs card summary fields, not every
  // report/item/column for every location — skips that work entirely rather
  // than fetching and discarding it.
  const summaryOnly = req.query.summary === "1" || req.query.summary === "true";

  // Deactivated (soft-deleted) locations are intentionally NOT filtered out
  // here — their historical reports must stay reachable. A deactivated
  // location is only dropped from the response below if it also has zero
  // reports (nothing to show); active locations are always included
  // regardless of report count.
  let locationsQuery = supabase
    .from("food_safety_cleaning_locations")
    .select("id, name, area, notes, is_active")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (locationIdParam) {
    locationsQuery = locationsQuery.eq("id", locationIdParam);
  }

  const { data: locations, error: locationsError } = await locationsQuery;

  if (locationsError) {
    return sendSafeError(res, 500, "Failed to load locations.", "Reports locations fetch error:", locationsError);
  }

  try {
    const cards = await Promise.all(
      ((locations ?? []) as LocationRow[]).map(async (location) => {
        // completed_at alone is not a unique key -- a location can now have
        // more than one report on the same day (see "Complete Another
        // Report"), and two attempts could in principle even share the same
        // completed_at down to the stored precision. created_at (real
        // insertion order) and id are added as tiebreakers purely so ORDER BY
        // is fully deterministic; they never change the primary, meaningful
        // sort by completed_at.
        let recentQuery = supabase
          .from("food_safety_cleaning_reports")
          .select("id, completed_at, completed_by_name, completed_by_initials, checklist_signature")
          .eq("organization_id", organizationId)
          .eq("location_id", location.id)
          .order("completed_at", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

        if (summaryOnly) {
          // Only the single most recent report is needed for the card.
          recentQuery = recentQuery.limit(1);
        } else {
          // A date range is an explicit request to see (and print) further
          // back than the default recent window, so it deliberately removes
          // the cap rather than layering a limit on top of it.
          recentQuery = dateRange
            ? recentQuery.gte("completed_at", dateRange.startUtc).lt("completed_at", dateRange.endUtcExclusive)
            : recentQuery.limit(RECENT_REPORTS_LIMIT);
        }

        const [countResult, recentResult] = await Promise.all([
          supabase
            .from("food_safety_cleaning_reports")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", organizationId)
            .eq("location_id", location.id),
          recentQuery
        ]);

        if (countResult.error) throw new Error(countResult.error.message);
        if (recentResult.error) throw new Error(recentResult.error.message);

        const reports = (recentResult.data ?? []) as (ReportRow & { checklist_signature: string | null })[];

        if (summaryOnly) {
          const mostRecent = reports[0] ?? null;
          return {
            id: location.id,
            name: location.name,
            area: location.area,
            notes: location.notes,
            isActive: location.is_active,
            totalReports: countResult.count ?? 0,
            mostRecentCompletedAt: mostRecent?.completed_at ?? null,
            mostRecentCompletedByInitials: mostRecent?.completed_by_initials ?? null,
            taskColumns: [],
            reports: []
          };
        }

        const { data: tasksData, error: tasksError } = await supabase
          .from("food_safety_cleaning_tasks")
          .select("name, sort_order, action_labels")
          .eq("organization_id", organizationId)
          .eq("location_id", location.id);

        if (tasksError) throw new Error(tasksError.message);
        const tasksResult = { data: tasksData };
        const reportIds = reports.map((r) => r.id);

        let items: ReportItemRow[] = [];
        if (reportIds.length > 0) {
          const { data: itemsData, error: itemsError } = await supabase
            .from("food_safety_cleaning_report_items")
            .select("report_id, task_name_snapshot, action_label_snapshot, response_type_snapshot, response_value, sort_order")
            .eq("organization_id", organizationId)
            .in("report_id", reportIds);

          if (itemsError) throw new Error(itemsError.message);
          items = (itemsData ?? []) as ReportItemRow[];
        }

        const { taskColumns, reports: reportsWithValues } = buildTaskColumnsAndValues(
          reports,
          items,
          (tasksResult.data ?? []) as TaskRow[]
        );

        // Attempt number, for the delete-confirmation modal ("if available").
        // Looked up separately (not carried through buildTaskColumnsAndValues,
        // which is a shared report-card utility with no concept of attempts)
        // by resolving each report's checklist_signature back to a single
        // checklist id and batching one query for the whole page.
        const checklistIdByReportId = new Map<string, string>();
        for (const report of reports) {
          const checklistId = deriveSingleChecklistId(report.checklist_signature);
          if (checklistId) checklistIdByReportId.set(report.id, checklistId);
        }

        const attemptNumberByReportId = new Map<string, number>();
        const checklistIdsToLookup = Array.from(new Set(checklistIdByReportId.values()));
        if (checklistIdsToLookup.length > 0) {
          const { data: checklistRows, error: checklistLookupError } = await supabase
            .from("food_safety_cleaning_checklists")
            .select("id, attempt_number")
            .eq("organization_id", organizationId)
            .in("id", checklistIdsToLookup);

          if (checklistLookupError) throw new Error(checklistLookupError.message);

          const attemptNumberByChecklistId = new Map(
            (checklistRows ?? []).map((row) => [row.id as string, row.attempt_number as number])
          );
          for (const [reportId, checklistId] of checklistIdByReportId) {
            const attemptNumber = attemptNumberByChecklistId.get(checklistId);
            if (attemptNumber !== undefined) attemptNumberByReportId.set(reportId, attemptNumber);
          }
        }

        const reportsWithAttempt = reportsWithValues.map((report) => ({
          ...report,
          attemptNumber: attemptNumberByReportId.get(report.id) ?? null
        }));

        const mostRecent = reports[0] ?? null;

        return {
          id: location.id,
          name: location.name,
          area: location.area,
          notes: location.notes,
          isActive: location.is_active,
          totalReports: countResult.count ?? 0,
          mostRecentCompletedAt: mostRecent?.completed_at ?? null,
          mostRecentCompletedByInitials: mostRecent?.completed_by_initials ?? null,
          taskColumns,
          reports: reportsWithAttempt
        };
      })
    );

    // A deactivated location only stays visible here if it has report
    // history to show; one with none is gone from every list (active
    // locations are always kept regardless of report count).
    const visibleCards = cards.filter((card) => card.isActive || card.totalReports > 0);

    return res.json({ locations: visibleCards });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load cleaning reports.", "Reports fetch error:", error);
  }
});

const MIN_DELETION_REASON_LENGTH = 5;

// Controlled, audited deletion of a single report — the only way a Food
// Safety report is ever removed (see food_safety_delete_report, migration
// 0102). Gated by a permission dedicated to this action, never bundled with
// food_safety:edit — a normal editor must not be able to delete records.
reportsRouter.delete("/food-safety/reports/:reportId", canDeleteReports, async (req, res) => {
  const organizationId = req.organizationId;
  const reportId = String(req.params.reportId);
  const rawReason = (req.body as Record<string, unknown> | undefined)?.reason;

  const reason = typeof rawReason === "string" ? rawReason : "";
  if (reason.trim().length < MIN_DELETION_REASON_LENGTH) {
    return res.status(400).json({ message: `A deletion reason of at least ${MIN_DELETION_REASON_LENGTH} characters is required.` });
  }

  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ message: "Authentication is required." });
  }

  let deletedByName: string;
  let deletedByEmail: string | null;
  try {
    const [actor, userResult] = await Promise.all([resolveActor(userId), supabase.auth.admin.getUserById(userId)]);
    deletedByName = actor.name;
    deletedByEmail = userResult.data?.user?.email ?? null;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Report deletion actor resolution error:", error);
  }

  const { error: rpcError } = await supabase.rpc("food_safety_delete_report", {
    p_organization_id: organizationId,
    p_report_id: reportId,
    p_deleted_by_user_id: userId,
    p_deleted_by_email: deletedByEmail ?? deletedByName,
    p_deletion_reason: reason.trim()
  });

  if (rpcError) {
    if (rpcError.code === "P0002") {
      return res.status(404).json({ message: "This report could not be found." });
    }
    if (rpcError.code === "GL010") {
      return res.status(400).json({ message: "A valid deletion reason is required." });
    }
    if (rpcError.code === "GL011") {
      return res.status(409).json({ message: rpcError.message || "This report could not be safely deleted right now. Try again." });
    }
    return sendSafeError(res, 500, "Failed to delete this report.", "Report deletion error:", rpcError);
  }

  return res.status(204).send();
});

export { reportsRouter };
