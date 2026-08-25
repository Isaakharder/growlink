// Shared types for the generic, organization-configurable CSV Import
// Template Builder. Deliberately independent of flowMasterCsvParser.ts /
// flowMasterSizeRules.ts — those stay pinned to the FlowMaster-specific
// pipeline; this is the new, vendor-agnostic mapping system.

export const MAPPED_FIELDS = [
  "variety",
  "packed_date",
  "year",
  "week",
  "lot_number",
  "run_number",
  "market_grade",
  "size_label",
  "size_weight_kg",
  "average_fruit_weight_g",
  "piece_count",
  "waste_kg",
  "total_lot_weight",
  "ignore",
  "custom"
] as const;

export type MappedField = (typeof MAPPED_FIELDS)[number];

export const DATE_FORMATS = [
  "DDMMYYYY",
  "YYYYMMDD",
  "MMDDYYYY",
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "CUSTOM"
] as const;

export type DateFormat = (typeof DATE_FORMATS)[number];

export type BlankNumberHandling = "zero" | "skip" | "error";

export type NumberFormatConfig = {
  decimalSeparator: "." | ",";
  thousandsSeparator: "" | "," | "." | " ";
  /** Multiplies the parsed value, e.g. lbs->kg = 0.45359237. Omit/1 for no conversion. */
  unitConversionFactor?: number;
  blankHandling: BlankNumberHandling;
};

export type ColumnMapping = {
  columnIndex: number;
  field: MappedField;
  dateFormat?: DateFormat;
  /** Only used when dateFormat === "CUSTOM": a literal pattern using D/M/Y tokens and separators, e.g. "DD.MM.YYYY". Never evaluated as code. */
  customDatePattern?: string;
  numberFormat?: NumberFormatConfig;
  /** Only used when field === "custom": a user-facing label for this otherwise-unmapped column. */
  customLabel?: string;
};

export type FixedCellMapping = {
  rowIndex: number;
  columnIndex: number;
  field: MappedField;
  dateFormat?: DateFormat;
  customDatePattern?: string;
  numberFormat?: NumberFormatConfig;
  customLabel?: string;
};

export type ValueMappingAction =
  | "map"
  | "create"
  | "ignore"
  | "distribute"
  | "subtotal"
  | "use_other_field"
  | "unresolved";

export type ValueMapping = {
  /** Which mapped field's raw values this entry resolves. */
  sourceField: "size_label" | "market_grade";
  /** Normalized (trimmed) raw text this mapping applies to. */
  rawValue: string;
  action: ValueMappingAction;
  /** action === "map": id of an existing yield_sizes row. */
  targetSizeId?: string;
  /** action === "create": name for a new yield_sizes row (created on save). */
  newSizeName?: string;
  /** action === "distribute": destination yield_sizes ids, in priority order (last gets any rounding residual). */
  distributeSizeIds?: string[];
  /** action === "use_other_field": column index whose value should be used as the size label instead. */
  useFieldColumnIndex?: number;
};

export type RuleOperator = "equals" | "not_equals" | "contains" | "is_blank" | "is_not_blank";

export type RuleCondition = {
  /** Condition on an already-mapped field's resolved value. Exactly one of `field`/`columnIndex` is set. */
  field?: MappedField;
  /**
   * Condition on a raw grid column's value directly, with no field mapping
   * required. Lets the visual mapping tool key a rule off a column (e.g.
   * FlowMaster's MARKET) that was never assigned one of the user-facing
   * mapped-field types.
   */
  columnIndex?: number;
  operator: RuleOperator;
  /** Not required for is_blank / is_not_blank. */
  value?: string;
};

export type RuleAction = "map_to_size" | "ignore" | "distribute" | "treat_as_subtotal";

export type ConditionalRowRule = {
  id: string;
  /** Lower runs first; first matching rule wins. */
  priority: number;
  conditions: RuleCondition[];
  conditionLogic: "AND" | "OR";
  action: RuleAction;
  targetSizeId?: string;
  distributeSizeIds?: string[];
};

export type BlankRowBehavior = "skip" | "stop";

export type TemplateLayoutConfig = {
  delimiter: string;
  encoding: string;
  headerRowIndex: number;
  dataStartRowIndex: number;
  dataEndRowIndex: number | null;
  skipRowIndexes: number[];
  blankRowBehavior: BlankRowBehavior;
};

export type TemplateConfig = TemplateLayoutConfig & {
  columnMappings: ColumnMapping[];
  fixedCellMappings: FixedCellMapping[];
  valueMappings: ValueMapping[];
  rules: ConditionalRowRule[];
};

// ---- Grid parsing ----

export type CsvGridParseResult = {
  rows: string[][];
  rowCount: number;
  columnCount: number;
  delimiter: string;
  encoding: string;
  hadBom: boolean;
};

// ---- Fingerprint ----

export type TemplateFingerprint = {
  delimiter: string;
  headerRowIndex: number;
  headers: string[];
  columnCount: number;
};

export type FingerprintMatchKind = "exact" | "close" | "none";

// ---- Normalized preview / reconciliation ----

export type NormalizedRowAction = "included" | "ignored" | "subtotal" | "unresolved";

export type NormalizedRow = {
  rowIndex: number;
  action: NormalizedRowAction;
  sizeLabelRaw: string | null;
  marketGradeRaw: string | null;
  sizeWeightKg: number | null;
  pieceCount: number | null;
  averageFruitWeightG: number | null;
  matchedRuleId: string | null;
  resolvedSizeName: string | null;
  parseErrors: string[];
};

export type RowGroupReconciliation = {
  rawRowWeightKg: number;
  recognizedSizeKg: number;
  directMappedKg: number;
  distributedKg: number;
  ignoredKg: number;
  unresolvedKg: number;
  subtotalKg: number;
  lotTotalKg: number | null;
  difference: number | null;
  unexplainedDifference: boolean;
};

export type NormalizedGroup = {
  groupKey: string;
  varietyRaw: string | null;
  packedDate: string | null;
  isoYear: number | null;
  isoWeek: number | null;
  lotNumber: string | null;
  runNumber: string | null;
  sizeKg: Record<string, number>;
  unresolvedSizeLabels: string[];
  wasteKg: number;
  pieceCount: number;
  averageFruitWeightG: number | null;
  totalLotWeightKg: number | null;
  reconciliation: RowGroupReconciliation;
  rows: NormalizedRow[];
};

export type ValidationIssueCode =
  | "packed_date_unresolved"
  | "variety_unresolved"
  | "size_weight_not_mapped"
  | "unresolved_size_label"
  | "invalid_numeric_value"
  | "recognized_kg_zero"
  | "duplicate_raw_kg"
  | "subtotal_and_components_both_included"
  | "layout_mismatch"
  | "unexplained_reconciliation_difference"
  | "possible_duplicate_weight_source";

export type ValidationIssue = {
  code: ValidationIssueCode;
  message: string;
  groupKey?: string;
  rowIndex?: number;
};

export type NormalizedPreview = {
  groups: NormalizedGroup[];
  validationIssues: ValidationIssue[];
  canImport: boolean;
};
