// "Weekly kg by Variety" (Kg Entries tab): one table built from the server's
// complete read of a year (GET /api/yield-entries/weekly-by-variety), shared
// by the card, the CSV and the PDF so all three show the same weeks,
// columns, values and rounding. Totals are summed from full-precision kg;
// values are rounded to one decimal only when formatted.

export const WEEKLY_KG_BY_VARIETY_URL = "/api/yield-entries/weekly-by-variety";

export type WeeklyKgByVarietySource = {
  year: number | null;
  years: number[];
  entryCount: number;
  varieties: Array<{ id: string; name: string; status: string | null }>;
  entries: Array<{ variety_id: string; week: number; total_kg: number }>;
};

/**
 * The response, checked before use: an unexpected body (an error page, an
 * older server) or one whose entries don't match its own count is rejected
 * rather than shown as a season total.
 */
export function parseWeeklyKgSource(body: unknown): WeeklyKgByVarietySource {
  const b = body as Partial<WeeklyKgByVarietySource> | null;
  const isInt = (v: unknown) => Number.isInteger(v);
  const valid =
    !!b &&
    typeof b === "object" &&
    !Array.isArray(b) &&
    (b.year === null || isInt(b.year)) &&
    Array.isArray(b.years) &&
    b.years.every(isInt) &&
    Array.isArray(b.varieties) &&
    b.varieties.every((v) => v && typeof v.id === "string" && typeof v.name === "string") &&
    Array.isArray(b.entries) &&
    b.entries.every((e) => e && typeof e.variety_id === "string" && isInt(e.week) && Number.isFinite(Number(e.total_kg))) &&
    b.entryCount === b.entries.length;
  if (!valid) throw new Error("Weekly kg by variety came back incomplete");
  return b as WeeklyKgByVarietySource;
}

export type WeeklyKgColumn = { id: string; name: string; inactive: boolean; label: string };

export type WeeklyKgTable = {
  year: number;
  columns: WeeklyKgColumn[];
  /** Every week from the first to the last recorded week, including weeks with no entries. */
  rows: Array<{ week: number; cells: Array<number | null>; total: number | null }>;
  /** Per column, in column order. */
  seasonTotals: number[];
  seasonTotal: number;
  entryCount: number;
};

/**
 * The table for the source's year, or null when the year has no entries.
 * Entries are grouped by variety id (never by name) and summed once per
 * variety and week; a recorded 0 kg is kept as 0, a week with no entry is null.
 */
export function buildWeeklyKgTable(source: WeeklyKgByVarietySource): WeeklyKgTable | null {
  if (source.year === null || source.entries.length === 0) return null;

  const byVariety = new Map<string, Map<number, number>>();
  let minWeek = Infinity;
  let maxWeek = -Infinity;
  for (const entry of source.entries) {
    const kg = Number(entry.total_kg);
    const week = Number(entry.week);
    if (!Number.isInteger(week) || !Number.isFinite(kg)) {
      throw new Error(`Unreadable entry for variety ${entry.variety_id}`);
    }
    const weeks = byVariety.get(entry.variety_id) ?? new Map<number, number>();
    weeks.set(week, (weeks.get(week) ?? 0) + kg);
    byVariety.set(entry.variety_id, weeks);
    minWeek = Math.min(minWeek, week);
    maxWeek = Math.max(maxWeek, week);
  }

  const info = new Map(source.varieties.map((v) => [v.id, v]));
  const ordered = [...byVariety.keys()]
    .map((id) => ({ id, name: info.get(id)?.name ?? "Unknown variety", inactive: info.get(id)?.status === "inactive" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  // Varieties are grouped by id, so two can share a name: keep their headers distinct.
  const seen = new Map<string, number>();
  const columns: WeeklyKgColumn[] = ordered.map((v) => {
    const base = v.inactive ? `${v.name} (inactive)` : v.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...v, label: n === 1 ? base : `${base} (${n})` };
  });

  const rows: WeeklyKgTable["rows"] = [];
  for (let week = minWeek; week <= maxWeek; week += 1) {
    const cells = columns.map((c) => byVariety.get(c.id)!.get(week) ?? null);
    const recorded = cells.filter((c): c is number => c !== null);
    rows.push({ week, cells, total: recorded.length ? recorded.reduce((s, v) => s + v, 0) : null });
  }
  const seasonTotals = columns.map((c) => [...byVariety.get(c.id)!.values()].reduce((s, v) => s + v, 0));

  return {
    year: source.year,
    columns,
    rows,
    seasonTotals,
    seasonTotal: seasonTotals.reduce((s, v) => s + v, 0),
    entryCount: source.entryCount
  };
}

/** The one rounding step every view uses: kg to one decimal, half away from zero. */
export function roundKg1(kg: number): number {
  const rounded = Math.round((Math.abs(kg) + Number.EPSILON) * 10) / 10;
  return rounded === 0 ? 0 : Math.sign(kg) * rounded;
}

/** "12,345.6" — thousands separators, one decimal; "—" for no entry. */
export function formatKgCell(kg: number | null): string {
  if (kg === null) return "—";
  return roundKg1(kg).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** "12345.6" — plain number for CSV; "" for no entry. */
export function csvKgValue(kg: number | null): string {
  return kg === null ? "" : roundKg1(kg).toFixed(1);
}

export const weekLabel = (week: number) => `Week ${week}`;

/** Header row shared by the card, CSV and PDF. */
export function tableHeader(table: WeeklyKgTable): string[] {
  return ["Week", ...table.columns.map((c) => c.label), "Weekly total"];
}

/** The full table as display strings, header excluded: one row per week, then Season total. */
export function displayMatrix(table: WeeklyKgTable): { body: string[][]; foot: string[] } {
  return {
    body: table.rows.map((r) => [weekLabel(r.week), ...r.cells.map(formatKgCell), formatKgCell(r.total)]),
    foot: ["Season total", ...table.seasonTotals.map(formatKgCell), formatKgCell(table.seasonTotal)]
  };
}

function csvField(value: string): string {
  // Text that a spreadsheet would run as a formula is prefixed with '.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV (CRLF, UTF-8 BOM for Excel): week numbers, kg as plain one-decimal numbers. */
export function weeklyKgCsv(table: WeeklyKgTable): string {
  const lines = [
    tableHeader(table),
    ...table.rows.map((r) => [String(r.week), ...r.cells.map(csvKgValue), csvKgValue(r.total)]),
    ["Season total", ...table.seasonTotals.map(csvKgValue), csvKgValue(table.seasonTotal)]
  ];
  return "\uFEFF" + lines.map((line) => line.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export const weeklyKgFileBase = (year: number) => `weekly-kg-by-variety-${year}`;
