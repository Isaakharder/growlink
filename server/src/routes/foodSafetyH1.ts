import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";

const h1Router = Router();

const canView = requireAnyPermission(["pest:view", "pest:edit"]);
const canEdit = requirePermission("pest:edit");

// Whitelist of fields the user may update. organization_id, pest_job_id, id,
// and created_at are intentionally excluded to prevent cross-org tampering.
const EDITABLE_FIELDS = new Set([
  "operation_name", "current_crop", "previous_year_crops", "variety",
  "production_site_information", "production_site_area", "date_planted",
  "application_date", "product_name", "pcp_number",
  "actual_quantity_used", "actual_quantity_unit", "rate_applied_per_unit",
  "label_instructions_followed", "area_quantity_treated_m2",
  "method_of_application", "row_house_zones",
  "earliest_allowable_harvest_date", "phi_daa",
  "applicator_name", "confirmation_signature", "confirmation_date",
  "version_label",
]);

// Numeric fields — will be coerced to number or null
const NUMERIC_FIELDS = new Set([
  "actual_quantity_used", "area_quantity_treated_m2", "phi_daa",
]);

// Date fields — expected as YYYY-MM-DD string or null
const DATE_FIELDS = new Set([
  "application_date", "date_planted",
  "earliest_allowable_harvest_date", "confirmation_date",
]);

function parseFieldValue(key: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;

  if (NUMERIC_FIELDS.has(key)) {
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    return Number.isFinite(n) ? n : null;
  }

  if (key === "label_instructions_followed") {
    return raw === true || raw === "true";
  }

  if (DATE_FIELDS.has(key)) {
    if (typeof raw !== "string") return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  }

  return typeof raw === "string" ? raw.trim() || null : null;
}

// GET /records/h1 — org-scoped H1 food safety logs, newest first
h1Router.get("/records/h1", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("food_safety_h1_logs")
    .select("*")
    .eq("organization_id", organizationId)
    .order("application_date", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load H1 logs.", "H1 list fetch error:", error);
  }

  return res.json(data ?? []);
});

// GET /records/h1/:id — single org-scoped H1 log
h1Router.get("/records/h1/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { data, error } = await supabase
    .from("food_safety_h1_logs")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to load H1 log.", "H1 fetch error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "H1 log not found" });
  }

  return res.json(data);
});

// PATCH /records/h1/:id — update editable H1 fields (pest:edit required)
h1Router.patch("/records/h1/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  // Verify the log belongs to this org before updating
  const { data: existing, error: fetchError } = await supabase
    .from("food_safety_h1_logs")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load H1 log.", "H1 patch fetch error:", fetchError);
  }
  if (!existing) {
    return res.status(404).json({ message: "H1 log not found" });
  }

  // Build the update payload from the whitelist only
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    updates[key] = parseFieldValue(key, value);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: "No valid fields provided" });
  }

  const { data: updated, error: updateError } = await supabase
    .from("food_safety_h1_logs")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (updateError) {
    return sendSafeError(res, 500, "Failed to update H1 log.", "H1 patch error:", updateError);
  }

  return res.json(updated);
});

// GET /records/h1/:id/pdf — return single H1 log data for client-side PDF generation
h1Router.get("/records/h1/:id/pdf", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { data, error } = await supabase
    .from("food_safety_h1_logs")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to load H1 log.", "H1 pdf fetch error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "H1 log not found" });
  }

  return res.json(data);
});

export { h1Router };
