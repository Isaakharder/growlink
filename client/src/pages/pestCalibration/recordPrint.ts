// Shared between RecordDetailModal.tsx (on-screen, read-only detail view)
// and DeviceHistoryModal.tsx (batch print of every currently-filtered
// record — see calibrationPrintMode.ts and PrintRecord.tsx). Pure
// formatting/grouping logic only; no JSX lives here so both consumers can
// share it without pulling print-only markup into the on-screen viewer.

export type AnswerRow = {
  id: string;
  task_id: string | null;
  task_name_snapshot: string;
  task_sort_order: number;
  field_label_snapshot: string;
  field_type_snapshot: string;
  unit_snapshot: string | null;
  choice_options_snapshot: string[] | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_choices: string[] | null;
  is_within_range: boolean | null;
};

export type RepeatingRow = {
  id: string;
  task_id: string | null;
  task_name_snapshot: string;
  task_sort_order: number;
  row_index: number;
  answers: AnswerRow[];
};

export type FrequencySnapshot = {
  frequency_type: string;
  custom_interval_value: number | null;
  custom_interval_unit: string | null;
};

export type RecordDetail = {
  id: string;
  device_name_snapshot: string;
  device_identification_number_snapshot: string | null;
  device_area_snapshot: string | null;
  device_frequency_snapshot: FrequencySnapshot;
  instructions_snapshot: string | null;
  completed_by_name: string;
  completed_at: string;
  effective_date: string;
  next_due_at: string | null;
  answers: AnswerRow[];
  repeating_rows: RepeatingRow[];
};

export function formatAnswer(answer: AnswerRow): string {
  switch (answer.field_type_snapshot) {
    case "checkbox":
      return answer.value_choices && answer.value_choices.length > 0 ? answer.value_choices.join(", ") : "—";
    case "pass_fail": {
      if (answer.value_boolean === null) return "—";
      const [passLabel, failLabel] = [answer.choice_options_snapshot?.[0] ?? "Pass", answer.choice_options_snapshot?.[1] ?? "Fail"];
      return answer.value_boolean ? passLabel : failLabel;
    }
    case "number":
      return answer.value_number !== null
        ? `${answer.value_number}${answer.unit_snapshot ? ` ${answer.unit_snapshot}` : ""}${answer.is_within_range === false ? " (out of range)" : ""}`
        : "—";
    case "date":
      return answer.value_date ? formatEffectiveDate(answer.value_date) : "—";
    default:
      return answer.value_text ?? "—";
  }
}

// Formats a "YYYY-MM-DD" calendar label without any timezone conversion of
// the label itself — builds the instant at UTC noon on that date and reads
// it back pinned to UTC, so it always prints the same date regardless of
// the viewing device's local timezone.
export function formatEffectiveDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return instant.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// "YYYY-MM-DD" for the calendar date completed_at reads as in the org
// timezone — used only to decide whether the performed date differs from
// the entered date (never to derive an authoritative value; the server's
// effective_date column is always the source of truth for "performed on").
export function completedAtDateInOrgTimezone(completedAtIso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(completedAtIso));
}

// A record can have several non-repeating tasks (Nozzle 1, Nozzle 2,
// Pressure...), each with its own set of fields — group flat answers back
// under their originating task so the detail view mirrors the builder,
// not one undifferentiated table. Falls back to the name when task_id is
// null (the task was later deleted). Relies on the API's
// .order("task_sort_order").order("sort_order") to keep both the task
// grouping and each task's field order stable.
export function groupAnswersByTask(answers: AnswerRow[]): [string, AnswerRow[]][] {
  const byTask = new Map<string, AnswerRow[]>();
  for (const answer of answers) {
    const key = answer.task_id ?? `label:${answer.task_name_snapshot}`;
    const existing = byTask.get(key);
    if (existing) existing.push(answer);
    else byTask.set(key, [answer]);
  }
  return [...byTask.entries()];
}

// Same idea for repeating tasks — a record can have more than one (e.g.
// Nozzle Measurements AND a separate repeating task), so grouping must key
// off the actual task, not assume there's only ever one.
export function groupRepeatingRowsByTask(rows: RepeatingRow[]): [string, RepeatingRow[]][] {
  const byTask = new Map<string, RepeatingRow[]>();
  for (const row of rows) {
    const key = row.task_id ?? `label:${row.task_name_snapshot}`;
    const existing = byTask.get(key);
    if (existing) existing.push(row);
    else byTask.set(key, [row]);
  }
  return [...byTask.entries()];
}

export type PrintFieldRow = { label: string; value: string };
export type PrintSection = {
  key: string;
  taskName: string;
  taskSortOrder: number;
  rows: PrintFieldRow[];
  // Print-only cosmetic overrides — never affect the on-screen
  // RecordDetailModal view (which uses groupAnswersByTask/formatAnswer
  // directly, not this function).
  fieldColumnLabel: string;
  answerColumnLabel: string;
  showHeader: boolean;
};

// Identifies a section by what its ROWS actually are (every field literally
// labeled "Nozzle 1", "Nozzle 2", ...), not by matching "nozzle" against the
// task's own name — a task-name match would also catch something like "Did
// all nozzles pass" (a pass/fail summary that merely mentions nozzles, not
// a per-nozzle measurement list), mislabeling its header too.
function isNozzleMeasurementSection(rows: PrintFieldRow[]): boolean {
  return rows.length > 0 && rows.every((r) => /^Nozzle \d+$/i.test(r.label));
}

function isPressureSection(taskName: string): boolean {
  return taskName.trim().toLowerCase() === "pressure";
}

// A Nozzle section's fields are configured as plain short_text (not
// Number+unit "mL"), so there's no unit snapshot to print alongside the
// value — this appends " mL" for print display only, and only to values
// that are still a bare number (never double-appends onto an answer that
// already carries its own unit or isn't numeric, e.g. "—").
function withNozzleUnit(value: string): string {
  return /^-?\d+(\.\d+)?$/.test(value) ? `${value} mL` : value;
}

// One "Field | Answer" section per task, in configured task order. A
// repeating task whose rows each have exactly one field prints as
// "Row N | value"; a repeating task with several fields per row prints as
// "Row N — Field | value" for each field, preserving both row order and
// each row's own field order.
export function buildPrintSections(record: RecordDetail): PrintSection[] {
  const sections = new Map<string, PrintSection>();

  for (const [key, answers] of groupAnswersByTask(record.answers)) {
    sections.set(key, {
      key,
      taskName: answers[0].task_name_snapshot,
      taskSortOrder: answers[0].task_sort_order,
      rows: answers.map((a) => ({ label: a.field_label_snapshot, value: formatAnswer(a) })),
      fieldColumnLabel: "Field",
      answerColumnLabel: "Answer",
      showHeader: true
    });
  }

  for (const [key, rows] of groupRepeatingRowsByTask(record.repeating_rows)) {
    const singleField = rows[0].answers.length === 1;
    const printRows: PrintFieldRow[] = [];
    for (const row of rows) {
      if (singleField) {
        printRows.push({ label: `Row ${row.row_index + 1}`, value: row.answers[0] ? formatAnswer(row.answers[0]) : "—" });
      } else {
        for (const answer of row.answers) {
          printRows.push({ label: `Row ${row.row_index + 1} — ${answer.field_label_snapshot}`, value: formatAnswer(answer) });
        }
      }
    }
    sections.set(key, {
      key,
      taskName: rows[0].task_name_snapshot,
      taskSortOrder: rows[0].task_sort_order,
      rows: printRows,
      fieldColumnLabel: "Field",
      answerColumnLabel: "Answer",
      showHeader: true
    });
  }

  for (const section of sections.values()) {
    if (isNozzleMeasurementSection(section.rows)) {
      section.fieldColumnLabel = "Nozzles";
      section.answerColumnLabel = "Volume";
      section.rows = section.rows.map((r) => ({ ...r, value: withNozzleUnit(r.value) }));
    }
    if (isPressureSection(section.taskName)) {
      section.showHeader = false;
    }
  }

  return [...sections.values()].sort((a, b) => a.taskSortOrder - b.taskSortOrder);
}

// Structural rule (not a device-name check — never "Scale" vs. "Sprayer")
// for whether a batch-printed record is short enough to keep intact on one
// page (allowing another record to share the page underneath it) versus
// long enough that it needs to be free to paginate internally. Based on
// total answer-row count across every section, since that's what actually
// determines how tall the record renders — a device with few flat fields
// (e.g. a 3-row Scale record) counts as compact regardless of what it's
// named; a device with many rows (e.g. 28 nozzle measurements) does not,
// regardless of its name either.
const COMPACT_RECORD_MAX_ROWS = 10;

export function isCompactRecord(sections: PrintSection[]): boolean {
  const totalRows = sections.reduce((sum, section) => sum + section.rows.length, 0);
  return totalRows <= COMPACT_RECORD_MAX_ROWS;
}

// Structural rule (not a device-name check — never "Sprayer" vs. anything
// else) for whether a record has enough answer rows that a single-column
// layout would spill onto a second page, and so should instead use the
// two-column compact-long-record layout. Deliberately a much higher
// threshold than isCompactRecord's — a record can be "not compact enough
// to safely share a page with another record" (>10 rows) without yet being
// "long enough to need two columns" (>=20 rows); that middle range just
// uses the normal single-column layout on its own page.
const LONG_RECORD_MIN_ROWS = 20;

export function needsCompactLongLayout(sections: PrintSection[]): boolean {
  const totalRows = sections.reduce((sum, section) => sum + section.rows.length, 0);
  return totalRows >= LONG_RECORD_MIN_ROWS;
}

// Splits sections into two columns for the compact-long-record layout,
// preserving each column's internal task order and never splitting a
// single task's rows across columns. Picks whichever contiguous split
// point (after task 1, after task 2, ...) leaves the two columns' row
// totals as close to equal as possible — a generic balancing rule that
// happens to put Pressure+Side Nozzles in one column and Straight
// Nozzles+"Did all nozzles pass" in the other for the real Sprayer
// devices (15/15), without hardcoding those task names anywhere.
export function splitSectionsForCompactLayout(sections: PrintSection[]): [PrintSection[], PrintSection[]] {
  if (sections.length <= 1) return [sections, []];

  const rowCounts = sections.map((s) => s.rows.length);
  const total = rowCounts.reduce((a, b) => a + b, 0);

  let bestSplit = 1;
  let bestDiff = Infinity;
  let runningLeft = 0;
  for (let i = 1; i < sections.length; i++) {
    runningLeft += rowCounts[i - 1];
    const diff = Math.abs(runningLeft - (total - runningLeft));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = i;
    }
  }

  return [sections.slice(0, bestSplit), sections.slice(bestSplit)];
}
