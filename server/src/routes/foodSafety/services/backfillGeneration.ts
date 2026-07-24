import { computePeriodKey } from "./checklistPeriod";
import { zonedTimeToUtc } from "../../../utils/zonedTime";

export type BackfillFrequency = "daily" | "weekly" | "monthly" | "annually";

export type BackfillTaskInput = {
  id: string;
  name: string;
  responseType: "checkbox" | "number" | "short_text" | "long_text";
  actionLabels: string[] | null;
  sortOrder: number;
};

export type BackfillColumn = {
  taskId: string;
  name: string;
  actionLabel: string | null;
  frequency: BackfillFrequency;
  responseType: BackfillTaskInput["responseType"];
  sortOrder: number;
};

export type GeneratedTaskResult = BackfillColumn & { checked: boolean };

export type GeneratedDay = {
  date: string;
  completedAtIso: string;
  results: GeneratedTaskResult[];
};

// One of three independent "expand tasks into columns" implementations in
// the Food Safety module -- each solves a different problem and is not a
// candidate for merging into one shared function:
//   - HERE: builds columns from a location's CURRENT live tasks, for
//     generating brand-new backfill reports. Key format: `${taskId}::${actionLabel ?? ""}`
//     (see columnKeyFor below) -- stable across calls because it's derived
//     from real IDs, not discovery order.
//   - client/src/pages/foodSafetySetup/LogsBackfillTab.tsx has its OWN
//     buildColumns()/columnKeyFor(), deliberately kept in sync with this
//     file's key format (also `taskId::actionLabel`) so the backfill preview
//     table's column keys line up with what /backfill/create actually saves.
//     It cannot import this module directly (client/server are separate
//     runtimes) -- if this file's key format ever changes, that file's copy
//     must change too, or the preview will silently show the wrong task
//     under the wrong column.
//   - server/src/utils/foodSafetyReportCard.ts builds columns from
//     HISTORICAL REPORT SNAPSHOTS (task_name_snapshot/action_label_snapshot)
//     for the Reports page, where the live task list may have since changed
//     or a task may have been deleted entirely -- it cannot key by live
//     taskId at all, so it discovers columns from the data itself and keys
//     them sequentially (`col_0`, `col_1`, ...). Not interchangeable with
//     this file's key format, and not reviewed by changes here.
//
// Mirrors the (sort_order * 100) + labelIndex scaling used by the real
// food_safety_get_or_create_checklist() function so column ordering here
// matches what the live app would have produced for the same tasks.
// frequency is a single value for every column — it belongs to the
// location, not the individual task.
export function buildColumns(tasks: BackfillTaskInput[], locationFrequency: BackfillFrequency): BackfillColumn[] {
  const columns: BackfillColumn[] = [];

  for (const task of [...tasks].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const labels = task.actionLabels && task.actionLabels.length > 0 ? task.actionLabels : [null];
    labels.forEach((label, index) => {
      columns.push({
        taskId: task.id,
        name: task.name,
        actionLabel: label,
        frequency: locationFrequency,
        responseType: task.responseType,
        sortOrder: task.sortOrder * 100 + index
      });
    });
  }

  return columns;
}

export function columnKeyFor(column: Pick<BackfillColumn, "taskId" | "actionLabel">): string {
  return `${column.taskId}::${column.actionLabel ?? ""}`;
}

function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// Epoch-day integer (days since 1970-01-01 UTC) — arithmetic on these is
// plain integer math, unlike comparing/subtracting ISO date strings.
export function dateToDayIndex(value: string): number {
  const { year, month, day } = parseIsoDate(value);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

// Inclusive day count between two YYYY-MM-DD dates (may be negative if end
// precedes start — callers validate that separately).
export function daysBetweenIsoInclusive(startDate: string, endDate: string): number {
  return dateToDayIndex(endDate) - dateToDayIndex(startDate) + 1;
}

export function parseTimeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time: ${value}`);
  }
  return hour * 60 + minute;
}

function pickRandomMinuteInWindow(earliestMinutes: number, latestMinutes: number): number {
  if (latestMinutes < earliestMinutes) {
    throw new Error("Latest completion time must be on or after the earliest completion time.");
  }
  const span = latestMinutes - earliestMinutes;
  return earliestMinutes + Math.floor(Math.random() * (span + 1));
}

// response_value semantics mirror food_safety_set_checklist_item_response():
// checkbox -> 'true'/null, everything else -> any non-empty string/null.
export function responseValueFor(responseType: BackfillTaskInput["responseType"], checked: boolean): string | null {
  if (!checked) return null;
  return responseType === "checkbox" ? "true" : "Backfilled";
}

export type BuildManualDaysParams = {
  uniqueDates: string[]; // sorted ascending; callers exclude already-existing dates before calling
  columns: BackfillColumn[];
  taskDatesByColumnKey: Map<string, Set<string>>;
  earliestMinutes: number;
  latestMinutes: number;
  timeZone: string;
};

// Builds one daily location record per unique manually-selected date —
// combining every task's independent date selections into that day's set of
// checked/unchecked task results, exactly as a real single completion of the
// location would look. The same random completion time is used for every
// task result inside a given day's report (one location visit, one time).
export function buildManualGeneratedDays(params: BuildManualDaysParams): GeneratedDay[] {
  const { uniqueDates, columns, taskDatesByColumnKey, earliestMinutes, latestMinutes, timeZone } = params;

  return uniqueDates.map((dateStr) => {
    const { year, month, day } = parseIsoDate(dateStr);
    const totalMinutes = pickRandomMinuteInWindow(earliestMinutes, latestMinutes);
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const completedAtIso = zonedTimeToUtc(year, month, day, hour, minute, timeZone).toISOString();

    const results: GeneratedTaskResult[] = columns.map((column) => {
      const key = columnKeyFor(column);
      const checked = taskDatesByColumnKey.get(key)?.has(dateStr) ?? false;
      return { ...column, checked };
    });

    return { date: dateStr, completedAtIso, results };
  });
}

// Buckets each existing report's completed_at into its organization-timezone
// civil date, so duplicate detection works the same regardless of whether
// the existing report came from a real mobile completion or an earlier
// backfill run — both are just "a completed report exists on this date".
export function datesFromCompletedAt(completedAtValues: string[], timeZone: string): Set<string> {
  const dates = new Set<string>();
  for (const value of completedAtValues) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    dates.add(computePeriodKey("daily", date, timeZone));
  }
  return dates;
}
