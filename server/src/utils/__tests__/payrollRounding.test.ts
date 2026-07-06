import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyClockInRounding,
  applyClockOutRounding,
  computeShift,
  minutesToDisplayHours,
  type PayrollRoundingSettings,
} from "../payrollRounding";

const TZ = "America/Toronto"; // -04:00 in July (EDT)

function baseSettings(overrides: Partial<PayrollRoundingSettings> = {}): PayrollRoundingSettings {
  return {
    work_day_start: "07:00",
    start_rounding_mode: "up",
    start_rounding_interval_minutes: 15,
    end_rounding_mode: "down",
    end_rounding_interval_minutes: 15,
    snap_early_clock_in_to_start: true,
    break_deduction_minutes: 0,
    timezone: TZ,
    ...overrides,
  };
}

test("clock-in at 07:03:27.500 rounds UP to 15 min as a clean 07:15:00.000", () => {
  const settings = baseSettings({ snap_early_clock_in_to_start: false, start_rounding_mode: "up", start_rounding_interval_minutes: 15 });
  const clockIn = new Date("2026-07-06T07:03:27.500-04:00");

  const rounded = applyClockInRounding(clockIn, settings);

  assert.strictEqual(rounded.toISOString(), "2026-07-06T11:15:00.000Z");
});

test("clock-out at 15:47:52.300 rounds DOWN to 15 min as a clean 15:45:00.000", () => {
  const settings = baseSettings({ end_rounding_mode: "down", end_rounding_interval_minutes: 15 });
  const clockOut = new Date("2026-07-06T15:47:52.300-04:00");

  const rounded = applyClockOutRounding(clockOut, settings);

  assert.strictEqual(rounded.toISOString(), "2026-07-06T19:45:00.000Z");
});

test("rounded timestamps always land on :00.000 regardless of raw seconds/milliseconds", () => {
  const settings = baseSettings({ snap_early_clock_in_to_start: false });
  for (const [h, m, s, ms] of [
    [7, 3, 27, 500],
    [7, 3, 0, 0],
    [7, 3, 59, 999],
    [9, 17, 44, 123],
  ] as const) {
    const d = new Date(Date.UTC(2026, 6, 6, h + 4, m, s, ms)); // +4h to convert EDT wall time to UTC
    const rIn = applyClockInRounding(d, settings);
    const rOut = applyClockOutRounding(d, settings);
    assert.strictEqual(rIn.getUTCSeconds(), 0);
    assert.strictEqual(rIn.getUTCMilliseconds(), 0);
    assert.strictEqual(rOut.getUTCSeconds(), 0);
    assert.strictEqual(rOut.getUTCMilliseconds(), 0);
  }
});

test("6 shifts of exactly 12 hours total exactly 72.00, even with noisy seconds on each punch", () => {
  const settings = baseSettings({
    work_day_start: "07:00",
    snap_early_clock_in_to_start: true,
    end_rounding_mode: "down",
    end_rounding_interval_minutes: 60,
  });

  // Clock in a bit before 07:00 (snaps to 07:00) and clock out exactly at
  // 19:00 plus junk seconds/ms (rounds down to 19:00) — each shift is a
  // clean 12h, but the raw punches never land on a whole minute.
  const raggedSeconds = [1, 17, 33, 44, 58, 5];
  let totalPayableMinutes = 0;
  let totalPayableHoursSummedNaively = 0;

  for (let day = 1; day <= 6; day++) {
    const s = raggedSeconds[day - 1];
    const clockIn = new Date(`2026-07-0${day}T06:58:${s.toString().padStart(2, "0")}.777-04:00`);
    const clockOut = new Date(`2026-07-0${day}T19:00:${s.toString().padStart(2, "0")}.412-04:00`);

    const shift = computeShift(clockIn, clockOut, settings);

    assert.strictEqual(shift.payableMinutes, 720, `day ${day} should be exactly 720 payable minutes`);
    assert.strictEqual(shift.totalHours, 12, `day ${day} should display as exactly 12.00h, not 11.99/12.01`);

    totalPayableMinutes += shift.payableMinutes ?? 0;
    totalPayableHoursSummedNaively += shift.totalHours ?? 0;
  }

  assert.strictEqual(totalPayableMinutes, 4320);
  assert.strictEqual(minutesToDisplayHours(totalPayableMinutes), 72);
  // Also confirms the naive (already-rounded-hours) summation agrees here,
  // since every shift is perfectly clean — the divergence only shows up
  // once shifts aren't whole hours (see next test).
  assert.strictEqual(totalPayableHoursSummedNaively, 72);
});

test("weekly totals must sum payable minutes, not already-rounded per-shift hours", () => {
  // Each shift is 11h50m (710 minutes) — not a whole hour, so per-shift
  // display rounding (11.83h) loses information that compounds if you sum
  // the rounded decimals instead of the underlying minutes.
  const settings = baseSettings({
    work_day_start: "07:00",
    snap_early_clock_in_to_start: true,
    end_rounding_mode: "none",
  });

  let totalPayableMinutes = 0;
  let totalOfRoundedPerShiftHours = 0;

  for (let day = 1; day <= 6; day++) {
    const clockIn = new Date(`2026-07-0${day}T06:59:00.000-04:00`);
    const clockOut = new Date(`2026-07-0${day}T18:50:00.000-04:00`); // 11h50m after 07:00 snap
    const shift = computeShift(clockIn, clockOut, settings);

    assert.strictEqual(shift.payableMinutes, 710);
    assert.strictEqual(shift.totalHours, 11.83); // display-only rounding of 710/60

    totalPayableMinutes += shift.payableMinutes ?? 0;
    totalOfRoundedPerShiftHours += shift.totalHours ?? 0;
  }

  const correctWeeklyTotal = minutesToDisplayHours(totalPayableMinutes);
  assert.strictEqual(totalPayableMinutes, 4260);
  assert.strictEqual(correctWeeklyTotal, 71); // true total: 71.00h

  // Summing the already-rounded per-shift decimals instead would have
  // under-reported the week by 0.02h (70.98 vs the correct 71.00) — this is
  // exactly the 71.99/72.01-style drift the Payroll Summary used to show.
  assert.notStrictEqual(Math.round(totalOfRoundedPerShiftHours * 100) / 100, correctWeeklyTotal);
  assert.strictEqual(Math.round(totalOfRoundedPerShiftHours * 100) / 100, 70.98);
});

test("in-progress shifts (no clock-out) report null hours/minutes, not zero", () => {
  const settings = baseSettings();
  const shift = computeShift(new Date("2026-07-06T07:03:27.500-04:00"), null, settings);

  assert.strictEqual(shift.status, "in_progress");
  assert.strictEqual(shift.grossMinutes, null);
  assert.strictEqual(shift.payableMinutes, null);
  assert.strictEqual(shift.totalHours, null);
});

test("break deduction is subtracted in whole minutes before converting to hours", () => {
  const settings = baseSettings({
    work_day_start: "07:00",
    snap_early_clock_in_to_start: true,
    end_rounding_mode: "down",
    end_rounding_interval_minutes: 15,
    break_deduction_minutes: 30,
  });
  const clockIn = new Date("2026-07-06T06:55:12.900-04:00");
  const clockOut = new Date("2026-07-06T15:02:48.200-04:00"); // rounds down to 15:00 -> 8h gross

  const shift = computeShift(clockIn, clockOut, settings);

  assert.strictEqual(shift.grossMinutes, 480);
  assert.strictEqual(shift.payableMinutes, 450); // 480 - 30
  assert.strictEqual(shift.totalHours, 7.5);
});

test("start rounding NONE still truncates to a whole minute (no interval snapping)", () => {
  const settings = baseSettings({ snap_early_clock_in_to_start: false, start_rounding_mode: "none" });
  const clockIn = new Date("2026-07-06T09:17:44.123-04:00");

  const rounded = applyClockInRounding(clockIn, settings);

  assert.strictEqual(rounded.toISOString(), "2026-07-06T13:17:00.000Z");
});

test("nearest mode rounds to the closer interval boundary", () => {
  const settings = baseSettings({ snap_early_clock_in_to_start: false, start_rounding_mode: "nearest", start_rounding_interval_minutes: 15 });

  const roundsDown = applyClockInRounding(new Date("2026-07-06T09:07:00.000-04:00"), settings);
  assert.strictEqual(roundsDown.toISOString(), "2026-07-06T13:00:00.000Z");

  const roundsUp = applyClockInRounding(new Date("2026-07-06T09:08:00.000-04:00"), settings);
  assert.strictEqual(roundsUp.toISOString(), "2026-07-06T13:15:00.000Z");
});
