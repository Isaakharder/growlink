import { test } from "node:test";
import assert from "node:assert/strict";
import { addCalibrationInterval, computeDueStatus } from "../dueScheduling";
import { getZonedParts, zonedTimeToUtc } from "../../../../utils/zonedTime";
import { DEFAULT_ORG_TIMEZONE } from "../../../../config/orgTimezone";

const TZ = DEFAULT_ORG_TIMEZONE; // America/Toronto

function toronto(year: number, month: number, day: number, hour = 9, minute = 15): Date {
  return zonedTimeToUtc(year, month, day, hour, minute, TZ);
}

function assertZoned(result: Date | null, expected: { year: number; month: number; day: number; hour?: number; minute?: number }) {
  assert.ok(result, "expected a non-null due date");
  const parts = getZonedParts(result as Date, TZ);
  assert.equal(parts.year, expected.year, "year");
  assert.equal(parts.month, expected.month, "month");
  assert.equal(parts.day, expected.day, "day");
  if (expected.hour !== undefined) assert.equal(parts.hour, expected.hour, "hour (wall-clock preserved)");
  if (expected.minute !== undefined) assert.equal(parts.minute, expected.minute, "minute (wall-clock preserved)");
}

// ── basic frequency types ────────────────────────────────────────────────

test("daily adds one calendar day, preserving wall-clock time", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "daily", null, null);
  assertZoned(result, { year: 2026, month: 7, day: 30, hour: 9, minute: 15 });
});

test("weekly adds seven calendar days", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "weekly", null, null);
  assertZoned(result, { year: 2026, month: 8, day: 5, hour: 9, minute: 15 });
});

test("monthly adds one calendar month", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "monthly", null, null);
  assertZoned(result, { year: 2026, month: 8, day: 29 });
});

test("quarterly adds three calendar months", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "quarterly", null, null);
  assertZoned(result, { year: 2026, month: 10, day: 29 });
});

test("annually adds twelve calendar months", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "annually", null, null);
  assertZoned(result, { year: 2027, month: 7, day: 29 });
});

test("on_demand never produces a next due date", () => {
  assert.equal(addCalibrationInterval(toronto(2026, 7, 29), "on_demand", null, null), null);
});

test("custom: every 10 days", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "custom", 10, "days");
  assertZoned(result, { year: 2026, month: 8, day: 8 });
});

test("custom: every 2 weeks", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "custom", 2, "weeks");
  assertZoned(result, { year: 2026, month: 8, day: 12 });
});

test("custom: every 5 months", () => {
  const result = addCalibrationInterval(toronto(2026, 7, 29), "custom", 5, "months");
  assertZoned(result, { year: 2026, month: 12, day: 29 });
});

// ── month-end / leap-year clamping ───────────────────────────────────────

test("January 31 plus one month clamps to February 28 (non-leap year)", () => {
  const result = addCalibrationInterval(toronto(2026, 1, 31), "monthly", null, null);
  assertZoned(result, { year: 2026, month: 2, day: 28 });
});

test("January 31 plus one month clamps to February 29 (leap year)", () => {
  const result = addCalibrationInterval(toronto(2028, 1, 31), "monthly", null, null);
  assertZoned(result, { year: 2028, month: 2, day: 29 });
});

test("February 29 (leap year) plus one year clamps to February 28 (next year is not leap)", () => {
  const result = addCalibrationInterval(toronto(2028, 2, 29), "annually", null, null);
  assertZoned(result, { year: 2029, month: 2, day: 28 });
});

test("month-end that fits exactly: April 30 plus one month is May 30, not clamped", () => {
  const result = addCalibrationInterval(toronto(2026, 4, 30), "monthly", null, null);
  assertZoned(result, { year: 2026, month: 5, day: 30 });
});

test("month-end that overflows: May 31 plus one month clamps to June 30", () => {
  const result = addCalibrationInterval(toronto(2026, 5, 31), "monthly", null, null);
  assertZoned(result, { year: 2026, month: 6, day: 30 });
});

test("quarterly completion on a month-end clamps correctly (Nov 30 + 3 months -> Feb 28)", () => {
  const result = addCalibrationInterval(toronto(2026, 11, 30), "quarterly", null, null);
  assertZoned(result, { year: 2027, month: 2, day: 28 });
});

// ── daylight-saving transitions (America/Toronto, 2026: spring-forward
// Mar 8, fall-back Nov 1 — confirmed via Intl.DateTimeFormat, not assumed) ──

test("daily interval across the spring-forward DST transition preserves wall-clock time", () => {
  const result = addCalibrationInterval(toronto(2026, 3, 7, 9, 0), "daily", null, null);
  assertZoned(result, { year: 2026, month: 3, day: 8, hour: 9, minute: 0 });
});

test("daily interval across the fall-back DST transition preserves wall-clock time", () => {
  const result = addCalibrationInterval(toronto(2026, 10, 31, 9, 0), "daily", null, null);
  assertZoned(result, { year: 2026, month: 11, day: 1, hour: 9, minute: 0 });
});

test("custom weekly interval spanning a DST transition preserves wall-clock time", () => {
  const result = addCalibrationInterval(toronto(2026, 3, 3, 14, 30), "weekly", null, null);
  assertZoned(result, { year: 2026, month: 3, day: 10, hour: 14, minute: 30 });
});

// ── effective (performed) date, not entry timestamp, is the due-date base ──
// records.ts passes effectiveDate.referenceDate (noon on the performed date,
// from services/effectiveDate.ts) into addCalibrationInterval — not the
// actual submission instant. This proves the exact scenario from the
// backdating spec: a quarterly device performed July 15 but entered July 30
// is next due October 15, not October 30.

test("quarterly calibration performed July 15 but entered July 30 is next due October 15, not October 30", () => {
  const performedDate = toronto(2026, 7, 15, 12, 0); // referenceDate: noon on the performed date
  const result = addCalibrationInterval(performedDate, "quarterly", null, null);
  assertZoned(result, { year: 2026, month: 10, day: 15 });
});

// ── due status ────────────────────────────────────────────────────────────

test("computeDueStatus: null next_due_at is on_demand", () => {
  assert.equal(computeDueStatus(null, new Date("2026-07-29T12:00:00Z")), "on_demand");
});

test("computeDueStatus: a past due date is overdue", () => {
  const now = new Date("2026-07-29T12:00:00Z");
  const past = new Date("2026-07-28T12:00:00Z");
  assert.equal(computeDueStatus(past, now), "overdue");
});

test("computeDueStatus: within the 7-day window is due_soon", () => {
  const now = new Date("2026-07-29T12:00:00Z");
  const soon = new Date("2026-08-03T12:00:00Z"); // 5 days out
  assert.equal(computeDueStatus(soon, now), "due_soon");
});

test("computeDueStatus: exactly 7 days out is due_soon (inclusive boundary)", () => {
  const now = new Date("2026-07-29T12:00:00Z");
  const boundary = new Date("2026-08-05T12:00:00Z"); // exactly 7 days
  assert.equal(computeDueStatus(boundary, now), "due_soon");
});

test("computeDueStatus: beyond the window is ok", () => {
  const now = new Date("2026-07-29T12:00:00Z");
  const far = new Date("2026-09-01T12:00:00Z");
  assert.equal(computeDueStatus(far, now), "ok");
});
