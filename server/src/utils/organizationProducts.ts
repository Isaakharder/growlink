import { supabase } from "../config/supabase";

// The products an organization has enabled from the GrowLink catalog
// (migrations 0148/0149), with the capabilities the app branches on:
//   tracksColour  varieties carry a colour (Bell Peppers) or none (Cucumbers)
//   tracksSizes   harvests are kg per yield size, or a total kg only
// One lookup shared by Products, Varieties, Manual Entry and Yield Analytics,
// so they can't disagree about what a product is.
export type OrganizationProduct = {
  code: string;
  name: string;
  tracksColour: boolean;
  tracksSizes: boolean;
  status: "active" | "inactive";
  defaultUnitCode: string;
};

export type CatalogProduct = {
  code: string;
  name: string;
  tracksColour: boolean;
  tracksSizes: boolean;
  defaultUnitCode: string;
};

type CatalogRow = { code: string; name: string; tracks_colour: boolean; tracks_sizes: boolean; default_unit_code: string };

export async function loadCatalogProducts(): Promise<CatalogProduct[]> {
  const { data, error } = await supabase
    .from("catalog_products")
    .select("code, name, tracks_colour, tracks_sizes, default_unit_code");
  if (error) throw error;
  return ((data ?? []) as CatalogRow[])
    .map((row) => ({
      code: row.code,
      name: row.name,
      tracksColour: row.tracks_colour === true,
      tracksSizes: row.tracks_sizes === true,
      defaultUnitCode: row.default_unit_code
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every product the organization has enabled, active or not, by name. */
export async function loadOrganizationProducts(organizationId: string): Promise<OrganizationProduct[]> {
  const [enabledResult, catalog] = await Promise.all([
    supabase
      .from("organization_products")
      .select("product_code, default_unit_code, status")
      .eq("organization_id", organizationId),
    loadCatalogProducts()
  ]);
  if (enabledResult.error) throw enabledResult.error;

  const catalogByCode = new Map(catalog.map((p) => [p.code, p]));
  return ((enabledResult.data ?? []) as Array<{ product_code: string; default_unit_code: string; status: "active" | "inactive" }>)
    .map((row) => {
      const product = catalogByCode.get(row.product_code);
      return {
        code: row.product_code,
        name: product?.name ?? row.product_code,
        tracksColour: product?.tracksColour ?? false,
        tracksSizes: product?.tracksSizes ?? false,
        status: row.status,
        defaultUnitCode: row.default_unit_code
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The client-facing shape: what a page needs to branch on a product. */
export function productView(product: OrganizationProduct) {
  return {
    code: product.code,
    name: product.name,
    tracksColour: product.tracksColour,
    tracksSizes: product.tracksSizes,
    status: product.status
  };
}

// Yield imports (FlowMaster PDF/CSV, CSV templates, the Agent review queue)
// map rows onto yield size buckets, so they can only target varieties of a
// product that tracks sizes. Cucumber imports come later; until then a
// cucumber variety is never matched or accepted as an import target.
// Rows without a product_code (fixtures from before products) pass.
export async function sizedProductVarietiesOnly<T extends { product_code?: string | null }>(rows: T[]): Promise<T[]> {
  if (!rows.some((row) => row.product_code)) return rows;
  const unsized = new Set((await loadCatalogProducts()).filter((p) => !p.tracksSizes).map((p) => p.code));
  return rows.filter((row) => !row.product_code || !unsized.has(row.product_code));
}

/** The product's name when its harvests have no size buckets, else null. */
export async function unsizedProductName(productCode: string | null | undefined): Promise<string | null> {
  if (!productCode) return null;
  const product = (await loadCatalogProducts()).find((p) => p.code === productCode);
  return product && !product.tracksSizes ? product.name : null;
}
