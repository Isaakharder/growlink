// DB/RPC-level integration tests for maintenance_log_equipment_work (0132),
// run against the real hosted Supabase project using the Denva
// organization only — same conventions as maintenance.integration.test.ts:
// every test creates its own throwaway rows and cleans up in `finally`;
// First Light is never touched. Route-level permission wiring
// (canView/canAct using the correct keys, identical to meters.ts/
// schedules.ts) is verified by code review against the shared middleware,
// not re-driven through HTTP here — matching the existing convention.

import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../../config/supabase";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";
const TEST_USER_ID = "3ed136df-95f1-4a3d-b460-240e128f2937"; // real Denva owner user, used only as an FK target for audit columns
const TEST_USER_NAME = "Integration Test User";

async function cleanupAll(...tasks: Array<() => PromiseLike<unknown>>): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.warn("[work log test cleanup] a cleanup step failed (continuing):", err instanceof Error ? err.message : err);
    }
  }
}

async function createCategory(organizationId: string) {
  const { data, error } = await supabase
    .from("maintenance_categories")
    .insert({ organization_id: organizationId, name: `Work Log Test Category ${randomUUID()}` })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function createLocation(organizationId: string) {
  const { data, error } = await supabase
    .from("maintenance_locations")
    .insert({ organization_id: organizationId, name: `Work Log Test Location ${randomUUID()}` })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function createEquipment(organizationId: string, categoryId: string, locationId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await supabase
    .from("maintenance_equipment")
    .insert({
      organization_id: organizationId,
      name: `Work Log Test Equipment ${randomUUID()}`,
      asset_code: `WLT-${randomUUID().slice(0, 8)}`,
      category_id: categoryId,
      location_id: locationId,
      meter_unit: "hours",
      ...overrides
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function deleteEquipment(id: string) {
  await supabase.from("maintenance_meter_readings").delete().eq("equipment_id", id);
  await supabase.from("maintenance_work_logs").delete().eq("equipment_id", id);
  await supabase.from("maintenance_equipment").delete().eq("id", id);
}

async function logWork(overrides: Record<string, unknown>) {
  return supabase.rpc("maintenance_log_equipment_work", {
    p_organization_id: DENVA_ORG_ID,
    p_request_id: randomUUID(),
    p_work_performed: "Test work performed",
    p_meter_reading_value: null,
    p_notes: null,
    p_performed_at: null,
    p_performed_by: TEST_USER_ID,
    p_performed_by_name: TEST_USER_NAME,
    ...overrides
  });
}

test("work log without a meter reading: creates a work log row, leaves the equipment's current reading untouched", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id, { current_meter_reading: 50 });

  try {
    const { data, error } = await logWork({ p_equipment_id: equipment.id, p_work_performed: "Inspected lift controls" });
    assert.equal(error, null);
    assert.equal(data.work_performed, "Inspected lift controls");
    assert.equal(data.meter_reading_value, null);
    assert.equal(data.meter_reading_unit_snapshot, null);

    const { data: refreshedEquipment } = await supabase.from("maintenance_equipment").select("current_meter_reading").eq("id", equipment.id).single();
    assert.equal(Number(refreshedEquipment!.current_meter_reading), 50);

    const { data: readings } = await supabase.from("maintenance_meter_readings").select("*").eq("equipment_id", equipment.id);
    assert.equal(readings!.length, 0, "no meter reading row should be created when none was supplied");
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("work log with a meter reading: work log, linked meter reading, and cached current reading all save atomically", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id, { current_meter_reading: 100 });

  try {
    const { data, error } = await logWork({ p_equipment_id: equipment.id, p_work_performed: "Replaced hydraulic hose", p_meter_reading_value: 125, p_notes: "Old hose was cracked" });
    assert.equal(error, null);
    assert.equal(Number(data.meter_reading_value), 125);
    assert.equal(data.meter_reading_unit_snapshot, "hours");
    assert.equal(data.notes, "Old hose was cracked");

    const { data: readings } = await supabase.from("maintenance_meter_readings").select("*").eq("equipment_id", equipment.id);
    assert.equal(readings!.length, 1);
    assert.equal(readings![0].related_work_log_id, data.id, "the meter reading must be linked back to its work log");
    assert.equal(Number(readings![0].value), 125);

    const { data: refreshedEquipment } = await supabase.from("maintenance_equipment").select("current_meter_reading").eq("id", equipment.id).single();
    assert.equal(Number(refreshedEquipment!.current_meter_reading), 125);
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("work_performed is required — blank/whitespace-only is rejected and nothing is created", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);

  try {
    const { error } = await logWork({ p_equipment_id: equipment.id, p_work_performed: "   " });
    assert.ok(error);
    assert.equal(error!.code, "22023");

    const { data: logs } = await supabase.from("maintenance_work_logs").select("*").eq("equipment_id", equipment.id);
    assert.equal(logs!.length, 0);
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("a failed save (reading lower than current) creates neither a partial work log nor a partial reading — full rollback", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id, { current_meter_reading: 200 });

  try {
    const { error } = await logWork({ p_equipment_id: equipment.id, p_work_performed: "Attempted service with a bad reading", p_meter_reading_value: 50 });
    assert.ok(error, "expected the lower-reading rejection");
    assert.equal(error!.code, "22023");

    const { data: logs } = await supabase.from("maintenance_work_logs").select("*").eq("equipment_id", equipment.id);
    assert.equal(logs!.length, 0, "no work log row should exist after a rejected save");

    const { data: readings } = await supabase.from("maintenance_meter_readings").select("*").eq("equipment_id", equipment.id);
    assert.equal(readings!.length, 0, "no meter reading row should exist after a rejected save");

    const { data: refreshedEquipment } = await supabase.from("maintenance_equipment").select("current_meter_reading").eq("id", equipment.id).single();
    assert.equal(Number(refreshedEquipment!.current_meter_reading), 200, "the cached reading must be unchanged");
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("Save Job cannot create duplicates from repeated taps: replaying the same request_id returns the same row, not a second one", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);
  const requestId = randomUUID();

  try {
    const first = await logWork({ p_equipment_id: equipment.id, p_request_id: requestId, p_work_performed: "Lubricated pivot points" });
    assert.equal(first.error, null);

    const second = await logWork({ p_equipment_id: equipment.id, p_request_id: requestId, p_work_performed: "Lubricated pivot points" });
    assert.equal(second.error, null);
    assert.equal(second.data.id, first.data.id, "a replayed request_id must return the identical row");

    const { data: logs } = await supabase.from("maintenance_work_logs").select("*").eq("equipment_id", equipment.id);
    assert.equal(logs!.length, 1, "exactly one work log must exist despite two identical-request_id calls");
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("cross-organization access is rejected: Denva equipment is not found when queried under the First Light org id", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);

  try {
    const { error } = await logWork({ p_organization_id: FIRST_LIGHT_ORG_ID, p_equipment_id: equipment.id, p_work_performed: "Should not be allowed" });
    assert.ok(error);
    assert.equal(error!.code, "P0002");

    const { data: logs } = await supabase.from("maintenance_work_logs").select("*").eq("equipment_id", equipment.id);
    assert.equal(logs!.length, 0);
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("existing (manual, non-work-log) meter reading history remains intact and unlinked after a work log with its own reading is added", async () => {
  const category = await createCategory(DENVA_ORG_ID);
  const location = await createLocation(DENVA_ORG_ID);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id, { current_meter_reading: 10 });

  try {
    // A pre-existing manual reading, as if recorded before this feature existed.
    const { data: manualReading, error: manualError } = await supabase.rpc("maintenance_record_meter_reading", {
      p_organization_id: DENVA_ORG_ID,
      p_equipment_id: equipment.id,
      p_value: 20,
      p_note: "manual reading",
      p_is_reset: false,
      p_reset_reason: null,
      p_recorded_by: TEST_USER_ID,
      p_recorded_by_name: TEST_USER_NAME
    });
    assert.equal(manualError, null);
    assert.equal(manualReading.related_work_log_id, null);

    const { error: workError } = await logWork({ p_equipment_id: equipment.id, p_work_performed: "Follow-up service", p_meter_reading_value: 30 });
    assert.equal(workError, null);

    const { data: allReadings } = await supabase
      .from("maintenance_meter_readings")
      .select("*")
      .eq("equipment_id", equipment.id)
      .order("recorded_at", { ascending: true });

    assert.equal(allReadings!.length, 2, "both the old manual reading and the new work-log reading must exist");
    assert.equal(allReadings![0].id, manualReading.id);
    assert.equal(allReadings![0].related_work_log_id, null, "the manual reading must remain unlinked");
    assert.ok(allReadings![1].related_work_log_id, "the new reading must be linked to its work log");
  } finally {
    await cleanupAll(() => deleteEquipment(equipment.id), () => supabase.from("maintenance_categories").delete().eq("id", category.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});
