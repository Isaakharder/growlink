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

export type AreaFootprints = {
  rows: Array<{ key: string; groupId: string; areaM2: number | null }>;
  footprints: Record<string, string[]>;
  linksAvailable?: boolean;
};

export type FarmKgPerM2Entry = { variety_id: string; total_kg: number };

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
  for (const entry of entries) {
    const kg = Number(entry.total_kg);
    if (!entry.variety_id || !Number.isFinite(kg)) continue;
    kgByVariety.set(entry.variety_id, (kgByVariety.get(entry.variety_id) ?? 0) + kg);
  }

  const areaByRow = new Map((areas?.rows ?? []).map((row) => [row.key, row.areaM2]));
  const measured = (key: string) => {
    const area = areaByRow.get(key);
    return typeof area === "number" && Number.isFinite(area) && area > 0 ? area : null;
  };

  let qualifyingKg = 0;
  let coveredKg = 0;
  const rowsInUse = new Set<string>();
  const uncovered: FarmKgPerM2["uncovered"] = [];

  for (const [varietyId, kg] of kgByVariety) {
    qualifyingKg += kg;
    if (kg <= 0) continue;
    const footprint = areas?.footprints[varietyId] ?? [];
    if (!footprint.some((key) => measured(key) !== null)) {
      uncovered.push({ varietyId, kg });
      continue;
    }
    coveredKg += kg;
    for (const key of footprint) rowsInUse.add(key);
  }

  let areaM2 = 0;
  let unmeasuredRowCount = 0;
  for (const key of rowsInUse) {
    const area = measured(key);
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
