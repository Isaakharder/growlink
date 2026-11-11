// Yield sizes per crop (migration 0152). Every size belongs to one crop
// (yield_sizes.product_code); each crop has its own list and sort order, and
// the same name can exist once per crop.
import { supabase } from "../config/supabase";

/**
 * The crop the FlowMaster and CSV template imports read and create sizes
 * for. Those imports bring Bell Pepper packline data, so they match labels
 * against the Bell Peppers list only; a Cucumbers size with the same name is
 * never picked up.
 */
export const IMPORT_SIZE_CROP = "bell_pepper";

export type CropSize = {
  id: string;
  name: string;
  sort_order: number;
  status: "active" | "inactive";
  product_code: string;
};

export class SizeKeyError extends Error {}

/**
 * Checks a harvest's size keys (size_kg or size_pieces) against the crop's
 * own sizes in the organization.
 *
 * keptKeys are the sizes already on the harvest being edited, for the same
 * crop: they stay allowed (a retired size, or one deleted before sizes had
 * crops, keeps its history). Any other key must be an active size of the
 * crop; a size of another crop or organization, a retired size or an unknown
 * id is refused.
 */
export async function assertSizeKeysForCrop(
  organizationId: string,
  productCode: string,
  productName: string,
  keys: string[],
  keptKeys: Set<string> = new Set()
): Promise<void> {
  const toCheck = Array.from(new Set(keys.filter((key) => !keptKeys.has(key))));
  if (toCheck.length === 0) return;

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (toCheck.some((key) => !uuid.test(key))) {
    throw new SizeKeyError(`One or more sizes are not ${productName} sizes.`);
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("product_code", productCode)
    .in("id", toCheck);
  if (error) throw error;

  const found = new Map((data ?? []).map((row) => [row.id as string, row.status as string]));
  if (toCheck.some((key) => !found.has(key))) {
    throw new SizeKeyError(`One or more sizes are not ${productName} sizes.`);
  }
  if (toCheck.some((key) => found.get(key) !== "active")) {
    throw new SizeKeyError(`A retired ${productName} size can't be used for a new harvest.`);
  }
}
