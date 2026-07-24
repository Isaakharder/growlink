import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedTimeToUtc, getZonedParts } from "../zonedTime";

const TZ = "America/Toronto";

test("zonedTimeToUtc + getZonedParts round-trip in EST (winter, UTC-5)", () => {
  const utc = zonedTimeToUtc(2026, 1, 15, 14, 30, TZ);
  const parts = getZonedParts(utc, TZ);
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute },
    { year: 2026, month: 1, day: 15, hour: 14, minute: 30 }
  );
  // EST is UTC-5 in January.
  assert.equal(utc.getUTCHours(), 19);
});

test("zonedTimeToUtc + getZonedParts round-trip in EDT (summer, UTC-4)", () => {
  const utc = zonedTimeToUtc(2026, 7, 18, 9, 15, TZ);
  const parts = getZonedParts(utc, TZ);
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute },
    { year: 2026, month: 7, day: 18, hour: 9, minute: 15 }
  );
  // EDT is UTC-4 in July.
  assert.equal(utc.getUTCHours(), 13);
});

test("round-trips correctly across the spring-forward DST boundary (2026-03-08)", () => {
  // Ontario springs forward at 2:00 AM on the second Sunday of March --
  // 2026-03-08. A time the day before/after must still round-trip cleanly.
  const before = zonedTimeToUtc(2026, 3, 7, 23, 0, TZ);
  const after = zonedTimeToUtc(2026, 3, 9, 1, 0, TZ);
  assert.equal(getZonedParts(before, TZ).day, 7);
  assert.equal(getZonedParts(after, TZ).day, 9);
  // The civil gap is 26 hours (23:00 Mar 7 -> 01:00 Mar 9, minus the missing
  // DST hour), so the real elapsed time must be less than the naive 26h.
  const diffHours = (after.getTime() - before.getTime()) / 3_600_000;
  assert.equal(diffHours, 25);
});

test("round-trips correctly across the fall-back DST boundary (2026-11-01)", () => {
  const before = zonedTimeToUtc(2026, 10, 31, 23, 0, TZ);
  const after = zonedTimeToUtc(2026, 11, 2, 1, 0, TZ);
  assert.equal(getZonedParts(before, TZ).day, 31);
  assert.equal(getZonedParts(after, TZ).day, 2);
  const diffHours = (after.getTime() - before.getTime()) / 3_600_000;
  assert.equal(diffHours, 27);
});
