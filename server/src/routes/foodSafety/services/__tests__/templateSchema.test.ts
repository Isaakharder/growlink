import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFormSchema, collectReferencedDepartmentIds, FORM_SCHEMA_VERSION } from "../templateSchema";

function validSchema() {
  return {
    schemaVersion: FORM_SCHEMA_VERSION,
    title: "Daily Sanitation Check",
    description: "Verify sanitation stations before shift start.",
    instructions: "Complete before 8am.",
    sections: [
      {
        id: "section_1",
        title: "Handwash Stations",
        description: "",
        sortOrder: 0,
        fields: [
          {
            id: "field_1",
            type: "pass_fail",
            label: "Handwash station stocked and functional",
            required: true,
            sortOrder: 0
          },
          {
            id: "field_2",
            type: "select",
            label: "Chemical used",
            required: false,
            sortOrder: 1,
            config: {
              options: [
                { value: "sanitizer_a", label: "Sanitizer A" },
                { value: "sanitizer_b", label: "Sanitizer B" }
              ]
            }
          }
        ]
      }
    ]
  };
}

test("accepts a valid schema", () => {
  const result = validateFormSchema(validSchema());
  assert.equal(result.valid, true);
});

test("rejects a non-object schema", () => {
  const result = validateFormSchema("not an object");
  assert.equal(result.valid, false);
});

test("rejects an empty schema (no sections)", () => {
  const schema = validSchema();
  schema.sections = [];
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("at least one section")));
  }
});

test("rejects a schema with sections but zero fields", () => {
  const schema = validSchema();
  schema.sections[0].fields = [];
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("at least one field")));
  }
});

test("rejects an unknown field type", () => {
  const schema = validSchema();
  (schema.sections[0].fields[0] as any).type = "signature";
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("unknown field type")));
  }
});

test("rejects duplicate section ids", () => {
  const schema = validSchema();
  schema.sections.push({ ...schema.sections[0], id: "section_1", title: "Duplicate" });
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes('Duplicate section id "section_1"')));
  }
});

test("rejects duplicate field ids across the whole form, even in different sections", () => {
  const schema = validSchema();
  schema.sections.push({
    id: "section_2",
    title: "Second section",
    description: "",
    sortOrder: 1,
    fields: [{ id: "field_1", type: "checkbox", label: "Repeat id", required: false, sortOrder: 0 }]
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes('Duplicate field id "field_1"')));
  }
});

test("rejects malformed select options (missing value/label, wrong types)", () => {
  const schema = validSchema();
  (schema.sections[0].fields[1] as any).config.options = [{ value: "ok", label: "Ok" }, { label: 5 }];
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
});

test("rejects duplicate option values within a field", () => {
  const schema = validSchema();
  (schema.sections[0].fields[1] as any).config.options = [
    { value: "same", label: "First" },
    { value: "same", label: "Second" }
  ];
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("duplicate option value")));
  }
});

test("rejects select field with no options at all", () => {
  const schema = validSchema();
  delete (schema.sections[0].fields[1] as any).config;
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("options is required")));
  }
});

test("rejects invalid number min/max combination", () => {
  const schema = validSchema();
  schema.sections[0].fields.push({
    id: "field_3",
    type: "number",
    label: "Temperature",
    required: false,
    sortOrder: 2,
    config: { min: 10, max: 5 }
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("min cannot be greater than max")));
  }
});

test("rejects invalid text minLength/maxLength combination", () => {
  const schema = validSchema();
  schema.sections[0].fields.push({
    id: "field_3",
    type: "short_text",
    label: "Notes",
    required: false,
    sortOrder: 2,
    config: { minLength: 50, maxLength: 5 }
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("minLength cannot be greater than maxLength")));
  }
});

test("rejects negative precision and precision above the cap", () => {
  const schema = validSchema();
  schema.sections[0].fields.push({
    id: "field_3",
    type: "number",
    label: "Temp",
    required: false,
    sortOrder: 2,
    config: { precision: -1 }
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
});

test("rejects config keys that don't belong to the field's type", () => {
  const schema = validSchema();
  // "options" is a select/multi_select-only key — invalid on a number field.
  schema.sections[0].fields.push({
    id: "field_3",
    type: "number",
    label: "Temp",
    required: false,
    sortOrder: 2,
    config: { options: [{ value: "x", label: "X" }] }
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("not a supported setting")));
  }
});

test("rejects an information field marked as required", () => {
  const schema = validSchema();
  schema.sections[0].fields.push({
    id: "field_3",
    type: "information",
    label: "Reminder",
    required: true,
    sortOrder: 2,
    config: { informationBody: "Wash hands before starting." }
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("cannot be required")));
  }
});

test("accepts a valid information field that is not required", () => {
  const schema = validSchema();
  schema.sections[0].fields.push({
    id: "field_3",
    type: "information",
    label: "Reminder",
    required: false,
    sortOrder: 2,
    config: { informationBody: "Wash hands before starting." }
  } as any);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, true);
});

test("rejects a missing label", () => {
  const schema = validSchema();
  (schema.sections[0].fields[0] as any).label = "";
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("label is required")));
  }
});

test("rejects malformed sections (not an object)", () => {
  const schema = validSchema();
  (schema.sections as any) = ["not a section"];
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
});

test("rejects schemaVersion mismatch", () => {
  const schema = validSchema();
  schema.schemaVersion = 999;
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
});

test("enforces the section count cap", () => {
  const schema = validSchema();
  const template = schema.sections[0];
  schema.sections = Array.from({ length: 51 }, (_, i) => ({
    ...template,
    id: `section_${i}`,
    fields: template.fields.map((f) => ({ ...f, id: `${f.id}_${i}` }))
  }));
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("may not have more than 50 sections")));
  }
});

test("enforces the total field count cap", () => {
  const schema = validSchema();
  schema.sections[0].fields = Array.from({ length: 301 }, (_, i) => ({
    id: `field_${i}`,
    type: "checkbox" as const,
    label: `Field ${i}`,
    required: false,
    sortOrder: i
  }));
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("may not have more than 300 fields")));
  }
});

test("rejects an oversized schema payload", () => {
  const schema = validSchema();
  (schema as any).description = "x".repeat(250_000);
  const result = validateFormSchema(schema);
  assert.equal(result.valid, false);
});

test("collectReferencedDepartmentIds returns distinct department ids from location_asset_selector fields", () => {
  const schema = validSchema();
  schema.sections[0].fields.push(
    {
      id: "field_dept_1",
      type: "location_asset_selector",
      label: "Cooler",
      required: false,
      sortOrder: 2,
      config: { filterDepartmentId: "dept-a" }
    } as any,
    {
      id: "field_dept_2",
      type: "location_asset_selector",
      label: "Cooler 2",
      required: false,
      sortOrder: 3,
      config: { filterDepartmentId: "dept-a" }
    } as any,
    {
      id: "field_dept_3",
      type: "location_asset_selector",
      label: "Freezer",
      required: false,
      sortOrder: 4,
      config: { filterDepartmentId: "dept-b" }
    } as any
  );

  const result = validateFormSchema(schema);
  assert.equal(result.valid, true);
  if (result.valid) {
    const ids = collectReferencedDepartmentIds(result.schema).sort();
    assert.deepEqual(ids, ["dept-a", "dept-b"]);
  }
});
