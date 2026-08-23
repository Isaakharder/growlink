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

export type NumberParseResult = { value: number | null; error: string | null };

export function parseNumberValue(raw: string, config: NumberFormatConfig): NumberParseResult {
  const cleaned = raw.trim();

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

function evaluateCondition(condition: RuleCondition, rowValues: ResolvedRowValues): boolean {
  const raw = rowValues[condition.field] ?? null;

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

function evaluateRule(rule: ConditionalRowRule, rowValues: ResolvedRowValues): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditionLogic === "AND"
    ? rule.conditions.every((c) => evaluateCondition(c, rowValues))
    : rule.conditions.some((c) => evaluateCondition(c, rowValues));
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
  context: EngineContext
): RowClassification {
  const sortedRules = [...template.rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    if (!evaluateRule(rule, rowValues)) continue;

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

    const classification = classifyRow(rowValues, template, context);

    const parseErrors: string[] = [];
    if (sizeWeight.error) parseErrors.push(sizeWeight.error);
    if (pieceCountResult.error) parseErrors.push(pieceCountResult.error);
    if (afwResult.error) parseErrors.push(afwResult.error);
    if (wasteResult.error) parseErrors.push(wasteResult.error);

    const normalizedRow: NormalizedRow = {
      rowIndex,
      action: classification.action,
      sizeLabelRaw: rowValues.size_label ?? null,
      marketGradeRaw: rowValues.market_grade ?? null,
      sizeWeightKg: sizeWeight.value,
      pieceCount: pieceCountResult.value,
      averageFruitWeightG: afwResult.value,
      matchedRuleId: classification.matchedRuleId,
      resolvedSizeName: classification.targetSizeName,
      parseErrors
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

    let afwNumerator = 0;
    let afwDenominator = 0;
    for (const row of includedRows) {
      if (row.averageFruitWeightG !== null && row.sizeWeightKg !== null && row.sizeWeightKg > 0) {
        afwNumerator += row.averageFruitWeightG * row.sizeWeightKg;
        afwDenominator += row.sizeWeightKg;
      }
    }
    const averageFruitWeightG = afwDenominator > 0 ? afwNumerator / afwDenominator : null;

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
      totalLotWeightKg: group.totalLotWeightKg,
      reconciliation,
      rows: group.rows
    });
  }

  const validationIssues = validateNormalizedPreview(normalizedGroups, template, context);

  return {
    groups: normalizedGroups,
    validationIssues,
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
  context: { alreadyImportedLotNumbers: Set<string> }
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

      for (const err of row.parseErrors) {
        issues.push({
          code: "invalid_numeric_value",
          message: `${err} (row ${row.rowIndex}).`,
          groupKey: group.groupKey,
          rowIndex: row.rowIndex
        });
      }
    }

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
  }

  return issues;
}

export { resolveDataRowIndexes as _internal_resolveDataRowIndexes };
