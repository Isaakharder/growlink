import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { fetchCsvSizeSettings } from "../utils/csvSizeSettings";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";
type RowPattern = "all" | "every_other";
type LegacyRowPattern = RowPattern | "odd" | "even";
type AssignmentPattern = "all" | "every_other";

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
  width_meters: number | null;
  length_meters: number | null;
};

type GreenhouseRowPayload = {
  row_number: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  width_meters: number | null;
  length_meters: number | null;
};

type GreenhouseVarietyAssignmentPayload = {
  group_id: string;
  variety_id: string;
  start_row: number;
  end_row: number;
  assignment_pattern: AssignmentPattern;
};

const GROUP_TYPES: GroupType[] = ["phase", "zone", "color"];
const STATUS_TYPES: StatusType[] = ["active", "inactive"];
const LEGACY_ROW_PATTERNS: LegacyRowPattern[] = ["all", "every_other", "odd", "even"];
const ASSIGNMENT_PATTERNS: AssignmentPattern[] = ["all", "every_other"];

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
  if (!LEGACY_ROW_PATTERNS.includes(pattern as LegacyRowPattern)) {
    throw new Error("row_pattern must be all or every_other");
  }

  return pattern === "all" ? "all" : "every_other";
}

function normalizeRowPattern(value: unknown): RowPattern {
  return value === "all" ? "all" : "every_other";
}

function toStoredRowPattern(pattern: RowPattern, startRow: number): LegacyRowPattern {
  if (pattern === "all") {
    return "all";
  }

  return startRow % 2 === 0 ? "even" : "odd";
}

function parseAssignmentPattern(value: unknown): AssignmentPattern {
  if (value === null || value === undefined || value === "") {
    return "all";
  }

  const pattern = typeof value === "string" ? value.toLowerCase() : "";
  if (!ASSIGNMENT_PATTERNS.includes(pattern as AssignmentPattern)) {
    throw new Error("assignment_pattern must be all or every_other");
  }

  return pattern as AssignmentPattern;
}

function parseOptionalPositiveNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be greater than 0`);
  }
  return parsed;
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
    stems_per_plant: parseInteger(body.stems_per_plant, "stems_per_plant", 0, true),
    width_meters: parseOptionalPositiveNumber(body.width_meters, "width_meters"),
    length_meters: parseOptionalPositiveNumber(body.length_meters, "length_meters")
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
    stems_per_plant: parseInteger(body.stems_per_plant, "stems_per_plant", 0, true),
    width_meters: parseOptionalPositiveNumber(body.width_meters, "width_meters"),
    length_meters: parseOptionalPositiveNumber(body.length_meters, "length_meters")
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
    end_row,
    assignment_pattern: parseAssignmentPattern(body.assignment_pattern)
  };
}

function generateRowNumbers(startRow: number, endRow: number, pattern: RowPattern) {
  const rowNumbers: number[] = [];
  const rowStep = pattern === "every_other" ? 2 : 1;

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += rowStep) {
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
  endRow: number,
  assignmentPattern: AssignmentPattern
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

  const rowStep = assignmentPattern === "every_other" ? 2 : 1;
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += rowStep) {
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
    width_meters: payload.width_meters,
    length_meters: payload.length_meters,
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

const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

// ── Full setup read ───────────────────────────────────────────────────────────

greenhouseSetupRouter.get("/greenhouse-setup", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const [groupsResult, sectionsResult, rowsResult, assignmentsResult, varietiesResult, rowValvesResult] =
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
      .order("row_number", { ascending: true }),
    supabase
      .from("greenhouse_variety_assignments")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("varieties")
      .select("id,name,color,status")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("greenhouse_row_valves")
      .select("id,valve_id,row_id")
      .eq("organization_id", organizationId)
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

  // rowValves gracefully degrades — table may not exist if migration is pending
  const rowValves = rowValvesResult.error ? [] : (rowValvesResult.data ?? []);

  return res.json({
    groups: groupsResult.data ?? [],
    rowSections: (sectionsResult.data ?? []).map((section) => ({
      ...section,
      row_pattern: normalizeRowPattern(section.row_pattern)
    })),
    rows: rowsResult.data ?? [],
    varietyAssignments: assignmentsResult.data ?? [],
    varieties: varietiesResult.data ?? [],
    rowValves
  });
});

// ── Greenhouse groups ─────────────────────────────────────────────────────────

greenhouseSetupRouter.post("/greenhouse-groups", canEdit, async (req, res) => {
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

greenhouseSetupRouter.put("/greenhouse-groups/:id", canEdit, async (req, res) => {
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

greenhouseSetupRouter.delete("/greenhouse-groups/:id", canEdit, async (req, res) => {
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

// ── Row sections ──────────────────────────────────────────────────────────────

greenhouseSetupRouter.post("/greenhouse-row-sections", canEdit, async (req, res) => {
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
    .insert({
      ...payload,
      row_pattern: toStoredRowPattern(payload.row_pattern, payload.start_row),
      organization_id: organizationId
    })
    .select("*")
    .single();

  if (sectionError || !sectionData) {
    console.error("row section save error", sectionError);
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

  return res.status(201).json({
    ...sectionData,
    row_pattern: normalizeRowPattern((sectionData as { row_pattern: unknown }).row_pattern)
  });
});

greenhouseSetupRouter.put("/greenhouse-row-sections/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
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
    .update({
      ...payload,
      row_pattern: toStoredRowPattern(payload.row_pattern, payload.start_row),
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (sectionError || !updatedSection) {
    console.error("row section save error", sectionError);
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

  return res.json({
    ...updatedSection,
    row_pattern: normalizeRowPattern(
      (updatedSection as { row_pattern: unknown }).row_pattern
    )
  });
});

greenhouseSetupRouter.delete("/greenhouse-row-sections/:id", canEdit, async (req, res) => {
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

// ── Individual row edit ───────────────────────────────────────────────────────

greenhouseSetupRouter.put("/greenhouse-rows/:id", canEdit, async (req, res) => {
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

// ── Variety assignments ───────────────────────────────────────────────────────

greenhouseSetupRouter.post("/greenhouse-variety-assignments", canEdit, async (req, res) => {
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
      payload.end_row,
      payload.assignment_pattern
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

greenhouseSetupRouter.put("/greenhouse-variety-assignments/:id", canEdit, async (req, res) => {
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
      payload.end_row,
      payload.assignment_pattern
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

greenhouseSetupRouter.delete("/greenhouse-variety-assignments/:id", canEdit, async (req, res) => {
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

// ── Row-valve link routes ─────────────────────────────────────────────────────

greenhouseSetupRouter.post("/greenhouse/row-valves", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  const valveId = typeof body.valve_id === "string" ? body.valve_id.trim() : "";
  const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";
  const rowPattern = body.row_pattern === "every_other" ? "every_other" : "all";
  const startRow = typeof body.start_row === "number" ? body.start_row : Number(body.start_row);
  const endRow = typeof body.end_row === "number" ? body.end_row : Number(body.end_row);

  console.log("[row-valves] assign request:", { valveId, groupId, rowPattern, startRow, endRow });

  if (!valveId) return res.status(400).json({ message: "valve_id is required" });
  if (!Number.isInteger(startRow) || startRow < 1) return res.status(400).json({ message: "start_row must be a positive integer" });
  if (!Number.isInteger(endRow) || endRow < startRow) return res.status(400).json({ message: "end_row must be >= start_row" });

  // Verify valve belongs to org
  const { data: valveData, error: valveError } = await supabase
    .from("irrigation_feed_valves")
    .select("id")
    .eq("id", valveId)
    .eq("organization_id", organizationId)
    .single();

  if (valveError || !valveData) {
    console.log("[row-valves] valve lookup failed:", valveError?.message);
    return res.status(400).json({ message: "Valve not found" });
  }

  // Find rows within the range; optionally scope to a specific group
  let rowQuery = supabase
    .from("greenhouse_rows")
    .select("id, row_number")
    .eq("organization_id", organizationId)
    .gte("row_number", startRow)
    .lte("row_number", endRow);

  if (groupId) rowQuery = rowQuery.eq("group_id", groupId);

  const { data: fetchedRows, error: rowsError } = await rowQuery;

  if (rowsError) {
    console.log("[row-valves] row fetch failed:", rowsError.message);
    return sendSafeError(res, 500, "Failed to look up rows.", "Row-valve rows fetch error:", rowsError);
  }

  console.log("[row-valves] rows found before filter:", fetchedRows?.length ?? 0);

  if (!fetchedRows || fetchedRows.length === 0) {
    return res.status(400).json({ message: "No rows found in the selected range." });
  }

  // Apply every-other-row filter: keep rows whose row_number has the same
  // parity as startRow (so start=1 → odd rows; start=2 → even rows).
  const targetRows =
    rowPattern === "every_other"
      ? fetchedRows.filter((r) => r.row_number % 2 === startRow % 2)
      : fetchedRows;

  console.log("[row-valves] rows after pattern filter:", targetRows.length, `(pattern=${rowPattern})`);

  if (targetRows.length === 0) {
    return res.status(400).json({ message: "No rows matched the selected pattern in this range." });
  }

  const now = new Date().toISOString();
  const upsertRows = targetRows.map((r) => ({
    organization_id: organizationId,
    valve_id: valveId,
    row_id: r.id,
    created_at: now
  }));

  const { error: upsertError } = await supabase
    .from("greenhouse_row_valves")
    .upsert(upsertRows, { onConflict: "organization_id,row_id" });

  if (upsertError) {
    console.log("[row-valves] upsert failed:", upsertError.message, upsertError.details, upsertError.hint);
    return sendSafeError(res, 500, "Failed to assign rows to valve.", "Row-valve upsert error:", upsertError);
  }

  console.log("[row-valves] assigned", targetRows.length, "rows to valve", valveId);
  return res.status(201).json({ assigned: targetRows.length });
});

greenhouseSetupRouter.delete("/greenhouse/row-valves/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("greenhouse_row_valves")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to remove row-valve link.", "Row-valve delete error:", error);
  }

  return res.status(204).send();
});

// ── Bin settings routes ───────────────────────────────────────────────────────

greenhouseSetupRouter.get("/greenhouse-setup/bin-settings", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("daily_yield_bin_settings")
    .select("picking_bin_kg, case_kg")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to load bin settings.", "Bin settings fetch error:", error);
  }

  return res.json({
    picking_bin_kg: data?.picking_bin_kg ?? null,
    case_kg: data?.case_kg ?? null
  });
});

greenhouseSetupRouter.put("/greenhouse-setup/bin-settings", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  let picking_bin_kg: number | null = null;
  let case_kg: number | null = null;

  if (body.picking_bin_kg !== null && body.picking_bin_kg !== undefined && body.picking_bin_kg !== "") {
    const parsed = Number(body.picking_bin_kg);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return res.status(400).json({ message: "kg per full bin must be greater than 0" });
    }
    picking_bin_kg = parsed;
  }

  if (body.case_kg !== null && body.case_kg !== undefined && body.case_kg !== "") {
    const parsed = Number(body.case_kg);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return res.status(400).json({ message: "kg per case must be greater than 0" });
    }
    case_kg = parsed;
  }

  const now = new Date().toISOString();

  const { data: existing, error: fetchError } = await supabase
    .from("daily_yield_bin_settings")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load bin settings.", "Bin settings fetch error:", fetchError);
  }

  if (existing) {
    const { data, error } = await supabase
      .from("daily_yield_bin_settings")
      .update({ picking_bin_kg, case_kg, updated_at: now })
      .eq("id", existing.id)
      .eq("organization_id", organizationId)
      .select("picking_bin_kg, case_kg")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to update bin settings.", "Bin settings update error:", error);
    }

    return res.json(data);
  }

  const { data, error } = await supabase
    .from("daily_yield_bin_settings")
    .insert({ organization_id: organizationId, picking_bin_kg, case_kg, updated_at: now })
    .select("picking_bin_kg, case_kg")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to save bin settings.", "Bin settings insert error:", error);
  }

  return res.status(201).json(data);
});

// ── CSV size settings routes ──────────────────────────────────────────────────

greenhouseSetupRouter.get("/greenhouse-setup/csv-size-settings", canView, async (req, res) => {
  const settings = await fetchCsvSizeSettings(req.organizationId);
  return res.json(settings);
});

greenhouseSetupRouter.patch("/greenhouse-setup/csv-size-settings", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  const ignoredSizeLabels: string[] = Array.isArray(body.ignoredSizeLabels)
    ? (body.ignoredSizeLabels as unknown[])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    : [];

  const sizeAliases: Record<string, string> = {};
  if (body.sizeAliases && typeof body.sizeAliases === "object" && !Array.isArray(body.sizeAliases)) {
    for (const [k, v] of Object.entries(body.sizeAliases as Record<string, unknown>)) {
      if (typeof v === "string" && k.trim().length > 0) {
        sizeAliases[k.trim().toUpperCase()] = v.trim();
      }
    }
  }

  const csv_size_settings = { ignoredSizeLabels, sizeAliases };
  const now = new Date().toISOString();

  const { data: existing, error: fetchError } = await supabase
    .from("daily_yield_bin_settings")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load settings.", "CSV size settings fetch error:", fetchError);
  }

  if (existing) {
    const { error } = await supabase
      .from("daily_yield_bin_settings")
      .update({ csv_size_settings, updated_at: now })
      .eq("id", existing.id)
      .eq("organization_id", organizationId);

    if (error) {
      return sendSafeError(res, 500, "Failed to update CSV size settings.", "CSV size settings update error:", error);
    }
  } else {
    const { error } = await supabase
      .from("daily_yield_bin_settings")
      .insert({ organization_id: organizationId, csv_size_settings, updated_at: now });

    if (error) {
      return sendSafeError(res, 500, "Failed to save CSV size settings.", "CSV size settings insert error:", error);
    }
  }

  return res.json(csv_size_settings);
});

export { greenhouseSetupRouter };
