import { supabase } from "../../../config/supabase";
import { computePeriodKey, type ChecklistPeriodType } from "./checklistPeriod";

export type CurrentChecklistRow = {
  id: string;
  period_type: ChecklistPeriodType;
  period_key: string;
  status: "incomplete" | "complete";
  completed_at: string | null;
  completed_by_user_id: string | null;
  completed_by_name: string | null;
  completed_by_initials: string | null;
};

// The set of checklists for one location whose period_key matches the given
// reference date's period for their own period_type — i.e. the ones due on
// that date, across every frequency the location currently has tasks for.
// Defaults to "now" (today), the normal live-completion case; the mobile
// long-press date selector passes a backdated referenceDate instead so a
// worker can retroactively fill out and complete a past day's checklist.
// Shared by report generation and the "Complete Location" endpoint so both
// agree on exactly which checklists a single completion action covers.
export async function getCurrentChecklistsForLocation(
  organizationId: string,
  locationId: string,
  referenceDate: Date = new Date()
): Promise<CurrentChecklistRow[]> {
  const now = referenceDate;
  const periodKeyByType: Record<ChecklistPeriodType, string> = {
    daily: computePeriodKey("daily", now),
    weekly: computePeriodKey("weekly", now),
    monthly: computePeriodKey("monthly", now),
    annually: computePeriodKey("annually", now)
  };

  const { data: checklists, error } = await supabase
    .from("food_safety_cleaning_checklists")
    .select(
      "id, period_type, period_key, status, completed_at, completed_by_user_id, completed_by_name, completed_by_initials"
    )
    .eq("organization_id", organizationId)
    .eq("location_id", locationId)
    .in("period_key", Array.from(new Set(Object.values(periodKeyByType))));

  if (error) {
    throw new Error(error.message);
  }

  return ((checklists ?? []) as CurrentChecklistRow[]).filter(
    (c) => c.period_key === periodKeyByType[c.period_type]
  );
}
