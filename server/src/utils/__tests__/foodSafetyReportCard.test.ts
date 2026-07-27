import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskColumnsAndValues,
  formatTaskCellValue,
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

function valuesByLabel(taskColumns: { key: string; label: string }[], taskValues: Record<string, { display: string; isCheckmark: boolean }>) {
  const byLabel: Record<string, { display: string; isCheckmark: boolean }> = {};
  for (const col of taskColumns) {
    byLabel[col.label] = taskValues[col.key] ?? { display: "", isCheckmark: false };
  }
  return byLabel;
}

test("a report's cell values are identical whether it's fetched alone (date-filtered) or alongside the full history (unfiltered)", () => {
  const unfiltered = buildTaskColumnsAndValues(ALL_REPORTS, ALL_ITEMS, TASKS);

  // Simulate a date-range filter that only pulls reports r2 and r3 — and,
  // just like the real route, only fetches items scoped to those report IDs.
  const filteredReports = [R2, R3];
  const filteredReportIds = new Set(filteredReports.map((r) => r.id));
  const filteredItems = ALL_ITEMS.filter((i) => filteredReportIds.has(i.report_id));
  const filtered = buildTaskColumnsAndValues(filteredReports, filteredItems, TASKS);

  for (const r of filteredReports) {
    const unfilteredRow = unfiltered.reports.find((row) => row.id === r.id)!;
    const filteredRow = filtered.reports.find((row) => row.id === r.id)!;

    const unfilteredValues = valuesByLabel(unfiltered.taskColumns, unfilteredRow.taskValues);
    const filteredValues = valuesByLabel(filtered.taskColumns, filteredRow.taskValues);

    assert.deepEqual(
      filteredValues,
      unfilteredValues,
      `report ${r.id} cell values mismatch between filtered and unfiltered results`
    );
  }
});

test("every item for a report appears as a column, even when the containing task is no longer part of the current config", () => {
  const { taskColumns, reports } = buildTaskColumnsAndValues([R1], ALL_ITEMS.filter((i) => i.report_id === "r1"), TASKS);

  assert.equal(taskColumns.length, 5, "Checked, Disposable Paper Towels, Floors, Water Source Operating (Hot, Cold)");
  const r1Row = reports.find((r) => r.id === "r1")!;
  assert.equal(Object.keys(r1Row.taskValues).length, 5);

  const values = valuesByLabel(taskColumns, r1Row.taskValues);
  assert.equal(values["Checked"].display, "✓");
  assert.equal(values["Water Source Operating — Hot"].display, "");
  assert.equal(values["Water Source Operating — Cold"].display, "");
});

test("excluding a report from the query never changes another report's own taskValues", () => {
  const withAllFour = buildTaskColumnsAndValues(ALL_REPORTS, ALL_ITEMS, TASKS);
  const withoutR1 = buildTaskColumnsAndValues(
    [R2, R3, R4],
    ALL_ITEMS.filter((i) => i.report_id !== "r1"),
    TASKS
  );

  for (const r of [R2, R3, R4]) {
    const a = valuesByLabel(withAllFour.taskColumns, withAllFour.reports.find((row) => row.id === r.id)!.taskValues);
    const b = valuesByLabel(withoutR1.taskColumns, withoutR1.reports.find((row) => row.id === r.id)!.taskValues);
    assert.deepEqual(b, a, `report ${r.id} should be unaffected by whether r1 is in the query set`);
  }
});

test("a report with no items at all still renders with every column blank, not missing", () => {
  const reportWithNoItems = report("r5", "2026-05-01T12:00:00Z");
  const { taskColumns, reports } = buildTaskColumnsAndValues(
    [R2, reportWithNoItems],
    ALL_ITEMS.filter((i) => i.report_id === "r2"),
    TASKS
  );

  const row = reports.find((r) => r.id === "r5")!;
  assert.ok(row, "report with zero items must still appear in the result");
  for (const col of taskColumns) {
    assert.equal(row.taskValues[col.key], undefined, "no items means no keys are set for this row, which the UI renders as blank");
  }
});

// ── formatTaskCellValue: the single formatting rule shared by the on-screen
// report table and the printed report (both render `.display` verbatim). ──

function checkboxItem(value: string | null): ReportItemRow {
  return {
    report_id: "r",
    task_name_snapshot: "Checked",
    action_label_snapshot: null,
    response_type_snapshot: "checkbox",
    response_value: value,
    sort_order: 0
  };
}

function typedItem(responseType: string, value: string | null): ReportItemRow {
  return {
    report_id: "r",
    task_name_snapshot: "Maintenance Required",
    action_label_snapshot: null,
    response_type_snapshot: responseType,
    response_value: value,
    sort_order: 0
  };
}

test("checked checkbox renders a checkmark", () => {
  const cell = formatTaskCellValue(checkboxItem("true"));
  assert.equal(cell.display, "✓");
  assert.equal(cell.isCheckmark, true);
});

test("unchecked checkbox renders blank", () => {
  const cell = formatTaskCellValue(checkboxItem(null));
  assert.equal(cell.display, "");
  assert.equal(cell.isCheckmark, false);
});

test("long-text value renders the exact saved text, not a checkmark", () => {
  const text = "Loose caulking around the west window frame; requested maintenance follow-up before next inspection.";
  const cell = formatTaskCellValue(typedItem("long_text", text));
  assert.equal(cell.display, text);
  assert.equal(cell.isCheckmark, false);
});

test("empty long-text value renders blank", () => {
  const cell = formatTaskCellValue(typedItem("long_text", null));
  assert.equal(cell.display, "");
  assert.equal(cell.isCheckmark, false);
});

test("short-text value renders the exact saved text", () => {
  const cell = formatTaskCellValue(typedItem("short_text", "West door"));
  assert.equal(cell.display, "West door");
  assert.equal(cell.isCheckmark, false);
});

test('numeric zero renders as "0", not blank', () => {
  const cell = formatTaskCellValue(typedItem("number", "0"));
  assert.equal(cell.display, "0");
  assert.equal(cell.isCheckmark, false);
});

test("a non-zero number renders its exact saved value", () => {
  const cell = formatTaskCellValue(typedItem("number", "21.5"));
  assert.equal(cell.display, "21.5");
});

test("an unrecognized/future response type renders its stored value verbatim instead of collapsing to a checkmark", () => {
  const cell = formatTaskCellValue(typedItem("future_type", "some answer"));
  assert.equal(cell.display, "some answer");
  assert.equal(cell.isCheckmark, false);
});

test("historical rows defaulted to response_type_snapshot='checkbox' (pre-migration-0087 data) still render exactly as before", () => {
  const cell = formatTaskCellValue(checkboxItem("true"));
  assert.equal(cell.display, "✓");
  assert.equal(cell.isCheckmark, true);
});

test("buildTaskColumnsAndValues carries a long-text answer through to the report row's cell, unmodified", () => {
  const longText = "Ceiling tile stained near the drain; needs replacing.";
  const longTextItem: ReportItemRow = {
    report_id: "r10",
    task_name_snapshot: "Maintenance Required",
    action_label_snapshot: null,
    response_type_snapshot: "long_text",
    response_value: longText,
    sort_order: 0
  };
  const r10 = report("r10", "2026-07-20T12:00:00Z");
  const { taskColumns, reports } = buildTaskColumnsAndValues([r10], [longTextItem], []);
  const row = reports.find((r) => r.id === "r10")!;
  const col = taskColumns.find((c) => c.label === "Maintenance Required")!;

  assert.equal(row.taskValues[col.key].display, longText);
  assert.equal(row.taskValues[col.key].isCheckmark, false);
});
