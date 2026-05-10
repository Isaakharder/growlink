import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";
type RowPattern = "all" | "odd" | "even";

type GreenhouseGroupPayload = {
  type: GroupType;
  name: string;
  status: StatusType;
};

type GreenhouseRowSectionPayload = {
  group_id: string;
  start_row: number;
  end_row: number;
  row_pattern: RowPattern;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
};

type GreenhouseRowPayload = {
  row_number: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
};

type GreenhouseVarietyAssignmentPayload = {
  group_id: string;
  variety_id: string;
  start_row: number;
  end_row: number;
};

const GROUP_TYPES: GroupType[] = ["phase", "zone", "color"];
const STATUS_TYPES: StatusType[] = ["active", "inactive"];
const ROW_PATTERNS: RowPattern[] = ["all", "odd", "even"];

function parseName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }

  return name;
}

function parseStatus(value: unknown): StatusType {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (!STATUS_TYPES.includes(status as StatusType)) {
    throw new Error("status must be active or inactive");
  }

  return status as StatusType;
}

function parseType(value: unknown): GroupType {
  const type = typeof value === "string" ? value.toLowerCase() : "";
  if (!GROUP_TYPES.includes(type as GroupType)) {
    throw new Error("type must be phase, zone, or color");
  }

  return type as GroupType;
}

function parsePattern(value: unknown): RowPattern {
  const pattern = typeof value === "string" ? value.toLowerCase() : "";
  if (!ROW_PATTERNS.includes(pattern as RowPattern)) {
    throw new Error("row_pattern must be all, odd, or even");
  }

  return pattern as RowPattern;
}

function parseInteger(
  value: unknown,
  fieldName: string,
  min: number,
  strictGreaterThan = false
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} is required`);
  }

  if (!Number.isInteger(parsed) && fieldName !== "stems_per_plant") {
    throw new Error(`${fieldName} must be a whole number`);
  }

  if (strictGreaterThan ? parsed <= min : parsed < min) {
    throw new Error(
      strictGreaterThan
        ? `${fieldName} must be greater than ${min}`
        : `${fieldName} must be ${min} or greater`
    );
  }

  return parsed;
}

function validateGroupPayload(input: unknown): GreenhouseGroupPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  return {
    type: parseType(body.type),
    name: parseName(body.name),
    status: parseStatus(body.status)
  };
}

function validateRowSectionPayload(input: unknown): GreenhouseRowSectionPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const group_id = typeof body.group_id === "string" ? body.group_id.trim() : "";
  const start_row = parseInteger(body.start_row, "start_row", 1);
  const end_row = parseInteger(body.end_row, "end_row", 1);

  if (!group_id) {
    throw new Error("group_id is required");
  }

  if (end_row < start_row) {
    throw new Error("end_row must be greater than or equal to start_row");
  }

  return {
    group_id,
    start_row,
    end_row,
    row_pattern: parsePattern(body.row_pattern),
    slab_count: parseInteger(body.slab_count, "slab_count", 0),
    plants_per_slab: parseInteger(body.plants_per_slab, "plants_per_slab", 0),
    stems_per_plant: parseInteger(body.stems_per_plant, "stems_per_plant", 0, true)
  };
}

function validateRowPayload(input: unknown): GreenhouseRowPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  return {
    row_number: parseInteger(body.row_number, "row_number", 1),
    slab_count: parseInteger(body.slab_count, "slab_count", 0),
    plants_per_slab: parseInteger(body.plants_per_slab, "plants_per_slab", 0),
    stems_per_plant: parseInteger(body.stems_per_plant, "stems_per_plant", 0, true)
  };
}

function validateVarietyAssignmentPayload(
  input: unknown
): GreenhouseVarietyAssignmentPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const group_id = typeof body.group_id === "string" ? body.group_id.trim() : "";
  const variety_id = typeof body.variety_id === "string" ? body.variety_id.trim() : "";
  const start_row = parseInteger(body.start_row, "start_row", 1);
  const end_row = parseInteger(body.end_row, "end_row", 1);

  if (!group_id) {
    throw new Error("group_id is required");
  }

  if (!variety_id) {
    throw new Error("variety_id is required");
  }

  if (end_row < start_row) {
    throw new Error("end_row must be greater than or equal to start_row");
  }

  return {
    group_id,
    variety_id,
    start_row,
    end_row
  };
}

function generateRowNumbers(startRow: number, endRow: number, pattern: RowPattern) {
  const rowNumbers: number[] = [];

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    if (pattern === "odd" && rowNumber % 2 === 0) {
      continue;
    }

    if (pattern === "even" && rowNumber % 2 !== 0) {
      continue;
    }

    rowNumbers.push(rowNumber);
  }

  return rowNumbers;
}

async function ensureGroupExists(groupId: string, organizationId: string) {
  const { data, error } = await supabase
    .from("greenhouse_groups")
    .select("id")
    .eq("id", groupId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) {
    throw new Error("Selected group was not found");
  }
}

async function ensureVarietyExists(varietyId: string, organizationId: string) {
  const { data, error } = await supabase
    .from("varieties")
    .select("id")
    .eq("id", varietyId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) {
    throw new Error("Selected variety was not found");
  }
}

async function ensureAssignmentRangeWithinGeneratedRows(
  groupId: string,
  organizationId: string,
  startRow: number,
  endRow: number
) {
  const { data, error } = await supabase
    .from("greenhouse_rows")
    .select("row_number")
    .eq("group_id", groupId)
    .eq("organization_id", organizationId)
    .gte("row_number", startRow)
    .lte("row_number", endRow);

  if (error) {
    console.error("Row assignment range validation error:", error);
    throw new Error("Failed to validate row assignment range.");
  }

  const generatedRows = new Set((data ?? []).map((row) => row.row_number as number));

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    if (!generatedRows.has(rowNumber)) {
      throw new Error(
        `Row range ${startRow}-${endRow} is outside the selected group's generated rows`
      );
    }
  }
}

async function upsertRowsFromSection(
  sectionId: string,
  organizationId: string,
  payload: GreenhouseRowSectionPayload
) {
  const rowNumbers = generateRowNumbers(payload.start_row, payload.end_row, payload.row_pattern);

  if (rowNumbers.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  const rows = rowNumbers.map((rowNumber) => ({
    organization_id: organizationId,
    group_id: payload.group_id,
    section_id: sectionId,
    row_number: rowNumber,
    slab_count: payload.slab_count,
    plants_per_slab: payload.plants_per_slab,
    stems_per_plant: payload.stems_per_plant,
    updated_at: now
  }));

  const { error } = await supabase
    .from("greenhouse_rows")
    .upsert(rows, { onConflict: "group_id,row_number" });

  if (error) {
    console.error("Row upsert error:", error);
    throw new Error("Failed to generate greenhouse rows.");
  }
}

const greenhouseSetupRouter = Router();

greenhouseSetupRouter.get("/greenhouse-setup", async (req, res) => {
  const organizationId = req.organizationId;

  const [groupsResult, sectionsResult, rowsResult, assignmentsResult, varietiesResult] =
    await Promise.all([
    supabase
      .from("greenhouse_groups")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("greenhouse_row_sections")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("greenhouse_rows")
      .select("*")
      .eq("organization_id", organizationId)
      .order("row_number", { ascending: true })
      ,
    supabase
      .from("greenhouse_variety_assignments")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("varieties")
      .select("id,name,color,status")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true })
  ]);

  if (groupsResult.error) {
    return sendSafeError(res, 500, "Failed to load greenhouse setup.", "Greenhouse setup - groups error:", groupsResult.error);
  }

  if (sectionsResult.error) {
    return sendSafeError(res, 500, "Failed to load greenhouse setup.", "Greenhouse setup - sections error:", sectionsResult.error);
  }

  if (rowsResult.error) {
    return sendSafeError(res, 500, "Failed to load greenhouse setup.", "Greenhouse setup - rows error:", rowsResult.error);
  }

  if (assignmentsResult.error) {
    return sendSafeError(res, 500, "Failed to load greenhouse setup.", "Greenhouse setup - assignments error:", assignmentsResult.error);
  }

  if (varietiesResult.error) {
    return sendSafeError(res, 500, "Failed to load greenhouse setup.", "Greenhouse setup - varieties error:", varietiesResult.error);
  }

  return res.json({
    groups: groupsResult.data ?? [],
    rowSections: sectionsResult.data ?? [],
    rows: rowsResult.data ?? [],
    varietyAssignments: assignmentsResult.data ?? [],
    varieties: varietiesResult.data ?? []
  });
});

greenhouseSetupRouter.post("/greenhouse-groups", async (req, res) => {
  const organizationId = req.organizationId;
  let payload: GreenhouseGroupPayload;

  try {
    payload = validateGroupPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("greenhouse_groups")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create greenhouse group.", "Greenhouse group insert error:", error);
  }

  return res.status(201).json(data);
});

greenhouseSetupRouter.put("/greenhouse-groups/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: GreenhouseGroupPayload;

  try {
    payload = validateGroupPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("greenhouse_groups")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update greenhouse group.", "Greenhouse group update error:", error);
  }

  return res.json(data);
});

greenhouseSetupRouter.delete("/greenhouse-groups/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("greenhouse_groups")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete greenhouse group.", "Greenhouse group delete error:", error);
  }

  return res.status(204).send();
});

greenhouseSetupRouter.post("/greenhouse-row-sections", async (req, res) => {
  const organizationId = req.organizationId;
  let payload: GreenhouseRowSectionPayload;

  try {
    payload = validateRowSectionPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data: sectionData, error: sectionError } = await supabase
    .from("greenhouse_row_sections")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (sectionError || !sectionData) {
    return sendSafeError(res, 500, "Failed to create row section.", "Greenhouse row section insert error:", sectionError ?? new Error("No data returned"));
  }

  try {
    await upsertRowsFromSection((sectionData as { id: string }).id, organizationId, payload);
  } catch (error) {
    await supabase
      .from("greenhouse_row_sections")
      .delete()
      .eq("id", (sectionData as { id: string }).id)
      .eq("organization_id", organizationId);

    return sendSafeError(res, 500, "Failed to generate greenhouse rows.", "Greenhouse row upsert error:", error);
  }

  return res.status(201).json(sectionData);
});

greenhouseSetupRouter.put("/greenhouse-row-sections/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: GreenhouseRowSectionPayload;

  try {
    payload = validateRowSectionPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data: updatedSection, error: sectionError } = await supabase
    .from("greenhouse_row_sections")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (sectionError || !updatedSection) {
    return sendSafeError(res, 500, "Failed to update row section.", "Greenhouse row section update error:", sectionError ?? new Error("No data returned"));
  }

  const rowNumbersToKeep = generateRowNumbers(
    payload.start_row,
    payload.end_row,
    payload.row_pattern
  );

  if (rowNumbersToKeep.length === 0) {
    const { error: clearError } = await supabase
      .from("greenhouse_rows")
      .delete()
      .eq("section_id", id)
      .eq("organization_id", organizationId);

    if (clearError) {
      return sendSafeError(res, 500, "Failed to update greenhouse rows.", "Greenhouse row clear error:", clearError);
    }
  } else {
    const { error: clearError } = await supabase
      .from("greenhouse_rows")
      .delete()
      .eq("section_id", id)
      .eq("organization_id", organizationId)
      .not("row_number", "in", `(${rowNumbersToKeep.join(",")})`);

    if (clearError) {
      return sendSafeError(res, 500, "Failed to update greenhouse rows.", "Greenhouse row clear error:", clearError);
    }
  }

  try {
    await upsertRowsFromSection(id, organizationId, payload);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to update greenhouse rows.", "Greenhouse row upsert error:", error);
  }

  return res.json(updatedSection);
});

greenhouseSetupRouter.delete("/greenhouse-row-sections/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error: rowsError } = await supabase
    .from("greenhouse_rows")
    .delete()
    .eq("section_id", id)
    .eq("organization_id", organizationId);

  if (rowsError) {
    return sendSafeError(res, 500, "Failed to delete greenhouse rows.", "Greenhouse rows delete error:", rowsError);
  }

  const { error } = await supabase
    .from("greenhouse_row_sections")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete row section.", "Greenhouse row section delete error:", error);
  }

  return res.status(204).send();
});

greenhouseSetupRouter.put("/greenhouse-rows/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: GreenhouseRowPayload;

  try {
    payload = validateRowPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("greenhouse_rows")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update greenhouse row.", "Greenhouse row update error:", error);
  }

  return res.json(data);
});

greenhouseSetupRouter.post("/greenhouse-variety-assignments", async (req, res) => {
  const organizationId = req.organizationId;
  let payload: GreenhouseVarietyAssignmentPayload;

  try {
    payload = validateVarietyAssignmentPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
    await ensureVarietyExists(payload.variety_id, organizationId);
    await ensureAssignmentRangeWithinGeneratedRows(
      payload.group_id,
      organizationId,
      payload.start_row,
      payload.end_row
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("greenhouse_variety_assignments")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create variety assignment.", "Greenhouse variety assignment insert error:", error);
  }

  return res.status(201).json(data);
});

greenhouseSetupRouter.put("/greenhouse-variety-assignments/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: GreenhouseVarietyAssignmentPayload;

  try {
    payload = validateVarietyAssignmentPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
    await ensureVarietyExists(payload.variety_id, organizationId);
    await ensureAssignmentRangeWithinGeneratedRows(
      payload.group_id,
      organizationId,
      payload.start_row,
      payload.end_row
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("greenhouse_variety_assignments")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update variety assignment.", "Greenhouse variety assignment update error:", error);
  }

  return res.json(data);
});

greenhouseSetupRouter.delete("/greenhouse-variety-assignments/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("greenhouse_variety_assignments")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete variety assignment.", "Greenhouse variety assignment delete error:", error);
  }

  return res.status(204).send();
});

export { greenhouseSetupRouter };
