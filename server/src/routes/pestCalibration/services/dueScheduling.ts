import { getZonedParts, zonedTimeToUtc } from "../../../utils/zonedTime";
import { DEFAULT_ORG_TIMEZONE } from "../../../config/orgTimezone";
import { FrequencyType, CustomIntervalUnit } from "./types";

export type DueStatus = "on_demand" | "overdue" | "due_soon" | "ok";

const DUE_SOON_WINDOW_DAYS = 7; // placeholder default, not yet org-configurable

function daysInMonth(year: number, month1To12: number): number {
  // Day 0 of the *next* month is the last day of the target month.
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

// Adds `days` to a civil (calendar) date, letting native Date normalize
// month/year rollover (e.g. day 32 of a 31-day month becomes day 1/2 of the
// next month automatically). Pure calendar arithmetic — no timezone
// involved at this step, since the caller already has the zoned civil parts.
function addCalendarDays(
  year: number, month1To12: number, day: number, days: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month1To12 - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Adds `months` calendar months to a zoned civil date, clamping the day to
// the target month's length (e.g. Jan 31 + 1 month => Feb 28, not a
// rollover into March). Native JS `Date` arithmetic does not do this
// clamp on its own — Date.UTC(y, m + n, d) silently overflows instead.
function addCalendarMonths(
  year: number, month1To12: number, day: number, months: number
): { year: number; month: number; day: number } {
  const totalMonths = (year * 12 + (month1To12 - 1)) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth1To12 = (totalMonths % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth1To12));
  return { year: targetYear, month: targetMonth1To12, day: clampedDay };
}

/**
 * Computes the next calibration due date from a completion instant, a
 * device's configured frequency, and (for `custom`) its interval value/unit.
 * Always computed in the organization's timezone so "add 1 day/month" means
 * a calendar day/month on the org's wall clock, not a fixed number of UTC
 * milliseconds — every branch below reconstructs the result via
 * zonedTimeToUtc so the wall-clock hour:minute is preserved across a DST
 * transition (a plain `completedAt.getTime() + N*86400000` would instead
 * silently shift the wall-clock time by an hour whenever the interval
 * crosses a spring-forward/fall-back boundary).
 * Returns null for `on_demand` devices — they never have a next due date.
 */
export function addCalibrationInterval(
  completedAt: Date,
  frequencyType: FrequencyType,
  customIntervalValue: number | null,
  customIntervalUnit: CustomIntervalUnit | null,
  timeZone: string = DEFAULT_ORG_TIMEZONE
): Date | null {
  if (frequencyType === "on_demand") return null;

  const parts = getZonedParts(completedAt, timeZone);

  function withDays(days: number): Date {
    const target = addCalendarDays(parts.year, parts.month, parts.day, days);
    return zonedTimeToUtc(target.year, target.month, target.day, parts.hour, parts.minute, timeZone);
  }

  function withMonths(months: number): Date {
    const target = addCalendarMonths(parts.year, parts.month, parts.day, months);
    return zonedTimeToUtc(target.year, target.month, target.day, parts.hour, parts.minute, timeZone);
  }

  if (frequencyType === "daily") return withDays(1);
  if (frequencyType === "weekly") return withDays(7);
  if (frequencyType === "monthly") return withMonths(1);
  if (frequencyType === "quarterly") return withMonths(3);
  if (frequencyType === "annually") return withMonths(12);

  // custom
  const value = customIntervalValue ?? 0;
  if (customIntervalUnit === "days") return withDays(value);
  if (customIntervalUnit === "weeks") return withDays(value * 7);
  return withMonths(value); // "months"
}

export function computeDueStatus(nextDueAt: Date | null, now: Date = new Date()): DueStatus {
  if (!nextDueAt) return "on_demand";
  if (nextDueAt.getTime() < now.getTime()) return "overdue";
  const dueSoonThreshold = now.getTime() + DUE_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (nextDueAt.getTime() <= dueSoonThreshold) return "due_soon";
  return "ok";
}
