import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

type RowRecord = {
  id: string;
  group_id: string;
  row_number: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
};

type AssignmentRecord = {
  variety_id: string;
  group_id: string;
  start_row: number;
  end_row: number;
};

type MobileYieldSamplePayload = {
  variety_id: string;
  row_id: string;
  phase_id: string | null;
  phase_name: string | null;
  row_label: string | null;
  row_number: number | null;
  percent_full: number;
  kg_per_full_bin: number;
  kg_per_case: number;
  calculated_sample_kg: number;
  calculated_kg_per_stem: number;
  sample_date: string;
  session_year: number;
  session_week: number;
};

const DEFAULT_CASES_PER_BIN = 38;
const DEFAULT_KG_PER_FULL_BIN = 0;
const DEFAULT_KG_PER_CASE = 0;

function isMissingSettingsStorageError(error: { code?: string; message?: string }) {
  const message = (error.message ?? "").toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    message.includes("daily_yield_bin_settings") && message.includes("does not exist")
  );
}

function parseRequiredNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} is required`);
  }

  return parsed;
}

function parseBinFillPercent(value: unknown): number {
  const parsed = parseRequiredNumber(value, "bin_fill_percent");

  if (parsed < 0) {
    throw new Error("bin_fill_percent must be 0 or greater");
  }

  return parsed;
}

function parseNonNegativeNumber(value: unknown, fieldName: string): number {
  const parsed = parseRequiredNumber(value, fieldName);

  if (parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error("row_number must be a whole number");
  }

  return parsed;
}

function parseRequiredInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} is required`);
  }

  return parsed;
}

function parseSampleDate(value: unknown): string {
  const parsed = typeof value === "string" ? value.trim() : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new Error("sample_date must be YYYY-MM-DD");
  }

  return parsed;
}

function parseCasesPerBin(value: unknown): number {
  const parsed = parseRequiredNumber(value, "cases_per_bin");

  if (parsed <= 0) {
    throw new Error("cases_per_bin must be greater than 0");
  }

  return parsed;
}

function parseId(value: unknown, fieldName: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";

  if (!parsed) {
    throw new Error(`${fieldName} is required`);
  }

  return parsed;
}

function validateSamplePayload(input: unknown): MobileYieldSamplePayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  return {
    variety_id: parseId(body.variety_id, "variety_id"),
    row_id: parseId(body.row_id, "row_id"),
    phase_id: parseOptionalString(body.phase_id),
    phase_name: parseOptionalString(body.phase_name),
    row_label: parseOptionalString(body.row_label),
    row_number: parseOptionalInteger(body.row_number),
    percent_full: parseBinFillPercent(body.percent_full ?? body.bin_fill_percent),
    kg_per_full_bin: parseNonNegativeNumber(body.kg_per_full_bin, "kg_per_full_bin"),
    kg_per_case: parseNonNegativeNumber(body.kg_per_case, "kg_per_case"),
    calculated_sample_kg: parseNonNegativeNumber(
      body.calculated_sample_kg,
      "calculated_sample_kg"
    ),
    calculated_kg_per_stem: parseNonNegativeNumber(
      body.calculated_kg_per_stem,
      "calculated_kg_per_stem"
    ),
    sample_date: parseSampleDate(body.sample_date),
    session_year: parseRequiredInteger(body.session_year, "session_year"),
    session_week: parseRequiredInteger(body.session_week, "session_week")
  };
}

type BinSettings = {
  casesPerBin: number;
  pickingBinKg: number | null;
  caseKg: number | null;
};

async function getCurrentBinSettings(organizationId: string): Promise<BinSettings> {
  const { data, error } = await supabase
    .from("daily_yield_bin_settings")
    .select("cases_per_bin, picking_bin_kg, case_kg")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingSettingsStorageError(error)) {
      return { casesPerBin: DEFAULT_CASES_PER_BIN, pickingBinKg: null, caseKg: null };
    }

    console.error("Bin settings fetch error:", error);
    throw new Error("Failed to load bin settings.");
  }

  if (!data) {
    return { casesPerBin: DEFAULT_CASES_PER_BIN, pickingBinKg: null, caseKg: null };
  }

  const casesPerBin = Number(data.cases_per_bin);
  const rawPickingBinKg = data.picking_bin_kg !== null && data.picking_bin_kg !== undefined
    ? Number(data.picking_bin_kg) : null;
  const rawCaseKg = data.case_kg !== null && data.case_kg !== undefined
    ? Number(data.case_kg) : null;

  return {
    casesPerBin: Number.isFinite(casesPerBin) && casesPerBin > 0 ? casesPerBin : DEFAULT_CASES_PER_BIN,
    pickingBinKg: rawPickingBinKg !== null && Number.isFinite(rawPickingBinKg) && rawPickingBinKg > 0
      ? rawPickingBinKg : null,
    caseKg: rawCaseKg !== null && Number.isFinite(rawCaseKg) && rawCaseKg > 0
      ? rawCaseKg : null
  };
}

async function fetchRowsLinkedToActiveVarieties(organizationId: string) {
  const [varietiesResult, assignmentsResult, rowsResult] = await Promise.all([
    supabase
      .from("varieties")
      .select("id, name, color, status")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("name", { ascending: true }),
    supabase
      .from("greenhouse_variety_assignments")
      .select("variety_id, group_id, start_row, end_row")
      .eq("organization_id", organizationId),
    supabase
      .from("greenhouse_rows")
      .select("id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant")
      .eq("organization_id", organizationId)
      .order("row_number", { ascending: true })
  ]);

  if (varietiesResult.error) {
    console.error("Varieties fetch error:", varietiesResult.error);
    throw new Error("Failed to load varieties.");
  }

  if (assignmentsResult.error) {
    console.error("Variety assignments fetch error:", assignmentsResult.error);
    throw new Error("Failed to load variety assignments.");
  }

  if (rowsResult.error) {
    console.error("Greenhouse rows fetch error:", rowsResult.error);
    throw new Error("Failed to load greenhouse rows.");
  }

  const varieties = varietiesResult.data ?? [];
  const activeVarietyIds = new Set(varieties.map((variety) => variety.id));
  const assignments = (assignmentsResult.data ?? []).filter((assignment) =>
    activeVarietyIds.has(assignment.variety_id)
  ) as AssignmentRecord[];

  const rowsByGroupId = new Map<string, RowRecord[]>();
  for (const row of (rowsResult.data ?? []) as RowRecord[]) {
    const groupRows = rowsByGroupId.get(row.group_id) ?? [];
    groupRows.push(row);
    rowsByGroupId.set(row.group_id, groupRows);
  }

  const varietyNameById = new Map<string, string>();
  for (const variety of varieties) {
    varietyNameById.set(variety.id, variety.name);
  }

  const linkedRows: Array<{
    row_id: string;
    row_number: number;
    variety_id: string;
    variety_name: string;
    slab_count: number;
    plants_per_slab: number;
    stems_per_plant: number;
    total_plants: number;
    total_stems: number;
  }> = [];

  const seen = new Set<string>();

  for (const assignment of assignments) {
    const groupRows = rowsByGroupId.get(assignment.group_id) ?? [];

    for (const row of groupRows) {
      if (row.row_number < assignment.start_row || row.row_number > assignment.end_row) {
        continue;
      }

      const key = `${assignment.variety_id}:${row.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const slabCount = Number(row.slab_count);
      const plantsPerSlab = Number(row.plants_per_slab);
      const stemsPerPlant = Number(row.stems_per_plant);
      const totalPlants = slabCount * plantsPerSlab;
      const totalStems = totalPlants * stemsPerPlant;

      linkedRows.push({
        row_id: row.id,
        row_number: row.row_number,
        variety_id: assignment.variety_id,
        variety_name: varietyNameById.get(assignment.variety_id) ?? "Unknown variety",
        slab_count: slabCount,
        plants_per_slab: plantsPerSlab,
        stems_per_plant: stemsPerPlant,
        total_plants: totalPlants,
        total_stems: totalStems
      });
    }
  }

  linkedRows.sort((a, b) => a.row_number - b.row_number);

  return {
    varieties,
    rows: linkedRows
  };
}

async function ensureRowLinkedToVariety(
  varietyId: string,
  rowId: string,
  organizationId: string
) {
  const { data: varietyData, error: varietyError } = await supabase
    .from("varieties")
    .select("id")
    .eq("id", varietyId)
    .eq("organization_id", organizationId)
    .single();

  if (varietyError || !varietyData) {
    throw new Error("Selected variety was not found");
  }

  const { data: rowData, error: rowError } = await supabase
    .from("greenhouse_rows")
    .select("id, group_id, row_number")
    .eq("id", rowId)
    .eq("organization_id", organizationId)
    .single();

  if (rowError || !rowData) {
    throw new Error("Selected row was not found");
  }

  const { data: assignmentData, error: assignmentError } = await supabase
    .from("greenhouse_variety_assignments")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("variety_id", varietyId)
    .eq("group_id", rowData.group_id)
    .lte("start_row", rowData.row_number)
    .gte("end_row", rowData.row_number)
    .limit(1)
    .maybeSingle();

  if (assignmentError) {
    console.error("Row assignment validation error:", assignmentError);
    throw new Error("Failed to validate row assignment.");
  }

  if (!assignmentData) {
    throw new Error("Selected row is not linked to the selected variety");
  }
}

// Suppress unused constants warning — kept for clarity in case of future use.
void DEFAULT_KG_PER_FULL_BIN;
void DEFAULT_KG_PER_CASE;

const mobileDailyYieldRouter = Router();

// Reads: mobile:daily_yield lets field pickers load their options and review samples.
// yield:view / yield:edit also grant access so desktop supervisors can review.
const canView = requireAnyPermission(["mobile:daily_yield", "yield:view", "yield:edit"]);

// Writes: mobile:daily_yield lets pickers submit samples and adjust settings.
// yield:edit also grants access for supervisors.
const canWrite = requireAnyPermission(["mobile:daily_yield", "yield:edit"]);

mobileDailyYieldRouter.get("/mobile/daily-yield/options", canView, async (req, res) => {
  const organizationId = req.organizationId;

  try {
    const [options, binSettings] = await Promise.all([
      fetchRowsLinkedToActiveVarieties(organizationId),
      getCurrentBinSettings(organizationId)
    ]);

    return res.json({
      varieties: options.varieties,
      rows: options.rows,
      casesPerBin: binSettings.casesPerBin
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load options";
    return res.status(500).json({ message });
  }
});

mobileDailyYieldRouter.get("/mobile/daily-yield/settings", canView, async (req, res) => {
  const organizationId = req.organizationId;

  try {
    const settings = await getCurrentBinSettings(organizationId);
    return res.json({
      cases_per_bin: settings.casesPerBin,
      kg_per_full_bin: settings.pickingBinKg ?? 0,
      kg_per_case: settings.caseKg ?? 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load settings";
    return res.status(500).json({ message });
  }
});

mobileDailyYieldRouter.put("/mobile/daily-yield/settings", canWrite, async (req, res) => {
  const organizationId = req.organizationId;
  let casesPerBin: number;

  try {
    const body = req.body as Record<string, unknown>;
    casesPerBin = parseCasesPerBin(body.cases_per_bin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const now = new Date().toISOString();

  const { data: currentSetting, error: currentError } = await supabase
    .from("daily_yield_bin_settings")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (currentError) {
    return sendSafeError(res, 500, "Failed to load bin settings.", "Bin settings fetch error:", currentError);
  }

  if (currentSetting) {
    const { data, error } = await supabase
      .from("daily_yield_bin_settings")
      .update({ cases_per_bin: casesPerBin, updated_at: now })
      .eq("id", currentSetting.id)
      .eq("organization_id", organizationId)
      .select("id, cases_per_bin, created_at, updated_at")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to update bin settings.", "Bin settings update error:", error);
    }

    return res.json(data);
  }

  const { data, error } = await supabase
    .from("daily_yield_bin_settings")
    .insert({ organization_id: organizationId, cases_per_bin: casesPerBin, updated_at: now })
    .select("id, cases_per_bin, created_at, updated_at")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create bin settings.", "Bin settings insert error:", error);
  }

  return res.status(201).json(data);
});

mobileDailyYieldRouter.post("/mobile/daily-yield/samples", canWrite, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: MobileYieldSamplePayload;

  try {
    payload = validateSamplePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  try {
    await ensureRowLinkedToVariety(payload.variety_id, payload.row_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid row/variety selection";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("daily_yield_samples")
    .insert({
      organization_id: organizationId,
      variety_id: payload.variety_id,
      row_id: payload.row_id,
      phase_id: payload.phase_id,
      phase_name: payload.phase_name,
      row_label: payload.row_label,
      row_number: payload.row_number,
      bin_fill_percent: payload.percent_full,
      percent_full: payload.percent_full,
      kg_per_full_bin: payload.kg_per_full_bin,
      kg_per_case: payload.kg_per_case,
      calculated_sample_kg: payload.calculated_sample_kg,
      calculated_kg_per_stem: payload.calculated_kg_per_stem,
      sample_date: payload.sample_date,
      session_year: payload.session_year,
      session_week: payload.session_week
    })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to save yield sample.", "Daily yield sample insert error:", error);
  }

  return res.status(201).json(data);
});

mobileDailyYieldRouter.get("/mobile/daily-yield/samples", canView, async (req, res) => {
  const organizationId = req.organizationId;

  try {
    const varietyId = parseId(req.query.variety_id, "variety_id");
    const sessionYear = parseRequiredInteger(req.query.session_year, "session_year");
    const sessionWeek = parseRequiredInteger(req.query.session_week, "session_week");

    const { data, error } = await supabase
      .from("daily_yield_samples")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("variety_id", varietyId)
      .eq("session_year", sessionYear)
      .eq("session_week", sessionWeek)
      .order("created_at", { ascending: true });

    if (error) {
      return sendSafeError(res, 500, "Failed to load yield samples.", "Daily yield samples fetch error:", error);
    }

    return res.json(data ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load samples";
    return res.status(400).json({ message });
  }
});

mobileDailyYieldRouter.delete("/mobile/daily-yield/samples", canWrite, async (req, res) => {
  const organizationId = req.organizationId;

  try {
    const varietyId = parseId(req.query.variety_id, "variety_id");
    const sessionYear = parseRequiredInteger(req.query.session_year, "session_year");
    const sessionWeek = parseRequiredInteger(req.query.session_week, "session_week");

    const { error } = await supabase
      .from("daily_yield_samples")
      .delete()
      .eq("organization_id", organizationId)
      .eq("variety_id", varietyId)
      .eq("session_year", sessionYear)
      .eq("session_week", sessionWeek);

    if (error) {
      return sendSafeError(res, 500, "Failed to delete yield samples.", "Daily yield samples delete error:", error);
    }

    return res.status(204).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reset samples";
    return res.status(400).json({ message });
  }
});

mobileDailyYieldRouter.get("/mobile/daily-yield/today-projection", async (req, res) => {
  const organizationId = req.organizationId;

  // ISO week/year matching the client-side getIsoWeekAndYear formula
  const now = new Date();
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const sessionWeek = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const sessionYear = utcDate.getUTCFullYear();

  const MINIMUM_SAMPLE_COUNT = 4;

  try {
    const [samplesResult, optionsResult, binSettings] = await Promise.all([
      supabase
        .from("daily_yield_samples")
        .select("variety_id, calculated_kg_per_stem")
        .eq("organization_id", organizationId)
        .eq("session_year", sessionYear)
        .eq("session_week", sessionWeek),
      fetchRowsLinkedToActiveVarieties(organizationId),
      getCurrentBinSettings(organizationId)
    ]);

    if (samplesResult.error) {
      return sendSafeError(res, 500, "Failed to load yield projection.", "Projection samples fetch error:", samplesResult.error);
    }

    const samples = samplesResult.data ?? [];
    const varieties = optionsResult.varieties;
    const linkedRows = optionsResult.rows;

    const kgPerCase = binSettings.caseKg;
    const kgPerFullBin = binSettings.pickingBinKg;
    const casesPerBin = binSettings.casesPerBin;

    const canUseKgPerCase = typeof kgPerCase === "number" && kgPerCase > 0;
    const canUseKgPerBin =
      typeof kgPerFullBin === "number" && kgPerFullBin > 0 && casesPerBin > 0;

    if (!canUseKgPerCase && !canUseKgPerBin) {
      return res.json({ hasProjection: false });
    }

    const samplesByVariety = new Map<string, number[]>();
    for (const sample of samples) {
      const kg = Number(sample.calculated_kg_per_stem);
      if (!Number.isFinite(kg) || kg <= 0) continue;
      const list = samplesByVariety.get(sample.variety_id) ?? [];
      list.push(kg);
      samplesByVariety.set(sample.variety_id, list);
    }

    const stemsByVariety = new Map<string, number>();
    for (const row of linkedRows) {
      stemsByVariety.set(row.variety_id, (stemsByVariety.get(row.variety_id) ?? 0) + row.total_stems);
    }

    const varietyColorById = new Map<string, string>();
    const varietyNameById = new Map<string, string>();
    for (const variety of varieties) {
      if (variety.color) varietyColorById.set(variety.id, variety.color);
      varietyNameById.set(variety.id, variety.name);
    }

    let totalSampledRows = 0;
    const byVariety: Array<{
      varietyId: string;
      varietyName: string;
      color: string;
      projectedCases: number;
      sampledRowCount: number;
    }> = [];
    const colorTotals = new Map<string, number>();

    for (const [varietyId, kgValues] of samplesByVariety.entries()) {
      if (kgValues.length < MINIMUM_SAMPLE_COUNT) continue;
      const totalLinkedStems = stemsByVariety.get(varietyId) ?? 0;
      if (totalLinkedStems <= 0) continue;
      const avgKgPerStem = kgValues.reduce((s, k) => s + k, 0) / kgValues.length;
      if (!Number.isFinite(avgKgPerStem) || avgKgPerStem <= 0) continue;
      const projectedKg = avgKgPerStem * totalLinkedStems;
      const projectedCases = canUseKgPerCase
        ? projectedKg / kgPerCase!
        : (projectedKg / kgPerFullBin!) * casesPerBin;
      if (!Number.isFinite(projectedCases) || projectedCases <= 0) continue;
      totalSampledRows += kgValues.length;
      const color = varietyColorById.get(varietyId) ?? "unknown";
      byVariety.push({
        varietyId,
        varietyName: varietyNameById.get(varietyId) ?? "Unknown",
        color,
        projectedCases,
        sampledRowCount: kgValues.length
      });
      colorTotals.set(color, (colorTotals.get(color) ?? 0) + projectedCases);
    }

    if (byVariety.length === 0) {
      return res.json({ hasProjection: false });
    }

    const byColor = Array.from(colorTotals.entries())
      .map(([color, totalCases]) => ({ color, totalCases }))
      .sort((a, b) => a.color.localeCompare(b.color));

    const grandTotal = byColor.reduce((sum, e) => sum + e.totalCases, 0);

    return res.json({
      hasProjection: true,
      sessionYear,
      sessionWeek,
      sampledRowCount: totalSampledRows,
      byVariety: byVariety.sort(
        (a, b) => a.color.localeCompare(b.color) || a.varietyName.localeCompare(b.varietyName)
      ),
      byColor,
      grandTotal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load yield projection";
    return res.status(500).json({ message });
  }
});

export { mobileDailyYieldRouter };
