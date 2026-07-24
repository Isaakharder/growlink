import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskColumnsAndChecks,
  type ReportItemRow,
  type ReportRow,
  type TaskRow
} from "../foodSafetyReportCard";

// Mirrors Washroom 1's live shape: a "Checked" task recorded on every report,
// plus periodic extra tasks, plus historical-only "Water Source Operating"
// columns no longer in the current task config.
const TASKS: TaskRow[] = [
  { name: "Checked", sort_order: 0, action_labels: ["Inspected"] },
  { name: "Disposable Paper Towels", sort_order: 100, action_labels: ["Filled"] },
  { name: "Floors", sort_order: 400, action_labels: ["Cleaned"] }
];

function item(reportId: string, name: string, actionLabel: string, checked: boolean, sortOrder: number): ReportItemRow {
  return {
    report_id: reportId,
    task_name_snapshot: name,
    action_label_snapshot: actionLabel,
    response_type_snapshot: "checkbox",
    response_value: checked ? "true" : null,
    sort_order: sortOrder
  };
}

function report(id: string, completedAt: string): ReportRow {
  return { id, completed_at: completedAt, completed_by_name: "Test User", completed_by_initials: "TU" };
}

// Matches the real backfill shape observed live on Washroom 1: every report
// carries a row for every task/label the location has EVER had — including
// "Water Source Operating", a task no longer in the current config — with
// response_value null meaning "not applicable/unchecked" rather than the
// item being absent. Only "Checked" and, on a couple of reports, "Floors"
// are ever actually ticked true.
const R1 = report("r1", "2026-01-19T12:00:00Z");
const R2 = report("r2", "2026-06-02T12:00:00Z");
const R3 = report("r3", "2026-06-20T12:00:00Z");
const R4 = report("r4", "2026-07-23T12:00:00Z");

function fullItemSet(reportId: string, floorsChecked: boolean): ReportItemRow[] {
  return [
    item(reportId, "Checked", "Inspected", true, 0),
    item(reportId, "Disposable Paper Towels", "Filled", false, 100),
    item(reportId, "Floors", "Cleaned", floorsChecked, 400),
    item(reportId, "Water Source Operating", "Hot", false, 600),
    item(reportId, "Water Source Operating", "Cold", false, 601)
  ];
}

const ALL_ITEMS: ReportItemRow[] = [
  ...fullItemSet("r1", false),
  ...fullItemSet("r2", false),
  ...fullItemSet("r3", true),
  ...fullItemSet("r4", false)
];

const ALL_REPORTS = [R1, R2, R3, R4];

function checksByLabel(taskColumns: { key: string; label: string }[], taskChecks: Record<string, boolean>) {
  const byLabel: Record<string, boolean> = {};
  for (const col of taskColumns) {
    byLabel[col.label] = taskChecks[col.key] ?? false;
  }
  return byLabel;
}

test("a report's checked state is identical whether it's fetched alone (date-filtered) or alongside the full history (unfiltered)", () => {
  const unfiltered = buildTaskColumnsAndChecks(ALL_REPORTS, ALL_ITEMS, TASKS);

  // Simulate a date-range filter that only pulls reports r2 and r3 — and,
  // just like the real route, only fetches items scoped to those report IDs.
  const filteredReports = [R2, R3];
  const filteredReportIds = new Set(filteredReports.map((r) => r.id));
  const filteredItems = ALL_ITEMS.filter((i) => filteredReportIds.has(i.report_id));
  const filtered = buildTaskColumnsAndChecks(filteredReports, filteredItems, TASKS);

  for (const r of filteredReports) {
    const unfilteredRow = unfiltered.reports.find((row) => row.id === r.id)!;
    const filteredRow = filtered.reports.find((row) => row.id === r.id)!;

    const unfilteredChecks = checksByLabel(unfiltered.taskColumns, unfilteredRow.taskChecks);
    const filteredChecks = checksByLabel(filtered.taskColumns, filteredRow.taskChecks);

    assert.deepEqual(
      filteredChecks,
      unfilteredChecks,
      `report ${r.id} checked-state mismatch between filtered and unfiltered results`
    );
  }
});

test("every item for a report appears as a column, even when the containing task is no longer part of the current config", () => {
  const { taskColumns, reports } = buildTaskColumnsAndChecks([R1], ALL_ITEMS.filter((i) => i.report_id === "r1"), TASKS);

  assert.equal(taskColumns.length, 5, "Checked, Disposable Paper Towels, Floors, Water Source Operating (Hot, Cold)");
  const r1Row = reports.find((r) => r.id === "r1")!;
  assert.equal(Object.keys(r1Row.taskChecks).length, 5);

  const checked = checksByLabel(taskColumns, r1Row.taskChecks);
  assert.equal(checked["Checked"], true);
  assert.equal(checked["Water Source Operating — Hot"], false);
  assert.equal(checked["Water Source Operating — Cold"], false);
});

test("excluding a report from the query never changes another report's own taskChecks", () => {
  const withAllFour = buildTaskColumnsAndChecks(ALL_REPORTS, ALL_ITEMS, TASKS);
  const withoutR1 = buildTaskColumnsAndChecks(
    [R2, R3, R4],
    ALL_ITEMS.filter((i) => i.report_id !== "r1"),
    TASKS
  );

  for (const r of [R2, R3, R4]) {
    const a = checksByLabel(withAllFour.taskColumns, withAllFour.reports.find((row) => row.id === r.id)!.taskChecks);
    const b = checksByLabel(withoutR1.taskColumns, withoutR1.reports.find((row) => row.id === r.id)!.taskChecks);
    assert.deepEqual(b, a, `report ${r.id} should be unaffected by whether r1 is in the query set`);
  }
});

test("a report with no items at all still renders with every column false, not missing", () => {
  const reportWithNoItems = report("r5", "2026-05-01T12:00:00Z");
  const { taskColumns, reports } = buildTaskColumnsAndChecks(
    [R2, reportWithNoItems],
    ALL_ITEMS.filter((i) => i.report_id === "r2"),
    TASKS
  );

  const row = reports.find((r) => r.id === "r5")!;
  assert.ok(row, "report with zero items must still appear in the result");
  for (const col of taskColumns) {
    assert.equal(row.taskChecks[col.key], undefined, "no items means no keys are set for this row, which the UI renders as unchecked");
  }
});
