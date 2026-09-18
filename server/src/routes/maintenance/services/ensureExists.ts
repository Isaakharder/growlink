// Cross-entity FK validation helpers — confirm a referenced row both exists
// and belongs to the caller's organization before it's attached to another
// record. Mirrors irrigationSetup.ts's ensureGroupExists pattern.

import { supabase } from "../../../config/supabase";

class MaintenanceNotFoundError extends Error {}

export { MaintenanceNotFoundError };

async function ensureActiveRefExists(table: string, id: string, organizationId: string, label: string): Promise<void> {
  const { data, error } = await supabase
    .from(table)
    .select("id, is_active")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new MaintenanceNotFoundError(`Selected ${label} was not found.`);
  if (!data.is_active) throw new MaintenanceNotFoundError(`Selected ${label} is inactive and cannot be assigned to new records.`);
}

export function ensureCategoryExists(id: string, organizationId: string): Promise<void> {
  return ensureActiveRefExists("maintenance_categories", id, organizationId, "category");
}

export function ensureLocationExists(id: string, organizationId: string): Promise<void> {
  return ensureActiveRefExists("maintenance_locations", id, organizationId, "location");
}

export function ensurePartTypeExists(id: string, organizationId: string): Promise<void> {
  return ensureActiveRefExists("maintenance_part_types", id, organizationId, "part type");
}

export async function ensureEquipmentExists(id: string, organizationId: string): Promise<void> {
  const { data, error } = await supabase
    .from("maintenance_equipment")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new MaintenanceNotFoundError("Equipment was not found.");
}

export async function ensureInventoryItemExists(id: string, organizationId: string): Promise<void> {
  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new MaintenanceNotFoundError("Inventory item was not found.");
}
