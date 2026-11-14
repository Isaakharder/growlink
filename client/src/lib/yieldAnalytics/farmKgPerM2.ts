// Farm-wide kg/m2 for Yield Analytics: qualifying yield kg divided by the
// unique physical growing area that produced it. Used for both the kg/m2
// metric card and the Variety Summary's Average row, so they can never
// disagree.
//
// Physical area is measured greenhouse rows (from
// /api/yield-analytics/area-footprints), never variety records' area_m2:
// summing those counts one greenhouse again every time a variety is renamed,
// split by phase or replaced. Rules:
// - Qualifying kg = every entry passed in (the page passes the year/week-
//   filtered entries). Nothing is dropped for lacking an area.
// - Kg whose variety has no footprint with a measured row cannot be put over
//   an area. It is excluded from the ratio and reported as uncovered, so the
//   page can say so rather than silently dropping it.
// - Denominator = area of the union of footprint rows of the varieties that
//   produced covered kg in the period. A row shared by successive or
//   continuing crops counts once. For a shorter period, only area that
//   actually produced yield in it counts; for any subset of varieties, only
//   their own rows count.
// - Row sizes by date: with Setup → Map measurements each row carries dated
//   sizes. Kg from a packing week is put over the sizes in effect on that
//   week's Monday, so a resize or new rows for a later season never change
//   an earlier period. A row counts once, at the size it had in the latest
//   week it produced in the period; a row not in the greenhouse yet then
//   doesn't count.

export type AreaFootprintRow = {
  key: string;
  groupId: string;
  /** Today's m². */
  areaM2: number | null;
  /** Setup → Map sizes, oldest first (from null = since the beginning); absent before row measurements. */
  sizes?: Array<{ from: string | null; areaM2: number | null }>;
};

export type AreaFootprints = {
  rows: AreaFootprintRow[];
  footprints: Record<string, string[]>;
  linksAvailable?: boolean;
  /** The date areaM2 describes (today in the organization's time zone), when rows carry dated sizes. */
  today?: string;
};

/** year/week: the packing week (ISO), which picks the row sizes in effect then; without them, today's sizes. */
export type FarmKgPerM2Entry = { variety_id: string; total_kg: number; year?: number | null; week?: number | null };

/** Monday (YYYY-MM-DD) of an ISO week. */
export function isoWeekMonday(year: number, week: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay() || 7;
  return new Date(jan4 - (jan4Day - 1) * 86400000 + (week - 1) * 7 * 86400000).toISOString().slice(0, 10);
}

/** A row's m² on a date; undefined when the row isn't in the greenhouse yet on that date. */
export function areaRowOn(row: AreaFootprintRow | undefined, date: string | null): number | null | undefined {
  if (!row) return null;
  if (!row.sizes || !row.sizes.length || !date) return row.areaM2;
  let found: { from: string | null; areaM2: number | null } | undefined;
  for (const s of row.sizes) if (s.from === null || s.from <= date) found = s;
  return found ? found.areaM2 : undefined;
}

export type FarmKgPerM2 = {
  /** All qualifying kg in the entries passed in. */
  qualifyingKg: number;
  /** Kg that has physical area behind it — the numerator. */
  coveredKg: number;
  /** Unique measured growing area behind coveredKg — the denominator. */
  areaM2: number;
  /** coveredKg / areaM2, or null when there is no measured area to divide by. */
  kgPerM2: number | null;
  /** Varieties whose kg could not be connected to measured growing area. */
  uncovered: Array<{ varietyId: string; kg: number }>;
  uncoveredKg: number;
  /** Rows in the footprint that have no dimensions, so contribute no area. */
  unmeasuredRowCount: number;
};

export function computeFarmKgPerM2(entries: FarmKgPerM2Entry[], areas: AreaFootprints | null): FarmKgPerM2 {
  const kgByVariety = new Map<string, number>();
  // Latest packing week (its Monday) per variety; null = an entry without a week, which uses today's sizes.
  const latestByVariety = new Map<string, string | null>();
  for (const entry of entries) {
    const kg = Number(entry.total_kg);
    if (!entry.variety_id || !Number.isFinite(kg)) continue;
    kgByVariety.set(entry.variety_id, (kgByVariety.get(entry.variety_id) ?? 0) + kg);
    if (kg <= 0) continue;
    const monday = entry.year != null && entry.week != null ? isoWeekMonday(Number(entry.year), Number(entry.week)) : null;
    const prev = latestByVariety.get(entry.variety_id);
    if (prev === undefined) latestByVariety.set(entry.variety_id, monday);
    else if (prev !== null && (monday === null || monday > prev)) latestByVariety.set(entry.variety_id, monday);
  }

  const rowByKey = new Map((areas?.rows ?? []).map((row) => [row.key, row]));
  const positive = (area: number | null | undefined) => (typeof area === "number" && Number.isFinite(area) && area > 0 ? area : null);
  const later = (a: string | null, b: string | null) => (a === null || b === null ? null : a > b ? a : b);

  let qualifyingKg = 0;
  let coveredKg = 0;
  const rowsInUse = new Map<string, string | null>();
  const uncovered: FarmKgPerM2["uncovered"] = [];

  for (const [varietyId, kg] of kgByVariety) {
    qualifyingKg += kg;
    if (kg <= 0) continue;
    const date = latestByVariety.get(varietyId) ?? areas?.today ?? null;
    const footprint = areas?.footprints[varietyId] ?? [];
    if (!footprint.some((key) => positive(areaRowOn(rowByKey.get(key), date)) !== null)) {
      uncovered.push({ varietyId, kg });
      continue;
    }
    coveredKg += kg;
    for (const key of footprint) rowsInUse.set(key, rowsInUse.has(key) ? later(rowsInUse.get(key) ?? null, date) : date);
  }

  let areaM2 = 0;
  let unmeasuredRowCount = 0;
  for (const [key, date] of rowsInUse) {
    const raw = areaRowOn(rowByKey.get(key), date);
    if (raw === undefined) continue; // not in the greenhouse yet in this period
    const area = positive(raw);
    if (area === null) unmeasuredRowCount += 1;
    else areaM2 += area;
  }

  uncovered.sort((a, b) => b.kg - a.kg);
  return {
    qualifyingKg,
    coveredKg,
    areaM2,
    kgPerM2: areaM2 > 0 ? coveredKg / areaM2 : null,
    uncovered,
    uncoveredKg: uncovered.reduce((sum, u) => sum + u.kg, 0),
    unmeasuredRowCount
  };
}
