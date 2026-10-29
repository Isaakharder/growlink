import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission } from "../middleware/requirePermission";

// The organization's enabled products from the GrowLink catalog (migration
// 0148), with each product's default unit and the units it supports. Read
// only: catalog products and their capabilities change only by migration.
const productsRouter = Router();

const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);

type OrganizationProductRow = { product_code: string; default_unit_code: string; status: "active" | "inactive" };
type CatalogProductRow = { code: string; name: string; tracks_colour: boolean };
type ProductUnitRow = { product_code: string; unit_code: string };
type UnitRow = { code: string; name: string; dimension: "weight" | "count" };

productsRouter.get("/products", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const [enabledResult, varietiesResult] = await Promise.all([
    supabase
      .from("organization_products")
      .select("product_code, default_unit_code, status")
      .eq("organization_id", organizationId),
    supabase
      .from("varieties")
      .select("product_code, status")
      .eq("organization_id", organizationId)
  ]);

  if (enabledResult.error) {
    return sendSafeError(res, 500, "Failed to load products.", "Organization products fetch error:", enabledResult.error);
  }
  if (varietiesResult.error) {
    return sendSafeError(res, 500, "Failed to load products.", "Product varieties fetch error:", varietiesResult.error);
  }

  const enabled = (enabledResult.data ?? []) as OrganizationProductRow[];
  const codes = enabled.map((row) => row.product_code);

  const [catalogResult, productUnitsResult, unitsResult] = await Promise.all([
    supabase.from("catalog_products").select("code, name, tracks_colour").in("code", codes),
    supabase.from("catalog_product_units").select("product_code, unit_code").in("product_code", codes),
    supabase.from("measurement_units").select("code, name, dimension")
  ]);

  for (const result of [catalogResult, productUnitsResult, unitsResult]) {
    if (result.error) {
      return sendSafeError(res, 500, "Failed to load products.", "Product catalog fetch error:", result.error);
    }
  }

  const catalogByCode = new Map(((catalogResult.data ?? []) as CatalogProductRow[]).map((p) => [p.code, p]));
  const unitByCode = new Map(((unitsResult.data ?? []) as UnitRow[]).map((u) => [u.code, u]));
  const unitView = (code: string) => {
    const unit = unitByCode.get(code);
    return { code, name: unit?.name ?? code, dimension: unit?.dimension ?? null };
  };

  const products = enabled
    .map((row) => {
      const varieties = ((varietiesResult.data ?? []) as Array<{ product_code: string; status: string }>).filter(
        (variety) => variety.product_code === row.product_code
      );
      return {
        code: row.product_code,
        name: catalogByCode.get(row.product_code)?.name ?? row.product_code,
        tracksColour: catalogByCode.get(row.product_code)?.tracks_colour ?? false,
        status: row.status,
        defaultUnit: unitView(row.default_unit_code),
        supportedUnits: ((productUnitsResult.data ?? []) as ProductUnitRow[])
          .filter((pu) => pu.product_code === row.product_code)
          .map((pu) => unitView(pu.unit_code))
          .sort((a, b) => a.code.localeCompare(b.code)),
        varietyCount: varieties.length,
        activeVarietyCount: varieties.filter((variety) => variety.status === "active").length
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return res.json({ products });
});

export { productsRouter };
