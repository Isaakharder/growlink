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

// The set of checklists for one location whose period_key matches *today's*
// period for their own period_type — i.e. the ones actually due right now,
// across every frequency the location currently has tasks for. Shared by
// report generation and the "Complete Location" endpoint so both agree on
// exactly which checklists a single completion action covers.
export async function getCurrentChecklistsForLocation(
  organizationId: string,
  locationId: string
): Promise<CurrentChecklistRow[]> {
  const now = new Date();
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
