// Manual kg entry: the form's live totals, its validation, and the exact
// request it sends to /api/yield-entries. Shared by the desktop Kg Entries
// tab and the iOS workspace so both validate and save identically.

export const YIELD_ENTRIES_URL = "/api/yield-entries";

export type YieldSizeOption = {
  id: string;
  name: string;
  sort_order: number;
  status: "active" | "inactive";
};

export type ManualKgEntryVariety = {
  area_m2: number;
  case_kg: number;
};

export type ManualKgEntryForm = {
  variety_id: string;
  year: string;
  week: string;
  packed_date: string;
  average_fruit_weight_g: string;
  size_kg: Record<string, string>;
};

export type ManualKgEntryPayload = {
  variety_id: string;
  year: number;
  week: number;
  packed_date: string | null;
  size_kg: Record<string, number>;
  average_fruit_weight_g: number | null;
};

export function numberOrZero(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** /api/yield-entry-options' sizes, in sort_order (a sorted copy). */
export function sortYieldSizes(sizes: YieldSizeOption[]): YieldSizeOption[] {
  return [...sizes].sort((a, b) => a.sort_order - b.sort_order);
}

/** Every size's kg field set to "0". */
export function zeroSizeKgFields(sizes: YieldSizeOption[]) {
  const next: Record<string, string> = {};
  for (const size of sizes) {
    next[size.id] = "0";
  }
  return next;
}

export function sumSizeKg(sizeKg: Record<string, string>) {
  return Object.values(sizeKg).reduce((sum, value) => sum + numberOrZero(value), 0);
}

/** kg/m² for the variety, or null when it has no area. */
export function kgPerM2For(totalKg: number, variety: ManualKgEntryVariety | undefined) {
  if (!variety || variety.area_m2 <= 0) {
    return null;
  }
  return totalKg / variety.area_m2;
}

/** Cases at the variety's case weight, or 0 without one. */
export function totalCasesFor(totalKg: number, variety: ManualKgEntryVariety | undefined) {
  if (!variety || variety.case_kg <= 0) {
    return 0;
  }
  return totalKg / variety.case_kg;
}

/**
 * The payload for the form, or the first validation message, checked in
 * this order: variety, size kg, year, week, average fruit weight. Sizes are
 * sent for every yield size, in the given order, blanks as 0.
 */
export function buildManualKgEntryPayload(
  form: ManualKgEntryForm,
  yieldSizes: YieldSizeOption[]
): { ok: true; payload: ManualKgEntryPayload } | { ok: false; error: string } {
  if (!form.variety_id) {
    return { ok: false, error: "Variety is required." };
  }

  const payloadSizeKg: Record<string, number> = {};
  for (const size of yieldSizes) {
    const kg = numberOrZero(form.size_kg[size.id] ?? "0");
    if (kg < 0) {
      return { ok: false, error: "Kg values must be 0 or greater." };
    }
    payloadSizeKg[size.id] = kg;
  }

  const payload: ManualKgEntryPayload = {
    variety_id: form.variety_id,
    year: Number(form.year),
    week: Number(form.week),
    packed_date: form.packed_date || null,
    size_kg: payloadSizeKg,
    average_fruit_weight_g:
      form.average_fruit_weight_g.trim() === ""
        ? null
        : Number(form.average_fruit_weight_g)
  };

  if (!Number.isInteger(payload.year)) {
    return { ok: false, error: "Year is required." };
  }

  if (!Number.isInteger(payload.week)) {
    return { ok: false, error: "Week is required." };
  }

  if (
    payload.average_fruit_weight_g !== null &&
    (!Number.isFinite(payload.average_fruit_weight_g) || payload.average_fruit_weight_g < 0)
  ) {
    return { ok: false, error: "Average fruit weight must be 0 or greater." };
  }

  return { ok: true, payload };
}

/** A new entry is POSTed; an edit is PUT to that entry. */
export function manualKgEntrySaveTarget(editingId: string | null) {
  return {
    method: editingId ? "PUT" : "POST",
    url: editingId ? `${YIELD_ENTRIES_URL}/${editingId}` : YIELD_ENTRIES_URL
  };
}

/** The entries of one year/week, for the duplicate check and week summary. */
export function weekEntriesUrl(year: number, week: number) {
  return `${YIELD_ENTRIES_URL}?year=${year}&week=${week}`;
}

/** The variety's existing entry in that week's entries, if any. */
export function findExistingWeekEntry<T extends { variety_id: string }>(weekEntries: T[], varietyId: string): T | null {
  return weekEntries.find((e) => e.variety_id === varietyId) ?? null;
}
