import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReportDate, MAX_BACKDATE_DAYS } from "../reportDate";
import { todayInOrgTimezone } from "../checklistPeriod";
import { dateToDayIndex } from "../backfillGeneration";
import { DEFAULT_ORG_TIMEZONE } from "../../../../config/orgTimezone";

// All boundary cases are computed relative to "today" (in the organization's
// America/Toronto timezone) rather than hardcoded, so this test stays valid
// regardless of what day it's actually run on.
function daysAgo(n: number): string {
  const todayIdx = dateToDayIndex(todayInOrgTimezone());
  const targetIdx = todayIdx - n;
  const ms = targetIdx * 86_400_000;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("today is valid and not backdated", () => {
  const result = validateReportDate(daysAgo(0));
  assert.equal(result.isBackdated, false);
  assert.equal(result.dateStr, todayInOrgTimezone());
});

test("yesterday works and is backdated", () => {
  const result = validateReportDate(daysAgo(1));
  assert.equal(result.isBackdated, true);
  assert.equal(result.dateStr, daysAgo(1));
});

test("six months (~183 days) ago works", () => {
  const result = validateReportDate(daysAgo(183));
  assert.equal(result.isBackdated, true);
});

test("exactly 299 days ago works", () => {
  const result = validateReportDate(daysAgo(299));
  assert.equal(result.isBackdated, true);
});

test("exactly 300 days ago (the boundary) works", () => {
  assert.equal(MAX_BACKDATE_DAYS, 300);
  const result = validateReportDate(daysAgo(300));
  assert.equal(result.isBackdated, true);
});

test("301 days ago is rejected", () => {
  assert.throws(() => validateReportDate(daysAgo(301)), /more than 300 days/);
});

test("far future date is rejected", () => {
  assert.throws(() => validateReportDate(daysAgo(-1)), /future/);
  assert.throws(() => validateReportDate(daysAgo(-30)), /future/);
});

test("malformed date strings are rejected", () => {
  assert.throws(() => validateReportDate("not-a-date"));
  assert.throws(() => validateReportDate("2026/07/24"));
  assert.throws(() => validateReportDate(""));
  assert.throws(() => validateReportDate(undefined));
  assert.throws(() => validateReportDate(12345));
});

test("referenceDate resolves to noon on the requested date in the org timezone", () => {
  const target = daysAgo(10);
  const result = validateReportDate(target);
  const readBack = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_ORG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(result.referenceDate);
  assert.equal(readBack, target);
});
