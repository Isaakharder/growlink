// Scheduled-maintenance due-date recurrence math.
//
// Mirrors this repo's existing convention (see
// pestCalibration/services/dueScheduling.ts) of computing dates in
// TypeScript and only ever storing already-computed values via the
// completion RPC — no date arithmetic happens in SQL.
//
// Two rules the product spec requires, both handled by computeNextOccurrence
// below with a single algorithm:
//   - Early/on-time completion must NOT drift the schedule: a monthly
//     schedule due Sep 30, completed Sep 28, is next due Oct 30 — not
//     Oct 28. This works because every occurrence is computed fresh from
//     the immutable anchor (first_due_date), never chained from the
//     previous occurrence's date.
//   - Late completion must advance to the next occurrence strictly after
//     the completion date, still computed from the same anchor (not from
//     the completion date itself).
//
// Postgres's own `date + interval '1 month'` semantics roll over (e.g.
// Jan 31 + 1 month = Mar 3) and are deliberately NOT used anywhere in this
// module — addCalendarMonthsClamped below always clamps the day to the
// target month's real length instead (Jan 31 -> Feb 28/29 -> Mar 31).

import { CalendarDate, RecurrenceType } from "./types";

const DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateString(value: string): CalendarDate {
  const match = DATE_STRING_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatDateString(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month1To12: number): number {
  // Day 0 of the *next* month is the last day of the target month.
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

function addCalendarDays(year: number, month1To12: number, day: number, days: number): CalendarDate {
  const d = new Date(Date.UTC(year, month1To12 - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addCalendarMonthsClamped(year: number, month1To12: number, day: number, months: number): CalendarDate {
  const totalMonths = year * 12 + (month1To12 - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  return { year: targetYear, month: targetMonth, day: Math.min(day, daysInMonth(targetYear, targetMonth)) };
}

function toSerial(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

/**
 * The k-th anchored occurrence of a recurring schedule (k=0 is
 * firstDueDate itself). Always computed fresh from the immutable anchor —
 * never chained from a previous occurrence, which is exactly what would
 * cause drift (chaining Jan31->Feb28->Mar28 would be wrong; re-anchoring
 * correctly gives Jan31->Feb28->Mar31).
 */
export function occurrenceDate(
  firstDueDate: CalendarDate,
  recurrenceType: Exclude<RecurrenceType, "one_time">,
  interval: number,
  k: number
): CalendarDate {
  if (recurrenceType === "daily") {
    return addCalendarDays(firstDueDate.year, firstDueDate.month, firstDueDate.day, k * interval);
  }
  if (recurrenceType === "weekly") {
    return addCalendarDays(firstDueDate.year, firstDueDate.month, firstDueDate.day, k * interval * 7);
  }
  const monthStep = recurrenceType === "yearly" ? interval * 12 : interval;
  return addCalendarMonthsClamped(firstDueDate.year, firstDueDate.month, firstDueDate.day, k * monthStep);
}

/**
 * Given the occurrence a schedule is currently sitting on (currentOccurrenceIndex,
 * whose date is occurrenceDate(..., currentOccurrenceIndex)) and the date it
 * was just completed on, returns the next occurrence index/date.
 *
 * - one_time: always advances to index+1 with no next due date (schedule
 *   is then deactivated by the caller/RPC).
 * - on-time or early completion: the while loop body never runs, so the
 *   result is simply occurrence (currentOccurrenceIndex + 1) — the next
 *   anchored date, un-drifted.
 * - late completion: the loop advances past every occurrence that would
 *   already be due by the completion date, landing on the first one
 *   strictly after it.
 *
 * Guarded at 10,000 iterations against a corrupted/zero interval slipping
 * past the DB's `recurrence_interval > 0` check constraint.
 */
export function computeNextOccurrence(
  firstDueDate: CalendarDate,
  recurrenceType: RecurrenceType,
  interval: number,
  currentOccurrenceIndex: number,
  completedAtDate: CalendarDate
): { nextOccurrenceIndex: number; nextDueDate: CalendarDate | null } {
  if (recurrenceType === "one_time") {
    return { nextOccurrenceIndex: currentOccurrenceIndex + 1, nextDueDate: null };
  }

  const completedSerial = toSerial(completedAtDate);

  let k = currentOccurrenceIndex;
  let candidate = occurrenceDate(firstDueDate, recurrenceType, interval, k + 1);
  let guard = 0;
  while (toSerial(candidate) <= completedSerial) {
    k += 1;
    candidate = occurrenceDate(firstDueDate, recurrenceType, interval, k + 1);
    guard += 1;
    if (guard > 10_000) {
      throw new Error("Could not compute the next due date — this schedule's interval looks invalid.");
    }
  }

  return { nextOccurrenceIndex: k + 1, nextDueDate: candidate };
}

export function compareDateStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDaysToDateString(dateStr: string, days: number): string {
  return formatDateString(addCalendarDays(
    parseDateString(dateStr).year, parseDateString(dateStr).month, parseDateString(dateStr).day, days
  ));
}
