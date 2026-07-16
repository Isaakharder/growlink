import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnswerChanges } from "../recordRevisions";

test("computeAnswerChanges finds no changes when answers are identical", () => {
  const changes = computeAnswerChanges({ a: 1, b: "x" }, { a: 1, b: "x" });
  assert.deepEqual(changes, []);
});

test("computeAnswerChanges detects a changed value", () => {
  const changes = computeAnswerChanges({ temp: 3 }, { temp: 5 });
  assert.deepEqual(changes, [{ field_id: "temp", old_value: 3, new_value: 5 }]);
});

test("computeAnswerChanges detects a field added since the last revision", () => {
  const changes = computeAnswerChanges({}, { notes: "added" });
  assert.deepEqual(changes, [{ field_id: "notes", old_value: null, new_value: "added" }]);
});

test("computeAnswerChanges detects a field removed since the last revision", () => {
  const changes = computeAnswerChanges({ notes: "was here" }, {});
  assert.deepEqual(changes, [{ field_id: "notes", old_value: "was here", new_value: null }]);
});

test("computeAnswerChanges treats deep-equal objects/arrays as unchanged", () => {
  const changes = computeAnswerChanges({ issues: ["a", "b"] }, { issues: ["a", "b"] });
  assert.deepEqual(changes, []);
});

test("computeAnswerChanges handles null/undefined answer maps gracefully", () => {
  assert.deepEqual(computeAnswerChanges(null, { a: 1 }), [{ field_id: "a", old_value: null, new_value: 1 }]);
  assert.deepEqual(computeAnswerChanges({ a: 1 }, undefined), [{ field_id: "a", old_value: 1, new_value: null }]);
});

test("computeAnswerChanges reports every changed field, not just the first", () => {
  const changes = computeAnswerChanges({ a: 1, b: 2, c: 3 }, { a: 1, b: 20, c: 30 });
  const byField = new Map(changes.map((c) => [c.field_id, c]));
  assert.equal(changes.length, 2);
  assert.deepEqual(byField.get("b"), { field_id: "b", old_value: 2, new_value: 20 });
  assert.deepEqual(byField.get("c"), { field_id: "c", old_value: 3, new_value: 30 });
});
