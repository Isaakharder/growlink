import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import { loadCatalogProducts, loadSupportedUnitCodes, unitLabel } from "../utils/organizationProducts";

// The organization's products from the GrowLink catalog (migrations 0148,
// 0149): the ones it has enabled, with each one's default unit, supported
// units and varieties, and the catalog products it can still enable.
// Catalog products and their capabilities change only by migration; an
// organization chooses which of them it grows.
const productsRouter = Router();

const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

type OrganizationProductRow = { product_code: string; default_unit_code: string; status: "active" | "inactive" };
type ProductUnitRow = { product_code: string; unit_code: string };
type UnitRow = { code: string; name: string; dimension: "weight" | "count" };

async function loadProductsView(organizationId: string) {
  const [enabledResult, varietiesResult, catalog, productUnitsResult, unitsResult] = await Promise.all([
    supabase
      .from("organization_products")
      .select("product_code, default_unit_code, status")
      .eq("organization_id", organizationId),
    supabase
      .from("varieties")
      .select("product_code, status")
      .eq("organization_id", organizationId),
    loadCatalogProducts(),
    supabase.from("catalog_product_units").select("product_code, unit_code"),
    supabase.from("measurement_units").select("code, name, dimension")
  ]);

  for (const result of [enabledResult, varietiesResult, productUnitsResult, unitsResult]) {
    if (result.error) throw result.error;
  }

  const unitByCode = new Map(((unitsResult.data ?? []) as UnitRow[]).map((u) => [u.code, u]));
  const unitView = (code: string) => {
    const unit = unitByCode.get(code);
    return { code, name: unit?.name ?? code, dimension: unit?.dimension ?? null };
  };
  const supportedUnits = (productCode: string) =>
    ((productUnitsResult.data ?? []) as ProductUnitRow[])
      .filter((pu) => pu.product_code === productCode)
      .map((pu) => unitView(pu.unit_code))
      .sort((a, b) => a.code.localeCompare(b.code));

  const enabled = (enabledResult.data ?? []) as OrganizationProductRow[];
  const enabledCodes = new Set(enabled.map((row) => row.product_code));
  const catalogByCode = new Map(catalog.map((p) => [p.code, p]));
  const varieties = (varietiesResult.data ?? []) as Array<{ product_code: string; status: string }>;

  const products = enabled
    .map((row) => {
      const own = varieties.filter((variety) => variety.product_code === row.product_code);
      const product = catalogByCode.get(row.product_code);
      return {
        code: row.product_code,
        name: product?.name ?? row.product_code,
        tracksColour: product?.tracksColour ?? false,
        tracksSizes: product?.tracksSizes ?? false,
        status: row.status,
        defaultUnit: unitView(row.default_unit_code),
        supportedUnits: supportedUnits(row.product_code),
        varietyCount: own.length,
        activeVarietyCount: own.filter((variety) => variety.status === "active").length
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const available = catalog
    .filter((product) => !enabledCodes.has(product.code))
    .map((product) => ({
      code: product.code,
      name: product.name,
      tracksColour: product.tracksColour,
      tracksSizes: product.tracksSizes,
      defaultUnit: unitView(product.defaultUnitCode),
      supportedUnits: supportedUnits(product.code)
    }));

  return { products, available };
}

productsRouter.get("/products", canView, async (req, res) => {
  try {
    return res.json(await loadProductsView(req.organizationId as string));
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load products.", "Products fetch error:", error);
  }
});

class UnitChoiceError extends Error {}

// The unit a request asks for, checked against the units the product can be
// recorded in (catalog_product_units). Absent: the fallback.
async function resolveUnitChoice(productCode: string, productName: string, requested: unknown, fallback: string): Promise<string> {
  if (requested === undefined || requested === null || requested === "") return fallback;
  const code = typeof requested === "string" ? requested.trim() : "";
  const supported = await loadSupportedUnitCodes(productCode);
  if (!supported.includes(code)) {
    throw new UnitChoiceError(
      code ? `${productName} can't be recorded in ${unitLabel(code)}.` : "unit_code must be one of the product's units"
    );
  }
  return code;
}

// Enable a catalog product for the organization in the unit chosen on the
// Available to Enable row (unit_code), or the catalog's default unit when
// none is sent. Enabling one the organization turned off makes it active
// again, with the unit it had unless another one is chosen.
productsRouter.post("/products/:code/enable", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  const code = String(req.params.code ?? "");
  const requestedUnit = (req.body as Record<string, unknown> | undefined)?.unit_code;

  try {
    const catalog = await loadCatalogProducts();
    const product = catalog.find((p) => p.code === code);
    if (!product) {
      return res.status(404).json({ message: "That product isn't in the GrowLink catalog." });
    }

    const { data: existing, error: lookupError } = await supabase
      .from("organization_products")
      .select("id, status, default_unit_code")
      .eq("organization_id", organizationId)
      .eq("product_code", code)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const current = existing as { id: string; status: string; default_unit_code: string } | null;
    const unit = await resolveUnitChoice(code, product.name, requestedUnit, current?.default_unit_code ?? product.defaultUnitCode);

    if (!current) {
      const { error } = await supabase
        .from("organization_products")
        .insert({ organization_id: organizationId, product_code: code, default_unit_code: unit, status: "active" });
      if (error) throw error;
    } else if (current.status !== "active" || current.default_unit_code !== unit) {
      const { error } = await supabase
        .from("organization_products")
        .update({ status: "active", default_unit_code: unit, updated_at: new Date().toISOString() })
        .eq("id", current.id)
        .eq("organization_id", organizationId);
      if (error) throw error;
    }

    return res.json(await loadProductsView(organizationId));
  } catch (error) {
    if (error instanceof UnitChoiceError) {
      return res.status(400).json({ message: error.message });
    }
    return sendSafeError(res, 500, "Failed to enable product.", "Product enable error:", error);
  }
});

// Change an enabled product's default unit. It applies to harvests entered
// from now on; every saved harvest keeps the unit it was recorded in (kg in
// yield_entries, pieces in yield_piece_entries), so nothing is converted.
productsRouter.patch("/products/:code", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  const code = String(req.params.code ?? "");
  const requestedUnit = (req.body as Record<string, unknown> | undefined)?.default_unit_code;

  if (requestedUnit === undefined || requestedUnit === null || requestedUnit === "") {
    return res.status(400).json({ message: "default_unit_code is required" });
  }

  try {
    const product = (await loadCatalogProducts()).find((p) => p.code === code);
    const { data: existing, error: lookupError } = await supabase
      .from("organization_products")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("product_code", code)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!product || !existing) {
      return res.status(404).json({ message: "That product isn't enabled for your organization." });
    }

    const unit = await resolveUnitChoice(code, product.name, requestedUnit, product.defaultUnitCode);
    const { error } = await supabase
      .from("organization_products")
      .update({ default_unit_code: unit, updated_at: new Date().toISOString() })
      .eq("id", (existing as { id: string }).id)
      .eq("organization_id", organizationId);
    if (error) throw error;

    return res.json(await loadProductsView(organizationId));
  } catch (error) {
    if (error instanceof UnitChoiceError) {
      return res.status(400).json({ message: error.message });
    }
    return sendSafeError(res, 500, "Failed to change the default unit.", "Product default unit error:", error);
  }
});

// Turn a product off. The database keeps the rules (migration 0148): an
// organization keeps one active product, and a product with active varieties
// stays on. Varieties and their history are kept.
productsRouter.post("/products/:code/disable", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  const code = String(req.params.code ?? "");

  const { data, error } = await supabase
    .from("organization_products")
    .update({ status: "inactive", updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("product_code", code)
    .select("id");

  if (error?.code === "23514") {
    return res.status(409).json({ message: error.message });
  }
  if (error) {
    return sendSafeError(res, 500, "Failed to turn off product.", "Product disable error:", error);
  }
  if (!data || (data as unknown[]).length === 0) {
    return res.status(404).json({ message: "That product isn't enabled for your organization." });
  }

  try {
    return res.json(await loadProductsView(organizationId));
  } catch (loadError) {
    return sendSafeError(res, 500, "Failed to load products.", "Products fetch error:", loadError);
  }
});

export { productsRouter };
