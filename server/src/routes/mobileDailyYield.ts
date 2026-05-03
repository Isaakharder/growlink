import { Router } from "express";
import { supabase } from "../config/supabase";

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

function parseRequiredNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} is required`);
  }

  return parsed;
}

function parseBinFillPercent(value: unknown): number {
  const parsed = parseRequiredNumber(value, "bin_fill_percent");

  if (parsed < 0 || parsed > 100) {
    throw new Error("bin_fill_percent must be between 0 and 100");
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

async function getCurrentCasesPerBin(): Promise<number> {
  const { data, error } = await supabase
    .from("daily_yield_bin_settings")
    .select("cases_per_bin")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return 38;
  }

  return Number(data.cases_per_bin);
}

async function fetchRowsLinkedToActiveVarieties() {
  const [varietiesResult, assignmentsResult, rowsResult] = await Promise.all([
    supabase
      .from("varieties")
      .select("id, name, color, status")
      .eq("status", "active")
      .order("name", { ascending: true }),
    supabase
      .from("greenhouse_variety_assignments")
      .select("variety_id, group_id, start_row, end_row"),
    supabase
      .from("greenhouse_rows")
      .select("id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant")
      .order("row_number", { ascending: true })
  ]);

  if (varietiesResult.error) {
    throw new Error(varietiesResult.error.message);
  }

  if (assignmentsResult.error) {
    throw new Error(assignmentsResult.error.message);
  }

  if (rowsResult.error) {
    throw new Error(rowsResult.error.message);
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

async function ensureRowLinkedToVariety(varietyId: string, rowId: string) {
  const { data: rowData, error: rowError } = await supabase
    .from("greenhouse_rows")
    .select("id, group_id, row_number")
    .eq("id", rowId)
    .single();

  if (rowError || !rowData) {
    throw new Error("Selected row was not found");
  }

  const { data: assignmentData, error: assignmentError } = await supabase
    .from("greenhouse_variety_assignments")
    .select("id")
    .eq("variety_id", varietyId)
    .eq("group_id", rowData.group_id)
    .lte("start_row", rowData.row_number)
    .gte("end_row", rowData.row_number)
    .limit(1)
    .maybeSingle();

  if (assignmentError) {
    throw new Error(assignmentError.message);
  }

  if (!assignmentData) {
    throw new Error("Selected row is not linked to the selected variety");
  }
}

const mobileDailyYieldRouter = Router();

mobileDailyYieldRouter.get("/mobile/daily-yield/options", async (_req, res) => {
  try {
    const [options, casesPerBin] = await Promise.all([
      fetchRowsLinkedToActiveVarieties(),
      getCurrentCasesPerBin()
    ]);

    return res.json({
      varieties: options.varieties,
      rows: options.rows,
      casesPerBin
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load options";
    return res.status(500).json({ message });
  }
});

mobileDailyYieldRouter.get("/mobile/daily-yield/settings", async (_req, res) => {
  try {
    const casesPerBin = await getCurrentCasesPerBin();
    return res.json({ cases_per_bin: casesPerBin });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load settings";
    return res.status(500).json({ message });
  }
});

mobileDailyYieldRouter.put("/mobile/daily-yield/settings", async (req, res) => {
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
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (currentError) {
    return res.status(500).json({ message: currentError.message });
  }

  if (currentSetting) {
    const { data, error } = await supabase
      .from("daily_yield_bin_settings")
      .update({ cases_per_bin: casesPerBin, updated_at: now })
      .eq("id", currentSetting.id)
      .select("id, cases_per_bin, created_at, updated_at")
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    return res.json(data);
  }

  const { data, error } = await supabase
    .from("daily_yield_bin_settings")
    .insert({ cases_per_bin: casesPerBin, updated_at: now })
    .select("id, cases_per_bin, created_at, updated_at")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(201).json(data);
});

mobileDailyYieldRouter.post("/mobile/daily-yield/samples", async (req, res) => {
  let varietyId: string;
  let rowId: string;
  let binFillPercent: number;

  try {
    const body = req.body as Record<string, unknown>;
    varietyId = parseId(body.variety_id, "variety_id");
    rowId = parseId(body.row_id, "row_id");
    binFillPercent = parseBinFillPercent(body.bin_fill_percent);
    await ensureRowLinkedToVariety(varietyId, rowId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("daily_yield_samples")
    .insert({
      variety_id: varietyId,
      row_id: rowId,
      bin_fill_percent: binFillPercent
    })
    .select("id, variety_id, row_id, bin_fill_percent, created_at")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(201).json(data);
});

export { mobileDailyYieldRouter };
