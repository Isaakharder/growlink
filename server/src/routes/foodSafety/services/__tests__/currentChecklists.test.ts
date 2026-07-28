import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceToLatestAttempts } from "../currentChecklists";
import type { ChecklistPeriodType } from "../checklistPeriod";

type Row = { id: string; period_type: ChecklistPeriodType; attempt_number: number };

function row(id: string, periodType: ChecklistPeriodType, attemptNumber: number): Row {
  return { id, period_type: periodType, attempt_number: attemptNumber };
}

// Covers the ticket's "Complete Another Report" attempt model: a location
// can now have more than one checklist row for the same period_type/
// period_key (one per attempt — see migration 0101), and only the latest
// attempt of each period_type is ever the live, currently-relevant one.

test("a single attempt is returned as-is", () => {
  const result = reduceToLatestAttempts([row("a", "daily", 1)]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["a"]
  );
});

test("of two attempts for the same period_type, only the higher attempt_number survives", () => {
  const result = reduceToLatestAttempts([row("attempt-1", "daily", 1), row("attempt-2", "daily", 2)]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["attempt-2"]
  );
});

test("three attempts (e.g. failed swab test, re-clean, passing retest) reduce to the third", () => {
  const result = reduceToLatestAttempts([row("attempt-1", "daily", 1), row("attempt-2", "daily", 2), row("attempt-3", "daily", 3)]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["attempt-3"]
  );
});

test("input order does not matter — the highest attempt_number always wins", () => {
  const result = reduceToLatestAttempts([row("attempt-2", "daily", 2), row("attempt-1", "daily", 1), row("attempt-3", "daily", 3)]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["attempt-3"]
  );
});

test("different period_types are reduced independently (does not collapse weekly into daily)", () => {
  const result = reduceToLatestAttempts([
    row("daily-1", "daily", 1),
    row("daily-2", "daily", 2),
    row("weekly-1", "weekly", 1),
    row("weekly-2", "weekly", 2),
    row("weekly-3", "weekly", 3)
  ]);
  const ids = new Set(result.map((r) => r.id));
  assert.equal(ids.size, 2);
  assert.ok(ids.has("daily-2"));
  assert.ok(ids.has("weekly-3"));
});

test("empty input returns empty output", () => {
  assert.deepEqual(reduceToLatestAttempts([]), []);
});
