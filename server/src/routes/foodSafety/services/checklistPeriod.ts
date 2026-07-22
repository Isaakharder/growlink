import { DEFAULT_ORG_TIMEZONE } from "../../../config/orgTimezone";

export type ChecklistPeriodType = "daily" | "weekly" | "monthly" | "annually";

export const CHECKLIST_PERIOD_TYPES: ChecklistPeriodType[] = ["daily", "weekly", "monthly", "annually"];

type ZonedDateParts = { year: number; month: number; day: number };

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(lookup.year), month: Number(lookup.month), day: Number(lookup.day) };
}

// Same ISO-8601 week algorithm already used client-side (MobileQualityCheckPage),
// applied to the already-zoned civil date so it never re-introduces a shift.
function getIsoWeek(parts: ZonedDateParts): { isoYear: number; week: number } {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear: d.getUTCFullYear(), week };
}

export function computePeriodKey(
  periodType: ChecklistPeriodType,
  now: Date = new Date(),
  timeZone: string = DEFAULT_ORG_TIMEZONE
): string {
  const parts = getZonedDateParts(now, timeZone);

  switch (periodType) {
    case "daily":
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    case "weekly": {
      const { isoYear, week } = getIsoWeek(parts);
      return `${isoYear}-W${String(week).padStart(2, "0")}`;
    }
    case "monthly":
      return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    case "annually":
      return `${parts.year}`;
  }
}
