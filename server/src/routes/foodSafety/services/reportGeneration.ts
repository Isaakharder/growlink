import { supabase } from "../../../config/supabase";
import { getCurrentChecklistsForLocation } from "./currentChecklists";
import { computePeriodKey, todayInOrgTimezone, type ChecklistPeriodType } from "./checklistPeriod";
import { DEFAULT_ORG_TIMEZONE } from "../../../config/orgTimezone";
import { getZonedParts, zonedTimeToUtc } from "../../../utils/zonedTime";

type ItemRow = {
  checklist_id: string;
  task_name_snapshot: string;
  frequency_snapshot: ChecklistPeriodType;
  response_type_snapshot: string;
  action_label_snapshot: string | null;
  response_value: string | null;
  sort_order: number;
  checked_at: string | null;
  checked_by_user_id: string | null;
  checked_by_name: string | null;
  checked_by_initials: string | null;
};

// Deterministic identity for "the exact set of checklist attempts that
// produced this report" -- the upsert conflict target for report creation
// (see maybeCreateReport below). Sorted so the same set of checklists always
// produces the same signature regardless of query ordering. Exported so it
// can be unit-tested without a live database.
export function buildChecklistSignature(checklistIds: string[]): string {
  return [...checklistIds].sort().join("|");
}

// Called after "Complete Location" succeeds. If the location's entire
// current-period set of checklists (across every frequency currently in use
// there) is now complete, creates one immutable report row plus its task
// snapshots. Safe to call unconditionally and repeatedly: a unique
// constraint on (location_id, checklist_signature) -- the exact set of
// checklist ids that produced this report, not the date -- makes the report
// insert idempotent per attempt, and this is a no-op whenever the location
// isn't fully complete. Because the key is per-attempt rather than per-day,
// a second (or third) "Complete Another Report" attempt for the same
// location/date always produces its own independent report row. Never
// throws — a failure here must never break the complete-location response
// it runs alongside.
//
// referenceDate, when given, is the mobile long-press date selector's chosen
// report date (see MobileFoodSafetyLocationPage.tsx / reportDate.ts) — undefined
// means "today", the ordinary live-completion case, and changes nothing below.
// When it names a different calendar day than today (org timezone), the
// report is being backdated: completed_at is set to that selected day (at
// the real current time-of-day) so the report reads as belonging to the day
// it's FOR, while generated_at/generated_by_user_id separately preserve the
// real moment and actor of this actual submission — the same
// report-date-vs-actual-submission split migration 0095 already established
// for admin backfills, just with a real (not random) time-of-day since a
// genuine completion event just happened. Nothing is faked: completed_at
// truthfully reads as "this day, around this time", and generated_at
// truthfully preserves exactly when the submission really occurred.
export async function maybeCreateReport(
  organizationId: string,
  locationId: string,
  referenceDate?: Date
): Promise<void> {
  try {
    const { data: location, error: locationError } = await supabase
      .from("food_safety_cleaning_locations")
      .select("id, name, area")
      .eq("id", locationId)
      .eq("organization_id", organizationId)
      .single();

    if (locationError || !location) return;

    const currentChecklists = await getCurrentChecklistsForLocation(organizationId, locationId, referenceDate);

    // No currently-due checklists, or at least one still incomplete — the
    // location isn't fully done yet, nothing to report.
    if (currentChecklists.length === 0) return;
    if (!currentChecklists.every((c) => c.status === "complete")) return;

    const periodSignature = currentChecklists
      .map((c) => `${c.period_type}:${c.period_key}`)
      .sort()
      .join("|");

    const lastCompleted = [...currentChecklists].sort((a, b) =>
      (b.completed_at ?? "").localeCompare(a.completed_at ?? "")
    )[0];

    const { data: items, error: itemsError } = await supabase
      .from("food_safety_cleaning_checklist_items")
      .select(
        "checklist_id, task_name_snapshot, frequency_snapshot, response_type_snapshot, action_label_snapshot, response_value, sort_order, checked_at, checked_by_user_id, checked_by_name, checked_by_initials"
      )
      .eq("organization_id", organizationId)
      .in(
        "checklist_id",
        currentChecklists.map((c) => c.id)
      );

    if (itemsError || !items) return;

    let completedAt = lastCompleted?.completed_at ?? new Date().toISOString();
    let generatedAt: string | null = null;
    let generatedByUserId: string | null = null;

    if (referenceDate) {
      const targetDailyKey = computePeriodKey("daily", referenceDate, DEFAULT_ORG_TIMEZONE);
      if (targetDailyKey !== todayInOrgTimezone(DEFAULT_ORG_TIMEZONE)) {
        const realNow = getZonedParts(new Date(), DEFAULT_ORG_TIMEZONE);
        const [year, month, day] = targetDailyKey.split("-").map(Number);
        completedAt = zonedTimeToUtc(year, month, day, realNow.hour, realNow.minute, DEFAULT_ORG_TIMEZONE).toISOString();
        generatedAt = new Date().toISOString();
        generatedByUserId = lastCompleted?.completed_by_user_id ?? null;
      }
    }

    const checklistSignature = buildChecklistSignature(currentChecklists.map((c) => c.id));

    const { data: insertedReports, error: reportError } = await supabase
      .from("food_safety_cleaning_reports")
      .upsert(
        {
          organization_id: organizationId,
          location_id: locationId,
          location_name_snapshot: location.name,
          location_area_snapshot: location.area,
          period_signature: periodSignature,
          checklist_signature: checklistSignature,
          task_count: items.length,
          completed_at: completedAt,
          completed_by_user_id: lastCompleted?.completed_by_user_id ?? null,
          completed_by_name: lastCompleted?.completed_by_name ?? "Unknown",
          completed_by_initials: lastCompleted?.completed_by_initials ?? "—",
          generated_at: generatedAt,
          generated_by_user_id: generatedByUserId
        },
        { onConflict: "location_id,checklist_signature", ignoreDuplicates: true }
      )
      .select("id");

    if (reportError) {
      console.error("Food Safety report insert error:", reportError);
      return;
    }

    // Empty result means the row already existed (ignoreDuplicates hit the
    // unique constraint) — another call already created this report.
    if (!insertedReports || insertedReports.length === 0) return;

    const reportId = insertedReports[0].id;

    const { error: itemsInsertError } = await supabase.from("food_safety_cleaning_report_items").insert(
      (items as ItemRow[])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => ({
          organization_id: organizationId,
          report_id: reportId,
          task_name_snapshot: item.task_name_snapshot,
          frequency_snapshot: item.frequency_snapshot,
          response_type_snapshot: item.response_type_snapshot,
          action_label_snapshot: item.action_label_snapshot,
          response_value: item.response_value,
          sort_order: item.sort_order,
          checked_at: item.checked_at,
          checked_by_user_id: item.checked_by_user_id,
          checked_by_name: item.checked_by_name,
          checked_by_initials: item.checked_by_initials
        }))
    );

    if (itemsInsertError) {
      console.error("Food Safety report items insert error:", itemsInsertError);
    }
  } catch (error) {
    console.error("Food Safety report generation error:", error);
  }
}
