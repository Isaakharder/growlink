import { test } from "node:test";
import assert from "node:assert/strict";
import { occurrenceDate, computeNextOccurrence, parseDateString, formatDateString } from "../dueDateCalc";

function d(dateStr: string) {
  return parseDateString(dateStr);
}

// ── occurrenceDate: basic frequencies ───────────────────────────────────────

test("occurrenceDate: daily, k=1 adds one day", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "daily", 1, 1)), "2026-07-30");
});

test("occurrenceDate: weekly, k=1 adds seven days", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "weekly", 1, 1)), "2026-08-05");
});

test("occurrenceDate: monthly, k=1 adds one calendar month", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "monthly", 1, 1)), "2026-08-29");
});

test("occurrenceDate: yearly, k=1 adds twelve calendar months", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "yearly", 1, 1)), "2027-07-29");
});

test("occurrenceDate: k=0 is the anchor itself", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "monthly", 1, 0)), "2026-07-29");
});

test("occurrenceDate: every-N-days interval", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "daily", 10, 1)), "2026-08-08");
});

test("occurrenceDate: every-N-months interval", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-07-29"), "monthly", 5, 1)), "2026-12-29");
});

// ── occurrenceDate: month-end / leap-year clamping ──────────────────────────
// Postgres's own `date + interval '1 month'` semantics roll over (Jan 31 + 1
// month = Mar 3) — deliberately not used anywhere in this module.

test("occurrenceDate: Jan 31 + 1 month clamps to Feb 28 in a non-leap year", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-01-31"), "monthly", 1, 1)), "2026-02-28");
});

test("occurrenceDate: Jan 31 + 1 month clamps to Feb 29 in a leap year", () => {
  assert.equal(formatDateString(occurrenceDate(d("2028-01-31"), "monthly", 1, 1)), "2028-02-29");
});

test("occurrenceDate: Feb 29 (leap year) + 1 year clamps to Feb 28 (next year not leap)", () => {
  assert.equal(formatDateString(occurrenceDate(d("2028-02-29"), "yearly", 1, 1)), "2029-02-28");
});

test("occurrenceDate: month-end that fits exactly is not clamped (Apr 30 + 1 month = May 30)", () => {
  assert.equal(formatDateString(occurrenceDate(d("2026-04-30"), "monthly", 1, 1)), "2026-05-30");
});

test("occurrenceDate: re-anchoring each occurrence from Jan 31 never drifts to a 28th permanently", () => {
  // Jan31 -> Feb28 -> Mar31 (NOT Mar28, which chaining from the previous
  // occurrence would incorrectly produce).
  assert.equal(formatDateString(occurrenceDate(d("2026-01-31"), "monthly", 1, 2)), "2026-03-31");
});

// ── computeNextOccurrence: the exact scenario from the product spec ────────
// "Monthly maintenance due September 30, completed September 28, next due
// remains October 30, not October 28."

test("early completion does not drift: due Sep 30, completed Sep 28, next due Oct 30", () => {
  const firstDueDate = d("2026-09-30");
  const result = computeNextOccurrence(firstDueDate, "monthly", 1, 0, d("2026-09-28"));
  assert.equal(result.nextOccurrenceIndex, 1);
  assert.equal(formatDateString(result.nextDueDate!), "2026-10-30");
});

test("on-time completion (same day as due) advances to the next anchored occurrence", () => {
  const firstDueDate = d("2026-09-30");
  const result = computeNextOccurrence(firstDueDate, "monthly", 1, 0, d("2026-09-30"));
  assert.equal(result.nextOccurrenceIndex, 1);
  assert.equal(formatDateString(result.nextDueDate!), "2026-10-30");
});

test("late completion advances to the first occurrence strictly after the completion date", () => {
  // Due Sep 30, completed Nov 5 (missed the Oct 30 occurrence entirely) —
  // next due should be Nov 30, not Oct 30 (already past) or Dec 30 (skips
  // too far).
  const firstDueDate = d("2026-09-30");
  const result = computeNextOccurrence(firstDueDate, "monthly", 1, 0, d("2026-11-05"));
  assert.equal(result.nextOccurrenceIndex, 2);
  assert.equal(formatDateString(result.nextDueDate!), "2026-11-30");
});

test("late completion landing exactly on an occurrence date advances past it", () => {
  // Completed exactly on what would have been the Oct 30 occurrence date —
  // "strictly after" means Oct 30 itself doesn't count as satisfied by a
  // completion recorded ON that date once it's already the due date being
  // completed; the next occurrence must be Nov 30.
  const firstDueDate = d("2026-09-30");
  const result = computeNextOccurrence(firstDueDate, "monthly", 1, 0, d("2026-10-30"));
  assert.equal(result.nextOccurrenceIndex, 2);
  assert.equal(formatDateString(result.nextDueDate!), "2026-11-30");
});

test("computeNextOccurrence: month-end clamping carries through late-completion advancement", () => {
  // Anchor Jan 31, currently on occurrence 0 (due Jan 31), completed in
  // April (well past Feb 28 and Mar 31) -> next due should be Apr 30 (the
  // first anchored occurrence after the completion date), clamped correctly
  // at each step.
  const firstDueDate = d("2026-01-31");
  const result = computeNextOccurrence(firstDueDate, "monthly", 1, 0, d("2026-04-15"));
  assert.equal(result.nextOccurrenceIndex, 3);
  assert.equal(formatDateString(result.nextDueDate!), "2026-04-30");
});

test("computeNextOccurrence: leap-year Feb 29 anchor with yearly recurrence, completed late", () => {
  const firstDueDate = d("2028-02-29");
  const result = computeNextOccurrence(firstDueDate, "yearly", 1, 0, d("2029-06-01"));
  // occurrence 1 = 2029-02-28 (clamped, non-leap year) -> already past ->
  // occurrence 2 = 2030-02-28
  assert.equal(result.nextOccurrenceIndex, 2);
  assert.equal(formatDateString(result.nextDueDate!), "2030-02-28");
});

test("computeNextOccurrence: one_time always advances with a null next due date", () => {
  const firstDueDate = d("2026-09-30");
  const result = computeNextOccurrence(firstDueDate, "one_time", 1, 0, d("2026-09-30"));
  assert.equal(result.nextOccurrenceIndex, 1);
  assert.equal(result.nextDueDate, null);
});

test("computeNextOccurrence: daily recurrence, early completion does not drift", () => {
  const firstDueDate = d("2026-07-01");
  const result = computeNextOccurrence(firstDueDate, "daily", 1, 5, d("2026-07-05"));
  // occurrence 5 is due 2026-07-06; completed a day early on 07-05 -> next
  // is occurrence 6, still anchored at 07-07, not shifted to 07-06.
  assert.equal(result.nextOccurrenceIndex, 6);
  assert.equal(formatDateString(result.nextDueDate!), "2026-07-07");
});
