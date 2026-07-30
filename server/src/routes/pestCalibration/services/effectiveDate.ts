// Validates the "performed date" (effectiveDate) a mobile employee may pick
// via the long-press backdating control on the Calibration completion page.
// Deliberately mirrors server/src/routes/foodSafety/services/reportDate.ts
// almost exactly — that module already solved this same problem (strict
// YYYY-MM-DD parsing, timezone-safe day-index arithmetic, a 300-day
// backdate window) for Food Safety's own long-press date selector, and
// there's no reason for Calibration to invent a second implementation of
// the same rules.
import { DEFAULT_ORG_TIMEZONE } from "../../../config/orgTimezone";
import { todayInOrgTimezone } from "../../foodSafety/services/checklistPeriod";
import { dateToDayIndex } from "../../foodSafety/services/backfillGeneration";
import { zonedTimeToUtc } from "../../../utils/zonedTime";

// How far back a mobile employee may backdate a calibration completion —
// see the long-press date selector on MobilePestCalibrationDeviceCompletePage.tsx.
export const MAX_BACKDATE_DAYS = 300;

export type ValidatedEffectiveDate = {
  // The requested date, "YYYY-MM-DD", in the organization's timezone.
  dateStr: string;
  // A safe Date instance (noon on dateStr, in the org timezone) for feeding
  // into due-date calculations. Noon avoids any ambiguity near a DST
  // transition's midnight boundary.
  referenceDate: Date;
  // True when dateStr differs from today's date in the org timezone.
  isBackdated: boolean;
};

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Never trusts the client's own notion of "today" or "how far back" — always
// re-derived server-side from the organization timezone. Throws a plain
// Error with a client-safe message on any violation.
export function validateEffectiveDate(raw: unknown, timeZone: string = DEFAULT_ORG_TIMEZONE): ValidatedEffectiveDate {
  if (!isIsoDate(raw)) {
    throw new Error("Calibration date must be a valid date.");
  }

  const today = todayInOrgTimezone(timeZone);
  const diffDays = dateToDayIndex(today) - dateToDayIndex(raw);

  if (diffDays < 0) {
    throw new Error("Calibration date cannot be in the future.");
  }
  if (diffDays > MAX_BACKDATE_DAYS) {
    throw new Error(`Calibration date cannot be more than ${MAX_BACKDATE_DAYS} days in the past.`);
  }

  const [year, month, day] = raw.split("-").map(Number);
  const referenceDate = zonedTimeToUtc(year, month, day, 12, 0, timeZone);

  return { dateStr: raw, referenceDate, isBackdated: raw !== today };
}
