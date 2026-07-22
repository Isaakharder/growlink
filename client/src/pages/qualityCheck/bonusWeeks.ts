import { BonusEntry, CheckType } from "./BonusesTab";

// Pure date/grouping helpers shared by the on-screen Bonus History table and
// the printed statements. Weeks are Sunday–Saturday, matching the payroll
// system's own reporting periods (its PDF exports use a "Period: <Sun> -
// <Sat>" header) — not the ISO 8601 Monday-start convention, and not labeled
// with an ISO week number since that wouldn't be accurate for a Sun-start
// week. Every entry's entry_date is bucketed into the week that contains it.

export function getWeekStartISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay(); // Sun=0 .. Sat=6
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

export function getWeekEndISO(weekStartIso: string): string {
  const [y, m, d] = weekStartIso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

function fmtShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtFull(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatWeekRangeLabel(weekStartIso: string): string {
  const end = getWeekEndISO(weekStartIso);
  const startYear = weekStartIso.slice(0, 4);
  const endYear = end.slice(0, 4);
  if (startYear === endYear) return `${fmtShort(weekStartIso)} – ${fmtShort(end)}, ${startYear}`;
  return `${fmtFull(weekStartIso)} – ${fmtFull(end)}`;
}

export function formatWeekLabel(weekStartIso: string): string {
  return formatWeekRangeLabel(weekStartIso);
}

export function buildDateRangeLabel(start: string, end: string): string {
  if (!start && !end) return "All dates";
  if (start && end) return `${fmtFull(start)} – ${fmtFull(end)}`;
  if (start) return `From ${fmtFull(start)}`;
  return `Through ${fmtFull(end)}`;
}

// Guards against floating-point sums like 25.42 + 5.8 displaying as
// 31.220000000000002 anywhere hours/bonus totals are rendered.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildJobFilterLabel(job: string): string {
  if (job === "picking_peppers") return "Picking";
  if (job === "winding_pruning") return "Winding/Pruning";
  return "All Jobs";
}

// One combined line per employee + week + job. Most weeks will contain a
// single saved record (the entry form now captures one week at a time), but
// this still safely combines any legacy/duplicate same-week records instead
// of listing them as separate rows.
export type BonusWeekGroup = {
  key: string;
  employeeId: string;
  employeeName: string;
  checkType: CheckType;
  weekStart: string;
  weekEnd: string;
  speedUnit: string;
  entries: BonusEntry[];
  totalHours: number;
  totalBonus: number;
  avgSpeed: number;
  blendedRate: number;
  thresholdLabel: string;
};

export function groupByEmployeeWeek(entries: BonusEntry[]): BonusWeekGroup[] {
  const byKey = new Map<string, BonusEntry[]>();
  for (const entry of entries) {
    const weekStart = getWeekStartISO(entry.entry_date);
    const key = `${entry.employee_id}|${weekStart}|${entry.check_type}`;
    const list = byKey.get(key) ?? [];
    list.push(entry);
    byKey.set(key, list);
  }

  const groups: BonusWeekGroup[] = [];
  for (const [key, list] of byKey.entries()) {
    const sorted = [...list].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
    const weekStart = getWeekStartISO(sorted[0].entry_date);
    const totalHours = round2(sorted.reduce((s, e) => s + e.hours_worked, 0));
    const totalBonus = round2(sorted.reduce((s, e) => s + e.total_bonus, 0));
    const avgSpeed = round2(
      totalHours > 0
        ? sorted.reduce((s, e) => s + e.entered_speed * e.hours_worked, 0) / totalHours
        : sorted.reduce((s, e) => s + e.entered_speed, 0) / sorted.length
    );
    const blendedRate = round2(totalHours > 0 ? totalBonus / totalHours : 0);
    const thresholds = new Set(sorted.map((e) => e.applied_threshold));
    const thresholdLabel =
      thresholds.size === 1
        ? sorted[0].applied_threshold !== null
          ? `${sorted[0].applied_threshold} ${sorted[0].speed_unit}`
          : "Below minimum"
        : "Multiple tiers";

    groups.push({
      key,
      employeeId: sorted[0].employee_id,
      employeeName: sorted[0].employee_name,
      checkType: sorted[0].check_type,
      weekStart,
      weekEnd: getWeekEndISO(weekStart),
      speedUnit: sorted[0].speed_unit,
      entries: sorted,
      totalHours,
      totalBonus,
      avgSpeed,
      blendedRate,
      thresholdLabel
    });
  }

  groups.sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.employeeName.localeCompare(b.employeeName));
  return groups;
}

// Per-employee page grouping for the printed statement: each employee's
// weeks sorted oldest-first (natural statement reading order), employees
// sorted alphabetically.
export type BonusPrintEmployeeGroup = {
  employeeId: string;
  employeeName: string;
  weeks: BonusWeekGroup[];
  totalHours: number;
  totalQualifyingHours: number;
  totalBonus: number;
};

export function buildPrintGroups(entries: BonusEntry[]): BonusPrintEmployeeGroup[] {
  const weekGroups = groupByEmployeeWeek(entries);

  const byEmployee = new Map<string, BonusWeekGroup[]>();
  for (const group of weekGroups) {
    const list = byEmployee.get(group.employeeId) ?? [];
    list.push(group);
    byEmployee.set(group.employeeId, list);
  }

  const result: BonusPrintEmployeeGroup[] = [];
  for (const [employeeId, weeks] of byEmployee.entries()) {
    const sortedWeeks = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const totalHours = round2(sortedWeeks.reduce((s, w) => s + w.totalHours, 0));
    const totalBonus = round2(sortedWeeks.reduce((s, w) => s + w.totalBonus, 0));
    const totalQualifyingHours = round2(
      sortedWeeks.reduce(
        (s, w) => s + w.entries.filter((e) => e.applied_rate > 0).reduce((s2, e) => s2 + e.hours_worked, 0),
        0
      )
    );
    result.push({
      employeeId,
      employeeName: sortedWeeks[0].employeeName,
      weeks: sortedWeeks,
      totalHours,
      totalQualifyingHours,
      totalBonus
    });
  }

  result.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  return result;
}
