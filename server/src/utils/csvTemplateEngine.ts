// Mapping + normalization engine for the CSV Import Template Builder.
// Turns a parsed grid (csvGridParser.ts) plus a saved/draft TemplateConfig
// into a NormalizedPreview: per-lot/report-unit size breakdowns, a full
// reconciliation of every kg, and a blocking validation-issues list. Pure
// and DB-agnostic — the caller (route layer) resolves variety/size ids
// against the organization's actual records and passes in only what's
// needed (a size-id -> name lookup and the set of already-imported lot
// numbers) so this file stays fully unit-testable without Supabase.
import type {
  ColumnMapping,
  ConditionalRowRule,
  FixedCellMapping,
  MappedField,
  NormalizedGroup,
  NormalizedPreview,
  NormalizedRow,
  NormalizedRowAction,
  NumberFormatConfig,
  RowGroupReconciliation,
  RuleCondition,
  TemplateConfig,
  ValidationIssue,
  ValueMapping,
  DateFormat
} from "./csvTemplateTypes";

// ---------------------------------------------------------------------------
// Date parsing — token-based, never regex-from-user-input / never eval'd.
// ---------------------------------------------------------------------------

const NAMED_DATE_PATTERNS: Record<Exclude<DateFormat, "CUSTOM">, string> = {
  DDMMYYYY: "DDMMYYYY",
  YYYYMMDD: "YYYYMMDD",
  MMDDYYYY: "MMDDYYYY",
  "YYYY-MM-DD": "YYYY-MM-DD",
  "DD/MM/YYYY": "DD/MM/YYYY",
  "MM/DD/YYYY": "MM/DD/YYYY"
};

function extractDateParts(raw: string, pattern: string): { day: number; month: number; year: number } | null {
  if (raw.length !== pattern.length) return null;

  let day = "";
  let month = "";
  let year = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i];
    const c = raw[i];

    if (p === "D") {
      if (!/[0-9]/.test(c)) return null;
      day += c;
    } else if (p === "M") {
      if (!/[0-9]/.test(c)) return null;
      month += c;
    } else if (p === "Y") {
      if (!/[0-9]/.test(c)) return null;
      year += c;
    } else if (c !== p) {
      return null;
    }
  }

  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return { day: d, month: m, year: y };
}

/** Parses `raw` per the given named format (or `customPattern` D/M/Y token pattern for "CUSTOM") into an ISO yyyy-mm-dd string, validating it's a real calendar date. */
export function parseDateValue(raw: string, format: DateFormat, customPattern?: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  const pattern = format === "CUSTOM" ? customPattern : NAMED_DATE_PATTERNS[format];
  if (!pattern) return null;

  const parts = extractDateParts(cleaned, pattern);
  if (!parts) return null;

  const { day, month, year } = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** ISO 8601 week/year for an ISO yyyy-mm-dd date string. */
export function getIsoWeekYear(isoDate: string): { isoYear: number; isoWeek: number } | null {
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
  const [y, m, d] = parts;

  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);

  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);

  const isoWeek = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { isoYear: date.getUTCFullYear(), isoWeek };
}

// ---------------------------------------------------------------------------
// Numeric parsing — decimal/thousands separators, unit conversion, blanks.
// ---------------------------------------------------------------------------

/** `missing` marks a literal "null" token: the source says the value is absent. It is never read as zero, whatever the blank-handling setting. */
export type NumberParseResult = { value: number | null; error: string | null; missing?: boolean };

/** Exporters such as FlowMaster write the literal text null (quoted or not — the grid parser strips quotes) for a value they don't have. */
export function isNullToken(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "null";
}

export function parseNumberValue(raw: string, config: NumberFormatConfig): NumberParseResult {
  const cleaned = raw.trim();

  if (isNullToken(cleaned)) return { value: null, error: null, missing: true };

  if (!cleaned) {
    if (config.blankHandling === "zero") return { value: 0, error: null };
    if (config.blankHandling === "skip") return { value: null, error: null };
    return { value: null, error: "blank numeric value is not allowed" };
  }

  let normalized = cleaned;
  if (config.thousandsSeparator) {
    normalized = normalized.split(config.thousandsSeparator).join("");
  }
  if (config.decimalSeparator === ",") {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `could not parse numeric value "${raw}"` };
  }

  const converted = config.unitConversionFactor ? parsed * config.unitConversionFactor : parsed;
  return { value: converted, error: null };
}

const DEFAULT_NUMBER_FORMAT: NumberFormatConfig = {
  decimalSeparator: ".",
  thousandsSeparator: "",
  blankHandling: "zero"
};

// ---------------------------------------------------------------------------
// Distribution rounding — proportional split, residual on the last
// destination, exactly preserving the source total. Independently
// reimplemented (not imported) from flowMasterSizeRules.ts's algorithm so
// that file's pinned test suite is never put at risk by this engine.
// ---------------------------------------------------------------------------

export function distributeKgAcrossSizes(
  totalKg: number,
  destinationSizeNames: string[],
  weightBasis: Record<string, number>
): Record<string, number> {
  if (destinationSizeNames.length === 0) return {};

  const weights = destinationSizeNames.map((name) => weightBasis[name] ?? 0);
  const weightSum = weights.reduce((sum, w) => sum + w, 0);

  const shares =
    weightSum > 0
      ? weights.map((w) => (w / weightSum) * totalKg)
      : destinationSizeNames.map(() => totalKg / destinationSizeNames.length);

  const rounded = shares.map((s) => Math.round(s * 100) / 100);
  const roundedSum = rounded.reduce((sum, v) => sum + v, 0);
  const residual = Math.round((totalKg - roundedSum) * 100) / 100;
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + residual) * 100) / 100;

  const result: Record<string, number> = {};
  destinationSizeNames.forEach((name, i) => {
    result[name] = (result[name] ?? 0) + rounded[i];
  });

  return result;
}

// ---------------------------------------------------------------------------
// Row value resolution
// ---------------------------------------------------------------------------

type ResolvedRowValues = Partial<Record<MappedField, string | null>>;

function findColumnMapping(mappings: ColumnMapping[], field: MappedField): ColumnMapping | undefined {
  return mappings.find((m) => m.field === field);
}

function findFixedCellMapping(mappings: FixedCellMapping[], field: MappedField): FixedCellMapping | undefined {
  return mappings.find((m) => m.field === field);
}

/** Resolves the raw (unparsed) string value of `field` for `rowIndex`, preferring a fixed-cell mapping over a column mapping. */
function resolveRawFieldValue(
  grid: string[][],
  rowIndex: number,
  field: MappedField,
  template: TemplateConfig
): string | null {
  const fixed = findFixedCellMapping(template.fixedCellMappings, field);
  if (fixed) {
    return grid[fixed.rowIndex]?.[fixed.columnIndex] ?? null;
  }

  const column = findColumnMapping(template.columnMappings, field);
  if (column) {
    return grid[rowIndex]?.[column.columnIndex] ?? null;
  }

  return null;
}

function resolveAllRowValues(grid: string[][], rowIndex: number, template: TemplateConfig): ResolvedRowValues {
  const values: ResolvedRowValues = {};
  const fields = new Set<MappedField>([
    ...template.columnMappings.map((m) => m.field),
    ...template.fixedCellMappings.map((m) => m.field)
  ]);

  for (const field of fields) {
    values[field] = resolveRawFieldValue(grid, rowIndex, field, template);
  }

  return values;
}

function getMappingFormat(template: TemplateConfig, field: MappedField): ColumnMapping | FixedCellMapping | undefined {
  return findFixedCellMapping(template.fixedCellMappings, field) ?? findColumnMapping(template.columnMappings, field);
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(condition: RuleCondition, rowValues: ResolvedRowValues, grid: string[][], rowIndex: number): boolean {
  const raw =
    condition.columnIndex !== undefined
      ? grid[rowIndex]?.[condition.columnIndex] ?? null
      : condition.field !== undefined
        ? (rowValues[condition.field] ?? null)
        : null;

  switch (condition.operator) {
    case "is_blank":
      return raw === null || raw.trim() === "";
    case "is_not_blank":
      return raw !== null && raw.trim() !== "";
    case "equals":
      return (raw ?? "").trim().toLowerCase() === (condition.value ?? "").trim().toLowerCase();
    case "not_equals":
      return (raw ?? "").trim().toLowerCase() !== (condition.value ?? "").trim().toLowerCase();
    case "contains":
      return (raw ?? "").toLowerCase().includes((condition.value ?? "").toLowerCase());
    default:
      return false;
  }
}

function evaluateRule(rule: ConditionalRowRule, rowValues: ResolvedRowValues, grid: string[][], rowIndex: number): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditionLogic === "AND"
    ? rule.conditions.every((c) => evaluateCondition(c, rowValues, grid, rowIndex))
    : rule.conditions.some((c) => evaluateCondition(c, rowValues, grid, rowIndex));
}

function normalizeValueKey(raw: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

function findValueMapping(
  valueMappings: ValueMapping[],
  sourceField: "size_label" | "market_grade",
  rawValue: string | null
): ValueMapping | undefined {
  const key = normalizeValueKey(rawValue);
  if (!key) return undefined;
  return valueMappings.find((v) => v.sourceField === sourceField && normalizeValueKey(v.rawValue) === key);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type EngineContext = {
  /** yield_sizes id -> display name, for resolving map/create/distribute/rule targets. */
  sizeNameById: Map<string, string>;
  /** Lot numbers already present in yield_import_runs for this org, for duplicate-import detection. */
  alreadyImportedLotNumbers: Set<string>;
};

type RowClassification = {
  action: NormalizedRowAction;
  matchedRuleId: string | null;
  targetSizeName: string | null;
  distributeSizeNames: string[] | null;
};

function resolveTargetSizeName(id: string | undefined, context: EngineContext): string | null {
  if (!id) return null;
  return context.sizeNameById.get(id) ?? null;
}

function classifyRow(
  rowValues: ResolvedRowValues,
  template: TemplateConfig,
  context: EngineContext,
  grid: string[][],
  rowIndex: number
): RowClassification {
  const sortedRules = [...template.rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    if (!evaluateRule(rule, rowValues, grid, rowIndex)) continue;

    switch (rule.action) {
      case "ignore":
        return { action: "ignored", matchedRuleId: rule.id, targetSizeName: null, distributeSizeNames: null };
      case "treat_as_subtotal":
        return { action: "subtotal", matchedRuleId: rule.id, targetSizeName: null, distributeSizeNames: null };
      case "map_to_size":
        return {
          action: "included",
          matchedRuleId: rule.id,
          targetSizeName: resolveTargetSizeName(rule.targetSizeId, context),
          distributeSizeNames: null
        };
      case "distribute":
        return {
          action: "included",
          matchedRuleId: rule.id,
          targetSizeName: null,
          distributeSizeNames: (rule.distributeSizeIds ?? []).map((id) => resolveTargetSizeName(id, context)).filter((n): n is string => !!n)
        };
      default:
        break;
    }
  }

  // No rule matched — fall back to value mappings. Market/grade outranks
  // size label, mirroring the existing FlowMaster precedent that a
  // MARKET-level classification (e.g. "waste") must outrank a direct SIZE1
  // code so it isn't silently folded into a real size.
  const marketMapping = findValueMapping(template.valueMappings, "market_grade", rowValues.market_grade ?? null);
  const sizeMapping = findValueMapping(template.valueMappings, "size_label", rowValues.size_label ?? null);
  const mapping = marketMapping ?? sizeMapping;

  if (!mapping) {
    return { action: "unresolved", matchedRuleId: null, targetSizeName: null, distributeSizeNames: null };
  }

  switch (mapping.action) {
    case "ignore":
      return { action: "ignored", matchedRuleId: null, targetSizeName: null, distributeSizeNames: null };
    case "subtotal":
      return { action: "subtotal", matchedRuleId: null, targetSizeName: null, distributeSizeNames: null };
    case "map":
    case "create":
      return {
        action: "included",
        matchedRuleId: null,
        targetSizeName: mapping.action === "create" ? (mapping.newSizeName ?? null) : resolveTargetSizeName(mapping.targetSizeId, context),
        distributeSizeNames: null
      };
    case "distribute":
      return {
        action: "included",
        matchedRuleId: null,
        targetSizeName: null,
        distributeSizeNames: (mapping.distributeSizeIds ?? []).map((id) => resolveTargetSizeName(id, context)).filter((n): n is string => !!n)
      };
    case "use_other_field": {
      if (mapping.useFieldColumnIndex === undefined) {
        return { action: "unresolved", matchedRuleId: null, targetSizeName: null, distributeSizeNames: null };
      }
      // One level of indirection only — never recurse further.
      return { action: "unresolved", matchedRuleId: null, targetSizeName: null, distributeSizeNames: null };
    }
    default:
      return { action: "unresolved", matchedRuleId: null, targetSizeName: null, distributeSizeNames: null };
  }
}

function isRowBlank(row: string[] | undefined): boolean {
  if (!row) return true;
  return row.every((c) => c.trim() === "");
}

function resolveDataRowIndexes(grid: string[][], template: TemplateConfig): number[] {
  const skip = new Set(template.skipRowIndexes);
  const end = template.dataEndRowIndex ?? grid.length - 1;
  const indexes: number[] = [];

  for (let i = template.dataStartRowIndex; i <= end && i < grid.length; i += 1) {
    if (i === template.headerRowIndex) continue;
    if (skip.has(i)) continue;

    if (isRowBlank(grid[i])) {
      if (template.blankRowBehavior === "stop") break;
      continue;
    }

    indexes.push(i);
  }

  return indexes;
}

function parseRowNumber(
  rowValues: ResolvedRowValues,
  field: MappedField,
  template: TemplateConfig
): NumberParseResult {
  const raw = rowValues[field];
  if (raw === null || raw === undefined) return { value: null, error: null };

  const mapping = getMappingFormat(template, field);
  const numberFormat = mapping?.numberFormat ?? DEFAULT_NUMBER_FORMAT;
  return parseNumberValue(raw, numberFormat);
}

function resolveRowDate(rowValues: ResolvedRowValues, template: TemplateConfig): string | null {
  const raw = rowValues.packed_date;
  if (!raw) return null;

  const mapping = getMappingFormat(template, "packed_date");
  const format = mapping?.dateFormat ?? "YYYY-MM-DD";
  const customPattern = mapping && "customDatePattern" in mapping ? mapping.customDatePattern : undefined;
  return parseDateValue(raw, format, customPattern);
}

function buildGroupKey(
  lotNumber: string | null,
  varietyRaw: string | null,
  isoYear: number | null,
  isoWeek: number | null,
  packedDate: string | null
): string {
  if (lotNumber) return `lot:${lotNumber}`;
  return `synthetic:${varietyRaw ?? "unknown"}::${isoYear ?? "?"}::${isoWeek ?? "?"}::${packedDate ?? "?"}`;
}

const RECONCILIATION_EPSILON = 0.01;

export type GroupAverageFruitWeight = {
  averageFruitWeightG: number | null;
  basis: { kg: number; pieces: number } | null;
  /** Set when a mapped PCS/AVG column holds one repeated lot-level value instead of per-row values. */
  lotTotalColumn: { field: "piece_count" | "average_fruit_weight_g"; value: number; rowCount: number } | null;
};

function isValidPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** The single repeated value when every entry is identical, else null. */
function repeatedValue(values: number[]): number | null {
  if (values.length < 2) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

/**
 * Canonical group AFW — same rule as the pinned FlowMaster CSV parser
 * (flowMasterCsvParser.ts): total included kg x 1000 / total included
 * pieces, where a row's pieces come from its PCS when > 0, otherwise from
 * kg x 1000 / AVG. Equivalent to a PCS-weighted mean of the row AFWs,
 * never a plain or kg-weighted mean of AVG cells.
 *
 * Returns a null AFW rather than a misleading one when:
 * - any included row with weight has neither a valid PCS nor a valid AVG
 *   (the AFW would silently describe only part of the imported kg), or
 * - the PCS/AVG actually used holds the same value on every included row
 *   while the row weights differ. That is a lot-total column — e.g. the
 *   SECOND WEIGHT/AVG/PCS group of a FlowMaster export — and summing it per
 *   row multiplies the lot's piece count by the number of size rows.
 */
export function computeGroupAverageFruitWeight(includedRows: NormalizedRow[]): GroupAverageFruitWeight {
  const weighted = includedRows.filter((r) => isValidPositive(r.sizeWeightKg));
  if (weighted.length === 0) return { averageFruitWeightG: null, basis: null, lotTotalColumn: null };

  const weightsDiffer = repeatedValue(weighted.map((r) => r.sizeWeightKg as number)) === null;

  const pcsRows = weighted.filter((r) => isValidPositive(r.pieceCount));
  const repeatedPcs = weightsDiffer ? repeatedValue(pcsRows.map((r) => r.pieceCount as number)) : null;
  if (repeatedPcs !== null) {
    return {
      averageFruitWeightG: null,
      basis: null,
      lotTotalColumn: { field: "piece_count", value: repeatedPcs, rowCount: pcsRows.length }
    };
  }

  const avgFallbackRows = weighted.filter((r) => !isValidPositive(r.pieceCount) && isValidPositive(r.averageFruitWeightG));
  const repeatedAvg = weightsDiffer ? repeatedValue(avgFallbackRows.map((r) => r.averageFruitWeightG as number)) : null;
  if (repeatedAvg !== null) {
    return {
      averageFruitWeightG: null,
      basis: null,
      lotTotalColumn: { field: "average_fruit_weight_g", value: repeatedAvg, rowCount: avgFallbackRows.length }
    };
  }

  let kg = 0;
  let pieces = 0;
  for (const row of weighted) {
    const rowKg = row.sizeWeightKg as number;
    if (isValidPositive(row.pieceCount)) {
      pieces += row.pieceCount;
    } else if (isValidPositive(row.averageFruitWeightG)) {
      pieces += (rowKg * 1000) / row.averageFruitWeightG;
    } else {
      return { averageFruitWeightG: null, basis: null, lotTotalColumn: null };
    }
    kg += rowKg;
  }

  return { averageFruitWeightG: (kg * 1000) / pieces, basis: { kg, pieces }, lotTotalColumn: null };
}

export function normalizeCsvWithTemplate(
  grid: string[][],
  template: TemplateConfig,
  context: EngineContext
): NormalizedPreview {
  const dataRowIndexes = resolveDataRowIndexes(grid, template);

  type WorkingGroup = {
    groupKey: string;
    varietyRaw: string | null;
    packedDate: string | null;
    isoYear: number | null;
    isoWeek: number | null;
    lotNumber: string | null;
    runNumber: string | null;
    totalLotWeightKg: number | null;
    wasteKg: number;
    rows: NormalizedRow[];
    directTargets: Array<{ row: NormalizedRow; targetSizeName: string }>;
    distributeTargets: Array<{ row: NormalizedRow; destinationNames: string[] }>;
  };

  const groups = new Map<string, WorkingGroup>();

  for (const rowIndex of dataRowIndexes) {
    const rowValues = resolveAllRowValues(grid, rowIndex, template);

    const varietyRaw = (rowValues.variety ?? "").trim() || null;
    const lotNumber = (rowValues.lot_number ?? "").trim() || null;
    const runNumber = (rowValues.run_number ?? "").trim() || null;

    let packedDate = resolveRowDate(rowValues, template);
    let isoYear: number | null = null;
    let isoWeek: number | null = null;

    const explicitYear = parseRowNumber(rowValues, "year", template);
    const explicitWeek = parseRowNumber(rowValues, "week", template);
    if (explicitYear.value !== null) isoYear = Math.trunc(explicitYear.value);
    if (explicitWeek.value !== null) isoWeek = Math.trunc(explicitWeek.value);

    if ((isoYear === null || isoWeek === null) && packedDate) {
      const derived = getIsoWeekYear(packedDate);
      if (derived) {
        isoYear = isoYear ?? derived.isoYear;
        isoWeek = isoWeek ?? derived.isoWeek;
      }
    }

    const sizeWeight = parseRowNumber(rowValues, "size_weight_kg", template);
    const pieceCountResult = parseRowNumber(rowValues, "piece_count", template);
    const afwResult = parseRowNumber(rowValues, "average_fruit_weight_g", template);
    const wasteResult = parseRowNumber(rowValues, "waste_kg", template);
    const totalLotWeightResult = parseRowNumber(rowValues, "total_lot_weight", template);

    const classification = classifyRow(rowValues, template, context, grid, rowIndex);

    const parseErrors: string[] = [];
    const invalidFields: Array<{ field: MappedField; raw: string }> = [];
    const numericResults: Array<[MappedField, NumberParseResult]> = [
      ["size_weight_kg", sizeWeight],
      ["piece_count", pieceCountResult],
      ["average_fruit_weight_g", afwResult],
      ["waste_kg", wasteResult]
    ];
    for (const [field, result] of numericResults) {
      if (!result.error) continue;
      parseErrors.push(result.error);
      invalidFields.push({ field, raw: rowValues[field] ?? "" });
    }

    const missingFields = (
      [
        ["size_weight_kg", sizeWeight],
        ["piece_count", pieceCountResult],
        ["average_fruit_weight_g", afwResult],
        ["waste_kg", wasteResult],
        ["total_lot_weight", totalLotWeightResult]
      ] as Array<[MappedField, NumberParseResult]>
    )
      .filter(([, result]) => result.missing)
      .map(([field]) => field);

    // A "null" weight is only ever resolved from another exact source
    // value: a Piece Count written as a literal 0 means no fruit was
    // counted on that row, so its weight is 0 kg by definition. A blank PCS
    // that blank-handling turned into 0 doesn't qualify.
    const pieceCountIsLiteralZero = pieceCountResult.value === 0 && (rowValues.piece_count ?? "").trim() !== "";
    const sizeWeightFromZeroPieces = sizeWeight.missing === true && pieceCountIsLiteralZero;

    const normalizedRow: NormalizedRow = {
      rowIndex,
      action: classification.action,
      sizeLabelRaw: rowValues.size_label ?? null,
      marketGradeRaw: rowValues.market_grade ?? null,
      sizeWeightKg: sizeWeightFromZeroPieces ? 0 : sizeWeight.value,
      pieceCount: pieceCountResult.value,
      averageFruitWeightG: afwResult.value,
      matchedRuleId: classification.matchedRuleId,
      resolvedSizeName: classification.targetSizeName,
      parseErrors,
      missingFields,
      invalidFields,
      sizeWeightFromZeroPieces,
      averageFruitWeightRaw: rowValues.average_fruit_weight_g ?? null
    };

    const groupKey = buildGroupKey(lotNumber, varietyRaw, isoYear, isoWeek, packedDate);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        varietyRaw,
        packedDate,
        isoYear,
        isoWeek,
        lotNumber,
        runNumber,
        totalLotWeightKg: null,
        wasteKg: 0,
        rows: [],
        directTargets: [],
        distributeTargets: []
      };
      groups.set(groupKey, group);
    }

    if (totalLotWeightResult.value !== null && group.totalLotWeightKg === null) {
      group.totalLotWeightKg = totalLotWeightResult.value;
    }
    if (wasteResult.value !== null) {
      group.wasteKg += wasteResult.value;
    }

    group.rows.push(normalizedRow);

    if (classification.action === "included") {
      if (classification.targetSizeName) {
        group.directTargets.push({ row: normalizedRow, targetSizeName: classification.targetSizeName });
      } else if (classification.distributeSizeNames && classification.distributeSizeNames.length > 0) {
        group.distributeTargets.push({ row: normalizedRow, destinationNames: classification.distributeSizeNames });
      }
    }
  }

  const normalizedGroups: NormalizedGroup[] = [];

  for (const group of groups.values()) {
    const sizeKg: Record<string, number> = {};
    let directMappedKg = 0;

    // Pass 1: direct map/create targets.
    for (const { row, targetSizeName } of group.directTargets) {
      const kg = row.sizeWeightKg ?? 0;
      sizeKg[targetSizeName] = (sizeKg[targetSizeName] ?? 0) + kg;
      directMappedKg += kg;
    }

    // Pass 2: distribution, using the progressively-updated sizeKg as the
    // weight basis (matches flowMasterSizeRules.ts's two-pass semantics).
    let distributedKg = 0;
    for (const { row, destinationNames } of group.distributeTargets) {
      const kg = row.sizeWeightKg ?? 0;
      const shares = distributeKgAcrossSizes(kg, destinationNames, sizeKg);
      for (const [name, share] of Object.entries(shares)) {
        sizeKg[name] = (sizeKg[name] ?? 0) + share;
      }
      distributedKg += kg;
    }

    const ignoredKg = group.rows
      .filter((r) => r.action === "ignored")
      .reduce((sum, r) => sum + (r.sizeWeightKg ?? 0), 0);
    const unresolvedKg = group.rows
      .filter((r) => r.action === "unresolved")
      .reduce((sum, r) => sum + (r.sizeWeightKg ?? 0), 0);
    const subtotalKg = group.rows
      .filter((r) => r.action === "subtotal")
      .reduce((sum, r) => sum + (r.sizeWeightKg ?? 0), 0);

    const recognizedSizeKg = directMappedKg + distributedKg;
    const rawRowWeightKg = recognizedSizeKg + ignoredKg + unresolvedKg;

    const lotTotalKg = group.totalLotWeightKg;
    const difference = lotTotalKg !== null ? Math.round((lotTotalKg - rawRowWeightKg) * 100) / 100 : null;
    const unexplainedDifference = lotTotalKg !== null && Math.abs(difference ?? 0) > RECONCILIATION_EPSILON;

    const reconciliation: RowGroupReconciliation = {
      rawRowWeightKg: Math.round(rawRowWeightKg * 100) / 100,
      recognizedSizeKg: Math.round(recognizedSizeKg * 100) / 100,
      directMappedKg: Math.round(directMappedKg * 100) / 100,
      distributedKg: Math.round(distributedKg * 100) / 100,
      ignoredKg: Math.round(ignoredKg * 100) / 100,
      unresolvedKg: Math.round(unresolvedKg * 100) / 100,
      subtotalKg: Math.round(subtotalKg * 100) / 100,
      lotTotalKg,
      difference,
      unexplainedDifference
    };

    const includedRows = group.rows.filter((r) => r.action === "included");
    const pieceCount = includedRows.reduce((sum, r) => sum + (r.pieceCount ?? 0), 0);

    const afw = computeGroupAverageFruitWeight(includedRows);
    const averageFruitWeightG = afw.averageFruitWeightG;

    const unresolvedSizeLabels = Array.from(
      new Set(
        group.rows
          .filter((r) => r.action === "unresolved" && r.sizeLabelRaw)
          .map((r) => r.sizeLabelRaw as string)
      )
    );

    normalizedGroups.push({
      groupKey: group.groupKey,
      varietyRaw: group.varietyRaw,
      packedDate: group.packedDate,
      isoYear: group.isoYear,
      isoWeek: group.isoWeek,
      lotNumber: group.lotNumber,
      runNumber: group.runNumber,
      sizeKg,
      unresolvedSizeLabels,
      wasteKg: Math.round(group.wasteKg * 100) / 100,
      pieceCount,
      averageFruitWeightG,
      averageFruitWeightBasis: afw.basis,
      totalLotWeightKg: group.totalLotWeightKg,
      reconciliation,
      rows: group.rows
    });
  }

  const columnHeaders = grid[template.headerRowIndex] ?? [];
  const validationIssues = validateNormalizedPreview(normalizedGroups, template, context, columnHeaders);
  const warnings = normalizedGroups.flatMap((g) => analyzeValueIssues(g, template, columnHeaders).warnings);

  return {
    groups: normalizedGroups,
    validationIssues,
    warnings,
    canImport: validationIssues.length === 0
  };
}

/**
 * Pure validation of an already-normalized preview. Does NOT check layout
 * fingerprint match (that requires comparing against the freshly-uploaded
 * file's own fingerprint, which is a route-layer concern — see
 * csvMappingTemplates.ts) — a "layout_mismatch" issue is pushed there, into
 * the same issues array shape, when applicable.
 */
export function validateNormalizedPreview(
  groups: NormalizedGroup[],
  template: TemplateConfig,
  context: { alreadyImportedLotNumbers: Set<string> },
  columnHeaders: string[] = []
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const sizeWeightMapped =
    template.columnMappings.some((m) => m.field === "size_weight_kg") ||
    template.fixedCellMappings.some((m) => m.field === "size_weight_kg");

  if (!sizeWeightMapped) {
    issues.push({ code: "size_weight_not_mapped", message: "No column or fixed cell is mapped to Size Weight kg." });
  }

  for (const group of groups) {
    if (!group.packedDate) {
      issues.push({
        code: "packed_date_unresolved",
        message: `Packed date could not be resolved for ${group.groupKey}.`,
        groupKey: group.groupKey
      });
    }

    if (!group.varietyRaw) {
      issues.push({
        code: "variety_unresolved",
        message: `Variety could not be resolved for ${group.groupKey}.`,
        groupKey: group.groupKey
      });
    }

    for (const row of group.rows) {
      if (row.action === "unresolved" && (row.sizeWeightKg === null || row.sizeWeightKg > 0)) {
        issues.push({
          code: "unresolved_size_label",
          message: `Unresolved size label "${row.sizeLabelRaw ?? ""}" on row ${row.rowIndex}.`,
          groupKey: group.groupKey,
          rowIndex: row.rowIndex
        });
      }

      // Rows built without invalidFields (older callers) keep the per-row message.
      if (row.invalidFields) continue;
      for (const err of row.parseErrors) {
        issues.push({
          code: "invalid_numeric_value",
          message: `${err} (row ${row.rowIndex}).`,
          groupKey: group.groupKey,
          rowIndex: row.rowIndex
        });
      }
    }

    issues.push(...analyzeValueIssues(group, template, columnHeaders).blocking);

    const rawNonIgnoredKg = group.rows
      .filter((r) => r.action === "included" || r.action === "unresolved")
      .reduce((sum, r) => sum + (r.sizeWeightKg ?? 0), 0);

    if (rawNonIgnoredKg > RECONCILIATION_EPSILON && group.reconciliation.recognizedSizeKg === 0) {
      issues.push({
        code: "recognized_kg_zero",
        message: `Recognized size kg is zero for ${group.groupKey} despite ${rawNonIgnoredKg.toFixed(2)} kg of non-ignored raw rows.`,
        groupKey: group.groupKey
      });
    }

    if (group.lotNumber && context.alreadyImportedLotNumbers.has(group.lotNumber)) {
      issues.push({
        code: "duplicate_raw_kg",
        message: `Lot ${group.lotNumber} has already been imported.`,
        groupKey: group.groupKey
      });
    }

    if (group.reconciliation.unexplainedDifference) {
      issues.push({
        code: "unexplained_reconciliation_difference",
        message: `Reconciliation difference of ${group.reconciliation.difference} kg is unexplained for ${group.groupKey}.`,
        groupKey: group.groupKey
      });
    }

    // Heuristic double-counting guard: a repeated lot-total column mapped
    // as Size Weight kg (instead of the true per-row weight column) shows
    // up as the identical value repeated across many rows of the same lot.
    const includedWeights = group.rows.filter(
      (r) => r.action === "included" && r.sizeWeightKg !== null && r.sizeWeightKg > 0
    );
    const weightRepeatCounts = new Map<number, number>();
    for (const row of includedWeights) {
      const key = row.sizeWeightKg as number;
      weightRepeatCounts.set(key, (weightRepeatCounts.get(key) ?? 0) + 1);
    }
    for (const [weight, count] of weightRepeatCounts) {
      if (count < 2) continue;
      const repeatedTotalKg = weight * count;
      if (group.reconciliation.recognizedSizeKg > 0 && repeatedTotalKg / group.reconciliation.recognizedSizeKg > 0.5) {
        issues.push({
          code: "possible_duplicate_weight_source",
          message: `The column mapped to Size Weight kg has the same value (${weight}) repeated across ${count} rows of ${group.groupKey} — this looks like a lot total, not a per-row weight.`,
          groupKey: group.groupKey
        });
        break;
      }
    }

    // Same hazard for the fruit-weight columns: a FlowMaster export repeats
    // WEIGHT/AVG/PCS as a per-size group then a lot-total group. Mapping the
    // lot-total PCS/AVG makes every size row carry the whole lot's value.
    const lotTotalColumn = computeGroupAverageFruitWeight(group.rows.filter((r) => r.action === "included")).lotTotalColumn;
    if (lotTotalColumn) {
      const label = lotTotalColumn.field === "piece_count" ? "Piece Count" : "Average Fruit Weight g";
      issues.push({
        code: "possible_lot_total_fruit_column",
        message: `The column mapped to ${label} has the same value (${lotTotalColumn.value}) on all ${lotTotalColumn.rowCount} included rows of ${group.groupKey} — this looks like a lot total (e.g. the second WEIGHT/AVG/PCS group), not a per-size value. Map the ${label} column from the same group as Size Weight kg.`,
        groupKey: group.groupKey
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Missing / unreadable value analysis — one consolidated issue per group and
// field (never one per row), stating the column it came from, the rows
// affected and whether it blocks the import, only the AFW, or nothing.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Partial<Record<MappedField, string>> = {
  size_weight_kg: "Size Weight",
  piece_count: "Piece Count",
  average_fruit_weight_g: "Source AFW",
  waste_kg: "Waste kg",
  total_lot_weight: "Total Lot Weight"
};

function fieldLabel(field: MappedField): string {
  return FIELD_LABELS[field] ?? field;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** Where a field's value comes from, naming the header occurrence when a header repeats (e.g. FlowMaster's two WEIGHT/AVG/PCS groups). */
export function describeFieldSource(template: TemplateConfig, field: MappedField, columnHeaders: string[]): string {
  const fixed = findFixedCellMapping(template.fixedCellMappings, field);
  if (fixed) return `fixed cell at row ${fixed.rowIndex + 1}, column ${fixed.columnIndex + 1}`;

  const column = findColumnMapping(template.columnMappings, field);
  if (!column) return "an unmapped column";

  const columnNumber = column.columnIndex + 1;
  const header = (columnHeaders[column.columnIndex] ?? "").trim();
  if (!header) return `column ${columnNumber}`;

  const sameHeader = columnHeaders
    .map((h, i) => ({ h: h.trim().toLowerCase(), i }))
    .filter((c) => c.h === header.toLowerCase())
    .map((c) => c.i);
  if (sameHeader.length <= 1) return `column "${header}" (column ${columnNumber})`;

  const occurrence = sameHeader.indexOf(column.columnIndex) + 1;
  return `column "${header}" (column ${columnNumber}, the ${ordinal(occurrence)} of ${sameHeader.length} "${header}" columns)`;
}

/** Spreadsheet-style row numbers (header row = row 1), compressed into ranges: "rows 2–9, 12". */
export function formatRowNumbers(rowIndexes: number[]): string {
  const sorted = Array.from(new Set(rowIndexes.map((i) => i + 1))).sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i += 1;
    ranges.push(start === sorted[i] ? `${start}` : `${start}\u2013${sorted[i]}`);
  }
  const shown = ranges.length > 10 ? [...ranges.slice(0, 10), "\u2026"] : ranges;
  return `${sorted.length === 1 ? "row" : "rows"} ${shown.join(", ")}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function decimalsOf(raw: string | null | undefined): number {
  const cleaned = (raw ?? "").trim();
  const sep = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
  return sep === -1 ? 0 : cleaned.length - sep - 1;
}

function isMapped(template: TemplateConfig, field: MappedField): boolean {
  return !!findFixedCellMapping(template.fixedCellMappings, field) || !!findColumnMapping(template.columnMappings, field);
}

export function analyzeValueIssues(
  group: NormalizedGroup,
  template: TemplateConfig,
  columnHeaders: string[]
): { blocking: ValidationIssue[]; warnings: ValidationIssue[] } {
  const blocking: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const source = (field: MappedField) => describeFieldSource(template, field, columnHeaders);
  const base = (field: MappedField, rows: NormalizedRow[]) => ({
    groupKey: group.groupKey,
    field,
    columnLabel: source(field),
    rowIndexes: rows.map((r) => r.rowIndex),
    rowIndex: rows[0]?.rowIndex
  });
  const missing = (row: NormalizedRow, field: MappedField) => (row.missingFields ?? []).includes(field);
  const counted = (row: NormalizedRow) => row.action === "included" || row.action === "unresolved";

  // Unreadable values: blocking, one issue per field.
  const invalidByField = new Map<MappedField, { rows: NormalizedRow[]; raws: Set<string> }>();
  for (const row of group.rows) {
    for (const { field, raw } of row.invalidFields ?? []) {
      const entry = invalidByField.get(field) ?? { rows: [], raws: new Set<string>() };
      entry.rows.push(row);
      entry.raws.add(raw.trim());
      invalidByField.set(field, entry);
    }
  }
  for (const [field, { rows, raws }] of invalidByField) {
    const examples = Array.from(raws).slice(0, 3).map((r) => `"${r}"`).join(", ");
    blocking.push({
      code: "invalid_numeric_value",
      severity: "blocking",
      impact: "import",
      message: `${fieldLabel(field)} could not be read on ${plural(rows.length, "row")} (${formatRowNumbers(rows.map((r) => r.rowIndex))}, ${source(field)}): ${examples}. The import is blocked until the file or mapping is corrected.`,
      ...base(field, rows)
    });
  }

  // "null" Size Weight on rows whose Piece Count is a literal 0: no fruit.
  const noFruitRows = group.rows.filter((r) => r.sizeWeightFromZeroPieces);
  if (noFruitRows.length > 0) {
    const afwAlsoMissing = noFruitRows.every((r) => missing(r, "average_fruit_weight_g"));
    warnings.push({
      code: "missing_values_no_fruit",
      severity: "warning",
      impact: "none",
      message: `Size Weight${afwAlsoMissing ? " and Source AFW are" : " is"} "null" on ${plural(noFruitRows.length, "row")} (${formatRowNumbers(noFruitRows.map((r) => r.rowIndex))}, ${source("size_weight_kg")}), and Piece Count is 0 on each of them. No fruit was recorded, so these rows count as 0 kg and do not affect AFW.`,
      ...base("size_weight_kg", noFruitRows)
    });
  }

  // "null" Size Weight on a counted row with nothing exact to derive it from: blocking.
  const missingWeightRows = group.rows.filter((r) => counted(r) && missing(r, "size_weight_kg") && !r.sizeWeightFromZeroPieces);
  if (missingWeightRows.length > 0) {
    blocking.push({
      code: "missing_size_weight",
      severity: "blocking",
      impact: "import",
      message: `Size Weight is "null" on ${plural(missingWeightRows.length, "included size row")} (${formatRowNumbers(missingWeightRows.map((r) => r.rowIndex))}, ${source("size_weight_kg")}) and no exact source value provides it. The import is blocked — kg cannot be assumed.`,
      ...base("size_weight_kg", missingWeightRows)
    });
  }

  // AFW / Piece Count on included rows that carry weight.
  const weightedIncluded = group.rows.filter((r) => r.action === "included" && isValidPositive(r.sizeWeightKg));

  const afwMissingWithPcs = weightedIncluded.filter((r) => missing(r, "average_fruit_weight_g") && isValidPositive(r.pieceCount));
  if (afwMissingWithPcs.length > 0) {
    warnings.push({
      code: "missing_source_afw",
      severity: "warning",
      impact: "none",
      message: `Source AFW is "null" on ${plural(afwMissingWithPcs.length, "included row")} (${formatRowNumbers(afwMissingWithPcs.map((r) => r.rowIndex))}, ${source("average_fruit_weight_g")}). Valid Piece Count is available, so AFW is calculated from kg and pieces.`,
      ...base("average_fruit_weight_g", afwMissingWithPcs)
    });
  }

  const pcsDerivedFromAfw = weightedIncluded.filter(
    (r) => missing(r, "piece_count") && !isValidPositive(r.pieceCount) && isValidPositive(r.averageFruitWeightG)
  );
  if (pcsDerivedFromAfw.length > 0) {
    // A source AFW rounded to d decimals is off by at most half a unit in
    // its last place, so pieces derived from it (and the resulting AFW) are
    // off by at most that fraction of the AFW, relatively.
    const maxRelativeError = Math.max(
      ...pcsDerivedFromAfw.map((r) => (0.5 * 10 ** -decimalsOf(r.averageFruitWeightRaw)) / (r.averageFruitWeightG as number))
    );
    const pct = Math.ceil(maxRelativeError * 100 * 100) / 100;
    warnings.push({
      code: "missing_piece_count_derived",
      severity: "warning",
      impact: "none",
      message: `Piece Count is "null" on ${plural(pcsDerivedFromAfw.length, "included row")} (${formatRowNumbers(pcsDerivedFromAfw.map((r) => r.rowIndex))}, ${source("piece_count")}). Pieces are derived as kg \u00d7 1000 \u00f7 source AFW; because the source AFW is rounded, the derived pieces and the AFW can differ from the true values by up to \u00b1${pct.toFixed(2)}%.`,
      ...base("piece_count", pcsDerivedFromAfw)
    });
  }

  if (isMapped(template, "piece_count") || isMapped(template, "average_fruit_weight_g")) {
    const noFruitBasis = weightedIncluded.filter((r) => !isValidPositive(r.pieceCount) && !isValidPositive(r.averageFruitWeightG));
    if (noFruitBasis.length > 0) {
      const kg = noFruitBasis.reduce((sum, r) => sum + (r.sizeWeightKg as number), 0);
      warnings.push({
        code: "afw_not_calculable",
        severity: "warning",
        impact: "afw",
        message: `Piece Count and AFW are both missing for ${plural(noFruitBasis.length, "included size row")} (${formatRowNumbers(noFruitBasis.map((r) => r.rowIndex))}, ${kg.toFixed(2)} kg). Kg can be imported, but AFW cannot be calculated and will be left blank.`,
        ...base(isMapped(template, "piece_count") ? "piece_count" : "average_fruit_weight_g", noFruitBasis)
      });
    }
  }

  // "null" anywhere on rows that are not imported never blocks.
  const ignoredWithMissing = group.rows.filter(
    (r) => (r.action === "ignored" || r.action === "subtotal") && (r.missingFields ?? []).length > 0 && !r.sizeWeightFromZeroPieces
  );
  if (ignoredWithMissing.length > 0) {
    const fields = Array.from(new Set(ignoredWithMissing.flatMap((r) => r.missingFields ?? [])));
    const labels = Array.from(new Set(ignoredWithMissing.map((r) => (r.sizeLabelRaw ?? "").trim()).filter(Boolean)));
    warnings.push({
      code: "missing_values_ignored_rows",
      severity: "warning",
      impact: "none",
      message: `${fields.map(fieldLabel).join(", ")} ${fields.length === 1 ? "is" : "are"} "null" on ${plural(ignoredWithMissing.length, "ignored row")} (${formatRowNumbers(ignoredWithMissing.map((r) => r.rowIndex))}${labels.length > 0 ? `: ${labels.join(", ")}` : ""}). These rows are not imported, so this does not block the import.`,
      ...base(fields[0], ignoredWithMissing)
    });
  }

  // Optional numeric fields on counted rows: left blank, never zero.
  for (const field of ["waste_kg", "total_lot_weight"] as MappedField[]) {
    const rows = group.rows.filter((r) => counted(r) && missing(r, field));
    if (rows.length === 0) continue;
    const consequence =
      field === "total_lot_weight" && group.totalLotWeightKg === null
        ? " No lot total is available, so kg is not reconciled against one."
        : "";
    warnings.push({
      code: "missing_optional_value",
      severity: "warning",
      impact: "none",
      message: `${fieldLabel(field)} is "null" on ${plural(rows.length, "row")} (${formatRowNumbers(rows.map((r) => r.rowIndex))}, ${source(field)}) and is left blank.${consequence}`,
      ...base(field, rows)
    });
  }

  return { blocking, warnings };
}

export { resolveDataRowIndexes as _internal_resolveDataRowIndexes };
