import { describe, expect, it } from "vitest";
import {
  dueStatusClassSuffix, dueStatusLabel, equipmentMeterUnit, equipmentStatusLabel, formatQuantity, inventoryUnitLabel,
  recurrenceLabel, stockStatusClassSuffix, stockStatusLabel
} from "../formatters";

describe("dueStatusClassSuffix", () => {
  // Overdue must map to a visually alarming class, not the neutral "gray"
  // class the food-safety module's cleaning-checklist badge would render —
  // that mismatch was caught and fixed while building this module, so it's
  // pinned here.
  it("maps overdue to danger, due_soon to warning, ok to ok", () => {
    expect(dueStatusClassSuffix("overdue")).toBe("danger");
    expect(dueStatusClassSuffix("due_soon")).toBe("warning");
    expect(dueStatusClassSuffix("ok")).toBe("ok");
  });

  it("labels match the badge text shown to the user", () => {
    expect(dueStatusLabel("overdue")).toBe("Overdue");
    expect(dueStatusLabel("due_soon")).toBe("Due Soon");
    expect(dueStatusLabel("ok")).toBe("OK");
  });
});

describe("stockStatusClassSuffix", () => {
  it("maps out_of_stock to danger, low_stock to warning, in_stock to ok", () => {
    expect(stockStatusClassSuffix("out_of_stock")).toBe("danger");
    expect(stockStatusClassSuffix("low_stock")).toBe("warning");
    expect(stockStatusClassSuffix("in_stock")).toBe("ok");
  });

  it("labels match the badge text shown to the user", () => {
    expect(stockStatusLabel("out_of_stock")).toBe("Out of Stock");
    expect(stockStatusLabel("low_stock")).toBe("Low Stock");
    expect(stockStatusLabel("in_stock")).toBe("In Stock");
  });
});

describe("equipmentMeterUnit", () => {
  it("uses the custom label when meter_unit is custom", () => {
    expect(equipmentMeterUnit({ meter_unit: "custom", meter_unit_custom_label: "Cycles Run" })).toBe("Cycles Run");
  });

  it("falls back to a friendly label for known units", () => {
    expect(equipmentMeterUnit({ meter_unit: "hours", meter_unit_custom_label: null })).toBe("Hours");
    expect(equipmentMeterUnit({ meter_unit: "km", meter_unit_custom_label: null })).toBe("km");
  });
});

describe("inventoryUnitLabel", () => {
  it("uses the custom label when unit_of_measure is custom", () => {
    expect(inventoryUnitLabel({ unit_of_measure: "custom", unit_of_measure_custom_label: "Pallet" })).toBe("Pallet");
  });

  it("falls back to a friendly label for known units", () => {
    expect(inventoryUnitLabel({ unit_of_measure: "each", unit_of_measure_custom_label: null })).toBe("each");
    expect(inventoryUnitLabel({ unit_of_measure: "kilogram", unit_of_measure_custom_label: null })).toBe("kg");
  });
});

describe("recurrenceLabel", () => {
  it("describes one_time distinctly from a recurring interval of 1", () => {
    expect(recurrenceLabel("one_time", 1)).toBe("One-time");
    expect(recurrenceLabel("monthly", 1)).toBe("Every month");
  });

  it("pluralizes multi-interval recurrences", () => {
    expect(recurrenceLabel("weekly", 2)).toBe("Every 2 weeks");
    expect(recurrenceLabel("yearly", 3)).toBe("Every 3 years");
  });
});

describe("equipmentStatusLabel", () => {
  it("labels every equipment status", () => {
    expect(equipmentStatusLabel("active")).toBe("Active");
    expect(equipmentStatusLabel("out_of_service")).toBe("Out of Service");
    expect(equipmentStatusLabel("retired")).toBe("Retired");
  });
});

describe("formatQuantity", () => {
  it("renders whole numbers without decimals", () => {
    expect(formatQuantity(5)).toBe("5");
    expect(formatQuantity(0)).toBe("0");
  });

  it("renders fractional quantities trimmed of trailing zeros", () => {
    expect(formatQuantity(5.5)).toBe("5.5");
    expect(formatQuantity(5.25)).toBe("5.25");
  });
});
