import { Router } from "express";
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

type DepartmentPayload = {
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
};

function validateDepartmentPayload(input: unknown): DepartmentPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  return {
    name: parseRequiredName(body.name),
    description: parseOptionalText(body.description, "description"),
    active: parseActive(body.active),
    sort_order: parseSortOrder(body.sort_order)
  };
}

const departmentsRouter = Router();

// A user with only food_safety:manage_departments can still read departments
// (they need to see what they're managing) — mirrors the existing
// requireAnyPermission(["x:view", "x:edit"]) pattern used for pest/irrigation.
const canView = requireAnyPermission(["food_safety:view", "food_safety:manage_departments"]);
const canManage = requirePermission("food_safety:manage_departments");

// GET /food-safety/departments — org-scoped list, sorted for display
departmentsRouter.get("/food-safety/departments", canView, async (req, res) => {
  const scope = orgScopedTable("food_safety_departments", req.organizationId);

  const { data, error } = await scope
    .selectAll()
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load departments.", "Food safety departments list error:", error);
  }

  return res.json(data ?? []);
});

// POST /food-safety/departments — create
departmentsRouter.post("/food-safety/departments", canManage, async (req, res) => {
  let payload: DepartmentPayload;

  try {
    payload = validateDepartmentPayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_departments", req.organizationId);
  const { data, error } = await scope.insert(payload);

  if (error) {
    return sendSafeError(res, 500, "Failed to create department.", "Food safety department insert error:", error);
  }

  return res.status(201).json(data);
});

// PUT /food-safety/departments/:id — update (used for edits and for
// activate/deactivate, which the client implements by resending the full
// row with `active` flipped).
departmentsRouter.put("/food-safety/departments/:id", canManage, async (req, res) => {
  const id = req.params.id as string;
  let payload: DepartmentPayload;

  try {
    payload = validateDepartmentPayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_departments", req.organizationId);
  const { data, error } = await scope.update(id, payload);

  if (error) {
    return sendSafeError(res, 500, "Failed to update department.", "Food safety department update error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "Department not found" });
  }

  return res.json(data);
});

// POST /food-safety/departments/reorder — body: { orderedIds: string[] }
// Every id must already belong to this organization; sort_order is set to
// each id's index in the array.
departmentsRouter.post("/food-safety/departments/reorder", canManage, async (req, res) => {
  let orderedIds: string[];

  try {
    orderedIds = parseOrderedIds(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_departments", req.organizationId);

  const { data: existing, error: fetchError } = await scope.selectAll("id").in("id", orderedIds);
  if (fetchError) {
    return sendSafeError(res, 500, "Failed to reorder departments.", "Food safety department reorder fetch error:", fetchError);
  }

  const existingIds = new Set(
    ((existing ?? []) as Array<{ id: string }>).map((row) => row.id)
  );
  const unknownIds = orderedIds.filter((id) => !existingIds.has(id));
  if (unknownIds.length > 0) {
    return res.status(400).json({ message: "One or more departments were not found in this organization." });
  }

  const results = await Promise.all(orderedIds.map((id, index) => scope.update(id, { sort_order: index })));
  const failed = results.find((result) => result.error);
  if (failed?.error) {
    return sendSafeError(res, 500, "Failed to reorder departments.", "Food safety department reorder update error:", failed.error);
  }

  return res.json({ success: true });
});

export { departmentsRouter };
