import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnswers } from "../recordValidation";
import type { FoodSafetyFormSchema } from "../templateSchema";

// These tests deliberately avoid employee_selector/location_asset_selector
// fields so validateAnswers never touches the database — that keeps this
// suite fully offline. Cross-org/active/filter checks for those two field
// types are covered by the DB-backed records.integration.test.ts instead.

function schemaWithFields(fields: FoodSafetyFormSchema["sections"][number]["fields"]): FoodSafetyFormSchema {
  return {
    schemaVersion: 1,
    title: "Test form",
    sections: [{ id: "section_1", title: "Section 1", sortOrder: 0, fields }]
  };
}

const ORG_ID = "org-1";

test("accepts a complete, valid submission", async () => {
  const schema = schemaWithFields([
    { id: "notes", type: "short_text", label: "Notes", required: true, sortOrder: 0 },
    { id: "temp", type: "number", label: "Temperature", required: true, sortOrder: 1, config: { min: 0, max: 10 } }
  ]);
  const result = await validateAnswers(schema, { notes: "All good", temp: 5 }, ORG_ID, "submit");
  assert.equal(result.valid, true);
});

test("rejects a non-object answers payload", async () => {
  const schema = schemaWithFields([{ id: "a", type: "checkbox", label: "A", required: false, sortOrder: 0 }]);
  const result = await validateAnswers(schema, "not an object", ORG_ID, "submit");
  assert.equal(result.valid, false);
});

test("rejects an unknown field id", async () => {
  const schema = schemaWithFields([{ id: "a", type: "checkbox", label: "A", required: false, sortOrder: 0 }]);
  const result = await validateAnswers(schema, { a: true, mystery: "x" }, ORG_ID, "submit");
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes('Unknown field id "mystery"')));
});

test("submit mode rejects a missing required field; draft mode allows it", async () => {
  const schema = schemaWithFields([{ id: "a", type: "short_text", label: "A", required: true, sortOrder: 0 }]);

  const submitResult = await validateAnswers(schema, {}, ORG_ID, "submit");
  assert.equal(submitResult.valid, false);

  const draftResult = await validateAnswers(schema, {}, ORG_ID, "draft");
  assert.equal(draftResult.valid, true);
});

test("information fields must not accept an answer", async () => {
  const schema = schemaWithFields([
    { id: "info", type: "information", label: "Reminder", required: false, sortOrder: 0, config: { informationBody: "Wash hands." } }
  ]);
  const result = await validateAnswers(schema, { info: "some value" }, ORG_ID, "submit");
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((e) => e.includes("information field")));
});

test("validates text length (min/max)", async () => {
  const schema = schemaWithFields([
    { id: "notes", type: "short_text", label: "Notes", required: false, sortOrder: 0, config: { minLength: 5, maxLength: 10 } }
  ]);

  const tooShort = await validateAnswers(schema, { notes: "hi" }, ORG_ID, "submit");
  assert.equal(tooShort.valid, false);

  const tooLong = await validateAnswers(schema, { notes: "this is way too long" }, ORG_ID, "submit");
  assert.equal(tooLong.valid, false);

  const justRight = await validateAnswers(schema, { notes: "hello!" }, ORG_ID, "submit");
  assert.equal(justRight.valid, true);
});

test("validates numeric min/max", async () => {
  const schema = schemaWithFields([
    { id: "temp", type: "number", label: "Temp", required: false, sortOrder: 0, config: { min: 0, max: 5 } }
  ]);

  const tooLow = await validateAnswers(schema, { temp: -1 }, ORG_ID, "submit");
  assert.equal(tooLow.valid, false);

  const tooHigh = await validateAnswers(schema, { temp: 10 }, ORG_ID, "submit");
  assert.equal(tooHigh.valid, false);

  const ok = await validateAnswers(schema, { temp: 3 }, ORG_ID, "submit");
  assert.equal(ok.valid, true);
});

test("validates numeric precision", async () => {
  const schema = schemaWithFields([
    { id: "temp", type: "number", label: "Temp", required: false, sortOrder: 0, config: { precision: 1 } }
  ]);

  const tooPrecise = await validateAnswers(schema, { temp: 3.456 }, ORG_ID, "submit");
  assert.equal(tooPrecise.valid, false);

  const ok = await validateAnswers(schema, { temp: 3.5 }, ORG_ID, "submit");
  assert.equal(ok.valid, true);
});

test("rejects a select answer that isn't one of the configured options", async () => {
  const schema = schemaWithFields([
    {
      id: "chem",
      type: "select",
      label: "Chemical",
      required: false,
      sortOrder: 0,
      config: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }
    }
  ]);
  const invalid = await validateAnswers(schema, { chem: "c" }, ORG_ID, "submit");
  assert.equal(invalid.valid, false);

  const valid = await validateAnswers(schema, { chem: "a" }, ORG_ID, "submit");
  assert.equal(valid.valid, true);
});

test("rejects multi-select values outside the allowed set", async () => {
  const schema = schemaWithFields([
    {
      id: "issues",
      type: "multi_select",
      label: "Issues",
      required: false,
      sortOrder: 0,
      config: { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }
    }
  ]);
  const invalid = await validateAnswers(schema, { issues: ["a", "z"] }, ORG_ID, "submit");
  assert.equal(invalid.valid, false);

  const valid = await validateAnswers(schema, { issues: ["a", "b"] }, ORG_ID, "submit");
  assert.equal(valid.valid, true);
});

test("validates date and time formats", async () => {
  const schema = schemaWithFields([
    { id: "d", type: "date", label: "Date", required: false, sortOrder: 0 },
    { id: "t", type: "time", label: "Time", required: false, sortOrder: 1 }
  ]);

  const badDate = await validateAnswers(schema, { d: "not-a-date" }, ORG_ID, "submit");
  assert.equal(badDate.valid, false);

  const badTime = await validateAnswers(schema, { t: "25:99" }, ORG_ID, "submit");
  assert.equal(badTime.valid, false);

  const ok = await validateAnswers(schema, { d: "2026-01-15", t: "08:30" }, ORG_ID, "submit");
  assert.equal(ok.valid, true);
});

test("checkbox/yes_no/pass_fail: false/'fail' is a real answer, not missing", async () => {
  const schema = schemaWithFields([
    { id: "check", type: "checkbox", label: "Checked", required: true, sortOrder: 0 },
    { id: "yn", type: "yes_no", label: "Passed inspection", required: true, sortOrder: 1 },
    { id: "pf", type: "pass_fail", label: "Result", required: true, sortOrder: 2 }
  ]);

  const result = await validateAnswers(schema, { check: false, yn: false, pf: "fail" }, ORG_ID, "submit");
  assert.equal(result.valid, true, "false/\"fail\" must satisfy a required field, not be treated as missing");
});

test("missing checkbox/yes_no/pass_fail (key absent) fails a required check", async () => {
  const schema = schemaWithFields([{ id: "check", type: "checkbox", label: "Checked", required: true, sortOrder: 0 }]);
  const result = await validateAnswers(schema, {}, ORG_ID, "submit");
  assert.equal(result.valid, false);
});

test("rejects a malformed pass_fail value", async () => {
  const schema = schemaWithFields([{ id: "pf", type: "pass_fail", label: "Result", required: false, sortOrder: 0 }]);
  const result = await validateAnswers(schema, { pf: "maybe" }, ORG_ID, "submit");
  assert.equal(result.valid, false);
});
