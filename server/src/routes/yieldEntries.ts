import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

type YieldEntryStatus = "active" | "inactive";
type YieldEntryPayload = {
  variety_id: string;
  year: number;
  week: number;
  size_kg: Record<string, number>;
  average_fruit_weight_g: number | null;
  packed_date: string | null;
};

type VarietyForCalc = {
  id: string;
  name: string;
  area_m2: number;
  case_kg: number;
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

function validatePayload(input: unknown): YieldEntryPayload {
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

  const size_kg = parseSizeKg(body.size_kg);
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
    average_fruit_weight_g,
    packed_date
  };
}

function calculateTotals(sizeKg: Record<string, number>, variety: VarietyForCalc) {
  const total_kg = Object.values(sizeKg).reduce((sum, value) => sum + value, 0);
  const kg_per_m2 = variety.area_m2 > 0 ? total_kg / variety.area_m2 : 0;
  const total_cases = variety.case_kg > 0 ? total_kg / variety.case_kg : 0;

  return { total_kg, kg_per_m2, total_cases };
}

async function fetchVarietyForCalc(
  varietyId: string,
  organizationId: string
): Promise<VarietyForCalc> {
  const { data, error } = await supabase
    .from("varieties")
    .select("id, name, area_m2, case_kg")
    .eq("id", varietyId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) {
    throw new Error("Selected variety was not found");
  }

  return data as VarietyForCalc;
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

  const [varietiesResult, sizesResult] = await Promise.all([
    supabase
      .from("varieties")
      .select("id, name, area_m2, case_kg, status, color")
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

  return res.json({
    varieties: varietiesResult.data ?? [],
    yieldSizes: sizesResult.data ?? []
  });
});

yieldEntriesRouter.get("/yield-entries", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("yield_entries")
    .select(
      "id, variety_id, year, week, packed_date, size_kg, total_kg, average_fruit_weight_g, kg_per_m2, total_cases, created_at, updated_at, varieties(name), yield_entry_daily_breakdown(id, packed_date, size_kg, total_kg)"
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load yield entries.", "Yield entries fetch error:", error);
  }

  const entries = (data ?? []).map((entry) => {
    const varietyRef = entry.varieties as
      | { name?: string }
      | Array<{ name?: string }>
      | null;

    const varietyName = Array.isArray(varietyRef)
      ? (varietyRef[0]?.name ?? "-")
      : (varietyRef?.name ?? "-");

    const rawBreakdowns = entry.yield_entry_daily_breakdown as Array<{
      id?: string;
      packed_date?: string | null;
      size_kg?: Record<string, unknown> | null;
      total_kg?: number | null;
    }> | null;

    const daily_breakdowns = (rawBreakdowns ?? []).map((b) => ({
      id: b.id ?? "",
      packed_date: b.packed_date ?? null,
      size_kg: (b.size_kg ?? {}) as Record<string, number>,
      total_kg: Number(b.total_kg ?? 0)
    }));

    const { varieties, yield_entry_daily_breakdown, ...rest } = entry;
    void varieties;
    void yield_entry_daily_breakdown;

    return {
      ...rest,
      variety_name: varietyName,
      daily_breakdowns
    };
  });

  return res.json(entries);
});

yieldEntriesRouter.post("/yield-entries", canYieldEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: YieldEntryPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const variety = await fetchVarietyForCalc(payload.variety_id, organizationId);

    const { data: existing, error: lookupError } = await supabase
      .from("yield_entries")
      .select("id, size_kg, average_fruit_weight_g, packed_date")
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

      const mergedTotals = calculateTotals(mergedSizeKg, variety);
      const mergedPackedDate = existing.packed_date !== null ? existing.packed_date : (payload.packed_date ?? null);

      const { data: updated, error: updateError } = await supabase
        .from("yield_entries")
        .update({
          size_kg: mergedSizeKg,
          average_fruit_weight_g: payload.average_fruit_weight_g,
          packed_date: mergedPackedDate,
          ...mergedTotals,
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
      const incomingTotal = Object.values(payload.size_kg).reduce((sum, v) => sum + v, 0);
      const { error: breakdownError } = await supabase
        .from("yield_entry_daily_breakdown")
        .insert({
          organization_id: organizationId,
          yield_entry_id: existing.id,
          packed_date: payload.packed_date,
          size_kg: payload.size_kg,
          total_kg: incomingTotal
        });

      if (breakdownError) {
        console.error("Yield entry breakdown insert error (append):", breakdownError);
      }

      return res.status(200).json({
        ...updated,
        message: `Added to existing ${variety.name} Week ${payload.week} entry.`
      });
    }

    const totals = calculateTotals(payload.size_kg, variety);

    const { data, error } = await supabase
      .from("yield_entries")
      .insert({ ...payload, ...totals, organization_id: organizationId })
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
        total_kg: totals.total_kg
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
  let payload: YieldEntryPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const variety = await fetchVarietyForCalc(payload.variety_id, organizationId);
    const totals = calculateTotals(payload.size_kg, variety);

    const { data, error } = await supabase
      .from("yield_entries")
      .update({ ...payload, ...totals, updated_at: new Date().toISOString() })
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
        total_kg: totals.total_kg
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

yieldEntriesRouter.get("/yield-analytics/summary", canYieldView, async (req, res) => {
  const organizationId = req.organizationId;

  const [entriesResult, sizesResult, varietiesResult] = await Promise.all([
    supabase
      .from("yield_entries")
      .select("variety_id, total_kg, average_fruit_weight_g, size_kg, varieties(id, name, area_m2)")
      .eq("organization_id", organizationId),
    supabase
      .from("yield_sizes")
      .select("id, name, sort_order")
      .eq("organization_id", organizationId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("varieties")
      .select("id, name, area_m2")
      .eq("organization_id", organizationId)
      .order("name", { ascending: true })
  ]);

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
  const varietiesMap = new Map<string, { id: string; name: string; area_m2: number }>();
  for (const v of varietiesResult.data ?? []) {
    varietiesMap.set(v.id, v);
  }

  type VarietySummary = {
    variety_id: string;
    variety_name: string;
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
      entries_count: row.entries_count,
      total_kg: row.total_kg,
      avg_fruit_weight_g,
      kg_per_m2,
      size_pct
    };
  });

  rows.sort((a, b) => a.variety_name.localeCompare(b.variety_name));

  return res.json({ sizes, rows });
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
