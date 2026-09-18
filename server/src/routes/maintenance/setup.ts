// Maintenance Setup: Categories, Locations, Part Types.
//
// All three tables (0127) share an identical shape (org-scoped name/
// description/display_order/is_active, case-insensitive unique name), so
// one small factory builds the CRUD routes for each rather than tripling
// near-identical handlers — the three resources are genuinely the same
// shape, not just superficially similar.
//
// Safe-delete-when-unused is enforced by the database (every FK from
// equipment/inventory into these tables is `on delete restrict`, see
// 0128/0129) — DELETE just attempts the delete and converts a 23503
// foreign-key-violation into a 409 asking the caller to deactivate instead.
// This avoids a check-then-delete race between two concurrent requests.

import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError, isUniqueViolation } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { parseOptionalString, parseRequiredString, MaintenanceValidationError } from "./services/validation";

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canEdit = requirePermission("maintenance:edit");

type SetupPayload = {
  name: string;
  description: string | null;
  display_order: number;
};

function validateSetupPayload(input: unknown): SetupPayload {
  if (!input || typeof input !== "object") throw new MaintenanceValidationError("Invalid request body.");
  const body = input as Record<string, unknown>;
  return {
    name: parseRequiredString(body.name, "Name"),
    description: parseOptionalString(body.description),
    display_order: typeof body.display_order === "number" && Number.isFinite(body.display_order) ? body.display_order : 0
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23503");
}

const setupRouter = Router();

function registerSetupResource(table: string, basePath: string, resourceLabel: string) {
  setupRouter.get(basePath, canView, async (req, res) => {
    const organizationId = req.organizationId;
    const { search, active } = req.query;

    let query = supabase
      .from(table)
      .select("*")
      .eq("organization_id", organizationId)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (typeof active === "string" && (active === "true" || active === "false")) {
      query = query.eq("is_active", active === "true");
    }
    if (typeof search === "string" && search.trim()) {
      query = query.ilike("name", `%${search.trim()}%`);
    }

    const { data, error } = await query;
    if (error) return sendSafeError(res, 500, `Failed to load ${resourceLabel}.`, `Maintenance ${resourceLabel} list error:`, error);
    return res.json(data ?? []);
  });

  setupRouter.post(basePath, canEdit, async (req, res) => {
    const organizationId = req.organizationId;
    let payload: SetupPayload;
    try {
      payload = validateSetupPayload(req.body);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
    }

    const { data, error } = await supabase
      .from(table)
      .insert({ ...payload, organization_id: organizationId, created_by: req.userId, updated_by: req.userId })
      .select("*")
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ message: `A ${resourceLabel.replace(/s$/, "")} with this name already exists.` });
      }
      return sendSafeError(res, 500, `Failed to create ${resourceLabel.replace(/s$/, "")}.`, `Maintenance ${resourceLabel} insert error:`, error);
    }
    return res.status(201).json(data);
  });

  setupRouter.put(`${basePath}/:id`, canEdit, async (req, res) => {
    const organizationId = req.organizationId;
    const id = String(req.params.id);
    let payload: SetupPayload;
    try {
      payload = validateSetupPayload(req.body);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body." });
    }

    const { data, error } = await supabase
      .from(table)
      .update({ ...payload, updated_at: new Date().toISOString(), updated_by: req.userId })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("*")
      .maybeSingle();

    if (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ message: `A ${resourceLabel.replace(/s$/, "")} with this name already exists.` });
      }
      return sendSafeError(res, 500, `Failed to update ${resourceLabel.replace(/s$/, "")}.`, `Maintenance ${resourceLabel} update error:`, error);
    }
    if (!data) return res.status(404).json({ message: `${resourceLabel} not found.` });
    return res.json(data);
  });

  setupRouter.post(`${basePath}/:id/deactivate`, canEdit, async (req, res) => {
    const organizationId = req.organizationId;
    const id = String(req.params.id);
    const { data, error } = await supabase
      .from(table)
      .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: req.userId })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("id")
      .maybeSingle();
    if (error) return sendSafeError(res, 500, `Failed to deactivate ${resourceLabel.replace(/s$/, "")}.`, `Maintenance ${resourceLabel} deactivate error:`, error);
    if (!data) return res.status(404).json({ message: `${resourceLabel} not found.` });
    return res.status(204).send();
  });

  setupRouter.post(`${basePath}/:id/reactivate`, canEdit, async (req, res) => {
    const organizationId = req.organizationId;
    const id = String(req.params.id);
    const { data, error } = await supabase
      .from(table)
      .update({ is_active: true, updated_at: new Date().toISOString(), updated_by: req.userId })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("id")
      .maybeSingle();
    if (error) return sendSafeError(res, 500, `Failed to reactivate ${resourceLabel.replace(/s$/, "")}.`, `Maintenance ${resourceLabel} reactivate error:`, error);
    if (!data) return res.status(404).json({ message: `${resourceLabel} not found.` });
    return res.status(204).send();
  });

  setupRouter.delete(`${basePath}/:id`, canEdit, async (req, res) => {
    const organizationId = req.organizationId;
    const id = String(req.params.id);
    const { error } = await supabase
      .from(table)
      .delete()
      .eq("id", id)
      .eq("organization_id", organizationId);

    if (error) {
      if (isForeignKeyViolation(error)) {
        return res.status(409).json({ message: `This ${resourceLabel.replace(/s$/, "")} is still in use — deactivate it instead.` });
      }
      return sendSafeError(res, 500, `Failed to delete ${resourceLabel.replace(/s$/, "")}.`, `Maintenance ${resourceLabel} delete error:`, error);
    }
    return res.status(204).send();
  });
}

registerSetupResource("maintenance_categories", "/maintenance/setup/categories", "categories");
registerSetupResource("maintenance_locations", "/maintenance/setup/locations", "locations");
registerSetupResource("maintenance_part_types", "/maintenance/setup/part-types", "part types");

export { setupRouter, validateSetupPayload };
