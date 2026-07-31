import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskPayload, validateFieldPayload } from "../devices";

function validField(overrides: Record<string, unknown> = {}) {
  return {
    client_key: "f1",
    field_type: "short_text",
    label: "Field",
    sort_order: 0,
    ...overrides
  };
}

function validTask(overrides: Record<string, unknown> = {}) {
  return {
    client_key: "t1",
    name: "Task",
    sort_order: 0,
    is_repeating: false,
    min_rows: null,
    max_rows: null,
    fields: [validField()],
    ...overrides
  };
}

// ── validateFieldPayload ────────────────────────────────────────────────

test("field with an unrecognized field_type is rejected", () => {
  assert.throws(() => validateFieldPayload(validField({ field_type: "not_a_type" }), "Task", 0), /invalid response type/);
});

test("field with a blank label is rejected", () => {
  assert.throws(() => validateFieldPayload(validField({ label: "  " }), "Task", 0), /needs a label/);
});

test("new field (no id) without a client_key is rejected", () => {
  const raw = validField();
  delete (raw as Record<string, unknown>).client_key;
  assert.throws(() => validateFieldPayload(raw, "Task", 0), /needs a client_key/);
});

test("existing field (has id) does not require a client_key", () => {
  const raw = validField({ id: "field-123" });
  delete (raw as Record<string, unknown>).client_key;
  const field = validateFieldPayload(raw, "Task", 0);
  assert.equal(field.id, "field-123");
});

test("checkbox field with no options is rejected", () => {
  assert.throws(
    () => validateFieldPayload(validField({ field_type: "checkbox", choice_options: [] }), "Task", 0),
    /needs at least one checkbox/
  );
});

test("pass_fail field with no options defaults to Pass/Fail", () => {
  const field = validateFieldPayload(validField({ field_type: "pass_fail" }), "Task", 0);
  assert.deepEqual(field.choice_options, ["Pass", "Fail"]);
});

test("pass_fail field with exactly two custom labels keeps them", () => {
  const field = validateFieldPayload(
    validField({ field_type: "pass_fail", choice_options: ["Within tolerance", "Out of tolerance"] }),
    "Task",
    0
  );
  assert.deepEqual(field.choice_options, ["Within tolerance", "Out of tolerance"]);
});

test("pass_fail field with only one label is rejected", () => {
  assert.throws(
    () => validateFieldPayload(validField({ field_type: "pass_fail", choice_options: ["Pass"] }), "Task", 0),
    /exactly two labels/
  );
});

// ── validateTaskPayload ──────────────────────────────────────────────────

test("task with a blank name is rejected", () => {
  assert.throws(() => validateTaskPayload(validTask({ name: " " }), 0), /needs a name/);
});

test("new task (no id) without a client_key is rejected", () => {
  const raw = validTask();
  delete (raw as Record<string, unknown>).client_key;
  assert.throws(() => validateTaskPayload(raw, 0), /needs a client_key/);
});

test("task with no fields is rejected", () => {
  assert.throws(() => validateTaskPayload(validTask({ fields: [] }), 0), /needs at least one response field/);
});

test("non-repeating task ignores any provided min_rows/max_rows", () => {
  const task = validateTaskPayload(validTask({ is_repeating: false, min_rows: 2, max_rows: 5 }), 0);
  assert.equal(task.min_rows, null);
  assert.equal(task.max_rows, null);
});

test("repeating task keeps its min_rows/max_rows", () => {
  const task = validateTaskPayload(validTask({ is_repeating: true, min_rows: 1, max_rows: 10 }), 0);
  assert.equal(task.min_rows, 1);
  assert.equal(task.max_rows, 10);
});

test("an invalid field inside a task surfaces the task's own name in the error", () => {
  assert.throws(
    () => validateTaskPayload(validTask({ name: "Pressure", fields: [validField({ label: "" })] }), 0),
    /Pressure/
  );
});
