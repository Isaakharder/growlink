// Shared types for the mobile Maintenance module, mirrored from the
// recovered server contracts (server/src/routes/maintenance/). Kept in this
// feature's own directory rather than a repo-wide shared types module, to
// match this codebase's existing per-feature convention (pestCalibration,
// foodSafetyReports, etc. each keep their own types.ts).

export type EquipmentStatus = "active" | "out_of_service" | "retired";
export const EQUIPMENT_STATUSES: EquipmentStatus[] = ["active", "out_of_service", "retired"];

export type MeterUnit = "hours" | "km" | "cycles" | "custom";
export const METER_UNITS: MeterUnit[] = ["hours", "km", "cycles", "custom"];

export type RecurrenceType = "one_time" | "daily" | "weekly" | "monthly" | "yearly";
export const RECURRENCE_TYPES: RecurrenceType[] = ["one_time", "daily", "weekly", "monthly", "yearly"];

export type UnitOfMeasure = "each" | "box" | "package" | "litre" | "kilogram" | "metre" | "custom";
export const UNITS_OF_MEASURE: UnitOfMeasure[] = ["each", "box", "package", "litre", "kilogram", "metre", "custom"];
export const DISCRETE_UNITS_OF_MEASURE: UnitOfMeasure[] = ["each", "box", "package"];

export type InventoryTransactionType =
  | "receive" | "add" | "remove" | "manual_adjustment" | "stock_count_correction" | "restock_receipt";

export type DirectInventoryTransactionType = "receive" | "add" | "remove" | "manual_adjustment";
export const DIRECT_INVENTORY_TRANSACTION_TYPES: DirectInventoryTransactionType[] = [
  "receive", "add", "remove", "manual_adjustment"
];

export type RestockRequestStatus = "requested" | "ordered" | "partially_received" | "received" | "cancelled";
export type StockCountSessionStatus = "draft" | "confirmed" | "cancelled";
export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";
export type DueStatus = "overdue" | "due_soon" | "ok";

export type NamedRef = { id: string; name: string };

// ── Setup ────────────────────────────────────────────────────────────────

export type SetupRecord = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

// ── Equipment ────────────────────────────────────────────────────────────

export type EquipmentRow = {
  id: string;
  organization_id: string;
  name: string;
  asset_code: string;
  category_id: string;
  location_id: string;
  status: EquipmentStatus;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  description: string | null;
  meter_unit: MeterUnit;
  meter_unit_custom_label: string | null;
  qr_token: string;
  qr_token_created_at: string;
  current_meter_reading: number | null;
  current_meter_reading_at: string | null;
  created_at: string;
  updated_at: string;
  category: NamedRef | null;
  location: NamedRef | null;
  due_status: DueStatus;
};

export type EquipmentDetail = EquipmentRow & { schedules: ScheduleRow[] };

export type EquipmentPayload = {
  name: string;
  asset_code: string;
  category_id: string;
  location_id: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  description: string | null;
  meter_unit: MeterUnit;
  meter_unit_custom_label: string | null;
};

export type MeterReadingRow = {
  id: string;
  organization_id: string;
  equipment_id: string | null;
  equipment_name_snapshot: string;
  asset_code_snapshot: string;
  value: number;
  unit_snapshot: string;
  recorded_at: string;
  recorded_by: string | null;
  recorded_by_name_snapshot: string;
  note: string | null;
  is_reset: boolean;
  reset_reason: string | null;
  created_at: string;
  related_work_log_id: string | null;
};

// ── Work logs ────────────────────────────────────────────────────────────

export type WorkLogRow = {
  id: string;
  organization_id: string;
  equipment_id: string | null;
  equipment_name_snapshot: string;
  asset_code_snapshot: string;
  work_performed: string;
  meter_reading_value: number | null;
  meter_reading_unit_snapshot: string | null;
  notes: string | null;
  performed_at: string;
  performed_by: string | null;
  performed_by_name_snapshot: string;
  request_id: string;
  created_at: string;
};

// Discriminated union returned by GET /maintenance/equipment/:id/history —
// each entry carries its own full row fields alongside a `type` tag and a
// normalized `at` timestamp the client can sort/display uniformly without
// needing to know which underlying table it came from.
export type EquipmentHistoryEntry =
  | (WorkLogRow & { type: "work_log"; at: string })
  | (MeterReadingRow & { type: "meter_reading"; at: string })
  | (ScheduleCompletion & { type: "schedule_completion"; at: string });

export type DueSummarySchedule = {
  id: string;
  equipment_id: string;
  name: string;
  next_due_date: string;
  warning_days_before_due: number;
  equipment: { id: string; name: string; asset_code: string; status: EquipmentStatus };
};

export type DueSummary = { overdue: DueSummarySchedule[]; due_soon: DueSummarySchedule[] };

// ── Schedules ────────────────────────────────────────────────────────────

export type ScheduleChecklistItem = { id?: string | null; label: string; sort_order: number };

export type ScheduleRow = {
  id: string;
  organization_id: string;
  equipment_id: string;
  name: string;
  instructions: string | null;
  first_due_date: string;
  recurrence_type: RecurrenceType;
  recurrence_interval: number;
  warning_days_before_due: number;
  is_active: boolean;
  next_due_date: string | null;
  next_occurrence_index: number;
  last_completed_at: string | null;
  created_at: string;
  updated_at: string;
  equipment?: { id: string; name: string; asset_code: string };
};

export type ScheduleDetail = ScheduleRow & { checklist_items: ScheduleChecklistItem[] };

export type SchedulePayload = {
  equipment_id: string;
  name: string;
  instructions: string | null;
  first_due_date: string;
  recurrence_type: RecurrenceType;
  recurrence_interval: number;
  warning_days_before_due: number;
  checklist_items: ScheduleChecklistItem[];
};

export type ScheduleCompletion = {
  id: string;
  organization_id: string;
  schedule_id: string | null;
  schedule_name_snapshot: string;
  equipment_id: string | null;
  equipment_name_snapshot: string;
  asset_code_snapshot: string;
  occurrence_index: number;
  due_date_snapshot: string;
  completion_request_id: string;
  completed_by: string | null;
  completed_by_name_snapshot: string;
  completed_at: string;
  meter_reading_value: number | null;
  meter_reading_unit_snapshot: string | null;
  notes: string | null;
  checklist_snapshot: Array<{ id: string; label: string; sort_order: number; checked: boolean }>;
  next_due_date_snapshot: string | null;
  created_at: string;
};

// ── Inventory ────────────────────────────────────────────────────────────

export type InventoryItemRow = {
  id: string;
  organization_id: string;
  name: string;
  part_number: string | null;
  part_type_id: string | null;
  location_id: string;
  quantity_on_hand: number;
  unit_of_measure: UnitOfMeasure;
  unit_of_measure_custom_label: string | null;
  minimum_quantity: number | null;
  suggested_reorder_quantity: number | null;
  supplier: string | null;
  supplier_part_number: string | null;
  cost: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  part_type: NamedRef | null;
  location: NamedRef | null;
  stock_status: StockStatus;
};

export type InventoryItemPayload = {
  name: string;
  part_number: string | null;
  part_type_id: string | null;
  location_id: string;
  unit_of_measure: UnitOfMeasure;
  unit_of_measure_custom_label: string | null;
  minimum_quantity: number | null;
  suggested_reorder_quantity: number | null;
  supplier: string | null;
  supplier_part_number: string | null;
  cost: number | null;
  notes: string | null;
};

export type InventoryTransactionResult = {
  transaction_id: string;
  quantity_before: number;
  quantity_after: number;
  is_replay: boolean;
  item: InventoryItemRow;
};

export type InventoryTransactionRow = {
  id: string;
  organization_id: string;
  item_id: string | null;
  item_name_snapshot: string;
  transaction_type: InventoryTransactionType;
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
  unit_snapshot: string;
  reason: string | null;
  request_id: string;
  performed_by: string | null;
  performed_by_name_snapshot: string;
  related_restock_request_id: string | null;
  related_restock_line_id: string | null;
  related_stock_count_session_id: string | null;
  created_at: string;
  item: { id: string; name: string; part_number: string | null } | null;
};

// ── Restock ──────────────────────────────────────────────────────────────

export type RestockRequestRow = {
  id: string;
  organization_id: string;
  status: RestockRequestStatus;
  notes: string | null;
  requested_by: string | null;
  requested_by_name_snapshot: string;
  ordered_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancelled_reason: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RestockRequestLineRow = {
  id: string;
  organization_id: string;
  request_id: string;
  item_id: string | null;
  item_name_snapshot: string;
  unit_snapshot: string;
  requested_quantity: number;
  received_quantity: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  item: { id: string; name: string; part_number: string | null } | null;
};

export type RestockRequestDetail = RestockRequestRow & { lines: RestockRequestLineRow[] };

export type RestockReceiveResult = { line: RestockRequestLineRow; request_status: RestockRequestStatus };

// ── Stock counts ─────────────────────────────────────────────────────────

export type StockCountSessionRow = {
  id: string;
  organization_id: string;
  location_id: string | null;
  location_name_snapshot: string;
  status: StockCountSessionStatus;
  started_by: string | null;
  started_by_name_snapshot: string;
  started_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type StockCountLineRow = {
  id: string;
  organization_id: string;
  session_id: string;
  item_id: string | null;
  item_name_snapshot: string;
  unit_snapshot: string;
  expected_quantity: number;
  expected_last_transaction_id: string | null;
  counted_quantity: number | null;
  counted_at: string | null;
  counted_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  variance: number | null;
};

export type StockCountSessionDetail = StockCountSessionRow & { lines: StockCountLineRow[] };

export type StockCountConflict = { line_id: string; reason: "not_counted" | "inventory_changed_since_snapshot" };

// ── Badges ───────────────────────────────────────────────────────────────

export type MaintenanceBadges = {
  equipment_due_soon: number;
  equipment_overdue: number;
  inventory_low_stock: number;
  inventory_out_of_stock: number;
  restock_pending: number;
};
