// Declarative, versioned JSON schema for a Food Safety form template version.
//
// This is intentionally NOT executable content: no expressions, no formulas,
// no component references — every field is plain data (strings/numbers/
// booleans/arrays of the same). validateFormSchema() is the single
// authority for whether a schema_json blob is safe to store; the frontend's
// own validation is a UX convenience only and must never be trusted instead
// of this.

export const FORM_SCHEMA_VERSION = 1;

export const FOOD_SAFETY_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "time",
  "checkbox",
  "yes_no",
  "pass_fail",
  "select",
  "multi_select",
  "employee_selector",
  "location_asset_selector",
  "information"
] as const;

export type FoodSafetyFieldType = (typeof FOOD_SAFETY_FIELD_TYPES)[number];

export type SelectOption = {
  value: string;
  label: string;
};

export type FoodSafetyFieldConfig = {
  // short_text / long_text / information
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  informationBody?: string;
  // number
  min?: number;
  max?: number;
  precision?: number;
  unitLabel?: string;
  // date / time — config only; no submission/default-fill behavior yet
  allowDefaultToCurrentValue?: boolean;
  // select / multi_select
  options?: SelectOption[];
  // employee_selector
  activeEmployeesOnly?: boolean;
  // location_asset_selector
  filterDepartmentId?: string | null;
  filterLocationType?: "location" | "asset" | null;
};

export type FoodSafetyFormField = {
  id: string;
  type: FoodSafetyFieldType;
  label: string;
  helpText?: string;
  required: boolean;
  sortOrder: number;
  config?: FoodSafetyFieldConfig;
};

export type FoodSafetyFormSection = {
  id: string;
  title: string;
  description?: string;
  sortOrder: number;
  fields: FoodSafetyFormField[];
};

export type FoodSafetyFormSchema = {
  schemaVersion: number;
  title: string;
  description?: string;
  instructions?: string;
  sections: FoodSafetyFormSection[];
};

export type ValidationResult =
  | { valid: true; schema: FoodSafetyFormSchema }
  | { valid: false; errors: string[] };

// ── abuse/size limits ─────────────────────────────────────────────────────────

const MAX_JSON_BYTES = 200_000; // ~200KB
const MAX_SECTIONS = 50;
const MAX_FIELDS_PER_SECTION = 100;
const MAX_TOTAL_FIELDS = 300;
const MAX_OPTIONS_PER_FIELD = 200;
const MAX_SHORT_STRING = 500; // titles, labels, ids, unit labels
const MAX_LONG_STRING = 10_000; // descriptions, help text, information body
const MAX_TEXT_FIELD_LENGTH = 20_000; // short_text/long_text minLength/maxLength cap
const MAX_NUMBER_PRECISION = 10;

// Config keys allowed per field type — anything else on `config` is rejected
// as "unsupported configuration for this field type".
const ALLOWED_CONFIG_KEYS: Record<FoodSafetyFieldType, Set<string>> = {
  short_text: new Set(["placeholder", "minLength", "maxLength"]),
  long_text: new Set(["placeholder", "minLength", "maxLength"]),
  number: new Set(["min", "max", "precision", "unitLabel"]),
  date: new Set(["allowDefaultToCurrentValue"]),
  time: new Set(["allowDefaultToCurrentValue"]),
  checkbox: new Set([]),
  yes_no: new Set([]),
  pass_fail: new Set([]),
  select: new Set(["options"]),
  multi_select: new Set(["options"]),
  employee_selector: new Set(["activeEmployeesOnly"]),
  location_asset_selector: new Set(["filterDepartmentId", "filterLocationType"]),
  information: new Set(["informationBody"])
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validates an arbitrary, untrusted value as a FoodSafetyFormSchema.
 * Collects every error found (rather than stopping at the first) so the
 * client can show a useful, complete list. Never throws.
 */
export function validateFormSchema(input: unknown): ValidationResult {
  const errors: string[] = [];

  let sizeInBytes = 0;
  try {
    sizeInBytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
  } catch {
    return { valid: false, errors: ["Schema is not serializable JSON."] };
  }
  if (sizeInBytes > MAX_JSON_BYTES) {
    return { valid: false, errors: [`Schema is too large (${sizeInBytes} bytes, max ${MAX_JSON_BYTES}).`] };
  }

  if (!isPlainObject(input)) {
    return { valid: false, errors: ["Schema must be a JSON object."] };
  }

  if (input.schemaVersion !== FORM_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${FORM_SCHEMA_VERSION}.`);
  }

  if (!isNonEmptyString(input.title, MAX_SHORT_STRING)) {
    errors.push("title is required and must be a non-empty string.");
  }

  if (!isOptionalString(input.description, MAX_LONG_STRING)) {
    errors.push("description must be a string.");
  }

  if (!isOptionalString(input.instructions, MAX_LONG_STRING)) {
    errors.push("instructions must be a string.");
  }

  if (!Array.isArray(input.sections)) {
    errors.push("sections must be an array.");
    return { valid: false, errors };
  }

  if (input.sections.length === 0) {
    errors.push("A form must have at least one section.");
  }

  if (input.sections.length > MAX_SECTIONS) {
    errors.push(`A form may not have more than ${MAX_SECTIONS} sections.`);
  }

  const sectionIds = new Set<string>();
  const fieldIds = new Set<string>();
  let totalFieldCount = 0;

  input.sections.forEach((rawSection, sectionIndex) => {
    const sectionLabel = `Section #${sectionIndex + 1}`;

    if (!isPlainObject(rawSection)) {
      errors.push(`${sectionLabel}: must be an object.`);
      return;
    }

    if (!isNonEmptyString(rawSection.id, MAX_SHORT_STRING)) {
      errors.push(`${sectionLabel}: id is required and must be a non-empty string.`);
    } else if (sectionIds.has(rawSection.id)) {
      errors.push(`Duplicate section id "${rawSection.id}".`);
    } else {
      sectionIds.add(rawSection.id);
    }

    if (!isNonEmptyString(rawSection.title, MAX_SHORT_STRING)) {
      errors.push(`${sectionLabel}: title is required and must be a non-empty string.`);
    }

    if (!isOptionalString(rawSection.description, MAX_LONG_STRING)) {
      errors.push(`${sectionLabel}: description must be a string.`);
    }

    if (!isNonNegativeInteger(rawSection.sortOrder)) {
      errors.push(`${sectionLabel}: sortOrder must be a non-negative integer.`);
    }

    if (!Array.isArray(rawSection.fields)) {
      errors.push(`${sectionLabel}: fields must be an array.`);
      return;
    }

    if (rawSection.fields.length > MAX_FIELDS_PER_SECTION) {
      errors.push(`${sectionLabel}: may not have more than ${MAX_FIELDS_PER_SECTION} fields.`);
    }

    rawSection.fields.forEach((rawField, fieldIndex) => {
      totalFieldCount += 1;
      const fieldLabel = `${sectionLabel}, field #${fieldIndex + 1}`;
      validateField(rawField, fieldLabel, fieldIds, errors);
    });
  });

  if (totalFieldCount === 0) {
    errors.push("A form must have at least one field.");
  }

  if (totalFieldCount > MAX_TOTAL_FIELDS) {
    errors.push(`A form may not have more than ${MAX_TOTAL_FIELDS} fields in total.`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, schema: input as unknown as FoodSafetyFormSchema };
}

function validateField(
  rawField: unknown,
  fieldLabel: string,
  fieldIds: Set<string>,
  errors: string[]
): void {
  if (!isPlainObject(rawField)) {
    errors.push(`${fieldLabel}: must be an object.`);
    return;
  }

  if (!isNonEmptyString(rawField.id, MAX_SHORT_STRING)) {
    errors.push(`${fieldLabel}: id is required and must be a non-empty string.`);
  } else if (fieldIds.has(rawField.id)) {
    errors.push(`Duplicate field id "${rawField.id}".`);
  } else {
    fieldIds.add(rawField.id);
  }

  const type = rawField.type;
  if (typeof type !== "string" || !FOOD_SAFETY_FIELD_TYPES.includes(type as FoodSafetyFieldType)) {
    errors.push(`${fieldLabel}: unknown field type "${String(type)}".`);
    return; // no point validating config against an unknown type
  }
  const fieldType = type as FoodSafetyFieldType;

  if (!isNonEmptyString(rawField.label, MAX_SHORT_STRING)) {
    errors.push(`${fieldLabel}: label is required and must be a non-empty string.`);
  }

  if (!isOptionalString(rawField.helpText, MAX_LONG_STRING)) {
    errors.push(`${fieldLabel}: helpText must be a string.`);
  }

  if (typeof rawField.required !== "boolean") {
    errors.push(`${fieldLabel}: required must be a boolean.`);
  } else if (fieldType === "information" && rawField.required === true) {
    errors.push(`${fieldLabel}: an information field cannot be required — it is not a response field.`);
  }

  if (!isNonNegativeInteger(rawField.sortOrder)) {
    errors.push(`${fieldLabel}: sortOrder must be a non-negative integer.`);
  }

  // Config is validated even when omitted (as an empty object) so that
  // field types with *required* config (select/multi_select options) are
  // still caught rather than silently skipped when the caller sends no
  // config at all.
  if (rawField.config !== undefined && !isPlainObject(rawField.config)) {
    errors.push(`${fieldLabel}: config must be an object.`);
  } else {
    const config = isPlainObject(rawField.config) ? rawField.config : {};
    validateFieldConfig(config, fieldType, fieldLabel, errors);
  }
}

function validateFieldConfig(
  config: Record<string, unknown>,
  fieldType: FoodSafetyFieldType,
  fieldLabel: string,
  errors: string[]
): void {
  const allowedKeys = ALLOWED_CONFIG_KEYS[fieldType];
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${fieldLabel}: "${key}" is not a supported setting for field type "${fieldType}".`);
    }
  }

  if (fieldType === "short_text" || fieldType === "long_text") {
    if (!isOptionalString(config.placeholder, MAX_SHORT_STRING)) {
      errors.push(`${fieldLabel}: placeholder must be a string.`);
    }
    validateMinMaxLength(config, fieldLabel, errors);
  }

  if (fieldType === "number") {
    validateNumberRange(config, fieldLabel, errors);
    if (config.precision !== undefined) {
      if (!isNonNegativeInteger(config.precision) || (config.precision as number) > MAX_NUMBER_PRECISION) {
        errors.push(`${fieldLabel}: precision must be an integer between 0 and ${MAX_NUMBER_PRECISION}.`);
      }
    }
    if (!isOptionalString(config.unitLabel, MAX_SHORT_STRING)) {
      errors.push(`${fieldLabel}: unitLabel must be a string.`);
    }
  }

  if (fieldType === "date" || fieldType === "time") {
    if (config.allowDefaultToCurrentValue !== undefined && typeof config.allowDefaultToCurrentValue !== "boolean") {
      errors.push(`${fieldLabel}: allowDefaultToCurrentValue must be a boolean.`);
    }
  }

  if (fieldType === "select" || fieldType === "multi_select") {
    validateOptions(config.options, fieldLabel, errors);
  }

  if (fieldType === "employee_selector") {
    if (config.activeEmployeesOnly !== undefined && typeof config.activeEmployeesOnly !== "boolean") {
      errors.push(`${fieldLabel}: activeEmployeesOnly must be a boolean.`);
    }
  }

  if (fieldType === "location_asset_selector") {
    if (
      config.filterDepartmentId !== undefined &&
      config.filterDepartmentId !== null &&
      !isNonEmptyString(config.filterDepartmentId, MAX_SHORT_STRING)
    ) {
      errors.push(`${fieldLabel}: filterDepartmentId must be a string or null.`);
    }
    if (
      config.filterLocationType !== undefined &&
      config.filterLocationType !== null &&
      config.filterLocationType !== "location" &&
      config.filterLocationType !== "asset"
    ) {
      errors.push(`${fieldLabel}: filterLocationType must be "location", "asset", or null.`);
    }
  }

  if (fieldType === "information") {
    if (!isOptionalString(config.informationBody, MAX_LONG_STRING)) {
      errors.push(`${fieldLabel}: informationBody must be a string.`);
    }
  }
}

function validateMinMaxLength(config: Record<string, unknown>, fieldLabel: string, errors: string[]): void {
  const { minLength, maxLength } = config;

  if (minLength !== undefined && (!isNonNegativeInteger(minLength) || minLength > MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`${fieldLabel}: minLength must be an integer between 0 and ${MAX_TEXT_FIELD_LENGTH}.`);
  }
  if (maxLength !== undefined && (!isNonNegativeInteger(maxLength) || maxLength > MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`${fieldLabel}: maxLength must be an integer between 0 and ${MAX_TEXT_FIELD_LENGTH}.`);
  }
  if (
    typeof minLength === "number" &&
    typeof maxLength === "number" &&
    Number.isInteger(minLength) &&
    Number.isInteger(maxLength) &&
    minLength > maxLength
  ) {
    errors.push(`${fieldLabel}: minLength cannot be greater than maxLength.`);
  }
}

function validateNumberRange(config: Record<string, unknown>, fieldLabel: string, errors: string[]): void {
  const { min, max } = config;

  if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) {
    errors.push(`${fieldLabel}: min must be a finite number.`);
  }
  if (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) {
    errors.push(`${fieldLabel}: max must be a finite number.`);
  }
  if (
    typeof min === "number" &&
    typeof max === "number" &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min > max
  ) {
    errors.push(`${fieldLabel}: min cannot be greater than max.`);
  }
}

function validateOptions(rawOptions: unknown, fieldLabel: string, errors: string[]): void {
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    errors.push(`${fieldLabel}: options is required and must be a non-empty array.`);
    return;
  }

  if (rawOptions.length > MAX_OPTIONS_PER_FIELD) {
    errors.push(`${fieldLabel}: may not have more than ${MAX_OPTIONS_PER_FIELD} options.`);
  }

  const seenValues = new Set<string>();

  rawOptions.forEach((rawOption, optionIndex) => {
    const optionLabel = `${fieldLabel}, option #${optionIndex + 1}`;

    if (!isPlainObject(rawOption)) {
      errors.push(`${optionLabel}: must be an object.`);
      return;
    }

    const keys = Object.keys(rawOption);
    const unknownKeys = keys.filter((key) => key !== "value" && key !== "label");
    if (unknownKeys.length > 0) {
      errors.push(`${optionLabel}: unsupported field(s) ${unknownKeys.join(", ")}.`);
    }

    if (!isNonEmptyString(rawOption.value, MAX_SHORT_STRING)) {
      errors.push(`${optionLabel}: value is required and must be a non-empty string.`);
    } else if (seenValues.has(rawOption.value)) {
      errors.push(`${fieldLabel}: duplicate option value "${rawOption.value}".`);
    } else {
      seenValues.add(rawOption.value);
    }

    if (!isNonEmptyString(rawOption.label, MAX_SHORT_STRING)) {
      errors.push(`${optionLabel}: label is required and must be a non-empty string.`);
    }
  });
}

/**
 * Scans a validated schema for location_asset_selector fields that reference
 * a department by id. Returns the distinct set of referenced ids so the
 * caller can verify (with a DB query) that every one belongs to the same
 * organization as the template — this file has no DB access by design and
 * only checks shape, not cross-table ownership.
 */
export function collectReferencedDepartmentIds(schema: FoodSafetyFormSchema): string[] {
  const ids = new Set<string>();
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const departmentId = field.config?.filterDepartmentId;
      if (typeof departmentId === "string" && departmentId.length > 0) {
        ids.add(departmentId);
      }
    }
  }
  return Array.from(ids);
}
