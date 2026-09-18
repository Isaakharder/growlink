import { DueStatus, EquipmentRow, EquipmentStatus, InventoryItemRow, MeterUnit, RecurrenceType, StockStatus, UnitOfMeasure } from "./types";

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return dateStr;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function equipmentMeterUnitLabel(unit: MeterUnit, customLabel: string | null): string {
  if (unit === "custom") return customLabel ?? "Custom";
  return { hours: "Hours", km: "km", cycles: "Cycles" }[unit] ?? unit;
}

export function equipmentMeterUnit(equipment: Pick<EquipmentRow, "meter_unit" | "meter_unit_custom_label">): string {
  return equipmentMeterUnitLabel(equipment.meter_unit, equipment.meter_unit_custom_label);
}

export function unitOfMeasureLabel(unit: UnitOfMeasure, customLabel: string | null): string {
  if (unit === "custom") return customLabel ?? "Custom";
  return { each: "each", box: "box", package: "package", litre: "litre", kilogram: "kg", metre: "metre" }[unit] ?? unit;
}

export function inventoryUnitLabel(item: Pick<InventoryItemRow, "unit_of_measure" | "unit_of_measure_custom_label">): string {
  return unitOfMeasureLabel(item.unit_of_measure, item.unit_of_measure_custom_label);
}

export function dueStatusLabel(status: DueStatus): string {
  return { overdue: "Overdue", due_soon: "Due Soon", ok: "OK" }[status];
}

// Maps to .maintenance-status-badge.<suffix> — a dedicated badge class (not
// the food-safety cleaning-checklist one, whose "not-started" is a neutral
// gray, not red — that would visually understate "Overdue").
export function dueStatusClassSuffix(status: DueStatus): string {
  return { overdue: "danger", due_soon: "warning", ok: "ok" }[status];
}

export function stockStatusLabel(status: StockStatus): string {
  return { in_stock: "In Stock", low_stock: "Low Stock", out_of_stock: "Out of Stock" }[status];
}

export function stockStatusClassSuffix(status: StockStatus): string {
  return { in_stock: "ok", low_stock: "warning", out_of_stock: "danger" }[status];
}

export function equipmentStatusLabel(status: EquipmentStatus): string {
  return { active: "Active", out_of_service: "Out of Service", retired: "Retired" }[status];
}

export function recurrenceLabel(type: RecurrenceType, interval: number): string {
  if (type === "one_time") return "One-time";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[type];
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

export function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
