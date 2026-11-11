import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { loadCatalogProducts } from "../utils/organizationProducts";

type VarietyStatus = "active" | "inactive";
type VarietyColor = "red" | "orange" | "yellow" | "green";

type VarietyPayload = {
  name: string;
  area_m2: number;
  case_kg: number;
  planting_date: string | null;
  pull_out_date: string | null;
  status: VarietyStatus;
};

const STATUS_VALUES: VarietyStatus[] = ["active", "inactive"];
const COLOR_VALUES: VarietyColor[] = ["red", "orange", "yellow", "green"];

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseNonNegativeNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

// A request the client can correct: an unknown or inactive product, or a
// colour that does not fit the product. Answered with 400.
class ProductSelectionError extends Error {}

function validatePayload(input: unknown): VarietyPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    throw new Error("name is required");
  }

  const area_m2 = parseNonNegativeNumber(body.area_m2, "area_m2");
  const case_kg = parseNonNegativeNumber(body.case_kg, "case_kg");

  const statusValue =
    typeof body.status === "string" ? body.status.toLowerCase() : "";

  if (!STATUS_VALUES.includes(statusValue as VarietyStatus)) {
    throw new Error("status must be active or inactive");
  }

  if (body.planting_date !== null && body.planting_date !== undefined) {
    if (!isValidDate(body.planting_date)) {
      throw new Error("planting_date must be in YYYY-MM-DD format");
    }
  }

  if (body.pull_out_date !== null && body.pull_out_date !== undefined) {
    if (!isValidDate(body.pull_out_date)) {
      throw new Error("pull_out_date must be in YYYY-MM-DD format");
    }
  }

  return {
    name,
    area_m2,
    case_kg,
    planting_date: (body.planting_date as string | null | undefined) ?? null,
    pull_out_date: (body.pull_out_date as string | null | undefined) ?? null,
    status: statusValue as VarietyStatus
  };
}

// A variety has a colour exactly when its product tracks colour (migration
// 0149): Bell Peppers need one of the four; Cucumbers store none — never a
// placeholder.
function resolveColor(input: unknown, product: { name: string; tracksColour: boolean }): VarietyColor | null {
  const raw = (input as Record<string, unknown>).color;
  const colorValue = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (!product.tracksColour) {
    if (colorValue) {
      throw new ProductSelectionError(`${product.name} varieties have no colour`);
    }
    return null;
  }

  if (!COLOR_VALUES.includes(colorValue as VarietyColor)) {
    throw new ProductSelectionError("color must be red, orange, yellow, or green");
  }
  return colorValue as VarietyColor;
}

async function catalogCapabilities(code: string) {
  const product = (await loadCatalogProducts()).find((p) => p.code === code);
  if (!product) {
    throw new ProductSelectionError("product_code must be an active product enabled for your organization");
  }
  return product;
}


// A variety belongs to a product its organization has enabled and is using
// (migration 0148). A request without product_code — what every client sent
// before products existed — gets the organization's only active product.
async function resolveProductCode(organizationId: string, requested: unknown): Promise<string> {
  const { data, error } = await supabase
    .from("organization_products")
    .select("product_code")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (error) {
    throw error;
  }

  const activeCodes = (data ?? []).map((row) => row.product_code as string);

  if (requested !== undefined && requested !== null && requested !== "") {
    const code = typeof requested === "string" ? requested.trim() : "";
    if (!activeCodes.includes(code)) {
      throw new ProductSelectionError("product_code must be an active product enabled for your organization");
    }
    return code;
  }

  if (activeCodes.length !== 1) {
    throw new ProductSelectionError("product_code is required");
  }

  return activeCodes[0];
}

const varietiesRouter = Router();

const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

varietiesRouter.get("/varieties", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("varieties")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load varieties.", "Varieties fetch error:", error);
  }

  return res.json(data ?? []);
});

varietiesRouter.post("/varieties", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: VarietyPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  let product_code: string;
  let color: VarietyColor | null;

  try {
    product_code = await resolveProductCode(organizationId, (req.body as Record<string, unknown>).product_code);
    color = resolveColor(req.body, await catalogCapabilities(product_code));
  } catch (error) {
    if (error instanceof ProductSelectionError) {
      return res.status(400).json({ message: error.message });
    }
    return sendSafeError(res, 500, "Failed to create variety.", "Variety product lookup error:", error);
  }

  const { data, error } = await supabase
    .from("varieties")
    .insert({ ...payload, color, product_code, organization_id: organizationId })
    .select("*")
    .single();

  // The database's product rules (migration 0148) explain themselves.
  if (error?.code === "23514") {
    return res.status(409).json({ message: error.message });
  }

  if (error) {
    return sendSafeError(res, 500, "Failed to create variety.", "Variety insert error:", error);
  }

  return res.status(201).json(data);
});

varietiesRouter.put("/varieties/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: VarietyPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  // Without product_code the variety keeps its product. Changing it is
  // refused by the database once the variety has recorded harvests (0149).
  const requestedProduct = (req.body as Record<string, unknown>).product_code;
  let productUpdate: { product_code?: string } = {};
  let color: VarietyColor | null;

  try {
    const { data: existing, error: existingError } = await supabase
      .from("varieties")
      .select("product_code")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      return res.status(404).json({ message: "Variety not found." });
    }

    let productCode = (existing as { product_code: string }).product_code;
    if (requestedProduct !== undefined && requestedProduct !== null && requestedProduct !== productCode) {
      productCode = await resolveProductCode(organizationId, requestedProduct);
      productUpdate = { product_code: productCode };
    }
    color = resolveColor(req.body, await catalogCapabilities(productCode));
  } catch (error) {
    if (error instanceof ProductSelectionError) {
      return res.status(400).json({ message: error.message });
    }
    return sendSafeError(res, 500, "Failed to update variety.", "Variety product lookup error:", error);
  }

  const { data, error } = await supabase
    .from("varieties")
    .update({ ...payload, color, ...productUpdate, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error?.code === "23514") {
    return res.status(409).json({ message: error.message });
  }

  if (error) {
    return sendSafeError(res, 500, "Failed to update variety.", "Variety update error:", error);
  }

  return res.json(data);
});

varietiesRouter.delete("/varieties/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("varieties")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete variety.", "Variety delete error:", error);
  }

  return res.status(204).send();
});

export { varietiesRouter };
