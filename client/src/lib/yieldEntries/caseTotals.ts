import { apiFetch } from "../api";
import { roundTo } from "../roundTo";

// Weekly Case Totals and the DockLink case sync. Shared by the desktop Cases
// tab and the iOS workspace so both show identical totals.

export type CaseColor = "red" | "orange" | "yellow" | "green";

export const CASE_COLORS: CaseColor[] = ["red", "orange", "yellow", "green"];

export const COLOR_CASE_ENTRIES_URL = "/api/color-case-entries";
export const DOCKLINK_CASE_SYNC_URL = "/api/integrations/docklink/sync-color-cases";

export type WeeklyCaseEntry = {
  color: CaseColor;
  year: number;
  week: number;
  total_cases: number;
};

export type WeeklyCaseCard = {
  year: number;
  week: number;
  totals: Record<CaseColor, number>;
};

export type WeeklyCaseColorRow = {
  color: CaseColor;
  total: number;
};

/** This year plus every year with an entry, newest first. */
export function buildCaseEntryYearOptions(entries: Array<{ year: number }>, currentYear: number) {
  const years = new Set<number>([currentYear]);

  for (const entry of entries) {
    if (Number.isInteger(entry.year)) {
      years.add(entry.year);
    }
  }

  return Array.from(years).sort((a, b) => b - a);
}

/**
 * One card per week of the year (newest first) that has cases > 0 in any
 * colour; weeks outside 1–53 and unknown colours are ignored.
 */
export function buildWeeklyCaseCards(entries: WeeklyCaseEntry[], selectedYear: number): WeeklyCaseCard[] {
  if (!Number.isInteger(selectedYear)) {
    return [] as WeeklyCaseCard[];
  }

  const byWeek = new Map<number, Record<CaseColor, number>>();

  for (const entry of entries) {
    if (entry.year !== selectedYear) {
      continue;
    }

    if (!Number.isInteger(entry.week) || entry.week < 1 || entry.week > 53) {
      continue;
    }

    if (!CASE_COLORS.includes(entry.color)) {
      continue;
    }

    const totalCases = Number(entry.total_cases);
    if (!Number.isFinite(totalCases)) {
      continue;
    }

    const totals = byWeek.get(entry.week) ?? {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };

    totals[entry.color] += totalCases;
    byWeek.set(entry.week, totals);
  }

  return Array.from(byWeek.entries())
    .map(([week, totals]) => ({
      year: selectedYear,
      week,
      totals
    }))
    .filter((card) => CASE_COLORS.some((color) => card.totals[color] > 0))
    .sort((a, b) => b.week - a.week);
}

/** A card's colours with cases > 0, rounded to 3 dp. */
export function getVisibleColorRows(totals: Record<CaseColor, number>): WeeklyCaseColorRow[] {
  return CASE_COLORS.map((color) => ({ color, total: Number(totals[color]) }))
    .filter((row) => Number.isFinite(row.total) && row.total > 0)
    .map((row) => ({ ...row, total: roundTo(row.total, 3) }));
}

/** The week's total: the sum of its shown (rounded) rows. */
export function weeklyCaseTotal(rows: WeeklyCaseColorRow[]) {
  return rows.reduce((sum, row) => sum + row.total, 0);
}

export function formatCaseTotal(value: number) {
  const rounded = roundTo(value, 3);
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * POSTs the DockLink colour case sync. Throws with the server's message
 * (or "Sync failed") when it is rejected; the caller reloads the entries.
 */
export async function requestDocklinkCaseSync(): Promise<void> {
  const response = await apiFetch(DOCKLINK_CASE_SYNC_URL, {
    method: "POST"
  });

  if (!response.ok) {
    let message = "Sync failed";

    try {
      const responseBody = (await response.json()) as { message?: string };
      if (responseBody.message) {
        message = responseBody.message;
      }
    } catch {
      // Ignore
    }

    throw new Error(message);
  }
}
