// ISO 8601 weeks (Monday start, week 1 contains 4 January), evaluated in UTC
// to match DockLink's pack export week rule.

export function isoWeekOf(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { isoYear, isoWeek: 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000)) };
}

export function isoWeekStartUtc(isoYear: number, isoWeek: number): Date {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  return new Date(Date.UTC(isoYear, 0, 4 - ((jan4.getUTCDay() + 6) % 7) + (isoWeek - 1) * 7));
}

export function isoWeeksInYear(isoYear: number): number {
  return isoWeekOf(new Date(Date.UTC(isoYear, 11, 28))).isoWeek;
}

export function shiftIsoWeek(isoYear: number, isoWeek: number, delta: number): { isoYear: number; isoWeek: number } {
  const start = isoWeekStartUtc(isoYear, isoWeek);
  return isoWeekOf(new Date(start.getTime() + delta * 7 * 86_400_000));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: Date) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/** "Mon 16 Nov – Sun 22 Nov 2026" (UTC; not locale-dependent). */
export function isoWeekRangeLabel(isoYear: number, isoWeek: number): string {
  const start = isoWeekStartUtc(isoYear, isoWeek);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return `${dayLabel(start)} – ${dayLabel(end)} ${end.getUTCFullYear()}`;
}
