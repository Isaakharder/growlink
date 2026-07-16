// Validates a record's answers_json against the exact published schema it
// was completed against. Structural/type/range checks are pure and
// synchronous; employee_selector and location_asset_selector answers
// additionally require a database lookup (cross-org / active / filter
// checks), so the overall function is async. Like templateSchema.ts's
// validateFormSchema, this is the SOLE authority — frontend validation is a
// UX convenience only.
import { supabase } from "../../../config/supabase";
import type { FoodSafetyFormField, FoodSafetyFormSchema } from "./templateSchema";

export type AnswersValidationMode = "draft" | "submit";

export type AnswersValidationResult =
  | { valid: true; answers: Record<string, unknown> }
  | { valid: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function from(table: string) {
  return (supabase as any).from(table); // eslint-disable-line @typescript-eslint/no-explicit-any
}

// "Answered" means the key is present with a non-null/non-undefined value —
// deliberately distinct from `false`, so a checkbox/yes_no/pass_fail answer
// of false/"fail" is treated as a real, present answer rather than missing.
function isAnswered(answers: Record<string, unknown>, fieldId: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(answers, fieldId) &&
    answers[fieldId] !== null &&
    answers[fieldId] !== undefined
  );
}

type SelectorCheck = { field: FoodSafetyFormField; value: string };

export async function validateAnswers(
  schema: FoodSafetyFormSchema,
  rawAnswers: unknown,
  organizationId: string,
  mode: AnswersValidationMode
): Promise<AnswersValidationResult> {
  const errors: string[] = [];

  if (rawAnswers === null || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    return { valid: false, errors: ["answers_json must be a JSON object."] };
  }
  const answers = rawAnswers as Record<string, unknown>;

  const fields: FoodSafetyFormField[] = schema.sections.flatMap((section) => section.fields);
  const fieldById = new Map(fields.map((field) => [field.id, field]));

  for (const key of Object.keys(answers)) {
    if (!fieldById.has(key)) {
      errors.push(`Unknown field id "${key}" in answers.`);
    }
  }

  const employeeChecks: SelectorCheck[] = [];
  const locationChecks: SelectorCheck[] = [];

  for (const field of fields) {
    if (field.type === "information") {
      if (isAnswered(answers, field.id)) {
        errors.push(`"${field.label}" is an information field and cannot accept an answer.`);
      }
      continue;
    }

    if (!isAnswered(answers, field.id)) {
      if (mode === "submit" && field.required) {
        errors.push(`"${field.label}" is required.`);
      }
      continue;
    }

    validateFieldValue(field, answers[field.id], errors, employeeChecks, locationChecks);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  if (employeeChecks.length > 0) {
    const ids = Array.from(new Set(employeeChecks.map((check) => check.value)));
    const { data, error } = await from("employees")
      .select("id, active")
      .eq("organization_id", organizationId)
      .in("id", ids);

    if (error) {
      return { valid: false, errors: ["Failed to verify employee selector answers."] };
    }

    const byId = new Map(((data ?? []) as Array<{ id: string; active: boolean }>).map((row) => [row.id, row]));
    for (const check of employeeChecks) {
      const employee = byId.get(check.value);
      if (!employee) {
        errors.push(`"${check.field.label}": selected employee was not found in this organization.`);
        continue;
      }
      if (check.field.config?.activeEmployeesOnly && !employee.active) {
        errors.push(`"${check.field.label}": selected employee is not active.`);
      }
    }
  }

  if (locationChecks.length > 0) {
    const ids = Array.from(new Set(locationChecks.map((check) => check.value)));
    const { data, error } = await from("food_safety_locations")
      .select("id, department_id, location_type")
      .eq("organization_id", organizationId)
      .in("id", ids);

    if (error) {
      return { valid: false, errors: ["Failed to verify location/asset selector answers."] };
    }

    const byId = new Map(
      ((data ?? []) as Array<{ id: string; department_id: string | null; location_type: string }>).map((row) => [
        row.id,
        row
      ])
    );
    for (const check of locationChecks) {
      const location = byId.get(check.value);
      if (!location) {
        errors.push(`"${check.field.label}": selected location/asset was not found in this organization.`);
        continue;
      }
      const filterDepartmentId = check.field.config?.filterDepartmentId;
      if (filterDepartmentId && location.department_id !== filterDepartmentId) {
        errors.push(`"${check.field.label}": selected location/asset does not belong to the required department.`);
      }
      const filterLocationType = check.field.config?.filterLocationType;
      if (filterLocationType && location.location_type !== filterLocationType) {
        errors.push(`"${check.field.label}": selected location/asset does not match the required type.`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, answers };
}

function validateFieldValue(
  field: FoodSafetyFormField,
  value: unknown,
  errors: string[],
  employeeChecks: SelectorCheck[],
  locationChecks: SelectorCheck[]
): void {
  const config = field.config ?? {};

  switch (field.type) {
    case "short_text":
    case "long_text": {
      if (typeof value !== "string") {
        errors.push(`"${field.label}" must be text.`);
        break;
      }
      if (typeof config.minLength === "number" && value.length < config.minLength) {
        errors.push(`"${field.label}" must be at least ${config.minLength} characters.`);
      }
      if (typeof config.maxLength === "number" && value.length > config.maxLength) {
        errors.push(`"${field.label}" must be at most ${config.maxLength} characters.`);
      }
      break;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`"${field.label}" must be a number.`);
        break;
      }
      if (typeof config.min === "number" && value < config.min) {
        errors.push(`"${field.label}" must be at least ${config.min}.`);
      }
      if (typeof config.max === "number" && value > config.max) {
        errors.push(`"${field.label}" must be at most ${config.max}.`);
      }
      if (typeof config.precision === "number") {
        const decimalPlaces = (value.toString().split(".")[1] ?? "").length;
        if (decimalPlaces > config.precision) {
          errors.push(
            `"${field.label}" must have at most ${config.precision} decimal place${config.precision === 1 ? "" : "s"}.`
          );
        }
      }
      break;
    }
    case "date": {
      if (typeof value !== "string" || !DATE_RE.test(value) || Number.isNaN(new Date(value).getTime())) {
        errors.push(`"${field.label}" must be a valid date (YYYY-MM-DD).`);
      }
      break;
    }
    case "time": {
      if (typeof value !== "string" || !TIME_RE.test(value)) {
        errors.push(`"${field.label}" must be a valid time (HH:MM).`);
      }
      break;
    }
    case "checkbox":
    case "yes_no": {
      if (typeof value !== "boolean") {
        errors.push(`"${field.label}" must be true or false.`);
      }
      break;
    }
    case "pass_fail": {
      if (value !== "pass" && value !== "fail") {
        errors.push(`"${field.label}" must be "pass" or "fail".`);
      }
      break;
    }
    case "select": {
      const options = config.options ?? [];
      if (typeof value !== "string" || !options.some((option) => option.value === value)) {
        errors.push(`"${field.label}": selected value is not one of the allowed options.`);
      }
      break;
    }
    case "multi_select": {
      const options = config.options ?? [];
      const allowedValues = new Set(options.map((option) => option.value));
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        errors.push(`"${field.label}" must be a list of selected option values.`);
        break;
      }
      const invalid = (value as string[]).filter((entry) => !allowedValues.has(entry));
      if (invalid.length > 0) {
        errors.push(`"${field.label}": ${invalid.join(", ")} ${invalid.length === 1 ? "is" : "are"} not an allowed option.`);
      }
      break;
    }
    case "employee_selector": {
      if (typeof value !== "string" || value.length === 0) {
        errors.push(`"${field.label}" must reference an employee.`);
        break;
      }
      employeeChecks.push({ field, value });
      break;
    }
    case "location_asset_selector": {
      if (typeof value !== "string" || value.length === 0) {
        errors.push(`"${field.label}" must reference a location or asset.`);
        break;
      }
      locationChecks.push({ field, value });
      break;
    }
    default:
      break;
  }
}
