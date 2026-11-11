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
  /** The harvest's kg for a product without size buckets (Cucumbers). */
  total_kg?: string;
  /** A whole-number piece count, for a crop recorded in pieces. */
  total_pieces?: string;
};

/** The unit a harvest is recorded in: kg, or a whole-number count of pieces. */
export type EntryUnit = "kg" | "pcs";

/** A piece count, POSTed or PUT to /api/yield-entries with unit_code "pcs". */
export type PieceEntryPayload = {
  variety_id: string;
  year: number;
  week: number;
  packed_date: string | null;
  unit_code: "pcs";
  total_pieces: number;
};

/** What the form needs to know about the selected variety's product. */
export type ManualKgEntryProduct = {
  code: string;
  name: string;
  tracksSizes: boolean;
  /** The unit new harvests are recorded in (Setup -> Products); absent means kg. */
  defaultUnitCode?: string;
};

/** The unit a new harvest of the product is entered in. */
export function newEntryUnit(product: ManualKgEntryProduct | undefined): EntryUnit {
  return product?.defaultUnitCode === "pcs" ? "pcs" : "kg";
}

export type ManualKgEntryPayload = {
  variety_id: string;
  year: number;
  week: number;
  packed_date: string | null;
  size_kg: Record<string, number>;
  /** Sent only for a product without size buckets; Bell Pepper totals are summed from sizes. */
  total_kg?: number;
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

/** True when the product's harvests are kg per size (Bell Peppers, and any variety whose product is unknown). */
export function entersSizes(product: ManualKgEntryProduct | undefined) {
  return product?.tracksSizes !== false;
}

/** The form's live total: summed sizes, or the total typed for a product without sizes. */
export function formTotalKg(form: ManualKgEntryForm, product: ManualKgEntryProduct | undefined) {
  return entersSizes(product) ? sumSizeKg(form.size_kg) : numberOrZero(form.total_kg ?? "");
}

/** kg/m² for the variety, or null when it has no area. */
export function kgPerM2For(totalKg: number, variety: ManualKgEntryVariety | undefined) {
  if (!variety || variety.area_m2 <= 0) {
    return null;
  }
  return totalKg / variety.area_m2;
}

/** Pieces per m2 for the variety, or null when it has no area. */
export function piecesPerM2For(totalPieces: number, variety: ManualKgEntryVariety | undefined) {
  if (!variety || variety.area_m2 <= 0) {
    return null;
  }
  return totalPieces / variety.area_m2;
}

/** The typed piece count when it is a whole number of 0 or more, else null. */
export function formTotalPieces(form: ManualKgEntryForm): number | null {
  const raw = (form.total_pieces ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * The piece-count payload for the form, or the first validation message:
 * variety, pieces, year, week. Pieces are whole counts only; a count has no
 * size buckets, kg or fruit weight.
 */
export function buildPieceEntryPayload(form: ManualKgEntryForm): { ok: true; payload: PieceEntryPayload } | { ok: false; error: string } {
  if (!form.variety_id) {
    return { ok: false, error: "Variety is required." };
  }
  const raw = (form.total_pieces ?? "").trim();
  if (raw === "") {
    return { ok: false, error: "Total pieces is required." };
  }
  const totalPieces = formTotalPieces(form);
  if (totalPieces === null || !Number.isSafeInteger(totalPieces)) {
    return { ok: false, error: "Pieces must be a whole number of 0 or more." };
  }
  const payload: PieceEntryPayload = {
    variety_id: form.variety_id,
    year: Number(form.year),
    week: Number(form.week),
    packed_date: form.packed_date || null,
    unit_code: "pcs",
    total_pieces: totalPieces
  };
  if (!Number.isInteger(payload.year)) {
    return { ok: false, error: "Year is required." };
  }
  if (!Number.isInteger(payload.week)) {
    return { ok: false, error: "Week is required." };
  }
  return { ok: true, payload };
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
 *
 * For a product without size buckets (Cucumbers) the harvest is the typed
 * total kg instead: no sizes are sent and the total is required.
 */
export function buildManualKgEntryPayload(
  form: ManualKgEntryForm,
  yieldSizes: YieldSizeOption[],
  product?: ManualKgEntryProduct
): { ok: true; payload: ManualKgEntryPayload } | { ok: false; error: string } {
  if (!form.variety_id) {
    return { ok: false, error: "Variety is required." };
  }

  const payloadSizeKg: Record<string, number> = {};
  let totalKg: number | undefined;

  if (entersSizes(product)) {
    for (const size of yieldSizes) {
      const kg = numberOrZero(form.size_kg[size.id] ?? "0");
      if (kg < 0) {
        return { ok: false, error: "Kg values must be 0 or greater." };
      }
      payloadSizeKg[size.id] = kg;
    }
  } else {
    const raw = (form.total_kg ?? "").trim();
    totalKg = Number(raw);
    if (raw === "" || !Number.isFinite(totalKg)) {
      return { ok: false, error: "Total kg is required." };
    }
    if (totalKg < 0) {
      return { ok: false, error: "Kg values must be 0 or greater." };
    }
  }

  const payload: ManualKgEntryPayload = {
    variety_id: form.variety_id,
    year: Number(form.year),
    week: Number(form.week),
    packed_date: form.packed_date || null,
    size_kg: payloadSizeKg,
    ...(totalKg === undefined ? {} : { total_kg: totalKg }),
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

/** The entries of one year/week, for the duplicate check and week summary; withPieces adds piece counts. */
export function weekEntriesUrl(year: number, week: number, { withPieces = false }: { withPieces?: boolean } = {}) {
  return `${YIELD_ENTRIES_URL}?year=${year}&week=${week}${withPieces ? "&units=all" : ""}`;
}

/** An entry's unit: piece counts say "pcs"; anything else is kg. */
export const entryUnitOf = (entry: { unit_code?: string | null }): EntryUnit => (entry.unit_code === "pcs" ? "pcs" : "kg");

/**
 * The variety's existing entry in that week's entries, in the same unit, if
 * any: a piece count never merges into a kg harvest, or the other way round.
 */
export function findExistingWeekEntry<T extends { variety_id: string; unit_code?: string | null }>(
  weekEntries: T[],
  varietyId: string,
  unit: EntryUnit = "kg"
): T | null {
  return weekEntries.find((e) => e.variety_id === varietyId && entryUnitOf(e) === unit) ?? null;
}
