import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { IMPORT_SIZE_CROP } from "../utils/cropSizes";
import { loadCatalogProducts, loadOrganizationProducts } from "../utils/organizationProducts";

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

/** The product_code a request names, or null when it names none. */
function requestedCrop(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const yieldSizesRouter = Router();

const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

// Sizes belong to a crop (migration 0152). ?product_code= lists one crop's
// sizes; without it, every crop's, each row naming its crop.
yieldSizesRouter.get("/yield-sizes", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const crop = requestedCrop(req.query.product_code);

  let query = supabase
    .from("yield_sizes")
    .select("*")
    .eq("organization_id", organizationId);
  if (crop) {
    query = query.eq("product_code", crop);
  }

  const { data, error } = await query
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load yield sizes.", "Yield sizes fetch error:", error);
  }

  return res.json(data ?? []);
});

// A new size is added to one crop: the one the request names, which must be
// enabled for the organization. A request naming no crop (a client from
// before crops had sizes) adds a Bell Peppers size, as it always did.
yieldSizesRouter.post("/yield-sizes", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: YieldSizePayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const productCode = requestedCrop((req.body as Record<string, unknown>).product_code) ?? IMPORT_SIZE_CROP;
  let productName: string;
  try {
    const product = (await loadOrganizationProducts(organizationId as string)).find((p) => p.code === productCode);
    if (!product || product.status !== "active") {
      const name = product?.name ?? (await loadCatalogProducts()).find((p) => p.code === productCode)?.name ?? "This crop";
      return res.status(400).json({ message: `${name} is not enabled for your organization.` });
    }
    productName = product.name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to create yield size.", "Yield size products error:", error);
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .insert({ ...payload, product_code: productCode, organization_id: organizationId })
    .select("*")
    .single();

  if (error?.code === "23505") {
    return res.status(409).json({ message: `${productName} already has a size named ${payload.name}.` });
  }
  if (error) {
    return sendSafeError(res, 500, "Failed to create yield size.", "Yield size insert error:", error);
  }

  return res.status(201).json(data);
});

// A size keeps its crop: product_code may be sent, but only as the size's own.
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

  const { data: existing, error: lookupError } = await supabase
    .from("yield_sizes")
    .select("id, product_code")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (lookupError) {
    return sendSafeError(res, 500, "Failed to update yield size.", "Yield size lookup error:", lookupError);
  }
  if (!existing) {
    return res.status(404).json({ message: "Yield size not found." });
  }
  const crop = requestedCrop((req.body as Record<string, unknown>).product_code);
  if (crop && crop !== existing.product_code) {
    return res.status(400).json({ message: "A size's crop can't be changed. Add the size to the other crop instead." });
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error?.code === "23505") {
    return res.status(409).json({ message: `This crop already has a size named ${payload.name}.` });
  }
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

  // 23001: the size is on recorded harvests (migration 0152); it is retired instead.
  if (error?.code === "23001") {
    return res.status(409).json({
      message: "This size is on recorded harvests. Set it to Inactive to retire it; its history stays readable."
    });
  }
  if (error) {
    return sendSafeError(res, 500, "Failed to delete yield size.", "Yield size delete error:", error);
  }

  return res.status(204).send();
});

export { yieldSizesRouter };
