import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { loadWeeklyKgByVarietySource } from "../utils/weeklyKgByVariety";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { resolveVarietyFootprints } from "../utils/varietyAreaFootprints";
import { writeSourceColumn } from "../utils/writeSource";
import { mergeAverageFruitWeightG } from "../utils/averageFruitWeight";
import { calculateYieldTotals, calculateYieldTotalsFromKg } from "../utils/yieldTotals";
import { loadOrganizationProducts, productView, type OrganizationProduct } from "../utils/organizationProducts";

type YieldEntryStatus = "active" | "inactive";
type YieldEntryPayload = {
  variety_id: string;
  year: number;
  week: number;
  size_kg: Record<string, number>;
  average_fruit_weight_g: number | null;
  packed_date: string | null;
};

// What a request carries before the variety's product decides how its kg is
// read: kg per size (Bell Peppers) or one total kg (Cucumbers).
type YieldEntryRequest = Omit<YieldEntryPayload, "size_kg"> & {
  size_kg: Record<string, number> | null;
  total_kg: number | null;
};

type VarietyForCalc = {
  id: string;
  name: string;
  area_m2: number;
  case_kg: number;
  product_code: string;
};

function parseRequiredInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} is required`);
  }

  return parsed;
}

function parseOptionalNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("average_fruit_weight_g must be 0 or greater");
  }

  return parsed;
}

function parseSizeKg(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("size_kg must be an object of sizeId -> kg number");
  }

  const result: Record<string, number> = {};

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = typeof raw === "number" ? raw : Number(raw);

    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("kg values must be 0 or greater");
    }

    result[key] = parsed;
  }

  return result;
}

function validatePayload(input: unknown): YieldEntryRequest {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const variety_id =
    typeof body.variety_id === "string" ? body.variety_id.trim() : "";

  if (!variety_id) {
    throw new Error("variety_id is required");
  }

  const year = parseRequiredInteger(body.year, "year");
  const week = parseRequiredInteger(body.week, "week");

  if (week < 1 || week > 53) {
    throw new Error("week must be between 1 and 53");
  }

  // Parsed here when sent; whether it is required depends on the product.
  const size_kg = body.size_kg === undefined || body.size_kg === null ? null : parseSizeKg(body.size_kg);
  let total_kg: number | null = null;
  if (body.total_kg !== undefined && body.total_kg !== null && body.total_kg !== "") {
    total_kg = typeof body.total_kg === "number" ? body.total_kg : Number(body.total_kg);
    if (!Number.isFinite(total_kg) || total_kg < 0) {
      throw new Error("total_kg must be 0 or greater");
    }
  }
  const average_fruit_weight_g = parseOptionalNonNegativeNumber(
    body.average_fruit_weight_g
  );

  const packedDateRaw =
    typeof body.packed_date === "string" ? body.packed_date.trim() : null;
  const packed_date =
    packedDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(packedDateRaw)
      ? packedDateRaw
      : null;

  return {
    variety_id,
    year,
    week,
    size_kg,
    total_kg,
    average_fruit_weight_g,
    packed_date
  };
}

class EntryInputError extends Error {}

// The entry as stored, by the variety's product: Bell Peppers are kg per size
// with the total summed from them, exactly as before; a product without sizes
// (Cucumbers) is one total kg and stores no size buckets.
function resolveEntryKg(request: YieldEntryRequest, product: OrganizationProduct): { payload: YieldEntryPayload; totalKg: number } {
  const { total_kg, size_kg, ...rest } = request;

  if (product.tracksSizes) {
    if (size_kg === null) {
      throw new EntryInputError("size_kg must be an object of sizeId -> kg number");
    }
    return { payload: { ...rest, size_kg }, totalKg: Object.values(size_kg).reduce((sum, kg) => sum + kg, 0) };
  }

  if (size_kg && Object.values(size_kg).some((kg) => kg !== 0)) {
    throw new EntryInputError(`A ${product.name} harvest is a total kg without size buckets`);
  }
  if (total_kg === null) {
    throw new EntryInputError("total_kg is required");
  }
  return { payload: { ...rest, size_kg: {} }, totalKg: total_kg };
}

function entryTotals(payload: YieldEntryPayload, totalKg: number, product: OrganizationProduct, variety: VarietyForCalc) {
  return product.tracksSizes ? calculateYieldTotals(payload.size_kg, variety) : calculateYieldTotalsFromKg(totalKg, variety);
}

// The variety and its product. A harvest can only be recorded for a product
// the organization has enabled and is using.
async function fetchVarietyForCalc(
  varietyId: string,
  organizationId: string
): Promise<{ variety: VarietyForCalc; product: OrganizationProduct }> {
  const { data, error } = await supabase
    .from("varieties")
    .select("id, name, area_m2, case_kg, product_code")
    .eq("id", varietyId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) {
    throw new EntryInputError("Selected variety was not found");
  }

  const variety = data as VarietyForCalc;
  const products = await loadOrganizationProducts(organizationId);
  const product = products.find((p) => p.code === variety.product_code);

  if (!product || product.status !== "active") {
    throw new EntryInputError(`${product?.name ?? "This product"} is not enabled for your organization`);
  }

  return { variety, product };
}

const yieldEntriesRouter = Router();

const canYieldView = requireAnyPermission(["yield:view", "yield:edit"]);
const canYieldEdit = requirePermission("yield:edit");
const canCasesView = requireAnyPermission(["cases:view", "cases:edit"]);
const canCasesEdit = requirePermission("cases:edit");

// Suppress unused-variable warning — YieldEntryStatus is declared for documentation.
void (undefined as unknown as YieldEntryStatus);

yieldEntriesRouter.get("/yield-entry-options", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;

  let products: OrganizationProduct[];
  try {
    products = await loadOrganizationProducts(organizationId as string);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load products.", "Yield entry options - products error:", error);
  }
  const activeProducts = products.filter((p) => p.status === "active");

  const [varietiesResult, sizesResult] = await Promise.all([
    supabase
      .from("varieties")
      .select("id, name, area_m2, case_kg, status, color, product_code")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("name", { ascending: true }),
    supabase
      .from("yield_sizes")
      .select("id, name, sort_order, status")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("sort_order", { ascending: true })
  ]);

  if (varietiesResult.error) {
    return sendSafeError(res, 500, "Failed to load varieties.", "Yield entry options - varieties error:", varietiesResult.error);
  }

  if (sizesResult.error) {
    return sendSafeError(res, 500, "Failed to load yield sizes.", "Yield entry options - sizes error:", sizesResult.error);
  }

  // Harvests are entered only for products the organization is using.
  const activeCodes = new Set(activeProducts.map((p) => p.code));
  return res.json({
    varieties: (varietiesResult.data ?? []).filter((v) => activeCodes.has((v as { product_code: string }).product_code)),
    yieldSizes: sizesResult.data ?? [],
    products: activeProducts.map(productView)
  });
});

const YIELD_ENTRY_SELECT =
  "id, variety_id, year, week, packed_date, size_kg, total_kg, average_fruit_weight_g, kg_per_m2, total_cases, created_at, updated_at, varieties(name, product_code), yield_entry_daily_breakdown(id, packed_date, size_kg, total_kg, average_fruit_weight_g)";

type RawYieldEntryRow = {
  id: string;
  variety_id: string;
  year: number;
  week: number;
  packed_date: string | null;
  size_kg: unknown;
  total_kg: number;
  average_fruit_weight_g: number | null;
  kg_per_m2: number;
  total_cases: number;
  created_at: string;
  updated_at: string;
  varieties: { name?: string; product_code?: string } | Array<{ name?: string; product_code?: string }> | null;
  yield_entry_daily_breakdown: Array<{
    id?: string;
    packed_date?: string | null;
    size_kg?: Record<string, unknown> | null;
    total_kg?: number | null;
    average_fruit_weight_g?: number | null;
  }> | null;
};

function mapYieldEntryRow(entry: RawYieldEntryRow) {
  const varietyRef = Array.isArray(entry.varieties) ? entry.varieties[0] : entry.varieties;
  const varietyName = varietyRef?.name ?? "-";
  const productCode = varietyRef?.product_code ?? null;

  const daily_breakdowns = (entry.yield_entry_daily_breakdown ?? []).map((b) => ({
    id: b.id ?? "",
    packed_date: b.packed_date ?? null,
    size_kg: (b.size_kg ?? {}) as Record<string, number>,
    total_kg: Number(b.total_kg ?? 0),
    average_fruit_weight_g: b.average_fruit_weight_g ?? null
  }));

  const { varieties, yield_entry_daily_breakdown, ...rest } = entry;
  void varieties;
  void yield_entry_daily_breakdown;

  return {
    ...rest,
    variety_name: varietyName,
    product_code: productCode,
    daily_breakdowns
  };
}

yieldEntriesRouter.get("/yield-entries", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;

  let query = supabase
    .from("yield_entries")
    .select(YIELD_ENTRY_SELECT)
    .eq("organization_id", organizationId);

  // Optional narrowing used by callers that only need one week's worth of
  // entries (e.g. the KgEntriesTab weekly summary / duplicate-week check).
  // Omitting both keeps the historical full-history behaviour relied on by
  // Yield Analytics, the dashboard, and pack history.
  if (req.query.year !== undefined) {
    const year = Number(req.query.year);
    if (Number.isInteger(year)) {
      query = query.eq("year", year);
    }
  }
  if (req.query.week !== undefined) {
    const week = Number(req.query.week);
    if (Number.isInteger(week)) {
      query = query.eq("week", week);
    }
  }

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load yield entries.", "Yield entries fetch error:", error);
  }

  return res.json((data ?? []).map((entry) => mapYieldEntryRow(entry as RawYieldEntryRow)));
});

const MAX_RECENT_LIMIT = 100;
const DEFAULT_RECENT_LIMIT = 7;

// Ordering: year DESC, week DESC, packed_date DESC (nulls last within the
// week), id DESC as the final stable tiebreaker. Week takes priority over
// packed_date so a null-packed_date entry (e.g. an early FlowMaster PDF
// import that predates reliable date extraction — see investigation notes
// in yieldEntriesRecent.test.ts) sorts alongside its own week's other
// entries instead of being pushed behind all dated history.
export type RecentEntriesCursor = { year: number; week: number; packedDate: string | null; id: string };

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRecentCursor(raw: unknown): RecentEntriesCursor | null {
  if (typeof raw !== "string" || !raw) return null;

  const parts = raw.split("_");
  if (parts.length !== 4) return null;

  const [yearPart, weekPart, packedDatePart, id] = parts;
  const year = Number(yearPart);
  const week = Number(weekPart);

  if (!Number.isInteger(year) || !Number.isInteger(week)) return null;
  if (!UUID_RE.test(id)) return null;
  if (packedDatePart !== "null" && !DATE_RE.test(packedDatePart)) return null;

  return { year, week, packedDate: packedDatePart === "null" ? null : packedDatePart, id };
}

export function encodeRecentCursor(year: number, week: number, packedDate: string | null, id: string): string {
  return `${year}_${week}_${packedDate ?? "null"}_${id}`;
}

export function resolveRecentLimit(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_RECENT_LIMIT
    ? parsed
    : DEFAULT_RECENT_LIMIT;
}

// Builds the keyset ("seek") predicate for "every row strictly after `cursor`
// in (year desc, week desc, packed_date desc nulls last, id desc) order".
// Expressed as a flat OR of AND-groups (one group per tiebreak level) rather
// than nesting or() inside and() — PostgREST's filter-string grammar accepts
// arbitrary nesting, but flat groups are easier to verify by inspection and
// exercise in tests than a nested tree.
export function buildRecentCursorFilter(cursor: RecentEntriesCursor): string {
  const { year, week, packedDate, id } = cursor;
  const clauses = [
    `year.lt.${year}`,
    `and(year.eq.${year},week.lt.${week})`
  ];

  if (packedDate !== null) {
    clauses.push(
      `and(year.eq.${year},week.eq.${week},packed_date.lt.${packedDate})`,
      `and(year.eq.${year},week.eq.${week},packed_date.is.null)`,
      `and(year.eq.${year},week.eq.${week},packed_date.eq.${packedDate},id.lt.${id})`
    );
  } else {
    // The cursor row itself has no packed_date, i.e. it's already in the
    // nulls-last tail for this (year, week) — the only rows still "after"
    // it are other null-packed_date rows in the same week with a smaller id.
    clauses.push(`and(year.eq.${year},week.eq.${week},packed_date.is.null,id.lt.${id})`);
  }

  return clauses.join(",");
}

// Cursor-based pagination for the KgEntriesTab "Recent Entries" table. Keyset
// pagination (vs. offset) means concurrent inserts/deletes can't shift
// already-fetched pages out from under the client, and the composite id
// tiebreaker means rows sharing every other sort key never duplicate or get
// skipped across pages. Exported so it can be exercised directly against the
// live DB in tests without standing up an HTTP server.
export async function fetchRecentYieldEntriesPage(
  organizationId: string,
  limit: number,
  cursor: RecentEntriesCursor | null
) {
  let query = supabase
    .from("yield_entries")
    .select(YIELD_ENTRY_SELECT)
    .eq("organization_id", organizationId)
    .order("year", { ascending: false })
    .order("week", { ascending: false })
    .order("packed_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    // Fetch one extra row so hasMore can be determined without a separate count query.
    .limit(limit + 1);

  if (cursor) {
    query = query.or(buildRecentCursorFilter(cursor));
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page[page.length - 1];

  return {
    entries: page.map((entry) => mapYieldEntryRow(entry as RawYieldEntryRow)),
    nextCursor:
      hasMore && lastRow
        ? encodeRecentCursor(lastRow.year, lastRow.week, lastRow.packed_date, lastRow.id)
        : null,
    hasMore
  };
}

yieldEntriesRouter.get("/yield-entries/recent", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;
  const limit = resolveRecentLimit(req.query.limit);
  const cursor = parseRecentCursor(req.query.cursor);

  try {
    const result = await fetchRecentYieldEntriesPage(organizationId, limit, cursor);
    return res.json(result);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load recent yield entries.", "Recent yield entries fetch error:", error);
  }
});

// Read-only source for the Kg Entries "Weekly kg by Variety" card and its
// exports: every entry of one recorded harvest year (default: the latest
// year with entries), read completely or not at all. See
// utils/weeklyKgByVariety.ts.
yieldEntriesRouter.get("/yield-entries/weekly-by-variety", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;
  let requestedYear: number | null = null;
  if (req.query.year !== undefined) {
    const year = Number(req.query.year);
    if (!Number.isInteger(year) || year < 1900 || year > 3000) {
      return res.status(400).json({ message: "year must be a four-digit year." });
    }
    requestedYear = year;
  }

  try {
    return res.json(await loadWeeklyKgByVarietySource(supabase, organizationId as string, requestedYear));
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load weekly kg by variety.", "Weekly kg by variety fetch error:", error);
  }
});

yieldEntriesRouter.post("/yield-entries", canYieldEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let request: YieldEntryRequest;

  try {
    request = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const { variety, product } = await fetchVarietyForCalc(request.variety_id, organizationId);
    const { payload, totalKg: incomingTotal } = resolveEntryKg(request, product);

    const { data: existing, error: lookupError } = await supabase
      .from("yield_entries")
      .select("id, size_kg, total_kg, average_fruit_weight_g, packed_date")
      .eq("organization_id", organizationId)
      .eq("variety_id", payload.variety_id)
      .eq("year", payload.year)
      .eq("week", payload.week)
      .maybeSingle();

    if (lookupError) {
      return sendSafeError(res, 500, "Failed to check existing yield entry.", "Yield entry lookup error:", lookupError);
    }

    if (existing) {
      const existingSizeKg: Record<string, number> = {};
      for (const [sizeId, rawKg] of Object.entries((existing.size_kg ?? {}) as Record<string, unknown>)) {
        const kg = typeof rawKg === "number" ? rawKg : Number(rawKg);
        if (Number.isFinite(kg) && kg >= 0) {
          existingSizeKg[sizeId] = kg;
        }
      }

      const mergedSizeKg: Record<string, number> = { ...existingSizeKg };
      for (const [sizeId, incomingKg] of Object.entries(payload.size_kg)) {
        mergedSizeKg[sizeId] = (mergedSizeKg[sizeId] ?? 0) + incomingKg;
      }

      // A product without sizes adds to the stored total; its size buckets stay empty.
      const existingTotal = product.tracksSizes
        ? Object.values(existingSizeKg).reduce((sum, kg) => sum + kg, 0)
        : Number(existing.total_kg ?? 0);
      const mergedTotals = product.tracksSizes
        ? calculateYieldTotals(mergedSizeKg, variety)
        : calculateYieldTotalsFromKg(existingTotal + incomingTotal, variety);
      const mergedPackedDate = existing.packed_date !== null ? existing.packed_date : (payload.packed_date ?? null);

      const { data: updated, error: updateError } = await supabase
        .from("yield_entries")
        .update({
          size_kg: product.tracksSizes ? mergedSizeKg : {},
          average_fruit_weight_g: mergeAverageFruitWeightG(
            existingTotal,
            existing.average_fruit_weight_g == null ? null : Number(existing.average_fruit_weight_g),
            incomingTotal,
            payload.average_fruit_weight_g
          ),
          packed_date: mergedPackedDate,
          ...mergedTotals,
          ...writeSourceColumn("manual_merge"),
          updated_at: new Date().toISOString()
        })
        .eq("id", existing.id)
        .eq("organization_id", organizationId)
        .select("*")
        .single();

      if (updateError) {
        return sendSafeError(res, 500, "Failed to update existing yield entry.", "Yield entry update (append) error:", updateError);
      }

      // Write a breakdown row for this packing day
      const { error: breakdownError } = await supabase
        .from("yield_entry_daily_breakdown")
        .insert({
          organization_id: organizationId,
          yield_entry_id: existing.id,
          packed_date: payload.packed_date,
          size_kg: payload.size_kg,
          total_kg: incomingTotal,
          average_fruit_weight_g: payload.average_fruit_weight_g
        });

      if (breakdownError) {
        console.error("Yield entry breakdown insert error (append):", breakdownError);
      }

      return res.status(200).json({
        ...updated,
        message: `Added to existing ${variety.name} Week ${payload.week} entry.`
      });
    }

    const totals = entryTotals(payload, incomingTotal, product, variety);

    const { data, error } = await supabase
      .from("yield_entries")
      .insert({ ...payload, ...totals, organization_id: organizationId, ...writeSourceColumn("manual_create") })
      .select("*")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to create yield entry.", "Yield entry insert error:", error);
    }

    // Write a breakdown row for this packing day
    const { error: breakdownError } = await supabase
      .from("yield_entry_daily_breakdown")
      .insert({
        organization_id: organizationId,
        yield_entry_id: data.id,
        packed_date: payload.packed_date,
        size_kg: payload.size_kg,
        total_kg: totals.total_kg,
        average_fruit_weight_g: payload.average_fruit_weight_g
      });

    if (breakdownError) {
      console.error("Yield entry breakdown insert error (create):", breakdownError);
    }

    return res.status(201).json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create entry";
    return res.status(400).json({ message });
  }
});

yieldEntriesRouter.put("/yield-entries/:id", canYieldEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let request: YieldEntryRequest;

  try {
    request = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const { variety, product } = await fetchVarietyForCalc(request.variety_id, organizationId);
    const { payload, totalKg } = resolveEntryKg(request, product);
    const totals = entryTotals(payload, totalKg, product, variety);

    const { data, error } = await supabase
      .from("yield_entries")
      .update({ ...payload, ...totals, ...writeSourceColumn("manual_edit"), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("*")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to update yield entry.", "Yield entry update error:", error);
    }

    // Replace all breakdown rows with a single row reflecting the edited totals
    await supabase
      .from("yield_entry_daily_breakdown")
      .delete()
      .eq("yield_entry_id", id)
      .eq("organization_id", organizationId);

    const { error: breakdownError } = await supabase
      .from("yield_entry_daily_breakdown")
      .insert({
        organization_id: organizationId,
        yield_entry_id: id,
        packed_date: payload.packed_date,
        size_kg: payload.size_kg,
        total_kg: totals.total_kg,
        average_fruit_weight_g: payload.average_fruit_weight_g
      });

    if (breakdownError) {
      console.error("Yield entry breakdown replace error (edit):", breakdownError);
    }

    return res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update entry";
    return res.status(400).json({ message });
  }
});

yieldEntriesRouter.delete("/yield-entries/:id", canYieldEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("yield_entries")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete yield entry.", "Yield entry delete error:", error);
  }

  return res.status(204).send();
});

const GREENHOUSE_ROWS_PAGE = 1000;

/** Every greenhouse row, paged: PostgREST caps a response at 1,000 rows, and a truncated list would undercount physical area. */
async function fetchAllGreenhouseRows(organizationId: string | undefined) {
  const data: Array<{ group_id: string; row_number: number; width_meters: number | null; length_meters: number | null; section_id: string | null }> = [];
  for (let from = 0; ; from += GREENHOUSE_ROWS_PAGE) {
    const { data: page, error } = await supabase
      .from("greenhouse_rows")
      .select("group_id, row_number, width_meters, length_meters, section_id")
      .eq("organization_id", organizationId)
      .order("group_id", { ascending: true })
      .order("row_number", { ascending: true })
      .range(from, from + GREENHOUSE_ROWS_PAGE - 1);
    if (error) return { data: null, error };
    data.push(...(page ?? []));
    if (!page || page.length < GREENHOUSE_ROWS_PAGE) return { data, error: null };
  }
}

// Physical growing-area footprints for the farm-wide kg/m2 (see
// utils/varietyAreaFootprints.ts). variety_area_links arrives with migration
// 0138; until it is applied, footprints come from row assignments alone and
// linksAvailable tells the page why a legacy variety shows as unlinked.
yieldEntriesRouter.get("/yield-analytics/area-footprints", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;

  const [groupsResult, rowsResult, sectionsResult, assignmentsResult, linksResult] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name").eq("organization_id", organizationId),
    fetchAllGreenhouseRows(organizationId),
    supabase.from("greenhouse_row_sections").select("id, width_meters, length_meters").eq("organization_id", organizationId),
    supabase
      .from("greenhouse_variety_assignments")
      .select("group_id, variety_id, start_row, end_row, assignment_pattern")
      .eq("organization_id", organizationId),
    supabase
      .from("variety_area_links")
      .select("variety_id, successor_variety_id, greenhouse_group_id")
      .eq("organization_id", organizationId)
  ]);

  for (const [label, result] of [
    ["groups", groupsResult],
    ["rows", rowsResult],
    ["sections", sectionsResult],
    ["assignments", assignmentsResult]
  ] as const) {
    if (result.error) {
      return sendSafeError(res, 500, "Failed to load growing areas.", `Yield analytics area footprints - ${label} error:`, result.error);
    }
  }

  // 42P01: relation does not exist (migration 0138 not applied yet).
  const linksAvailable = !linksResult.error;
  if (linksResult.error && linksResult.error.code !== "42P01" && linksResult.error.code !== "PGRST205") {
    return sendSafeError(res, 500, "Failed to load growing areas.", "Yield analytics area footprints - links error:", linksResult.error);
  }

  const footprints = resolveVarietyFootprints({
    groups: groupsResult.data ?? [],
    rows: rowsResult.data ?? [],
    sections: sectionsResult.data ?? [],
    assignments: assignmentsResult.data ?? [],
    links: linksAvailable ? linksResult.data ?? [] : []
  });

  return res.json({ ...footprints, linksAvailable });
});

yieldEntriesRouter.get("/yield-analytics/summary", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;

  const [entriesResult, sizesResult, varietiesResult] = await Promise.all([
    supabase
      .from("yield_entries")
      .select("variety_id, total_kg, average_fruit_weight_g, size_kg, varieties(id, name, area_m2, product_code)")
      .eq("organization_id", organizationId),
    supabase
      .from("yield_sizes")
      .select("id, name, sort_order")
      .eq("organization_id", organizationId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("varieties")
      .select("id, name, area_m2, product_code")
      .eq("organization_id", organizationId)
      .order("name", { ascending: true })
  ]);

  let products: OrganizationProduct[];
  try {
    products = await loadOrganizationProducts(organizationId as string);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load yield analytics.", "Yield analytics - products error:", error);
  }

  if (entriesResult.error) {
    return sendSafeError(res, 500, "Failed to load yield analytics.", "Yield analytics - entries error:", entriesResult.error);
  }
  if (sizesResult.error) {
    return sendSafeError(res, 500, "Failed to load yield analytics.", "Yield analytics - sizes error:", sizesResult.error);
  }
  if (varietiesResult.error) {
    return sendSafeError(res, 500, "Failed to load yield analytics.", "Yield analytics - varieties error:", varietiesResult.error);
  }

  const sizes = sizesResult.data ?? [];
  const varietiesMap = new Map<string, { id: string; name: string; area_m2: number; product_code: string }>();
  for (const v of varietiesResult.data ?? []) {
    varietiesMap.set(v.id, v);
  }

  type VarietySummary = {
    variety_id: string;
    variety_name: string;
    product_code: string | null;
    entries_count: number;
    total_kg: number;
    weighted_fw_sum: number;
    weighted_fw_kg: number;
    size_kg_sum: Record<string, number>;
    area_m2: number;
  };

  const summaryMap = new Map<string, VarietySummary>();

  for (const entry of entriesResult.data ?? []) {
    const varietyRef = entry.varieties as { id?: string; name?: string; area_m2?: number } | Array<{ id?: string; name?: string; area_m2?: number }> | null;
    const ref = Array.isArray(varietyRef) ? varietyRef[0] : varietyRef;
    const varietyName = ref?.name ?? varietiesMap.get(entry.variety_id)?.name ?? "-";
    const areaM2 = ref?.area_m2 ?? varietiesMap.get(entry.variety_id)?.area_m2 ?? 0;

    if (!summaryMap.has(entry.variety_id)) {
      summaryMap.set(entry.variety_id, {
        variety_id: entry.variety_id,
        variety_name: varietyName,
        product_code: varietiesMap.get(entry.variety_id)?.product_code ?? null,
        entries_count: 0,
        total_kg: 0,
        weighted_fw_sum: 0,
        weighted_fw_kg: 0,
        size_kg_sum: {},
        area_m2: areaM2
      });
    }

    const row = summaryMap.get(entry.variety_id)!;
    row.entries_count += 1;
    row.total_kg += entry.total_kg ?? 0;

    if (entry.average_fruit_weight_g !== null && entry.average_fruit_weight_g !== undefined && (entry.total_kg ?? 0) > 0) {
      row.weighted_fw_sum += entry.average_fruit_weight_g * (entry.total_kg ?? 0);
      row.weighted_fw_kg += entry.total_kg ?? 0;
    }

    const sizeKg = (entry.size_kg ?? {}) as Record<string, number>;
    for (const [sizeId, kg] of Object.entries(sizeKg)) {
      row.size_kg_sum[sizeId] = (row.size_kg_sum[sizeId] ?? 0) + (typeof kg === "number" ? kg : 0);
    }
  }

  const rows = Array.from(summaryMap.values()).map((row) => {
    const avg_fruit_weight_g = row.weighted_fw_kg > 0
      ? row.weighted_fw_sum / row.weighted_fw_kg
      : null;

    const kg_per_m2 = row.area_m2 > 0 ? row.total_kg / row.area_m2 : null;

    const size_pct: Record<string, number> = {};
    if (row.total_kg > 0) {
      for (const size of sizes) {
        const sizeKg = row.size_kg_sum[size.id] ?? 0;
        size_pct[size.id] = (sizeKg / row.total_kg) * 100;
      }
    } else {
      for (const size of sizes) {
        size_pct[size.id] = 0;
      }
    }

    return {
      variety_id: row.variety_id,
      variety_name: row.variety_name,
      product_code: row.product_code,
      entries_count: row.entries_count,
      total_kg: row.total_kg,
      avg_fruit_weight_g,
      kg_per_m2,
      size_pct
    };
  });

  rows.sort((a, b) => a.variety_name.localeCompare(b.variety_name));

  return res.json({ sizes, rows, products: products.map(productView) });
});

// ── Color Case Entries ────────────────────────────────────────────────────────

type ColorCasePayload = {
  color: string;
  year: number;
  week: number;
  total_cases: number;
  case_weight_kg: number;
};

type ColorAreaMap = {
  [color: string]: number;
};

function parseRequiredNonNegativeNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

function validateColor(value: unknown): string {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  const validColors = ["red", "orange", "yellow", "green"];

  if (!validColors.includes(color)) {
    throw new Error(`color must be one of: ${validColors.join(", ")}`);
  }

  return color;
}

function validateColorCasePayload(input: unknown): ColorCasePayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const color = validateColor(body.color);
  const year = parseRequiredInteger(body.year, "year");
  const week = parseRequiredInteger(body.week, "week");

  if (week < 1 || week > 53) {
    throw new Error("week must be between 1 and 53");
  }

  const total_cases = parseRequiredNonNegativeNumber(body.total_cases, "total_cases");
  const case_weight_kg = parseRequiredNonNegativeNumber(body.case_weight_kg, "case_weight_kg");

  return {
    color,
    year,
    week,
    total_cases,
    case_weight_kg
  };
}

async function fetchColorAreaM2(organizationId: string): Promise<ColorAreaMap> {
  const { data, error } = await supabase
    .from("varieties")
    .select("color, area_m2")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (error) {
    throw new Error("Failed to fetch variety areas");
  }

  const colorAreaMap: ColorAreaMap = {};

  for (const variety of data ?? []) {
    const color = (variety.color ?? "").toLowerCase();
    if (color) {
      colorAreaMap[color] = (colorAreaMap[color] ?? 0) + (variety.area_m2 ?? 0);
    }
  }

  return colorAreaMap;
}

yieldEntriesRouter.get("/color-case-entries", canCasesView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("color_case_entries")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load color case entries.", "Color case entries fetch error:", error);
  }

  return res.json(data ?? []);
});

yieldEntriesRouter.post("/color-case-entries", canCasesEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: ColorCasePayload;

  try {
    payload = validateColorCasePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const colorAreaMap = await fetchColorAreaM2(organizationId);
    const color_area_m2 = colorAreaMap[payload.color] ?? 0;
    const total_kg = payload.total_cases * payload.case_weight_kg;
    const kg_per_m2 = color_area_m2 > 0 ? total_kg / color_area_m2 : 0;

    const { data, error } = await supabase
      .from("color_case_entries")
      .insert({
        organization_id: organizationId,
        color: payload.color,
        year: payload.year,
        week: payload.week,
        total_cases: payload.total_cases,
        case_weight_kg: payload.case_weight_kg,
        total_kg,
        kg_per_m2,
        color_area_m2
      })
      .select("*")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to create color case entry.", "Color case entry insert error:", error);
    }

    return res.status(201).json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create entry";
    return res.status(400).json({ message });
  }
});

yieldEntriesRouter.put("/color-case-entries/:id", canCasesEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: ColorCasePayload;

  try {
    payload = validateColorCasePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const colorAreaMap = await fetchColorAreaM2(organizationId);
    const color_area_m2 = colorAreaMap[payload.color] ?? 0;
    const total_kg = payload.total_cases * payload.case_weight_kg;
    const kg_per_m2 = color_area_m2 > 0 ? total_kg / color_area_m2 : 0;

    const { data, error } = await supabase
      .from("color_case_entries")
      .update({
        color: payload.color,
        year: payload.year,
        week: payload.week,
        total_cases: payload.total_cases,
        case_weight_kg: payload.case_weight_kg,
        total_kg,
        kg_per_m2,
        color_area_m2,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("*")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to update color case entry.", "Color case entry update error:", error);
    }

    return res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update entry";
    return res.status(400).json({ message });
  }
});

yieldEntriesRouter.delete("/color-case-entries/:id", canCasesEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("color_case_entries")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete color case entry.", "Color case entry delete error:", error);
  }

  return res.status(204).send();
});

yieldEntriesRouter.get("/case-entry-options", canCasesView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("varieties")
    .select("color")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (error) {
    return sendSafeError(res, 500, "Failed to load case entry options.", "Case entry options fetch error:", error);
  }

  const colorsSet = new Set<string>();
  for (const variety of data ?? []) {
    if (variety.color) {
      colorsSet.add(variety.color);
    }
  }

  const colors = Array.from(colorsSet).sort();

  return res.json({ colors });
});

export { yieldEntriesRouter };
