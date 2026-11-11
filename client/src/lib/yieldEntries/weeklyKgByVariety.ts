// "Weekly kg by Variety" (Kg Entries tab): one table built from the server's
// complete read of a year (GET /api/yield-entries/weekly-by-variety), shared
// by the card, the CSV and the PDF so all three show the same weeks,
// columns, values and rounding. Totals are summed from full-precision kg;
// values are rounded to one decimal only when formatted.

export const WEEKLY_KG_BY_VARIETY_URL = "/api/yield-entries/weekly-by-variety";

/** The unit a table is in: kg, or whole pieces (a crop counted in pieces). Never both in one table. */
export type WeeklyUnit = "kg" | "pcs";

export type WeeklyKgByVarietySource = {
  year: number | null;
  years: number[];
  entryCount: number;
  varieties: Array<{ id: string; name: string; status: string | null; productCode?: string }>;
  /** kg entries; for a source narrowed to pieces (weeklyKgSourceForCrop), the piece counts. */
  entries: Array<{ variety_id: string; week: number; total_kg: number }>;
  /** Piece counts, from a server asked for ?units=all (migration 0151). */
  pieceEntryCount?: number;
  pieceEntries?: Array<{ variety_id: string; week: number; total_pieces: number }>;
  /** What entries are in; absent is kg. */
  unit?: WeeklyUnit;
};

/** The request for one year (or the latest), with piece counts alongside kg. */
export const weeklyByVarietyUrl = (year: number | null) =>
  year === null ? `${WEEKLY_KG_BY_VARIETY_URL}?units=all` : `${WEEKLY_KG_BY_VARIETY_URL}?year=${year}&units=all`;

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
    b.entryCount === b.entries.length &&
    (b.pieceEntries === undefined ||
      (Array.isArray(b.pieceEntries) &&
        b.pieceEntries.every((e) => e && typeof e.variety_id === "string" && isInt(e.week) && Number.isSafeInteger(Number(e.total_pieces))) &&
        b.pieceEntryCount === b.pieceEntries.length));
  if (!valid) throw new Error("Weekly kg by variety came back incomplete");
  return b as WeeklyKgByVarietySource;
}

/** A variety's crop; a server from before products sends none, which is Bell Peppers. */
export const weeklyKgCropOf = (variety: { productCode?: string }) => variety.productCode ?? "bell_pepper";

/** The crop codes the year's varieties belong to, Bell Peppers first. */
// (Varieties with only piece counts are listed by the server too.)
export function weeklyKgCrops(source: WeeklyKgByVarietySource): string[] {
  const codes = Array.from(new Set(source.varieties.map(weeklyKgCropOf)));
  return codes.sort((a, b) => (a === "bell_pepper" ? -1 : b === "bell_pepper" ? 1 : a.localeCompare(b)));
}

/** The units the crop has entries in this year, kg first. */
export function weeklyUnitsForCrop(source: WeeklyKgByVarietySource, cropCode: string): WeeklyUnit[] {
  const ids = new Set(source.varieties.filter((v) => weeklyKgCropOf(v) === cropCode).map((v) => v.id));
  const units: WeeklyUnit[] = [];
  if (source.entries.some((e) => ids.has(e.variety_id))) units.push("kg");
  if ((source.pieceEntries ?? []).some((e) => ids.has(e.variety_id))) units.push("pcs");
  return units;
}

/**
 * The source narrowed to one crop's varieties and one unit's entries, so
 * weekly and season totals never add one crop's kg to another's, or pieces
 * to kg. For pieces, entries carry the counts (in total_kg's place) and
 * unit is "pcs"; only varieties with entries in that unit are kept.
 */
export function weeklyKgSourceForCrop(
  source: WeeklyKgByVarietySource,
  cropCode: string,
  unit: WeeklyUnit = "kg"
): WeeklyKgByVarietySource {
  const cropVarieties = source.varieties.filter((variety) => weeklyKgCropOf(variety) === cropCode);
  const ids = new Set(cropVarieties.map((variety) => variety.id));
  const entries =
    unit === "pcs"
      ? (source.pieceEntries ?? [])
          .filter((entry) => ids.has(entry.variety_id))
          .map((entry) => ({ variety_id: entry.variety_id, week: entry.week, total_kg: entry.total_pieces }))
      : source.entries.filter((entry) => ids.has(entry.variety_id));
  const withEntries = new Set(entries.map((entry) => entry.variety_id));
  const varieties = cropVarieties.filter((variety) => withEntries.has(variety.id));
  return { ...source, varieties, entries, entryCount: entries.length, unit };
}

export type WeeklyKgColumn = { id: string; name: string; inactive: boolean; label: string };

export type WeeklyKgTable = {
  year: number;
  /** kg (one decimal) or pieces (whole numbers); every cell and total is in this unit. */
  unit: WeeklyUnit;
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
    unit: source.unit ?? "kg",
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

/** A table cell in the table's unit: kg to one decimal, pieces as a whole count. */
export function formatCell(value: number | null, unit: WeeklyUnit): string {
  if (unit === "kg") return formatKgCell(value);
  return value === null ? "—" : Math.round(value).toLocaleString("en-US");
}

/** A CSV value in the table's unit; "" for no entry. */
export function csvValue(value: number | null, unit: WeeklyUnit): string {
  if (unit === "kg") return csvKgValue(value);
  return value === null ? "" : String(Math.round(value));
}

/** The table's name: "Weekly kg by Variety" or "Weekly pieces by Variety". */
export const weeklyTableTitle = (unit: WeeklyUnit) => (unit === "pcs" ? "Weekly pieces by Variety" : "Weekly kg by Variety");

export const weekLabel = (week: number) => `Week ${week}`;

/** Header row shared by the card, CSV and PDF. */
export function tableHeader(table: WeeklyKgTable): string[] {
  return ["Week", ...table.columns.map((c) => c.label), "Weekly total"];
}

/** The full table as display strings, header excluded: one row per week, then Season total. */
export function displayMatrix(table: WeeklyKgTable): { body: string[][]; foot: string[] } {
  const cell = (value: number | null) => formatCell(value, table.unit);
  return {
    body: table.rows.map((r) => [weekLabel(r.week), ...r.cells.map(cell), cell(r.total)]),
    foot: ["Season total", ...table.seasonTotals.map(cell), cell(table.seasonTotal)]
  };
}

function csvField(value: string): string {
  // Text that a spreadsheet would run as a formula is prefixed with '.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV (CRLF, UTF-8 BOM for Excel): week numbers, kg as plain one-decimal numbers, pieces as whole numbers. */
export function weeklyKgCsv(table: WeeklyKgTable): string {
  const value = (v: number | null) => csvValue(v, table.unit);
  const lines = [
    tableHeader(table),
    ...table.rows.map((r) => [String(r.week), ...r.cells.map(value), value(r.total)]),
    ["Season total", ...table.seasonTotals.map(value), value(table.seasonTotal)]
  ];
  return "\uFEFF" + lines.map((line) => line.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * cropSlug only when the organization records more than one crop, so
 * single-crop file names are unchanged; a pieces table is always named so.
 */
export const weeklyKgFileBase = (year: number, cropSlug: string | null = null, unit: WeeklyUnit = "kg") => {
  const name = unit === "pcs" ? "weekly-pieces-by-variety" : "weekly-kg-by-variety";
  return cropSlug ? `${name}-${cropSlug}-${year}` : `${name}-${year}`;
};
