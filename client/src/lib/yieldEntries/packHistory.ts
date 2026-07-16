import { apiFetch } from "../api";

export type DailyBreakdownRecord = {
  id: string;
  packed_date: string | null;
  size_kg: Record<string, number>;
  total_kg: number;
  average_fruit_weight_g: number | null;
};

export type YieldEntryForHistory = {
  id: string;
  variety_id: string;
  variety_name: string;
  daily_breakdowns: DailyBreakdownRecord[];
};

export type PackedVarietyEntry = {
  varietyId: string;
  name: string;
  kg: number;
  /** kg-weighted average fruit weight for this variety on this specific day, or null if no AFW data exists. */
  averageFruitWeightG: number | null;
};

const ENTRIES_URL = "/api/yield-entries";

export type YieldEntryHistoryRange = {
  from?: string;
  to?: string;
};

/**
 * Fetches yield entries (with their daily_breakdowns) for the pack history view.
 * The backend endpoint currently returns the full unfiltered history — `range` is
 * accepted here so callers already write date-bounded call sites; once the API
 * grows `from`/`to` query params, only this function needs to change.
 */
export async function fetchYieldEntriesForHistory(
  range?: YieldEntryHistoryRange
): Promise<YieldEntryForHistory[]> {
  const params = new URLSearchParams();
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);
  const query = params.toString();
  const url = query ? `${ENTRIES_URL}?${query}` : ENTRIES_URL;

  const response = await apiFetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load yield entries (${response.status})`);
  }

  return (await response.json()) as YieldEntryForHistory[];
}

export function localIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseIsoDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Sunday that begins the week containing `date`. */
export function getWeekStart(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function formatWeekRangeLabel(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6);
  const startMonth = weekStart.toLocaleDateString(undefined, { month: "long" });
  const endMonth = weekEnd.toLocaleDateString(undefined, { month: "long" });
  const year = weekEnd.getFullYear();

  if (startMonth === endMonth) {
    return `${startMonth} ${weekStart.getDate()}–${weekEnd.getDate()}, ${year}`;
  }

  return `${startMonth} ${weekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${year}`;
}

type DailyVarietyAccumulator = {
  varietyId: string;
  name: string;
  kg: number;
  afwNumerator: number;
  afwDenominator: number;
};

/**
 * Groups every daily_breakdown row (across all yield entries) by its actual
 * packed_date, aggregating kg per variety. This preserves which day each
 * amount was packed, unlike the weekly yield_entries.total_kg rollup.
 *
 * Average fruit weight is kg-weighted across the breakdown rows that make up
 * a given variety/day (a day can have more than one row if multiple entries
 * or PDF imports landed on the same packed_date), mirroring how the weekly
 * yield_entries.average_fruit_weight_g is merged on the backend — but scoped
 * to a single day instead of the whole week.
 */
export function buildDailyPackMap(
  entries: YieldEntryForHistory[]
): Map<string, PackedVarietyEntry[]> {
  const byDate = new Map<string, Map<string, DailyVarietyAccumulator>>();

  for (const entry of entries) {
    for (const breakdown of entry.daily_breakdowns) {
      if (!breakdown.packed_date) continue;

      let byVariety = byDate.get(breakdown.packed_date);
      if (!byVariety) {
        byVariety = new Map();
        byDate.set(breakdown.packed_date, byVariety);
      }

      let accumulator = byVariety.get(entry.variety_id);
      if (!accumulator) {
        accumulator = {
          varietyId: entry.variety_id,
          name: entry.variety_name,
          kg: 0,
          afwNumerator: 0,
          afwDenominator: 0
        };
        byVariety.set(entry.variety_id, accumulator);
      }

      accumulator.kg += breakdown.total_kg;

      if (
        breakdown.average_fruit_weight_g !== null &&
        Number.isFinite(breakdown.average_fruit_weight_g) &&
        breakdown.total_kg > 0
      ) {
        accumulator.afwNumerator += breakdown.average_fruit_weight_g * breakdown.total_kg;
        accumulator.afwDenominator += breakdown.total_kg;
      }
    }
  }

  const result = new Map<string, PackedVarietyEntry[]>();
  for (const [isoDate, byVariety] of byDate) {
    const dayEntries = Array.from(byVariety.values())
      .map((accumulator) => ({
        varietyId: accumulator.varietyId,
        name: accumulator.name,
        kg: accumulator.kg,
        averageFruitWeightG:
          accumulator.afwDenominator > 0
            ? accumulator.afwNumerator / accumulator.afwDenominator
            : null
      }))
      .sort((a, b) => b.kg - a.kg);

    result.set(isoDate, dayEntries);
  }

  return result;
}

/** ISO date (Sunday) of every week that has at least one packed entry. */
export function getWeekStartsWithData(
  dailyPackMap: Map<string, PackedVarietyEntry[]>
): Set<string> {
  const weeks = new Set<string>();
  for (const isoDate of dailyPackMap.keys()) {
    weeks.add(localIsoDate(getWeekStart(parseIsoDate(isoDate))));
  }
  return weeks;
}
