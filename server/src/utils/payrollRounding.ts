// Pure payroll rounding engine — no I/O, fully unit-testable.
//
// Root-cause fix: rounded clock-in/out timestamps must land exactly on a
// whole local minute (":00.000"). The previous implementation shifted the
// *raw* timestamp (seconds/milliseconds included) by a whole-minute delta,
// so the rounded result silently kept the original sub-minute remainder
// (e.g. a clock-in at 07:03:27.500 "rounded up to 07:15" actually produced
// 07:15:27.500). Gross minutes were then a non-integer, and that fractional
// residue is what surfaced as 11.99h / 12.01h instead of clean values.
//
// All IANA timezone UTC offsets are a whole number of minutes, so truncating
// to a whole UTC minute after the shift also truncates to a whole local
// minute — no calendar-aware reconstruction is needed.

export type RoundingMode = "none" | "nearest" | "up" | "down";

export const ROUNDING_MODES: RoundingMode[] = ["none", "nearest", "up", "down"];

export type PayrollRoundingSettings = {
  work_day_start: string; // "HH:MM"
  start_rounding_mode: RoundingMode;
  start_rounding_interval_minutes: number;
  end_rounding_mode: RoundingMode;
  end_rounding_interval_minutes: number;
  snap_early_clock_in_to_start: boolean;
  break_deduction_minutes: number;
  timezone: string;
};

export function parseWorkDayStartMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Returns how many whole minutes past midnight the timestamp is in the given
// IANA timezone (seconds/milliseconds are not represented by Intl's minute
// part, so this is already floor-to-the-minute).
export function getLocalMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    timeZone: timezone,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

// Shifts a UTC timestamp so its local time becomes targetLocalMinutes, then
// truncates to a whole UTC minute so the result never carries the original
// seconds/milliseconds forward.
export function shiftToLocalMinutes(date: Date, timezone: string, targetLocalMinutes: number): Date {
  const currentLocalMinutes = getLocalMinutes(date, timezone);
  const deltaMs = (targetLocalMinutes - currentLocalMinutes) * 60_000;
  const shiftedMs = date.getTime() + deltaMs;
  return new Date(Math.floor(shiftedMs / 60_000) * 60_000);
}

function applyRoundingMode(localMinutes: number, mode: RoundingMode, intervalMinutes: number): number {
  switch (mode) {
    case "none":
      return localMinutes;
    case "up":
      return Math.ceil(localMinutes / intervalMinutes) * intervalMinutes;
    case "down":
      return Math.floor(localMinutes / intervalMinutes) * intervalMinutes;
    case "nearest":
      return Math.round(localMinutes / intervalMinutes) * intervalMinutes;
  }
}

// Start Time Rounding: if snap_early_clock_in_to_start is on and the
// clock-in is at or before the scheduled work day start, the employee is
// credited from the work day start. Otherwise the configured start rounding
// mode/interval is applied to the raw clock-in time directly.
export function applyClockInRounding(clockIn: Date, settings: PayrollRoundingSettings): Date {
  const localMins = getLocalMinutes(clockIn, settings.timezone);

  if (settings.snap_early_clock_in_to_start) {
    const startMins = parseWorkDayStartMinutes(settings.work_day_start);
    if (localMins <= startMins) {
      return shiftToLocalMinutes(clockIn, settings.timezone, startMins);
    }
  }

  const target = applyRoundingMode(localMins, settings.start_rounding_mode, settings.start_rounding_interval_minutes);
  return shiftToLocalMinutes(clockIn, settings.timezone, target);
}

// End Time Rounding: the configured end rounding mode/interval is applied to
// the raw clock-out time, independently of start rounding.
export function applyClockOutRounding(clockOut: Date, settings: PayrollRoundingSettings): Date {
  const localMins = getLocalMinutes(clockOut, settings.timezone);
  const target = applyRoundingMode(localMins, settings.end_rounding_mode, settings.end_rounding_interval_minutes);
  return shiftToLocalMinutes(clockOut, settings.timezone, target);
}

// Rounds a minute count to 2-decimal hours for display only. Never sum
// values already passed through this function — sum minutes first.
export function minutesToDisplayHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export type ShiftResult = {
  roundedIn: string;
  roundedOut: string | null;
  breakDeductionMinutes: number;
  grossMinutes: number | null;
  payableMinutes: number | null;
  rawHours: number | null;
  totalHours: number | null;
  status: "in_progress" | "completed";
};

export function computeShift(
  clockIn: Date,
  clockOut: Date | null,
  settings: PayrollRoundingSettings
): ShiftResult {
  const rIn = applyClockInRounding(clockIn, settings);

  if (!clockOut) {
    return {
      roundedIn: rIn.toISOString(),
      roundedOut: null,
      breakDeductionMinutes: 0,
      grossMinutes: null,
      payableMinutes: null,
      rawHours: null,
      totalHours: null,
      status: "in_progress",
    };
  }

  const rOut = applyClockOutRounding(clockOut, settings);
  // Both rIn and rOut are exact whole-minute UTC instants, so this is an
  // integer — no fractional-minute residue from leftover seconds/ms.
  const grossMinutes = Math.round((rOut.getTime() - rIn.getTime()) / 60_000);
  const breakMinutes = settings.break_deduction_minutes;
  const payableMinutes = Math.max(0, grossMinutes - breakMinutes);

  return {
    roundedIn: rIn.toISOString(),
    roundedOut: rOut.toISOString(),
    breakDeductionMinutes: breakMinutes,
    grossMinutes,
    payableMinutes,
    rawHours: minutesToDisplayHours(grossMinutes),
    totalHours: minutesToDisplayHours(payableMinutes),
    status: "completed",
  };
}
