import { Router } from "express";
import { supabase } from "../config/supabase";

type YieldEntryStatus = "active" | "inactive";
type YieldEntryPayload = {
  variety_id: string;
  year: number;
  week: number;
  size_kg: Record<string, number>;
  average_fruit_weight_g: number | null;
};

type VarietyForCalc = {
  id: string;
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

  return {
    variety_id,
    year,
    week,
    size_kg,
    average_fruit_weight_g
  };
}

function calculateTotals(sizeKg: Record<string, number>, variety: VarietyForCalc) {
  const total_kg = Object.values(sizeKg).reduce((sum, value) => sum + value, 0);
  const kg_per_m2 = variety.area_m2 > 0 ? total_kg / variety.area_m2 : 0;
  const total_cases = variety.case_kg > 0 ? total_kg / variety.case_kg : 0;

  return { total_kg, kg_per_m2, total_cases };
}

async function fetchVarietyForCalc(varietyId: string): Promise<VarietyForCalc> {
  const { data, error } = await supabase
    .from("varieties")
    .select("id, area_m2, case_kg")
    .eq("id", varietyId)
    .single();

  if (error || !data) {
    throw new Error("Selected variety was not found");
  }

  return data as VarietyForCalc;
}

const yieldEntriesRouter = Router();

yieldEntriesRouter.get("/yield-entry-options", async (_req, res) => {
  const [varietiesResult, sizesResult] = await Promise.all([
    supabase
      .from("varieties")
      .select("id, name, area_m2, case_kg, status")
      .eq("status", "active")
      .order("name", { ascending: true }),
    supabase
      .from("yield_sizes")
      .select("id, name, sort_order, status")
      .eq("status", "active")
      .order("sort_order", { ascending: true })
  ]);

  if (varietiesResult.error) {
    return res.status(500).json({ message: varietiesResult.error.message });
  }

  if (sizesResult.error) {
    return res.status(500).json({ message: sizesResult.error.message });
  }

  return res.json({
    varieties: varietiesResult.data ?? [],
    yieldSizes: sizesResult.data ?? []
  });
});

yieldEntriesRouter.get("/yield-entries", async (_req, res) => {
  const { data, error } = await supabase
    .from("yield_entries")
    .select(
      "id, variety_id, year, week, size_kg, total_kg, average_fruit_weight_g, kg_per_m2, total_cases, created_at, updated_at, varieties(name)"
    )
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  const entries = (data ?? []).map((entry) => {
    const varietyRef = entry.varieties as
      | { name?: string }
      | Array<{ name?: string }>
      | null;

    const varietyName = Array.isArray(varietyRef)
      ? (varietyRef[0]?.name ?? "-")
      : (varietyRef?.name ?? "-");

    const { varieties, ...rest } = entry;
    void varieties;

    return {
      ...rest,
      variety_name: varietyName
    };
  });

  return res.json(entries);
});

yieldEntriesRouter.post("/yield-entries", async (req, res) => {
  let payload: YieldEntryPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const variety = await fetchVarietyForCalc(payload.variety_id);
    const totals = calculateTotals(payload.size_kg, variety);

    const { data, error } = await supabase
      .from("yield_entries")
      .insert({ ...payload, ...totals })
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    return res.status(201).json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create entry";
    return res.status(400).json({ message });
  }
});

yieldEntriesRouter.put("/yield-entries/:id", async (req, res) => {
  const { id } = req.params;
  let payload: YieldEntryPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    const variety = await fetchVarietyForCalc(payload.variety_id);
    const totals = calculateTotals(payload.size_kg, variety);

    const { data, error } = await supabase
      .from("yield_entries")
      .update({ ...payload, ...totals, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    return res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update entry";
    return res.status(400).json({ message });
  }
});

yieldEntriesRouter.delete("/yield-entries/:id", async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from("yield_entries").delete().eq("id", id);

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(204).send();
});

yieldEntriesRouter.get("/yield-analytics/summary", async (_req, res) => {
  const [entriesResult, sizesResult, varietiesResult] = await Promise.all([
    supabase
      .from("yield_entries")
      .select("variety_id, total_kg, average_fruit_weight_g, size_kg, varieties(id, name, area_m2)"),
    supabase
      .from("yield_sizes")
      .select("id, name, sort_order")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("varieties")
      .select("id, name, area_m2")
      .order("name", { ascending: true })
  ]);

  if (entriesResult.error) {
    return res.status(500).json({ message: entriesResult.error.message });
  }
  if (sizesResult.error) {
    return res.status(500).json({ message: sizesResult.error.message });
  }
  if (varietiesResult.error) {
    return res.status(500).json({ message: varietiesResult.error.message });
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

export { yieldEntriesRouter };
