// Shared types for the Maintenance module, kept inline in this feature's own
// services directory rather than a repo-wide shared types module — matches
// the existing convention (Calibration, Food Safety, etc. each define their
// own shapes per-feature).

export type EquipmentStatus = "active" | "out_of_service" | "retired";
export const EQUIPMENT_STATUSES: EquipmentStatus[] = ["active", "out_of_service", "retired"];

export type MeterUnit = "hours" | "km" | "cycles" | "custom";
export const METER_UNITS: MeterUnit[] = ["hours", "km", "cycles", "custom"];

export type RecurrenceType = "one_time" | "daily" | "weekly" | "monthly" | "yearly";
export const RECURRENCE_TYPES: RecurrenceType[] = ["one_time", "daily", "weekly", "monthly", "yearly"];

export type UnitOfMeasure = "each" | "box" | "package" | "litre" | "kilogram" | "metre" | "custom";
export const UNITS_OF_MEASURE: UnitOfMeasure[] = ["each", "box", "package", "litre", "kilogram", "metre", "custom"];

// Units that must always carry a whole-number quantity — "custom" is
// deliberately excluded (an org's custom unit could be either whole or
// fractional; we can't know, so it isn't restricted).
export const DISCRETE_UNITS_OF_MEASURE: UnitOfMeasure[] = ["each", "box", "package"];

export type InventoryTransactionType =
  | "receive"
  | "add"
  | "remove"
  | "manual_adjustment"
  | "stock_count_correction"
  | "restock_receipt";

export const INVENTORY_TRANSACTION_TYPES: InventoryTransactionType[] = [
  "receive", "add", "remove", "manual_adjustment", "stock_count_correction", "restock_receipt"
];

// Transaction types a caller may request directly via
// POST /maintenance/inventory/items/:id/transactions — restock_receipt and
// stock_count_correction only ever come from their own dedicated flows
// (restock.ts / stockCounts.ts), which call maintenance_apply_inventory_
// transaction directly rather than going through the generic endpoint.
export const DIRECT_INVENTORY_TRANSACTION_TYPES: InventoryTransactionType[] = [
  "receive", "add", "remove", "manual_adjustment"
];

export type RestockRequestStatus = "requested" | "ordered" | "partially_received" | "received" | "cancelled";

export type StockCountSessionStatus = "draft" | "confirmed" | "cancelled";

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export type DueStatus = "overdue" | "due_soon" | "ok";

export type CalendarDate = { year: number; month: number; day: number };

export type ScheduleChecklistItemInput = {
  id?: string | null;
  label: string;
  sort_order: number;
};
