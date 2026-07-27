export type ReportRow = {
  id: string;
  completed_at: string;
  completed_by_name: string;
  completed_by_initials: string;
};

export type ReportItemRow = {
  report_id: string;
  task_name_snapshot: string;
  action_label_snapshot: string | null;
  response_type_snapshot: string;
  response_value: string | null;
  sort_order: number;
};

export type TaskRow = {
  name: string;
  sort_order: number;
  action_labels: string[] | null;
};

export type TaskColumn = {
  key: string;
  label: string;
};

// What a report table cell (screen or print) should render for one item.
// `display` is the exact, final text -- both renderers show it verbatim, so
// screen and print can never disagree on formatting. `isCheckmark` exists
// only so a checked checkbox can get checkmark-specific styling (color/size)
// without the renderer needing to re-derive "is this a checkmark" from the
// display string's content.
export type TaskCellValue = {
  display: string;
  isCheckmark: boolean;
};

export type ReportWithValues = {
  id: string;
  completedAt: string;
  completedByName: string;
  completedByInitials: string;
  taskValues: Record<string, TaskCellValue>;
};

type ColumnDef = {
  key: string;
  label: string;
  name: string;
  actionLabel: string | null;
  isCurrent: boolean;
  currentSortOrder: number;
  labelOrderInCurrent: number;
  discoveryIndex: number;
};

export function isItemChecked(item: ReportItemRow): boolean {
  if (item.response_type_snapshot === "checkbox") return item.response_value === "true";
  return item.response_value !== null && item.response_value.trim() !== "";
}

// The single source of truth for "what does this saved answer look like in a
// report cell" -- used to build both the on-screen report table and the
// printed report, so the two can never drift apart. A checkbox still renders
// as a checkmark (or blank); every other response type renders its actual
// stored text/number verbatim, blank only when nothing was ever saved.
// response_type_snapshot defaults to 'checkbox' for items created before
// response types existed (migration 0087), so pre-existing historical rows
// keep rendering exactly as they always have -- nothing here reinterprets
// stored data, it only stops discarding it.
export function formatTaskCellValue(item: ReportItemRow): TaskCellValue {
  const value = item.response_value;

  if (item.response_type_snapshot === "checkbox") {
    return value === "true" ? { display: "✓", isCheckmark: true } : { display: "", isCheckmark: false };
  }

  if (value === null || value.trim() === "") {
    return { display: "", isCheckmark: false };
  }

  // number / short_text / long_text / any future type: the raw saved value,
  // untouched -- including a numeric "0", and including internal line breaks
  // or spacing a long-text answer may contain.
  return { display: value, isCheckmark: false };
}

// One of three independent "expand tasks into columns" implementations in
// the Food Safety module (see backfillGeneration.ts's buildColumns for the
// full picture) -- this one is the odd one out by necessity: it builds
// columns from HISTORICAL REPORT SNAPSHOTS (task_name_snapshot /
// action_label_snapshot on food_safety_cleaning_report_items), not live
// tasks, because a report must stay displayable even after its task was
// renamed, reconfigured, or deleted entirely from the location's current
// config. There is no stable task ID to key columns by (a deleted task has
// none), so columns are discovered from the data itself and keyed
// sequentially (`col_0`, `col_1`, ...) via columnKeyFor below -- these keys
// are only ever compared within one response and carry no meaning across
// requests or against backfillGeneration.ts's `taskId::actionLabel` keys.
// Do not assume the two key formats are interchangeable.
//
// Builds the task-column set and per-report cell values from whatever
// reports + items are handed in — the caller (the /food-safety/reports
// route) is responsible for fetching items scoped to exactly the report IDs
// it passes here. Column identity is derived only from the given items, so
// this function makes no assumption about whether `reports` is a date-filtered
// subset or the full recent set; a report's taskValues depend only on that
// report's own items, never on which other reports happened to be included.
export function buildTaskColumnsAndValues(
  reports: ReportRow[],
  items: ReportItemRow[],
  tasks: TaskRow[]
): { taskColumns: TaskColumn[]; reports: ReportWithValues[] } {
  const itemsByReport = new Map<string, ReportItemRow[]>();
  for (const item of items) {
    const list = itemsByReport.get(item.report_id) ?? [];
    list.push(item);
    itemsByReport.set(item.report_id, list);
  }

  // A task name has multiple columns only if more than one distinct action
  // label was ever recorded for it (a multi-checkbox task) — single-checkbox
  // and non-checkbox tasks keep one plain column.
  const labelsByName = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.action_label_snapshot) continue;
    const set = labelsByName.get(item.task_name_snapshot) ?? new Set<string>();
    set.add(item.action_label_snapshot);
    labelsByName.set(item.task_name_snapshot, set);
  }

  const currentTaskByName = new Map<string, { sortOrder: number; actionLabels: string[] }>();
  for (const task of tasks) {
    currentTaskByName.set(task.name, { sortOrder: task.sort_order, actionLabels: task.action_labels ?? [] });
  }

  const columnDefs = new Map<string, ColumnDef>();
  let nextColumnIndex = 0;
  let nextDiscoveryIndex = 0;

  function columnKeyFor(item: ReportItemRow): string {
    const isMulti = (labelsByName.get(item.task_name_snapshot)?.size ?? 0) > 1;
    const actionLabel = isMulti ? item.action_label_snapshot : null;
    const dedupeKey = `${item.task_name_snapshot} ${actionLabel ?? ""}`;

    const existing = columnDefs.get(dedupeKey);
    if (existing) return existing.key;

    const current = currentTaskByName.get(item.task_name_snapshot);
    const labelOrderInCurrent = current && actionLabel ? current.actionLabels.indexOf(actionLabel) : 0;

    const def: ColumnDef = {
      key: `col_${nextColumnIndex++}`,
      label: actionLabel ? `${item.task_name_snapshot} — ${actionLabel}` : item.task_name_snapshot,
      name: item.task_name_snapshot,
      actionLabel,
      isCurrent: !!current,
      currentSortOrder: current?.sortOrder ?? 0,
      labelOrderInCurrent: labelOrderInCurrent >= 0 ? labelOrderInCurrent : 0,
      discoveryIndex: nextDiscoveryIndex++
    };
    columnDefs.set(dedupeKey, def);
    return def.key;
  }

  // Walk newest-first so historical-only (no-longer-configured) columns land
  // in a sensible discovery order.
  for (const report of reports) {
    const reportItems = (itemsByReport.get(report.id) ?? []).sort((a, b) => a.sort_order - b.sort_order);
    for (const item of reportItems) {
      columnKeyFor(item);
    }
  }

  const orderedColumns = Array.from(columnDefs.values()).sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isCurrent) {
      if (a.currentSortOrder !== b.currentSortOrder) return a.currentSortOrder - b.currentSortOrder;
      return a.labelOrderInCurrent - b.labelOrderInCurrent;
    }
    return a.discoveryIndex - b.discoveryIndex;
  });

  return {
    taskColumns: orderedColumns.map((column) => ({ key: column.key, label: column.label })),
    reports: reports.map((r) => {
      const taskValues: Record<string, TaskCellValue> = {};
      for (const item of itemsByReport.get(r.id) ?? []) {
        taskValues[columnKeyFor(item)] = formatTaskCellValue(item);
      }
      return {
        id: r.id,
        completedAt: r.completed_at,
        completedByName: r.completed_by_name,
        completedByInitials: r.completed_by_initials,
        taskValues
      };
    })
  };
}
