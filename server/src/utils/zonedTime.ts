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

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(guessUtcMs)).map((part) => [part.type, part.value])
  );

  const asIfUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const offsetMs = asIfUtcMs - guessUtcMs;
  return new Date(guessUtcMs - offsetMs);
}
