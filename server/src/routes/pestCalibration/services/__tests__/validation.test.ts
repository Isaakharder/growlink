import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFlatAnswerSnapshots, buildRepeatingRows, CalibrationValidationError } from "../validation";
import { Task, TemplateField, FieldAnswerInput, RepeatingRowInput } from "../types";

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "task-1",
    template_id: "template-1",
    name: "Task",
    sort_order: 0,
    is_repeating: false,
    min_rows: null,
    max_rows: null,
    ...overrides
  };
}

function field(overrides: Partial<TemplateField>): TemplateField {
  return {
    id: overrides.id ?? "field-1",
    task_id: overrides.task_id ?? "task-1",
    field_type: "short_text",
    label: "Field",
    help_text: null,
    is_required: false,
    placeholder: null,
    unit: null,
    min_value: null,
    max_value: null,
    decimal_precision: null,
    choice_options: null,
    sort_order: 0,
    required_when_field_id: null,
    required_when_equals: null,
    ...overrides
  };
}

// ── checkbox: multi-select against configured labels ──────────────────────

test("required checkbox with nothing checked is rejected", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "checkbox", label: "Scale inspection", is_required: true, choice_options: ["Scale clean", "Scale level"] });
  assert.throws(
    () => buildFlatAnswerSnapshots([t], [f], [{ template_field_id: f.id, value_choices: [] }]),
    CalibrationValidationError
  );
});

test("required checkbox with at least one checked succeeds and snapshots only the checked labels", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "checkbox", label: "Scale inspection", is_required: true, choice_options: ["Scale clean", "Scale level", "No visible damage"] });
  const [snapshot] = buildFlatAnswerSnapshots([t], [f], [{ template_field_id: f.id, value_choices: ["Scale clean", "No visible damage"] }]);
  assert.deepEqual(snapshot.value_choices, ["Scale clean", "No visible damage"]);
  assert.deepEqual(snapshot.choice_options_snapshot, ["Scale clean", "Scale level", "No visible damage"]);
  assert.equal(snapshot.task_id, "t1");
  assert.equal(snapshot.task_name_snapshot, "Task");
});

test("optional checkbox with nothing checked is allowed", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "checkbox", label: "Optional inspection", is_required: false, choice_options: ["A", "B"] });
  const [snapshot] = buildFlatAnswerSnapshots([t], [f], []);
  assert.equal(snapshot.value_choices, null);
});

test("checkbox answers not present in the field's configured options are silently dropped, not stored", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "checkbox", label: "Inspection", choice_options: ["A", "B"] });
  const [snapshot] = buildFlatAnswerSnapshots([t], [f], [{ template_field_id: f.id, value_choices: ["A", "Not a real option"] }]);
  assert.deepEqual(snapshot.value_choices, ["A"]);
});

// ── pass_fail: custom labels don't change the underlying boolean semantics ──

test("pass_fail stores a plain boolean regardless of custom labels, and snapshots the labels", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "pass_fail", label: "Overall result", is_required: true, choice_options: ["Within tolerance", "Out of tolerance"] });
  const [snapshot] = buildFlatAnswerSnapshots([t], [f], [{ template_field_id: f.id, value_boolean: false }]);
  assert.equal(snapshot.value_boolean, false);
  assert.deepEqual(snapshot.choice_options_snapshot, ["Within tolerance", "Out of tolerance"]);
});

test("required pass_fail with no answer is rejected", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "pass_fail", label: "Overall result", is_required: true, choice_options: ["Pass", "Fail"] });
  assert.throws(() => buildFlatAnswerSnapshots([t], [f], []), CalibrationValidationError);
});

// ── placeholder is snapshotted but never validated (a UI hint, not an answer) ──

test("placeholder passes through to the snapshot untouched", () => {
  const t = task({ id: "t1" });
  const f = field({ task_id: "t1", field_type: "short_text", label: "Note", placeholder: "Enter a note..." });
  const [snapshot] = buildFlatAnswerSnapshots([t], [f], [{ template_field_id: f.id, value_text: "hello" }]);
  assert.equal(snapshot.placeholder_snapshot, "Enter a note...");
});

// ── a task with multiple fields: all are answered flat, grouped by the same task ──

test("a non-repeating task with multiple fields produces one snapshot per field, all stamped with that task", () => {
  const t = task({ id: "nozzle-1", name: "Nozzle 1", sort_order: 2 });
  const volume = field({ id: "f-volume", task_id: "nozzle-1", field_type: "number", label: "Volume collected", unit: "mL", is_required: true, sort_order: 0 });
  const result = field({ id: "f-result", task_id: "nozzle-1", field_type: "pass_fail", label: "Result", is_required: true, sort_order: 1 });
  const note = field({ id: "f-note", task_id: "nozzle-1", field_type: "long_text", label: "Corrective action", is_required: false, sort_order: 2 });

  const snapshots = buildFlatAnswerSnapshots([t], [volume, result, note], [
    { template_field_id: "f-volume", value_number: 1000 },
    { template_field_id: "f-result", value_boolean: true }
  ]);

  assert.equal(snapshots.length, 3);
  assert.ok(snapshots.every((s) => s.task_id === "nozzle-1" && s.task_name_snapshot === "Nozzle 1" && s.task_sort_order === 2));
  assert.equal(snapshots.find((s) => s.field_label_snapshot === "Volume collected")?.value_number, 1000);
  assert.equal(snapshots.find((s) => s.field_label_snapshot === "Result")?.value_boolean, true);
  assert.equal(snapshots.find((s) => s.field_label_snapshot === "Corrective action")?.value_text, null);
});

test("a repeating task is excluded from flat answers entirely (its fields only ever appear in rows)", () => {
  const flatTask = task({ id: "t1", is_repeating: false });
  const repeatingTask = task({ id: "t2", is_repeating: true });
  const flatField = field({ id: "f1", task_id: "t1" });
  const repeatingField = field({ id: "f2", task_id: "t2" });

  const snapshots = buildFlatAnswerSnapshots([flatTask, repeatingTask], [flatField, repeatingField], [
    { template_field_id: "f1", value_text: "a" },
    { template_field_id: "f2", value_text: "b" }
  ]);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].template_field_id, "f1");
});

// ── repeating tasks: empty-row discard now also considers value_choices ──

test("a repeating task's row containing only unchecked checkboxes is discarded as empty", () => {
  const t = task({ id: "group-1", name: "Nozzle Measurements", is_repeating: true });
  const checkboxChild = field({ id: "child-1", task_id: "group-1", field_type: "checkbox", label: "Condition OK", choice_options: ["OK"] });

  const rows: RepeatingRowInput[] = [
    { task_id: "group-1", answers: [{ template_field_id: "child-1", value_choices: [] }] }
  ];

  const result = buildRepeatingRows([t], [checkboxChild], rows);
  assert.equal(result.length, 0, "an all-empty row (including an unchecked checkbox) must be discarded, not saved");
});

test("a repeating task's row with a checked checkbox is kept", () => {
  const t = task({ id: "group-1", name: "Nozzle Measurements", is_repeating: true });
  const checkboxChild = field({ id: "child-1", task_id: "group-1", field_type: "checkbox", label: "Condition OK", choice_options: ["OK"] });

  const rows: RepeatingRowInput[] = [
    { task_id: "group-1", answers: [{ template_field_id: "child-1", value_choices: ["OK"] }] }
  ];

  const result = buildRepeatingRows([t], [checkboxChild], rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].task_name_snapshot, "Nozzle Measurements");
  assert.deepEqual(result[0].answers[0].value_choices, ["OK"]);
});

test("min_rows/max_rows are still enforced against the surviving (non-empty) row count", () => {
  const t = task({ id: "group-1", name: "Nozzles", is_repeating: true, min_rows: 2, max_rows: 3 });
  const numberChild = field({ id: "child-1", task_id: "group-1", field_type: "number", label: "Volume" });

  const oneRow: RepeatingRowInput[] = [
    { task_id: "group-1", answers: [{ template_field_id: "child-1", value_number: 5 }] }
  ];
  assert.throws(() => buildRepeatingRows([t], [numberChild], oneRow), /at least 2/);

  const fourRows: RepeatingRowInput[] = Array.from({ length: 4 }, (_, i) => ({
    task_id: "group-1",
    answers: [{ template_field_id: "child-1", value_number: i + 1 }]
  }));
  assert.throws(() => buildRepeatingRows([t], [numberChild], fourRows), /at most 3/);
});
