// Shared types for the Calibration module (devices, tasks/fields,
// completed records). Kept inline in this feature's own services
// directory rather than a repo-wide shared types module, matching the
// existing convention (Food Safety/pest control also define their shapes
// per-feature, not in a shared types package).

export type FrequencyType =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annually"
  | "on_demand"
  | "custom";

export const FREQUENCY_TYPES: FrequencyType[] = [
  "daily", "weekly", "monthly", "quarterly", "annually", "on_demand", "custom"
];

export type CustomIntervalUnit = "days" | "weeks" | "months";

export const CUSTOM_INTERVAL_UNITS: CustomIntervalUnit[] = ["days", "weeks", "months"];

// "repeating_group" is deliberately not a field_type — repeating-ness is a
// per-task property (Task.is_repeating), not a kind of answer. Every
// remaining type is a genuinely answerable field.
export type FieldType =
  | "checkbox"
  | "short_text"
  | "long_text"
  | "number"
  | "pass_fail"
  | "multiple_choice"
  | "date";

export const FIELD_TYPES: FieldType[] = [
  "checkbox", "short_text", "long_text", "number", "pass_fail", "multiple_choice", "date"
];

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
  // by any validation logic yet.
  required_when_field_id: string | null;
  required_when_equals: unknown;
};

// Flat shape used both for a non-repeating task's direct answers and for
// each repeating-task row's child answers — same validation/snapshot code
// path for both.
export type FieldAnswerInput = {
  template_field_id: string;
  value_text?: string | null;
  value_number?: number | null;
  value_boolean?: boolean | null;
  value_date?: string | null;
  // checkbox only: which of the field's choice_options were checked.
  value_choices?: string[] | null;
};

export type RepeatingRowInput = {
  task_id: string; // the repeating task this row belongs to
  answers: FieldAnswerInput[];
};

// Snapshot shape stored per-answer (a non-repeating task's flat answer, or
// one within a repeating row) — matches the *_snapshot columns on
// pest_calibration_record_answers / pest_calibration_record_repeating_answers.
export type AnswerSnapshot = {
  template_field_id: string | null;
  field_label_snapshot: string;
  field_type_snapshot: FieldType;
  help_text_snapshot: string | null;
  placeholder_snapshot: string | null;
  unit_snapshot: string | null;
  min_value_snapshot: number | null;
  max_value_snapshot: number | null;
  decimal_precision_snapshot: number | null;
  choice_options_snapshot: string[] | null;
  is_required_snapshot: boolean;
  sort_order: number;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_choices: string[] | null;
  is_within_range: boolean | null;
};

// Only used for a non-repeating task's flat answers (buildFlatAnswerSnapshots) —
// carries the task context needed to group answers back under their task in
// the record detail view.
export type TaskStampedAnswerSnapshot = AnswerSnapshot & {
  task_id: string | null;
  task_name_snapshot: string;
  task_sort_order: number;
};
