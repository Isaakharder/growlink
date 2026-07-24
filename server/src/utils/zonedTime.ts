export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

// Reads the wall-clock date/time a given instant shows in `timeZone`. Shared
// by zonedTimeToUtc's own instant<->civil round-trip below and by callers
// (e.g. reportGeneration.ts) that need "what time is it right now, on a wall
// clock in the organization's timezone" without doing their own
// Intl.DateTimeFormat plumbing.
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

// Converts a civil date/time as it would read on a wall clock in `timeZone`
// into the correct UTC instant — the inverse of the UTC-instant -> civil-date
// conversion already used by checklistPeriod.ts. Needed because backfilled
// records must store a real UTC timestamp that reads as the chosen time in
// the organization's timezone (e.g. "6:42 AM America/Toronto"), correctly
// handling the EST/EDT offset for that specific date.
//
// Standard two-pass idiom: guess the instant assuming zero offset, see what
// wall-clock time that guess actually produces in the target zone, then
// correct by the difference. Accurate for all ordinary dates; the rare
// repeated/skipped hour during a DST transition is not a concern here since
// backfilled completion times are synthetic, not real events.
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const parts = getZonedParts(new Date(guessUtcMs), timeZone);

  const asIfUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

  const offsetMs = asIfUtcMs - guessUtcMs;
  return new Date(guessUtcMs - offsetMs);
}
