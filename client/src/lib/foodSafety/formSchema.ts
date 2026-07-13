// Client-side mirror of server/src/routes/foodSafety/services/templateSchema.ts.
// This project has no shared package between client and server, so the
// shape is duplicated deliberately (kept structurally identical) rather than
// introducing a build-time shared module for one type file. The SERVER copy
// is the authority — validateFormSchema() there is what actually decides
// whether a schema may be saved; these types exist purely so the builder/
// preview UI gets type-checking and autocomplete while editing.

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

export const FIELD_TYPE_LABELS: Record<FoodSafetyFieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  number: "Number",
  date: "Date",
  time: "Time",
  checkbox: "Checkbox",
  yes_no: "Yes / No",
  pass_fail: "Pass / Fail",
  select: "Dropdown (single choice)",
  multi_select: "Multi-select",
  employee_selector: "Employee selector",
  location_asset_selector: "Location / asset selector",
  information: "Information (not a response field)"
};

export type SelectOption = {
  value: string;
  label: string;
};

export type FoodSafetyFieldConfig = {
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  informationBody?: string;
  min?: number;
  max?: number;
  precision?: number;
  unitLabel?: string;
  allowDefaultToCurrentValue?: boolean;
  options?: SelectOption[];
  activeEmployeesOnly?: boolean;
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

let idCounter = 0;

/** Generates a short, unique-enough id for a new section/field/option in the builder UI. */
export function generateLocalId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function createEmptySchema(title: string): FoodSafetyFormSchema {
  return {
    schemaVersion: FORM_SCHEMA_VERSION,
    title,
    description: "",
    instructions: "",
    sections: []
  };
}

export function createEmptySection(sortOrder: number): FoodSafetyFormSection {
  return {
    id: generateLocalId("section"),
    title: "New section",
    description: "",
    sortOrder,
    fields: []
  };
}

export function createEmptyField(type: FoodSafetyFieldType, sortOrder: number): FoodSafetyFormField {
  const base: FoodSafetyFormField = {
    id: generateLocalId("field"),
    type,
    label: FIELD_TYPE_LABELS[type],
    helpText: "",
    required: false,
    sortOrder
  };

  if (type === "select" || type === "multi_select") {
    base.config = { options: [{ value: generateLocalId("option"), label: "Option 1" }] };
  }

  return base;
}
