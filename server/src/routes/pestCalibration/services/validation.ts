import {
  AnswerSnapshot, FieldAnswerInput, RepeatingRowInput, Task, TaskStampedAnswerSnapshot, TemplateField
} from "./types";

export class CalibrationValidationError extends Error {}

function isAnswerEmpty(answer: FieldAnswerInput | undefined): boolean {
  if (!answer) return true;
  const hasText = typeof answer.value_text === "string" && answer.value_text.trim().length > 0;
  const hasNumber = typeof answer.value_number === "number" && Number.isFinite(answer.value_number);
  const hasBoolean = typeof answer.value_boolean === "boolean";
  const hasDate = typeof answer.value_date === "string" && answer.value_date.trim().length > 0;
  const hasChoices = Array.isArray(answer.value_choices) && answer.value_choices.length > 0;
  return !hasText && !hasNumber && !hasBoolean && !hasDate && !hasChoices;
}

/**
 * Validates and snapshots a single field's answer against its template
 * field definition. Shared by both a non-repeating task's direct answers
 * and a repeating task's row answers — same rules either way.
 */
function buildAnswerSnapshot(field: TemplateField, answer: FieldAnswerInput | undefined): AnswerSnapshot {
  const base: AnswerSnapshot = {
    template_field_id: field.id,
    field_label_snapshot: field.label,
    field_type_snapshot: field.field_type,
    help_text_snapshot: field.help_text,
    placeholder_snapshot: field.placeholder,
    unit_snapshot: field.unit,
    min_value_snapshot: field.min_value,
    max_value_snapshot: field.max_value,
    decimal_precision_snapshot: field.decimal_precision,
    choice_options_snapshot: field.choice_options,
    is_required_snapshot: field.is_required,
    sort_order: field.sort_order,
    value_text: null,
    value_number: null,
    value_boolean: null,
    value_date: null,
    value_choices: null,
    is_within_range: null
  };

  switch (field.field_type) {
    case "checkbox": {
      // Multi-select against the field's configured choice_options labels
      // (e.g. "Clean" / "Undamaged" / "Installed correctly" under one
      // "Condition" field) — not a single true/false. Required means at
      // least one label must be checked.
      const configuredOptions = field.choice_options ?? [];
      const submitted = Array.isArray(answer?.value_choices) ? answer!.value_choices! : [];
      const checked = submitted.filter((label): label is string => typeof label === "string" && configuredOptions.includes(label));
      if (field.is_required && checked.length === 0) {
        throw new CalibrationValidationError(`"${field.label}" requires at least one checkbox checked.`);
      }
      base.value_choices = checked.length > 0 ? checked : null;
      return base;
    }

    case "pass_fail": {
      const value = answer?.value_boolean;
      if (field.is_required && typeof value !== "boolean") {
        throw new CalibrationValidationError(`"${field.label}" is required.`);
      }
      base.value_boolean = typeof value === "boolean" ? value : null;
      return base;
    }

    case "short_text":
    case "long_text": {
      const trimmed = typeof answer?.value_text === "string" ? answer.value_text.trim() : "";
      if (field.is_required && trimmed.length === 0) {
        throw new CalibrationValidationError(`"${field.label}" is required.`);
      }
      base.value_text = trimmed.length > 0 ? trimmed : null;
      return base;
    }

    case "multiple_choice": {
      const trimmed = typeof answer?.value_text === "string" ? answer.value_text.trim() : "";
      if (field.is_required && trimmed.length === 0) {
        throw new CalibrationValidationError(`"${field.label}" is required.`);
      }
      if (trimmed.length > 0 && field.choice_options && !field.choice_options.includes(trimmed)) {
        throw new CalibrationValidationError(`"${field.label}" must be one of the configured options.`);
      }
      base.value_text = trimmed.length > 0 ? trimmed : null;
      return base;
    }

    case "date": {
      const raw = typeof answer?.value_date === "string" ? answer.value_date.trim() : "";
      if (field.is_required && raw.length === 0) {
        throw new CalibrationValidationError(`"${field.label}" is required.`);
      }
      if (raw.length > 0 && Number.isNaN(Date.parse(raw))) {
        throw new CalibrationValidationError(`"${field.label}" must be a valid date.`);
      }
      base.value_date = raw.length > 0 ? raw : null;
      return base;
    }

    case "number": {
      const value = answer?.value_number;
      const hasValue = typeof value === "number" && Number.isFinite(value);
      if (field.is_required && !hasValue) {
        throw new CalibrationValidationError(`"${field.label}" is required.`);
      }
      if (hasValue) {
        base.value_number = value as number;
        const belowMin = field.min_value !== null && (value as number) < field.min_value;
        const aboveMax = field.max_value !== null && (value as number) > field.max_value;
        if (field.min_value !== null || field.max_value !== null) {
          base.is_within_range = !belowMin && !aboveMax;
        }
      }
      return base;
    }

    default:
      throw new CalibrationValidationError(`Unsupported field type for "${field.label}".`);
  }
}

/**
 * Validates and snapshots every non-repeating task's fields, in task order
 * then field order. Every answer is stamped with which task it belongs to
 * so the record detail view can group flat answers back under their task
 * card (a non-repeating task has no row wrapper — its fields are answered
 * directly, exactly once).
 */
export function buildFlatAnswerSnapshots(
  tasks: Task[],
  fields: TemplateField[],
  answers: FieldAnswerInput[]
): TaskStampedAnswerSnapshot[] {
  const answersByFieldId = new Map(answers.map((a) => [a.template_field_id, a]));
  const nonRepeatingTasks = tasks.filter((t) => !t.is_repeating).slice().sort((a, b) => a.sort_order - b.sort_order);

  const result: TaskStampedAnswerSnapshot[] = [];
  for (const task of nonRepeatingTasks) {
    const taskFields = fields
      .filter((f) => f.task_id === task.id)
      .sort((a, b) => a.sort_order - b.sort_order);

    for (const field of taskFields) {
      const snapshot = buildAnswerSnapshot(field, answersByFieldId.get(field.id));
      result.push({ ...snapshot, task_id: task.id, task_name_snapshot: task.name, task_sort_order: task.sort_order });
    }
  }
  return result;
}

export type RepeatingRowResult = {
  task_id: string;
  task_name_snapshot: string;
  task_sort_order: number;
  row_index: number;
  answers: AnswerSnapshot[];
};

/**
 * Validates and snapshots every repeating task's rows.
 * - A row where every answer is empty is discarded before validation runs
 *   (an added-then-abandoned row never becomes a phantom empty row).
 * - min_rows/max_rows on the task are enforced against the surviving row count.
 * - Each remaining row is validated as its own mini-record — every
 *   required field in the task must be answered within that row.
 */
export function buildRepeatingRows(
  tasks: Task[],
  fields: TemplateField[],
  rowsInput: RepeatingRowInput[]
): RepeatingRowResult[] {
  const repeatingTasks = tasks.filter((t) => t.is_repeating);
  const results: RepeatingRowResult[] = [];

  for (const task of repeatingTasks) {
    const taskFields = fields
      .filter((f) => f.task_id === task.id)
      .sort((a, b) => a.sort_order - b.sort_order);

    const rowsForTask = rowsInput.filter((r) => r.task_id === task.id);

    const nonEmptyRows = rowsForTask.filter(
      (row) => !row.answers.every((a) => isAnswerEmpty(a))
    );

    if (task.min_rows !== null && nonEmptyRows.length < task.min_rows) {
      throw new CalibrationValidationError(
        `"${task.name}" requires at least ${task.min_rows} row(s).`
      );
    }
    if (task.max_rows !== null && nonEmptyRows.length > task.max_rows) {
      throw new CalibrationValidationError(
        `"${task.name}" allows at most ${task.max_rows} row(s).`
      );
    }

    nonEmptyRows.forEach((row, index) => {
      const answersByFieldId = new Map(row.answers.map((a) => [a.template_field_id, a]));
      const answers = taskFields.map((field) =>
        buildAnswerSnapshot(field, answersByFieldId.get(field.id))
      );

      results.push({
        task_id: task.id,
        task_name_snapshot: task.name,
        task_sort_order: task.sort_order,
        row_index: index,
        answers
      });
    });
  }

  return results;
}
