import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildColumns,
  buildManualGeneratedDays,
  columnKeyFor,
  type BackfillTaskInput
} from "../../routes/foodSafety/services/backfillGeneration";

// backfill.ts builds two things from the exact same `columns` array: the
// /backfill/preview response's taskColumns (what the admin sees before
// confirming) and, on /backfill/create, the actual
// food_safety_cleaning_report_items rows that get saved. Because both come
// from one shared `columns`/`buildManualGeneratedDays` call, they can't
// structurally diverge in the real route -- this test pins that invariant
// down so a future edit to either code path can't silently break it, by
// independently reconstructing both a "preview column list" and a "saved
// report item list" the same way backfill.ts does, then checking they agree
// key-for-key.

const TASKS: BackfillTaskInput[] = [
  { id: "task-checked", name: "Checked", responseType: "checkbox", actionLabels: ["Inspected"], sortOrder: 0 },
  { id: "task-soap", name: "Soap", responseType: "checkbox", actionLabels: ["Filled"], sortOrder: 1 },
  {
    id: "task-water",
    name: "Water Source Operating",
    responseType: "checkbox",
    actionLabels: ["Hot", "Cold", "Both"],
    sortOrder: 2
  }
];

function buildPreviewColumns(columns: ReturnType<typeof buildColumns>) {
  return columns.map((c) => ({ key: columnKeyFor(c), taskId: c.taskId, name: c.name, actionLabel: c.actionLabel }));
}

// Mirrors backfill.ts's reportItemRows construction from a GeneratedDay.
function buildSavedReportItems(day: ReturnType<typeof buildManualGeneratedDays>[number]) {
  return day.results.map((result) => ({
    task_name_snapshot: result.name,
    action_label_snapshot: result.actionLabel,
    sort_order: result.sortOrder,
    checked: result.checked
  }));
}

test("preview columns and saved report items agree on every key, name, action label, and sort order", () => {
  const columns = buildColumns(TASKS, "daily");
  const previewColumns = buildPreviewColumns(columns);

  const days = buildManualGeneratedDays({
    uniqueDates: ["2026-06-01"],
    columns,
    taskDatesByColumnKey: new Map([
      [columnKeyFor({ taskId: "task-checked", actionLabel: "Inspected" }), new Set(["2026-06-01"])],
      [columnKeyFor({ taskId: "task-water", actionLabel: "Hot" }), new Set(["2026-06-01"])]
    ]),
    earliestMinutes: 9 * 60,
    latestMinutes: 11 * 60,
    timeZone: "America/Toronto"
  });

  assert.equal(days.length, 1);
  const savedItems = buildSavedReportItems(days[0]);

  assert.equal(previewColumns.length, savedItems.length, "every previewed column must have exactly one saved item");

  // Preview and saved rows are built in the same array order (both derive
  // from `columns` / `day.results` in lockstep), so a straight zip-and-compare
  // is the right check, not a key-based lookup.
  for (let i = 0; i < previewColumns.length; i++) {
    const preview = previewColumns[i];
    const saved = savedItems[i];
    assert.equal(saved.task_name_snapshot, preview.name, `row ${i}: name mismatch`);
    assert.equal(saved.action_label_snapshot, preview.actionLabel, `row ${i}: action label mismatch`);
    assert.equal(saved.sort_order, columns[i].sortOrder, `row ${i}: sort order mismatch`);
  }

  // Spot-check the two dates actually selected above land as checked=true,
  // and everything else on that day is false.
  const checkedKey = columnKeyFor({ taskId: "task-checked", actionLabel: "Inspected" });
  const hotKey = columnKeyFor({ taskId: "task-water", actionLabel: "Hot" });
  const checkedIndex = previewColumns.findIndex((c) => c.key === checkedKey);
  const hotIndex = previewColumns.findIndex((c) => c.key === hotKey);
  assert.equal(savedItems[checkedIndex].checked, true);
  assert.equal(savedItems[hotIndex].checked, true);
  const uncheckedCount = savedItems.filter((r) => !r.checked).length;
  assert.equal(uncheckedCount, savedItems.length - 2);
});

test("columnKeyFor is stable and unique per task+label, independent of column array order", () => {
  const columns = buildColumns(TASKS, "weekly");
  const keys = columns.map((c) => columnKeyFor(c));
  assert.equal(new Set(keys).size, keys.length, "no two columns should share a key");

  // Water Source Operating has 3 labels -- confirms multi-label expansion
  // produces 3 distinct columns, all sharing the same taskId but keyed
  // separately by action label.
  const waterColumns = columns.filter((c) => c.taskId === "task-water");
  assert.equal(waterColumns.length, 3);
  assert.deepEqual(
    waterColumns.map((c) => c.actionLabel),
    ["Hot", "Cold", "Both"]
  );
});
