import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSetupPayload } from "../setup";
import { validateEquipmentPayload } from "../equipment";
import { validateInventoryItemPayload } from "../inventory";

// ── setup payload (categories/locations/part types share this validator) ──

test("setup payload: blank name is rejected", () => {
  assert.throws(() => validateSetupPayload({ name: "   " }), /Name is required/);
});

test("setup payload: trims name and defaults display_order to 0", () => {
  const result = validateSetupPayload({ name: "  Irrigation  " });
  assert.equal(result.name, "Irrigation");
  assert.equal(result.display_order, 0);
});

test("setup payload: non-object body is rejected", () => {
  assert.throws(() => validateSetupPayload(null), /Invalid request body/);
});

// ── equipment payload ────────────────────────────────────────────────────

function validEquipment(overrides: Record<string, unknown> = {}) {
  return {
    name: "Tractor 1",
    asset_code: "TR-001",
    category_id: "11111111-1111-1111-1111-111111111111",
    location_id: "22222222-2222-2222-2222-222222222222",
    meter_unit: "hours",
    ...overrides
  };
}

test("equipment payload: custom meter unit requires a custom label", () => {
  assert.throws(() => validateEquipmentPayload(validEquipment({ meter_unit: "custom" })), /custom meter unit label is required/);
});

test("equipment payload: custom label is rejected when meter unit is not custom", () => {
  assert.throws(
    () => validateEquipmentPayload(validEquipment({ meter_unit: "hours", meter_unit_custom_label: "Cycles" })),
    /only valid when the meter unit is Custom/
  );
});

test("equipment payload: valid custom meter unit is accepted", () => {
  const result = validateEquipmentPayload(validEquipment({ meter_unit: "custom", meter_unit_custom_label: "Sprays" }));
  assert.equal(result.meter_unit, "custom");
  assert.equal(result.meter_unit_custom_label, "Sprays");
});

test("equipment payload: missing asset_code is rejected", () => {
  assert.throws(() => validateEquipmentPayload(validEquipment({ asset_code: "" })), /Asset code is required/);
});

test("equipment payload: invalid meter_unit is rejected", () => {
  assert.throws(() => validateEquipmentPayload(validEquipment({ meter_unit: "gallons" })), /Meter unit must be one of/);
});

// ── inventory item payload ───────────────────────────────────────────────

function validInventoryItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "Bearing 6205",
    location_id: "33333333-3333-3333-3333-333333333333",
    unit_of_measure: "each",
    ...overrides
  };
}

test("inventory item payload: custom unit requires a custom label", () => {
  assert.throws(() => validateInventoryItemPayload(validInventoryItem({ unit_of_measure: "custom" })), /custom unit label is required/);
});

test("inventory item payload: negative minimum_quantity is rejected", () => {
  assert.throws(() => validateInventoryItemPayload(validInventoryItem({ minimum_quantity: -1 })), /Minimum quantity must be zero or greater/);
});

test("inventory item payload: null minimum_quantity is accepted (never low-stock)", () => {
  const result = validateInventoryItemPayload(validInventoryItem({ minimum_quantity: null }));
  assert.equal(result.minimum_quantity, null);
});

test("inventory item payload: missing location is rejected", () => {
  assert.throws(() => validateInventoryItemPayload(validInventoryItem({ location_id: "" })), /Location is required/);
});
