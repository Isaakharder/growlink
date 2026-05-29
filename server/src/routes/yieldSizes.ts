import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

type YieldSizeStatus = "active" | "inactive";

type YieldSizePayload = {
  name: string;
  sort_order: number;
  status: YieldSizeStatus;
};

const STATUS_VALUES: YieldSizeStatus[] = ["active", "inactive"];

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

function validatePayload(input: unknown): YieldSizePayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const statusValue =
    typeof body.status === "string" ? body.status.toLowerCase() : "";

  if (!name) {
    throw new Error("name is required");
  }

  const sort_order = parseNonNegativeInteger(body.sort_order, "sort_order");

  if (!STATUS_VALUES.includes(statusValue as YieldSizeStatus)) {
    throw new Error("status must be active or inactive");
  }

  return {
    name,
    sort_order,
    status: statusValue as YieldSizeStatus
  };
}

const yieldSizesRouter = Router();

const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

yieldSizesRouter.get("/yield-sizes", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("yield_sizes")
    .select("*")
    .eq("organization_id", organizationId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load yield sizes.", "Yield sizes fetch error:", error);
  }

  return res.json(data ?? []);
});

yieldSizesRouter.post("/yield-sizes", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: YieldSizePayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create yield size.", "Yield size insert error:", error);
  }

  return res.status(201).json(data);
});

yieldSizesRouter.put("/yield-sizes/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: YieldSizePayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update yield size.", "Yield size update error:", error);
  }

  return res.json(data);
});

yieldSizesRouter.delete("/yield-sizes/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("yield_sizes")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete yield size.", "Yield size delete error:", error);
  }

  return res.status(204).send();
});

export { yieldSizesRouter };
