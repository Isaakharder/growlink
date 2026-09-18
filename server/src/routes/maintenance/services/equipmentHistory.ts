// Pure merge/sort logic for the equipment work-log + meter-reading +
// schedule-completion history timeline, extracted so it can be unit
// tested directly (no live DB needed) — matching this module's existing
// convention of keeping business logic like dueDateCalc.ts pure and
// separately testable from the Express route that calls it.

export type WorkLogHistoryRow = { id: string; performed_at: string } & Record<string, unknown>;
export type MeterReadingHistoryRow = { id: string; recorded_at: string } & Record<string, unknown>;
export type ScheduleCompletionHistoryRow = { id: string; completed_at: string } & Record<string, unknown>;

export type HistoryEntry =
  | ({ type: "work_log"; id: string; at: string } & Record<string, unknown>)
  | ({ type: "meter_reading"; id: string; at: string } & Record<string, unknown>)
  | ({ type: "schedule_completion"; id: string; at: string } & Record<string, unknown>);

// Meter readings the caller passes in are assumed to already exclude any
// row with related_work_log_id set (the DB query does that filtering) —
// this function only merges and sorts what it's given.
export function mergeEquipmentHistory(
  workLogs: WorkLogHistoryRow[],
  meterReadings: MeterReadingHistoryRow[],
  scheduleCompletions: ScheduleCompletionHistoryRow[],
  limit: number
): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    ...workLogs.map((row): HistoryEntry => ({ type: "work_log", ...row, id: row.id, at: row.performed_at })),
    ...meterReadings.map((row): HistoryEntry => ({ type: "meter_reading", ...row, id: row.id, at: row.recorded_at })),
    ...scheduleCompletions.map((row): HistoryEntry => ({ type: "schedule_completion", ...row, id: row.id, at: row.completed_at }))
  ];

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return entries.slice(0, limit);
}
