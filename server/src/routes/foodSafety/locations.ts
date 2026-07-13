import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission, requirePermission } from "../../middleware/requirePermission";
import { orgScopedTable } from "./services/orgScopedTable";
import {
  parseActive,
  parseOptionalText,
  parseOrderedIds,
  parseRequiredName,
  parseSortOrder
} from "./services/validation";

type LocationType = "location" | "asset";
const LOCATION_TYPES: LocationType[] = ["location", "asset"];

type LocationPayload = {
  name: string;
  description: string | null;
  department_id: string | null;
  location_type: LocationType;
  active: boolean;
  sort_order: number;
};

function parseLocationType(value: unknown): LocationType {
  if (value === undefined) return "location";
  const type = typeof value === "string" ? value.toLowerCase() : "";
  if (!LOCATION_TYPES.includes(type as LocationType)) {
    throw new Error("location_type must be 'location' or 'asset'");
  }
  return type as LocationType;
}

function parseDepartmentId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("department_id must be a string");
  }
  return value;
}

// Verifies a department_id belongs to the same organization as the caller
// before it can be attached to a location — mirrors ensureGroupExists in
// server/src/routes/irrigationSetup.ts.
export async function ensureDepartmentExists(departmentId: string, organizationId: string): Promise<void> {
  const { data, error } = await supabase
    .from("food_safety_departments")
    .select("id")
    .eq("id", departmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to verify department");
  }
  if (!data) {
    throw new Error("Selected department was not found in this organization");
  }
}

async function validateLocationPayload(input: unknown, organizationId: string): Promise<LocationPayload> {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const department_id = parseDepartmentId(body.department_id);

  if (department_id) {
    await ensureDepartmentExists(department_id, organizationId);
  }

  return {
    name: parseRequiredName(body.name),
    description: parseOptionalText(body.description, "description"),
    department_id,
    location_type: parseLocationType(body.location_type),
    active: parseActive(body.active),
    sort_order: parseSortOrder(body.sort_order)
  };
}

const locationsRouter = Router();

const canView = requireAnyPermission(["food_safety:view", "food_safety:manage_locations"]);
const canManage = requirePermission("food_safety:manage_locations");

// GET /food-safety/locations — org-scoped list, sorted for display
locationsRouter.get("/food-safety/locations", canView, async (req, res) => {
  const scope = orgScopedTable("food_safety_locations", req.organizationId);

  const { data, error } = await scope
    .selectAll()
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load locations.", "Food safety locations list error:", error);
  }

  return res.json(data ?? []);
});

// POST /food-safety/locations — create
locationsRouter.post("/food-safety/locations", canManage, async (req, res) => {
  let payload: LocationPayload;

  try {
    payload = await validateLocationPayload(req.body, req.organizationId);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_locations", req.organizationId);
  const { data, error } = await scope.insert(payload);

  if (error) {
    return sendSafeError(res, 500, "Failed to create location.", "Food safety location insert error:", error);
  }

  return res.status(201).json(data);
});

// PUT /food-safety/locations/:id — update (also used for activate/deactivate)
locationsRouter.put("/food-safety/locations/:id", canManage, async (req, res) => {
  const id = req.params.id as string;
  let payload: LocationPayload;

  try {
    payload = await validateLocationPayload(req.body, req.organizationId);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_locations", req.organizationId);
  const { data, error } = await scope.update(id, payload);

  if (error) {
    return sendSafeError(res, 500, "Failed to update location.", "Food safety location update error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "Location not found" });
  }

  return res.json(data);
});

// POST /food-safety/locations/reorder — body: { orderedIds: string[] }
locationsRouter.post("/food-safety/locations/reorder", canManage, async (req, res) => {
  let orderedIds: string[];

  try {
    orderedIds = parseOrderedIds(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_locations", req.organizationId);

  const { data: existing, error: fetchError } = await scope.selectAll("id").in("id", orderedIds);
  if (fetchError) {
    return sendSafeError(res, 500, "Failed to reorder locations.", "Food safety location reorder fetch error:", fetchError);
  }

  const existingIds = new Set(
    ((existing ?? []) as Array<{ id: string }>).map((row) => row.id)
  );
  const unknownIds = orderedIds.filter((id) => !existingIds.has(id));
  if (unknownIds.length > 0) {
    return res.status(400).json({ message: "One or more locations were not found in this organization." });
  }

  const results = await Promise.all(orderedIds.map((id, index) => scope.update(id, { sort_order: index })));
  const failed = results.find((result) => result.error);
  if (failed?.error) {
    return sendSafeError(res, 500, "Failed to reorder locations.", "Food safety location reorder update error:", failed.error);
  }

  return res.json({ success: true });
});

export { locationsRouter };
