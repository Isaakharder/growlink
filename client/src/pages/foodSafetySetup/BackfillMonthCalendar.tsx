const WEEKDAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

type DayStatus = "selected" | "existing" | "future" | "outOfRange" | "available";

type BackfillMonthCalendarProps = {
  year: number;
  month: number; // 1-12
  rangeStart: string; // YYYY-MM-DD
  rangeEnd: string; // YYYY-MM-DD
  todayIso: string; // YYYY-MM-DD, organization-local "today"
  existingDates: Set<string>;
  selectedDates: Set<string>; // dates selected for the active task
  otherTaskDates: Set<string>; // union of dates selected for every other task
  onToggleDate: (date: string) => void;
  disabled: boolean; // true when no task is currently active — nothing is clickable
};

function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function BackfillMonthCalendar({
  year,
  month,
  rangeStart,
  rangeEnd,
  todayIso,
  existingDates,
  selectedDates,
  otherTaskDates,
  onToggleDate,
  disabled
}: BackfillMonthCalendarProps) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: Array<{ day: number; iso: string } | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push({ day, iso: toIsoDate(year, month, day) });

  function statusFor(iso: string): DayStatus {
    if (iso < rangeStart || iso > rangeEnd) return "outOfRange";
    if (iso > todayIso) return "future";
    if (existingDates.has(iso)) return "existing";
    if (selectedDates.has(iso)) return "selected";
    return "available";
  }

  return (
    <div className="backfill-calendar">
      <div className="backfill-calendar-title">
        {MONTH_NAMES[month - 1]} {year}
      </div>
      <div className="backfill-calendar-grid">
        {WEEKDAY_HEADERS.map((h, i) => (
          <div key={i} className="backfill-calendar-weekday">
            {h}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} className="backfill-calendar-cell backfill-calendar-cell-empty" />;

          const status = statusFor(cell.iso);
          const hasOtherTaskActivity = otherTaskDates.has(cell.iso);
          const clickable = !disabled && (status === "available" || status === "selected");

          const titleByStatus: Record<DayStatus, string> = {
            selected: "Selected for this task — click to remove",
            existing: "Already has a completed report",
            future: "Future date",
            outOfRange: "Outside the selected date range",
            available: hasOtherTaskActivity ? "Selected for another task" : "Click to select"
          };

          // Screen readers get the full state in words (not just the title
          // tooltip, which never shows on touch and is inconsistently
          // announced) — same five states the sighted legend below conveys
          // with colour: available, selected for this task, selected for
          // another task, existing report, future/outside range.
          const stateDescription =
            status === "selected"
              ? "selected for this task"
              : status === "existing"
                ? "existing report"
                : status === "future"
                  ? "future date"
                  : status === "outOfRange"
                    ? "outside selected range"
                    : hasOtherTaskActivity
                      ? "selected for another task"
                      : "available";

          const dateLabel = `${MONTH_NAMES[month - 1]} ${cell.day}, ${year}`;

          return (
            <button
              key={i}
              type="button"
              className={`backfill-calendar-cell backfill-calendar-cell-${status}${hasOtherTaskActivity ? " has-other-task" : ""}`}
              disabled={!clickable}
              title={titleByStatus[status]}
              aria-label={`${dateLabel} — ${stateDescription}`}
              aria-pressed={clickable ? status === "selected" : undefined}
              onClick={() => onToggleDate(cell.iso)}
            >
              {cell.day}
              {hasOtherTaskActivity && status !== "selected" ? <span className="backfill-calendar-dot" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
