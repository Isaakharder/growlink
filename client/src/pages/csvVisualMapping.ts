// Pure helpers for the visual CSV mapping tool: selection-state mechanics
// and turning a set of "ignore this row" clicks into stable, reusable
// value-based rules (never raw row coordinates, since rows move between
// exports). Kept independent of React so the selection/inference logic is
// easy to read and reason about on its own.

export const MAPPING_TYPES = [
  "variety",
  "packed_date",
  "lot_number",
  "size_label",
  "size_weight_kg",
  "average_fruit_weight_g",
  "run_number",
  "piece_count",
  "ignore"
] as const;

export type MappingType = (typeof MAPPING_TYPES)[number];

export const MAPPING_TYPE_LABELS: Record<MappingType, string> = {
  variety: "Variety",
  packed_date: "Pack Date",
  lot_number: "Lot Number",
  size_label: "Size Label",
  size_weight_kg: "Size Weight kg",
  average_fruit_weight_g: "Average Fruit Weight g",
  run_number: "Run Number",
  piece_count: "Piece Count",
  ignore: "Ignore"
};

export type MappingColor = { bg: string; border: string; text: string };

export const MAPPING_TYPE_COLORS: Record<MappingType, MappingColor> = {
  variety: { bg: "#eef4ff", border: "#b8d0f7", text: "#1a4a8f" },
  packed_date: { bg: "#f3eefe", border: "#d3c2f7", text: "#6b3fa0" },
  lot_number: { bg: "#e9fbfa", border: "#b6ece7", text: "#0e7c72" },
  size_label: { bg: "#eefaf0", border: "#b8e6cc", text: "#0f7660" },
  size_weight_kg: { bg: "#fff7e6", border: "#f2d39b", text: "#8a6300" },
  average_fruit_weight_g: { bg: "#fdeef3", border: "#f3c3d6", text: "#a03a63" },
  run_number: { bg: "#e7f8fc", border: "#b7e6f2", text: "#0f6f8a" },
  piece_count: { bg: "#f2f0ff", border: "#cfc7f9", text: "#4b3aa8" },
  ignore: { bg: "#f1f2f4", border: "#d7dade", text: "#5b6470" }
};

// ---------------------------------------------------------------------------
// Cell / selection mechanics
// ---------------------------------------------------------------------------

export type CellCoord = { row: number; col: number };
export type CellKey = string;

export function cellKey(row: number, col: number): CellKey {
  return `${row}:${col}`;
}

export function parseCellKey(key: CellKey): CellCoord {
  const [row, col] = key.split(":").map(Number);
  return { row, col };
}

/** Every cell in the rectangle spanning two corners, inclusive. */
export function rectCells(a: CellCoord, b: CellCoord): CellCoord[] {
  const rowStart = Math.min(a.row, b.row);
  const rowEnd = Math.max(a.row, b.row);
  const colStart = Math.min(a.col, b.col);
  const colEnd = Math.max(a.col, b.col);
  const cells: CellCoord[] = [];
  for (let r = rowStart; r <= rowEnd; r += 1) {
    for (let c = colStart; c <= colEnd; c += 1) {
      cells.push({ row: r, col: c });
    }
  }
  return cells;
}

export type SelectionModifier = "replace" | "toggle" | "range";

/**
 * Applies click modifier semantics (plain / ctrl-toggle / shift-range) to a
 * selection set. `anchor` is the last plain/ctrl click, used as the range
 * start for a shift-click.
 */
export function applySelectionModifier(
  current: Set<CellKey>,
  cells: CellCoord[],
  modifier: SelectionModifier
): Set<CellKey> {
  if (modifier === "replace") {
    return new Set(cells.map((c) => cellKey(c.row, c.col)));
  }
  if (modifier === "range") {
    return new Set(cells.map((c) => cellKey(c.row, c.col)));
  }
  // toggle
  const next = new Set(current);
  for (const c of cells) {
    const key = cellKey(c.row, c.col);
    if (next.has(key)) next.delete(key);
    else next.add(key);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Column assignment compilation
// ---------------------------------------------------------------------------

export type ColumnAssignments = Map<number, MappingType>;

/** True when `selectedRows` is exactly the set of data rows for a column (order-independent). */
export function coversAllDataRows(selectedRows: number[], dataRowIndexes: number[]): boolean {
  if (selectedRows.length !== dataRowIndexes.length) return false;
  const dataSet = new Set(dataRowIndexes);
  return selectedRows.every((r) => dataSet.has(r));
}

// ---------------------------------------------------------------------------
// Row-ignore rule inference
// ---------------------------------------------------------------------------

export type InferredIgnoreRule = {
  /** Header text if known, else "Column N" (N is 1-based for display). */
  columnLabel: string;
  columnIndex: number;
  /** Set when the column is also assigned a visible field, so the rule can reference it by field instead of raw position. */
  mappedField: MappingType | null;
  value: string;
  rowIndexes: number[];
};

export type IgnoreInferenceResult = {
  rules: InferredIgnoreRule[];
  /** Rows where no column's value cleanly separates it from every kept row — cannot be safely reproduced. */
  unresolvedRows: number[];
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * For each row the user marked "ignore" (via the row-number gutter), finds
 * a column whose raw value on that row never appears on any *kept* row —
 * a value that safely and stably identifies rows like it on a future
 * export, since row position itself is not stable. Rows that share the
 * same discriminating (column, value) pair collapse into a single rule.
 */
export function inferIgnoreRules(
  ignoredRows: number[],
  keptDataRows: number[],
  grid: string[][],
  columnAssignments: ColumnAssignments,
  headerRow: string[]
): IgnoreInferenceResult {
  const columnCount = headerRow.length;

  const keptValuesByColumn: Array<Set<string>> = [];
  for (let c = 0; c < columnCount; c += 1) {
    const values = new Set<string>();
    for (const r of keptDataRows) {
      const raw = grid[r]?.[c];
      if (raw !== undefined && raw.trim() !== "") values.add(normalize(raw));
    }
    keptValuesByColumn.push(values);
  }

  const resolved = new Map<string, InferredIgnoreRule>(); // key: `${col}:${normalizedValue}`
  const unresolvedRows: number[] = [];

  for (const rowIndex of ignoredRows) {
    let chosenColumn = -1;
    let chosenRawValue = "";

    // Prefer a column that already carries a visible field assignment —
    // produces a more legible rule ("When Size Label is..." instead of
    // "When Column 6 is...") — then fall back to any raw column.
    const columnOrder = [...columnAssignments.keys()].filter((c) => c < columnCount);
    for (const c of [...columnOrder, ...Array.from({ length: columnCount }, (_, i) => i).filter((c) => !columnOrder.includes(c))]) {
      const raw = grid[rowIndex]?.[c];
      if (raw === undefined || raw.trim() === "") continue;
      const norm = normalize(raw);
      if (!keptValuesByColumn[c].has(norm)) {
        chosenColumn = c;
        chosenRawValue = raw.trim();
        break;
      }
    }

    if (chosenColumn === -1) {
      unresolvedRows.push(rowIndex);
      continue;
    }

    const key = `${chosenColumn}:${normalize(chosenRawValue)}`;
    const existing = resolved.get(key);
    if (existing) {
      existing.rowIndexes.push(rowIndex);
    } else {
      resolved.set(key, {
        columnIndex: chosenColumn,
        columnLabel: headerRow[chosenColumn]?.trim() || `Column ${chosenColumn + 1}`,
        mappedField: columnAssignments.get(chosenColumn) ?? null,
        value: chosenRawValue,
        rowIndexes: [rowIndex]
      });
    }
  }

  return { rules: Array.from(resolved.values()), unresolvedRows };
}

export function plainLanguageIgnoreRule(rule: InferredIgnoreRule): string {
  const subject = rule.mappedField && rule.mappedField !== "ignore" ? MAPPING_TYPE_LABELS[rule.mappedField] : rule.columnLabel;
  return `When ${subject} is "${rule.value}," ignore this row.`;
}

// ---------------------------------------------------------------------------
// Duplicate header positions
// ---------------------------------------------------------------------------

export type HeaderOccurrence = {
  /** Trimmed header text ("" for a blank header cell). */
  text: string;
  /** 1-based position among the columns sharing this exact header text. */
  occurrence: number;
  /** How many columns share this header text. */
  total: number;
};

/** Per column, which occurrence of its header text it is — e.g. FlowMaster's second "PCS" is { occurrence: 2, total: 2 }. */
export function describeHeaderOccurrences(headerRow: string[]): HeaderOccurrence[] {
  const normalized = headerRow.map((h) => normalize(h ?? ""));
  const totals = new Map<string, number>();
  for (const key of normalized) totals.set(key, (totals.get(key) ?? 0) + 1);

  const seen = new Map<string, number>();
  return headerRow.map((h, i) => {
    const key = normalized[i];
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { text: (h ?? "").trim(), occurrence, total: totals.get(key) ?? 1 };
  });
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

const FRUIT_FIELDS: MappingType[] = ["average_fruit_weight_g", "piece_count"];

/**
 * Positional rule for files that repeat a WEIGHT/AVG/PCS header group (a
 * FlowMaster export has a per-size group then a lot-total group): Average
 * Fruit Weight and Piece Count must come from the same occurrence of their
 * repeated header as Size Weight kg does. Returns one message per field
 * that was taken from a different group; empty when the headers aren't
 * repeated or the mapping is consistent.
 */
export function findDuplicateGroupMismatches(headerRow: string[], assignments: ColumnAssignments): string[] {
  const occurrences = describeHeaderOccurrences(headerRow);
  const columnFor = (field: MappingType): number | undefined => {
    const matches = [...assignments.entries()].filter(([, f]) => f === field).map(([c]) => c);
    return matches.length > 0 ? Math.min(...matches) : undefined;
  };

  const weightColumn = columnFor("size_weight_kg");
  if (weightColumn === undefined) return [];
  const weight = occurrences[weightColumn];
  if (!weight || weight.total < 2) return [];

  const messages: string[] = [];
  for (const field of FRUIT_FIELDS) {
    const column = columnFor(field);
    if (column === undefined) continue;
    const info = occurrences[column];
    if (!info || info.total < 2 || info.occurrence === weight.occurrence) continue;
    messages.push(
      `${MAPPING_TYPE_LABELS[field]} uses the ${ordinal(info.occurrence)} "${info.text}" column, but Size Weight kg uses the ` +
        `${ordinal(weight.occurrence)} "${weight.text}" column. Map it from the same repeated group as Size Weight kg — ` +
        `a later group usually holds lot totals, which gives a wrong average fruit weight.`
    );
  }
  return messages;
}
