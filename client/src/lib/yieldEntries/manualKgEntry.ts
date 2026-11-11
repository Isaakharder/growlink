// Manual kg entry: the form's live totals, its validation, and the exact
// request it sends to /api/yield-entries. Shared by the desktop Kg Entries
// tab and the iOS workspace so both validate and save identically.

export const YIELD_ENTRIES_URL = "/api/yield-entries";

export type YieldSizeOption = {
  id: string;
  name: string;
  sort_order: number;
  status: "active" | "inactive";
  /** The crop the size belongs to (migration 0152); absent from a server before it, where every size is a Bell Peppers size. */
  product_code?: string;
};

/** A size field on the entry form; retired marks a size kept only because an old harvest carries it. */
export type EntrySizeField = {
  id: string;
  name: string;
  retired: boolean;
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
  /** Pieces per size, for a crop recorded in pieces with sizes. */
  size_pieces?: Record<string, string>;
  /**
   * Whether the harvest is entered per size (the total is their sum) or as
   * one total. Absent: per size for Bell Peppers, one total otherwise.
   */
  by_size?: boolean;
  /**
   * kg (or pieces) of an old harvest not allocated to any size: kept when a
   * total-only harvest was combined with a sized one, so its total stays.
   */
  unsized?: string;
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
  /** Sent for a count without sizes; with sizes the server sums them (plus any unsized pieces). */
  total_pieces?: number;
  size_pieces?: Record<string, number>;
  unsized_pieces?: number;
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
  /** Sent only for a harvest entered as one total; sized totals are summed from sizes. */
  total_kg?: number;
  /** kg of a sized harvest not allocated to a size (an old total-only harvest combined with a sized one). */
  unsized_kg?: number;
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

/** True when every harvest of the product is kg per size (Bell Peppers, and any variety whose product is unknown). */
export function entersSizes(product: ManualKgEntryProduct | undefined) {
  return product?.tracksSizes !== false;
}

/** Whether the form enters the harvest per size: its own setting, else per size for Bell Peppers only. */
export function formBySize(form: ManualKgEntryForm, product: ManualKgEntryProduct | undefined) {
  return form.by_size ?? entersSizes(product);
}

/**
 * The crop's own sizes, in its sort order (migration 0152). A size or a
 * variety from a server before crops names no crop and is Bell Peppers.
 */
export function sizesForCrop(sizes: YieldSizeOption[], productCode: string | null | undefined, { activeOnly = true } = {}) {
  const crop = productCode ?? "bell_pepper";
  return sortYieldSizes(
    sizes.filter((size) => (size.product_code ?? "bell_pepper") === crop && (!activeOnly || size.status === "active"))
  );
}

/**
 * Whether a new harvest of the crop is entered per size: always for Bell
 * Peppers, and for another crop once it has active sizes. Without sizes it
 * keeps the single total field.
 */
export function newHarvestBySize(product: ManualKgEntryProduct | undefined, cropActiveSizes: YieldSizeOption[]) {
  return entersSizes(product) || cropActiveSizes.length > 0;
}

/**
 * The size fields the form shows: the crop's active sizes, then any other
 * size the harvest being edited carries with an amount (a retired size, or
 * one since removed), so an edit never drops part of an old harvest.
 */
export function entrySizeFields(
  sizes: YieldSizeOption[],
  productCode: string | null | undefined,
  entrySizes: Record<string, number | string> | null | undefined = null
): EntrySizeField[] {
  const active = sizesForCrop(sizes, productCode);
  const fields: EntrySizeField[] = active.map((size) => ({ id: size.id, name: size.name, retired: false }));
  const shown = new Set(fields.map((field) => field.id));
  const byId = new Map(sizes.map((size) => [size.id, size]));
  const kept = Object.entries(entrySizes ?? {})
    .filter(([id, amount]) => !shown.has(id) && Number(amount) !== 0)
    .map(([id]) => byId.get(id))
    .filter((size): size is YieldSizeOption => !!size)
    .sort((a, b) => a.sort_order - b.sort_order);
  for (const size of kept) {
    fields.push({ id: size.id, name: size.name, retired: true });
    shown.add(size.id);
  }
  for (const [id, amount] of Object.entries(entrySizes ?? {})) {
    if (!shown.has(id) && Number(amount) !== 0) {
      fields.push({ id, name: "Removed size", retired: true });
    }
  }
  return fields;
}

/** Each field's amount from the harvest being edited, else "0". */
export function sizeFieldValues(fields: Array<{ id: string }>, entrySizes: Record<string, number | string> | null | undefined = null) {
  const next: Record<string, string> = {};
  for (const field of fields) {
    const amount = entrySizes?.[field.id];
    next[field.id] = amount === undefined || amount === null ? "0" : String(amount);
  }
  return next;
}

/** An old harvest's amount not allocated to a size (total - sizes), or 0. */
export function unsizedAmount(total: number | null | undefined, entrySizes: Record<string, number | string> | null | undefined) {
  const sizes = Object.values(entrySizes ?? {}).reduce<number>((sum, amount) => sum + numberOrZero(String(amount)), 0);
  const rest = Number(total ?? 0) - sizes;
  return Object.keys(entrySizes ?? {}).length > 0 && rest > 1e-9 ? rest : 0;
}

/** The form's live total: summed sizes (plus any unsized kg), or the total typed in. */
export function formTotalKg(form: ManualKgEntryForm, product: ManualKgEntryProduct | undefined) {
  return formBySize(form, product)
    ? sumSizeKg(form.size_kg) + numberOrZero(form.unsized ?? "")
    : numberOrZero(form.total_kg ?? "");
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

const wholeCount = (value: string | undefined): number | null => {
  const raw = (value ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : null;
};

/**
 * The form's piece count when every count is a whole number of 0 or more,
 * else null: the sizes' sum (plus any unsized pieces) per size, or the
 * typed total.
 */
export function formTotalPieces(form: ManualKgEntryForm): number | null {
  if (form.by_size) {
    let total = 0;
    for (const value of Object.values(form.size_pieces ?? {})) {
      const count = (value ?? "").trim() === "" ? 0 : wholeCount(value);
      if (count === null) return null;
      total += count;
    }
    const unsized = (form.unsized ?? "").trim() === "" ? 0 : wholeCount(form.unsized);
    return unsized === null ? null : total + unsized;
  }
  return wholeCount(form.total_pieces);
}

/**
 * The piece-count payload for the form, or the first validation message:
 * variety, pieces, year, week. Pieces are whole counts only; a count has no
 * kg or fruit weight. Entered per size, every size field in sizeFields is
 * sent (blanks as 0) and the server totals them; otherwise the total is.
 */
export function buildPieceEntryPayload(
  form: ManualKgEntryForm,
  sizeFields: Array<{ id: string }> = []
): { ok: true; payload: PieceEntryPayload } | { ok: false; error: string } {
  if (!form.variety_id) {
    return { ok: false, error: "Variety is required." };
  }
  const base = {
    variety_id: form.variety_id,
    year: Number(form.year),
    week: Number(form.week),
    packed_date: form.packed_date || null,
    unit_code: "pcs" as const
  };
  let payload: PieceEntryPayload;
  if (form.by_size) {
    const sizePieces: Record<string, number> = {};
    for (const field of sizeFields) {
      const raw = (form.size_pieces?.[field.id] ?? "").trim();
      const count = raw === "" ? 0 : wholeCount(raw);
      if (count === null || !Number.isSafeInteger(count)) {
        return { ok: false, error: "Pieces must be whole numbers of 0 or more." };
      }
      sizePieces[field.id] = count;
    }
    const unsizedRaw = (form.unsized ?? "").trim();
    const unsized = unsizedRaw === "" ? 0 : wholeCount(unsizedRaw);
    if (unsized === null) {
      return { ok: false, error: "Pieces must be whole numbers of 0 or more." };
    }
    payload = { ...base, size_pieces: sizePieces, ...(unsized > 0 ? { unsized_pieces: unsized } : {}) };
  } else {
    const raw = (form.total_pieces ?? "").trim();
    if (raw === "") {
      return { ok: false, error: "Total pieces is required." };
    }
    const totalPieces = formTotalPieces(form);
    if (totalPieces === null || !Number.isSafeInteger(totalPieces)) {
      return { ok: false, error: "Pieces must be a whole number of 0 or more." };
    }
    payload = { ...base, total_pieces: totalPieces };
  }
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
  yieldSizes: Array<{ id: string }>,
  product?: ManualKgEntryProduct
): { ok: true; payload: ManualKgEntryPayload } | { ok: false; error: string } {
  if (!form.variety_id) {
    return { ok: false, error: "Variety is required." };
  }

  const payloadSizeKg: Record<string, number> = {};
  let totalKg: number | undefined;
  let unsizedKg: number | undefined;

  if (formBySize(form, product)) {
    for (const size of yieldSizes) {
      const kg = numberOrZero(form.size_kg[size.id] ?? "0");
      if (kg < 0) {
        return { ok: false, error: "Kg values must be 0 or greater." };
      }
      payloadSizeKg[size.id] = kg;
    }
    // Kept from an old harvest only (a crop whose sizes are optional).
    const unsized = numberOrZero(form.unsized ?? "");
    if (unsized < 0) {
      return { ok: false, error: "Kg values must be 0 or greater." };
    }
    if (unsized > 0 && !entersSizes(product)) {
      unsizedKg = unsized;
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
    ...(unsizedKg === undefined ? {} : { unsized_kg: unsizedKg }),
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
