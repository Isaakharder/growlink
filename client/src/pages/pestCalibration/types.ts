// Shared client-side types for the Calibration module, mirroring
// server/src/routes/pestCalibration/services/types.ts.

export type FrequencyType =
  | "daily" | "weekly" | "monthly" | "quarterly" | "annually" | "on_demand" | "custom";

export const FREQUENCY_OPTIONS: { value: FrequencyType; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annually", label: "Annually" },
  { value: "on_demand", label: "On demand" },
  { value: "custom", label: "Custom interval" }
];

export type CustomIntervalUnit = "days" | "weeks" | "months";

export type DueStatus = "on_demand" | "overdue" | "due_soon" | "ok";

// "repeating_group" is deliberately not a field_type — repeating-ness is a
// per-task property (Task.is_repeating), not a kind of answer.
export type FieldType =
  | "checkbox" | "short_text" | "long_text" | "number" | "pass_fail" | "multiple_choice" | "date";

export const FIELD_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "checkbox", label: "Checkbox" },
  { value: "pass_fail", label: "Pass/fail" },
  { value: "multiple_choice", label: "Multiple choice" },
  { value: "date", label: "Date" }
];

export type CalibrationDevice = {
  id: string;
  name: string;
  area: string | null;
  identification_number: string | null;
  frequency_type: FrequencyType;
  custom_interval_value: number | null;
  custom_interval_unit: CustomIntervalUnit | null;
  // Admin-internal notes — never shown to employees, mirrors Food Safety's notes.
  notes: string | null;
  // Worker-facing — shown when starting a calibration, mirrors Food Safety's
  // mobile_instructions. Plain text, not a structured document.
  instructions: string | null;
  is_active: boolean;
  last_completed_at: string | null;
  next_due_at: string | null;
  due_status: DueStatus;
  task_count: number;
};

// The employee-facing card. Always contains one or more TemplateFields.
// is_repeating=false: fields are answered once, directly (a "Nozzle 1" or
// "Pressure" task). is_repeating=true: the employee adds/removes rows,
// each containing all of the task's fields (a "Nozzle Measurements" task).
export type Task = {
  id: string;
  template_id: string;
  name: string;
  sort_order: number;
  is_repeating: boolean;
  min_rows: number | null;
  max_rows: number | null;
};

export type TemplateField = {
  id: string;
  task_id: string;
  field_type: FieldType;
  label: string;
  help_text: string | null;
  is_required: boolean;
  // short_text/long_text/number/date only — a UI input hint, not an answer.
  placeholder: string | null;
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
  decimal_precision: number | null;
  // multiple_choice: selectable options. checkbox: individually-checkable
  // labels (multi-select). pass_fail: exactly 2 entries [pass label, fail
  // label], defaulting to ["Pass", "Fail"].
  choice_options: string[] | null;
  sort_order: number;
  // Reserved for future conditional-required support — not read or written
  // by any UI yet.
  required_when_field_id: string | null;
  required_when_equals: unknown;
};

export type CalibrationTemplate = {
  id: string;
  device_id: string;
};

export type DeviceDetail = {
  device: CalibrationDevice;
  template: CalibrationTemplate | null;
  tasks: Task[];
  fields: TemplateField[];
};

export type CalibrationRecordSummary = {
  id: string;
  device_id: string | null;
  device_name_snapshot: string;
  device_area_snapshot: string | null;
  completed_by_user_id: string | null;
  completed_by_name: string;
  completed_at: string;
  created_at: string;
  // The (possibly backdated) date the calibration was actually performed —
  // see the mobile long-press date selector. Distinct from completed_at
  // (the real submission instant, never backdated).
  effective_date: string;
  next_due_at: string | null;
};
