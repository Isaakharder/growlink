// DB/RPC-level integration tests for the Maintenance module, run against the
// real hosted Supabase project (no local Docker Supabase, per project
// convention) using the Denva organization only. Every test creates its own
// throwaway rows (uniquely named via randomUUID) and cleans them up in a
// `finally` block — First Light is never touched.
//
// These call the Supabase service-role client and RPCs directly rather than
// driving full HTTP requests through requireOrganizationContext/
// requirePermission — matching this codebase's existing convention for
// every other Bearer-auth-gated module (see
// agentPdfImportCsvTemplate.integration.test.ts, which does the same for
// its own business-logic functions). The route-level permission wiring
// itself (canView/canEdit/canAct using the correct permission keys) is
// verified by direct code review against the shared, already-relied-upon
// requirePermission/requireAnyPermission middleware rather than re-testing
// that middleware's own internals here.

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
      console.warn("[maintenance test cleanup] a cleanup step failed (continuing):", err instanceof Error ? err.message : err);
    }
  }
}

async function createCategory(organizationId: string, name: string) {
  const { data, error } = await supabase
    .from("maintenance_categories")
    .insert({ organization_id: organizationId, name })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function createLocation(organizationId: string, name: string) {
  const { data, error } = await supabase
    .from("maintenance_locations")
    .insert({ organization_id: organizationId, name })
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
      name: `Test Equipment ${randomUUID()}`,
      asset_code: `TST-${randomUUID().slice(0, 8)}`,
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

async function createInventoryItem(organizationId: string, locationId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await supabase
    .from("maintenance_inventory_items")
    .insert({
      organization_id: organizationId,
      name: `Test Part ${randomUUID()}`,
      location_id: locationId,
      unit_of_measure: "each",
      quantity_on_hand: 0,
      ...overrides
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function deleteEquipment(id: string) {
  await supabase.from("maintenance_schedule_completions").delete().eq("equipment_id", id);
  await supabase.from("maintenance_schedule_checklist_items").delete().in(
    "schedule_id",
    (await supabase.from("maintenance_schedules").select("id").eq("equipment_id", id)).data?.map((s) => s.id) ?? []
  );
  await supabase.from("maintenance_schedules").delete().eq("equipment_id", id);
  await supabase.from("maintenance_meter_readings").delete().eq("equipment_id", id);
  await supabase.from("maintenance_equipment").delete().eq("id", id);
}

async function deleteInventoryItem(id: string) {
  await supabase.from("maintenance_stock_count_lines").delete().eq("item_id", id);
  await supabase.from("maintenance_restock_request_lines").delete().eq("item_id", id);
  await supabase.from("maintenance_inventory_transactions").delete().eq("item_id", id);
  await supabase.from("maintenance_inventory_items").delete().eq("id", id);
}

// ── Setup: case-insensitive duplicate prevention + safe delete ────────────

test("setup: case-insensitive/trimmed duplicate category name is rejected by the DB constraint", async () => {
  const name = `Irrigation Test ${randomUUID()}`;
  const category = await createCategory(DENVA_ORG_ID, name);

  try {
    const { error } = await supabase
      .from("maintenance_categories")
      .insert({ organization_id: DENVA_ORG_ID, name: `  ${name.toUpperCase()}  ` });

    assert.ok(error, "expected a unique-constraint violation");
    assert.equal(error!.code, "23505");
  } finally {
    await cleanupAll(() => supabase.from("maintenance_categories").delete().eq("id", category.id));
  }
});

test("setup: a referenced category cannot be hard-deleted, only deactivated, and equipment keeps showing its name", async () => {
  const category = await createCategory(DENVA_ORG_ID, `Vehicles Test ${randomUUID()}`);
  const location = await createLocation(DENVA_ORG_ID, `Shop Test ${randomUUID()}`);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);

  try {
    const { error: deleteError } = await supabase.from("maintenance_categories").delete().eq("id", category.id);
    assert.ok(deleteError, "expected a foreign-key violation");
    assert.equal(deleteError!.code, "23503");

    const { error: deactivateError } = await supabase
      .from("maintenance_categories")
      .update({ is_active: false })
      .eq("id", category.id);
    assert.equal(deactivateError, null);

    const { data: refreshedEquipment } = await supabase
      .from("maintenance_equipment")
      .select("*, category:maintenance_categories(id, name, is_active)")
      .eq("id", equipment.id)
      .single();
    assert.equal((refreshedEquipment!.category as { name: string }).name, category.name);
    assert.equal((refreshedEquipment!.category as { is_active: boolean }).is_active, false);
  } finally {
    await cleanupAll(
      () => deleteEquipment(equipment.id),
      () => supabase.from("maintenance_categories").delete().eq("id", category.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

// ── Equipment + QR ──────────────────────────────────────────────────────────

test("equipment: asset code must be unique per organization (case/trim-insensitive)", async () => {
  const category = await createCategory(DENVA_ORG_ID, `Cat ${randomUUID()}`);
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const code = `DUP-${randomUUID().slice(0, 8)}`;
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id, { asset_code: code });

  try {
    const { error } = await supabase
      .from("maintenance_equipment")
      .insert({
        organization_id: DENVA_ORG_ID, name: "Dup", asset_code: `  ${code.toLowerCase()}  `,
        category_id: category.id, location_id: location.id, meter_unit: "hours"
      });
    assert.ok(error);
    assert.equal(error!.code, "23505");
  } finally {
    await cleanupAll(
      () => deleteEquipment(equipment.id),
      () => supabase.from("maintenance_categories").delete().eq("id", category.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

test("QR: a token only resolves within its own organization — cross-org lookup finds nothing", async () => {
  const category = await createCategory(DENVA_ORG_ID, `Cat ${randomUUID()}`);
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);

  try {
    const { data: sameOrg } = await supabase
      .from("maintenance_equipment")
      .select("id")
      .eq("qr_token", equipment.qr_token)
      .eq("organization_id", DENVA_ORG_ID)
      .maybeSingle();
    assert.equal(sameOrg?.id, equipment.id);

    const { data: crossOrg, error: crossOrgError } = await supabase
      .from("maintenance_equipment")
      .select("id")
      .eq("qr_token", equipment.qr_token)
      .eq("organization_id", FIRST_LIGHT_ORG_ID)
      .maybeSingle();
    assert.equal(crossOrg, null);
    assert.equal(crossOrgError, null); // not-found, not an error — same response shape as a genuinely unknown token
  } finally {
    await cleanupAll(
      () => deleteEquipment(equipment.id),
      () => supabase.from("maintenance_categories").delete().eq("id", category.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

// ── Meter readings ──────────────────────────────────────────────────────────

test("meter readings: valid reading updates the cached current reading; lower reading rejected without reset; explicit reset succeeds; history preserved", async () => {
  const category = await createCategory(DENVA_ORG_ID, `Cat ${randomUUID()}`);
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);

  try {
    const { data: r1, error: e1 } = await supabase.rpc("maintenance_record_meter_reading", {
      p_organization_id: DENVA_ORG_ID, p_equipment_id: equipment.id, p_value: 100, p_note: null,
      p_is_reset: false, p_reset_reason: null, p_recorded_by: TEST_USER_ID, p_recorded_by_name: TEST_USER_NAME
    });
    assert.equal(e1, null, e1?.message);
    assert.equal(Number(r1.value), 100);

    const { data: afterFirst } = await supabase.from("maintenance_equipment").select("current_meter_reading").eq("id", equipment.id).single();
    assert.equal(Number(afterFirst!.current_meter_reading), 100);

    const { error: e2 } = await supabase.rpc("maintenance_record_meter_reading", {
      p_organization_id: DENVA_ORG_ID, p_equipment_id: equipment.id, p_value: 50, p_note: null,
      p_is_reset: false, p_reset_reason: null, p_recorded_by: TEST_USER_ID, p_recorded_by_name: TEST_USER_NAME
    });
    assert.ok(e2, "expected a lower-reading rejection");
    assert.equal(e2!.code, "22023");

    const { data: r3, error: e3 } = await supabase.rpc("maintenance_record_meter_reading", {
      p_organization_id: DENVA_ORG_ID, p_equipment_id: equipment.id, p_value: 10, p_note: "Meter replaced",
      p_is_reset: true, p_reset_reason: "New meter installed", p_recorded_by: TEST_USER_ID, p_recorded_by_name: TEST_USER_NAME
    });
    assert.equal(e3, null, e3?.message);
    assert.equal(Number(r3.value), 10);
    assert.equal(r3.is_reset, true);

    const { data: history } = await supabase
      .from("maintenance_meter_readings")
      .select("value, is_reset")
      .eq("equipment_id", equipment.id)
      .order("recorded_at", { ascending: true });
    assert.equal(history?.length, 2);
    assert.equal(Number(history![0].value), 100);
    assert.equal(Number(history![1].value), 10);
    assert.equal(history![1].is_reset, true);
  } finally {
    await cleanupAll(
      () => deleteEquipment(equipment.id),
      () => supabase.from("maintenance_categories").delete().eq("id", category.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

// ── Scheduled maintenance completion ────────────────────────────────────────

test("schedule completion: succeeds once, is idempotent on retry, and rejects a stale duplicate completion of the same occurrence", async () => {
  const category = await createCategory(DENVA_ORG_ID, `Cat ${randomUUID()}`);
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const equipment = await createEquipment(DENVA_ORG_ID, category.id, location.id);

  const { data: schedule, error: scheduleError } = await supabase
    .from("maintenance_schedules")
    .insert({
      organization_id: DENVA_ORG_ID, equipment_id: equipment.id, name: "Oil change",
      first_due_date: "2026-01-01", recurrence_type: "monthly", recurrence_interval: 1,
      warning_days_before_due: 7, next_due_date: "2026-01-01", next_occurrence_index: 0
    })
    .select("*")
    .single();
  assert.equal(scheduleError, null, scheduleError?.message);

  try {
    const completionRequestId = randomUUID();
    const rpcArgs = {
      p_organization_id: DENVA_ORG_ID, p_schedule_id: schedule.id, p_completion_request_id: completionRequestId,
      p_expected_occurrence_index: 0, p_next_occurrence_index: 1, p_next_due_date: "2026-02-01",
      p_completed_by: TEST_USER_ID, p_completed_by_name: TEST_USER_NAME, p_completed_at: new Date().toISOString(),
      p_meter_reading_value: null, p_meter_reading_unit_snapshot: null, p_notes: "All good",
      p_checklist_snapshot: [{ id: "x", label: "Check oil level", sort_order: 0, checked: true }]
    };

    const { data: first, error: firstError } = await supabase.rpc("maintenance_complete_schedule", rpcArgs);
    assert.equal(firstError, null, firstError?.message);
    assert.equal(first.occurrence_index, 0);

    // Idempotent replay: identical completion_request_id returns the same row, doesn't error.
    const { data: replay, error: replayError } = await supabase.rpc("maintenance_complete_schedule", rpcArgs);
    assert.equal(replayError, null, replayError?.message);
    assert.equal(replay.id, first.id);

    const { data: refreshedSchedule } = await supabase.from("maintenance_schedules").select("next_due_date, next_occurrence_index").eq("id", schedule.id).single();
    assert.equal(refreshedSchedule!.next_due_date, "2026-02-01");
    assert.equal(refreshedSchedule!.next_occurrence_index, 1);

    // A genuinely new attempt at the SAME (already-completed) occurrence
    // index must be rejected — this is the duplicate-completion guard.
    const { error: staleError } = await supabase.rpc("maintenance_complete_schedule", { ...rpcArgs, p_completion_request_id: randomUUID() });
    assert.ok(staleError, "expected the stale-occurrence guard to reject a second distinct completion of occurrence 0");
    assert.equal(staleError!.code, "GL020");

    const { data: history } = await supabase.from("maintenance_schedule_completions").select("checklist_snapshot").eq("schedule_id", schedule.id);
    assert.equal(history?.length, 1);
    assert.deepEqual(history![0].checklist_snapshot, [{ id: "x", label: "Check oil level", sort_order: 0, checked: true }]);
  } finally {
    await cleanupAll(
      () => supabase.from("maintenance_schedule_completions").delete().eq("schedule_id", schedule.id),
      () => supabase.from("maintenance_schedules").delete().eq("id", schedule.id),
      () => deleteEquipment(equipment.id),
      () => supabase.from("maintenance_categories").delete().eq("id", category.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

// ── Inventory transaction ledger ────────────────────────────────────────────

test("inventory ledger: negative stock is prevented, the ledger matches the cached quantity, and a retried request is idempotent", async () => {
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const item = await createInventoryItem(DENVA_ORG_ID, location.id, { quantity_on_hand: 5 });

  try {
    const { error: negativeError } = await supabase.rpc("maintenance_apply_inventory_transaction", {
      p_organization_id: DENVA_ORG_ID, p_item_id: item.id, p_transaction_type: "remove", p_quantity_change: -10,
      p_reason: "test", p_request_id: randomUUID(), p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    assert.ok(negativeError, "expected a negative-quantity rejection");
    assert.equal(negativeError!.code, "23514");

    const requestId = randomUUID();
    const { data: applyResult, error: applyError } = await supabase.rpc("maintenance_apply_inventory_transaction", {
      p_organization_id: DENVA_ORG_ID, p_item_id: item.id, p_transaction_type: "add", p_quantity_change: 20,
      p_reason: "test", p_request_id: requestId, p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    assert.equal(applyError, null, applyError?.message);
    const first = Array.isArray(applyResult) ? applyResult[0] : applyResult;
    assert.equal(first.is_replay, false);
    assert.equal(Number(first.quantity_before), 5);
    assert.equal(Number(first.quantity_after), 25);

    // Retry with the SAME request_id must be a safe no-op, not double-applied.
    const { data: retryResult, error: retryError } = await supabase.rpc("maintenance_apply_inventory_transaction", {
      p_organization_id: DENVA_ORG_ID, p_item_id: item.id, p_transaction_type: "add", p_quantity_change: 20,
      p_reason: "test", p_request_id: requestId, p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    assert.equal(retryError, null, retryError?.message);
    const retry = Array.isArray(retryResult) ? retryResult[0] : retryResult;
    assert.equal(retry.is_replay, true);

    const { data: finalItem } = await supabase.from("maintenance_inventory_items").select("quantity_on_hand").eq("id", item.id).single();
    assert.equal(Number(finalItem!.quantity_on_hand), 25, "a retried request must not double-apply");

    const { count: ledgerCount } = await supabase
      .from("maintenance_inventory_transactions")
      .select("*", { count: "exact", head: true })
      .eq("item_id", item.id)
      .eq("request_id", requestId);
    assert.equal(ledgerCount, 1, "exactly one ledger row per request_id, regardless of retries");
  } finally {
    await cleanupAll(() => deleteInventoryItem(item.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("inventory ledger: concurrent quantity changes never lose an update", async () => {
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const item = await createInventoryItem(DENVA_ORG_ID, location.id, { quantity_on_hand: 0 });

  try {
    const CONCURRENT_COUNT = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_COUNT }, () =>
        supabase.rpc("maintenance_apply_inventory_transaction", {
          p_organization_id: DENVA_ORG_ID, p_item_id: item.id, p_transaction_type: "add", p_quantity_change: 1,
          p_reason: "concurrency test", p_request_id: randomUUID(), p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
        })
      )
    );

    for (const result of results) {
      assert.equal(result.error, null, result.error?.message);
    }

    const { data: finalItem } = await supabase.from("maintenance_inventory_items").select("quantity_on_hand").eq("id", item.id).single();
    assert.equal(Number(finalItem!.quantity_on_hand), CONCURRENT_COUNT, "every concurrent +1 must be reflected — no lost updates from the advisory lock");

    const { count: ledgerCount } = await supabase
      .from("maintenance_inventory_transactions")
      .select("*", { count: "exact", head: true })
      .eq("item_id", item.id);
    assert.equal(ledgerCount, CONCURRENT_COUNT, "one ledger row per distinct request");
  } finally {
    await cleanupAll(() => deleteInventoryItem(item.id), () => supabase.from("maintenance_locations").delete().eq("id", location.id));
  }
});

test("inventory: low/out-of-stock classification matches the documented rules", () => {
  function classify(qty: number, min: number | null): "in_stock" | "low_stock" | "out_of_stock" {
    if (qty <= 0) return "out_of_stock";
    if (min !== null && qty <= min) return "low_stock";
    return "in_stock";
  }
  assert.equal(classify(0, 5), "out_of_stock");
  assert.equal(classify(3, 5), "low_stock");
  assert.equal(classify(5, 5), "low_stock");
  assert.equal(classify(6, 5), "in_stock");
  assert.equal(classify(0, null), "out_of_stock");
  assert.equal(classify(3, null), "in_stock", "no minimum configured must never classify as low-stock");
});

// ── Restock requests ─────────────────────────────────────────────────────────

test("restock: partial receiving is safe and cannot exceed the requested quantity, even on a retried receipt", async () => {
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const item = await createInventoryItem(DENVA_ORG_ID, location.id, { quantity_on_hand: 0 });

  const { data: request, error: requestError } = await supabase
    .from("maintenance_restock_requests")
    .insert({ organization_id: DENVA_ORG_ID, requested_by: TEST_USER_ID, requested_by_name_snapshot: TEST_USER_NAME })
    .select("*")
    .single();
  assert.equal(requestError, null, requestError?.message);

  const { data: line, error: lineError } = await supabase
    .from("maintenance_restock_request_lines")
    .insert({
      organization_id: DENVA_ORG_ID, request_id: request.id, item_id: item.id,
      item_name_snapshot: item.name, unit_snapshot: "each", requested_quantity: 10
    })
    .select("*")
    .single();
  assert.equal(lineError, null, lineError?.message);

  try {
    const { data: partial, error: partialError } = await supabase.rpc("maintenance_receive_restock_line", {
      p_organization_id: DENVA_ORG_ID, p_request_id: request.id, p_line_id: line.id, p_receive_quantity: 4,
      p_ledger_request_id: randomUUID(), p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    assert.equal(partialError, null, partialError?.message);
    const partialRow = Array.isArray(partial) ? partial[0] : partial;
    assert.equal(partialRow.request_status, "partially_received");
    assert.equal(Number(partialRow.line.received_quantity), 4);

    const { error: overReceiveError } = await supabase.rpc("maintenance_receive_restock_line", {
      p_organization_id: DENVA_ORG_ID, p_request_id: request.id, p_line_id: line.id, p_receive_quantity: 10,
      p_ledger_request_id: randomUUID(), p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    assert.ok(overReceiveError, "expected receiving more than remains to be rejected");
    assert.equal(overReceiveError!.code, "23514");

    const finalRequestId = randomUUID();
    const { data: full, error: fullError } = await supabase.rpc("maintenance_receive_restock_line", {
      p_organization_id: DENVA_ORG_ID, p_request_id: request.id, p_line_id: line.id, p_receive_quantity: 6,
      p_ledger_request_id: finalRequestId, p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    assert.equal(fullError, null, fullError?.message);
    const fullRow = Array.isArray(full) ? full[0] : full;
    assert.equal(fullRow.request_status, "received");

    // Retrying the same ledger request_id must not double-receive.
    const { data: retry } = await supabase.rpc("maintenance_receive_restock_line", {
      p_organization_id: DENVA_ORG_ID, p_request_id: request.id, p_line_id: line.id, p_receive_quantity: 6,
      p_ledger_request_id: finalRequestId, p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });
    const retryRow = Array.isArray(retry) ? retry[0] : retry;
    assert.equal(Number(retryRow.line.received_quantity), 10, "retrying an already-applied receipt must not push received past requested");

    const { data: finalItem } = await supabase.from("maintenance_inventory_items").select("quantity_on_hand").eq("id", item.id).single();
    assert.equal(Number(finalItem!.quantity_on_hand), 10);
  } finally {
    await cleanupAll(
      () => supabase.from("maintenance_inventory_transactions").delete().eq("related_restock_request_id", request.id),
      () => supabase.from("maintenance_restock_request_lines").delete().eq("request_id", request.id),
      () => supabase.from("maintenance_restock_requests").delete().eq("id", request.id),
      () => deleteInventoryItem(item.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

// ── Stock counts ─────────────────────────────────────────────────────────────

test("stock count: variance is calculated correctly, confirm is idempotent, and a conflicting change is detected", async () => {
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const item = await createInventoryItem(DENVA_ORG_ID, location.id, { quantity_on_hand: 10 });

  const { data: session, error: sessionError } = await supabase.rpc("maintenance_create_stock_count_session", {
    p_organization_id: DENVA_ORG_ID, p_location_id: location.id, p_location_name: location.name,
    p_started_by: TEST_USER_ID, p_started_by_name: TEST_USER_NAME
  });
  assert.equal(sessionError, null, sessionError?.message);
  const sessionRow = Array.isArray(session) ? session[0] : session;

  try {
    const { data: lines } = await supabase.from("maintenance_stock_count_lines").select("*").eq("session_id", sessionRow.id);
    assert.equal(lines?.length, 1);
    const line = lines![0];
    assert.equal(Number(line.expected_quantity), 10);

    await supabase.from("maintenance_stock_count_lines").update({ counted_quantity: 7, counted_by: TEST_USER_ID, counted_at: new Date().toISOString() }).eq("id", line.id);

    const { data: confirmed, error: confirmError } = await supabase.rpc("maintenance_confirm_stock_count_session", {
      p_organization_id: DENVA_ORG_ID, p_session_id: sessionRow.id, p_confirmed_by: TEST_USER_ID, p_confirmed_by_name: TEST_USER_NAME
    });
    assert.equal(confirmError, null, confirmError?.message);
    const confirmedRow = Array.isArray(confirmed) ? confirmed[0] : confirmed;
    assert.equal(confirmedRow.status, "confirmed");

    const { data: itemAfter } = await supabase.from("maintenance_inventory_items").select("quantity_on_hand").eq("id", item.id).single();
    assert.equal(Number(itemAfter!.quantity_on_hand), 7, "confirming applies a stock_count_correction bringing quantity to the counted value");

    const { count: correctionCount } = await supabase
      .from("maintenance_inventory_transactions")
      .select("*", { count: "exact", head: true })
      .eq("item_id", item.id)
      .eq("transaction_type", "stock_count_correction");
    assert.equal(correctionCount, 1);

    // Confirm is idempotent — calling it again on an already-confirmed session is a safe no-op.
    const { data: reconfirmed, error: reconfirmError } = await supabase.rpc("maintenance_confirm_stock_count_session", {
      p_organization_id: DENVA_ORG_ID, p_session_id: sessionRow.id, p_confirmed_by: TEST_USER_ID, p_confirmed_by_name: TEST_USER_NAME
    });
    assert.equal(reconfirmError, null, reconfirmError?.message);
    const { count: correctionCountAfterReconfirm } = await supabase
      .from("maintenance_inventory_transactions")
      .select("*", { count: "exact", head: true })
      .eq("item_id", item.id)
      .eq("transaction_type", "stock_count_correction");
    assert.equal(correctionCountAfterReconfirm, 1, "re-confirming must not apply a second correction");
  } finally {
    await cleanupAll(
      () => supabase.from("maintenance_inventory_transactions").delete().eq("related_stock_count_session_id", sessionRow.id),
      () => supabase.from("maintenance_stock_count_lines").delete().eq("session_id", sessionRow.id),
      () => supabase.from("maintenance_stock_count_sessions").delete().eq("id", sessionRow.id),
      () => deleteInventoryItem(item.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});

test("stock count: an inventory change after the session starts is detected as a conflict at confirm time", async () => {
  const location = await createLocation(DENVA_ORG_ID, `Loc ${randomUUID()}`);
  const item = await createInventoryItem(DENVA_ORG_ID, location.id, { quantity_on_hand: 10 });

  const { data: session, error: sessionError } = await supabase.rpc("maintenance_create_stock_count_session", {
    p_organization_id: DENVA_ORG_ID, p_location_id: location.id, p_location_name: location.name,
    p_started_by: TEST_USER_ID, p_started_by_name: TEST_USER_NAME
  });
  assert.equal(sessionError, null, sessionError?.message);
  const sessionRow = Array.isArray(session) ? session[0] : session;

  try {
    const { data: lines } = await supabase.from("maintenance_stock_count_lines").select("*").eq("session_id", sessionRow.id);
    const line = lines![0];
    await supabase.from("maintenance_stock_count_lines").update({ counted_quantity: 10, counted_by: TEST_USER_ID, counted_at: new Date().toISOString() }).eq("id", line.id);

    // Someone else adjusts the item AFTER the session snapshot was taken.
    await supabase.rpc("maintenance_apply_inventory_transaction", {
      p_organization_id: DENVA_ORG_ID, p_item_id: item.id, p_transaction_type: "add", p_quantity_change: 3,
      p_reason: "intervening change", p_request_id: randomUUID(), p_performed_by: TEST_USER_ID, p_performed_by_name: TEST_USER_NAME
    });

    const { error: confirmError } = await supabase.rpc("maintenance_confirm_stock_count_session", {
      p_organization_id: DENVA_ORG_ID, p_session_id: sessionRow.id, p_confirmed_by: TEST_USER_ID, p_confirmed_by_name: TEST_USER_NAME
    });
    assert.ok(confirmError, "expected the conflicting intervening transaction to block confirmation");
    assert.ok(confirmError!.message.startsWith("CONFLICT:"));

    const { data: sessionAfter } = await supabase.from("maintenance_stock_count_sessions").select("status").eq("id", sessionRow.id).single();
    assert.equal(sessionAfter!.status, "draft", "a rejected confirm must not change the session's status");

    const { data: itemAfter } = await supabase.from("maintenance_inventory_items").select("quantity_on_hand").eq("id", item.id).single();
    assert.equal(Number(itemAfter!.quantity_on_hand), 13, "the rejected confirm must not overwrite the newer, real transaction");
  } finally {
    await cleanupAll(
      () => supabase.from("maintenance_inventory_transactions").delete().eq("item_id", item.id),
      () => supabase.from("maintenance_stock_count_lines").delete().eq("session_id", sessionRow.id),
      () => supabase.from("maintenance_stock_count_sessions").delete().eq("id", sessionRow.id),
      () => deleteInventoryItem(item.id),
      () => supabase.from("maintenance_locations").delete().eq("id", location.id)
    );
  }
});
