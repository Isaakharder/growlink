import { type FlowMasterParseResult, type CsvSizeEntry, type CsvRowKg } from "./flowMasterPdfParser";

export type { FlowMasterParseResult, CsvSizeEntry, CsvRowKg };

// Exported so flowMasterCsvRuleResolver.ts (the rules-aware re-resolution
// pass that runs once saved flowmaster_size_rules are loaded) shares the
// exact same built-in mapping/alias/summary-value definitions instead of
// duplicating them and risking drift.
export const SIZE_LABEL_MAP: Record<string, string> = {
  // Old format column-header labels (SM / MD / LG)
  SM: "Small",
  MD: "Medium",
  LG: "Large",
  // New format SIZE1 cell values (S / M / L)
  S: "Small",
  M: "Medium",
  L: "Large",
  // Shared by both formats
  SXL: "SXL",
  XL: "XL",
  XXL: "XXL",
};

// Built-in aliases applied before SIZE_LABEL_MAP and before org-provided sizeAliases.
// Caller-provided sizeAliases extend (and override) these. Keyed by normalizeForMatch().
export const DEFAULT_SIZE_ALIASES: Record<string, string> = {
  "X-L": "SXL",
};

// SIZE1 values that mean "this row is a market-level summary/total, not a real
// pepper size" — when SIZE1 is one of these (or empty), the MARKET column is
// the row's actionable label instead. See classifyNewFormatRow().
export const SIZE1_SUMMARY_VALUES = new Set(["ALL WEIGHT", "ALLWEIGHT"]);

// Old format: every header NOT in this set is treated as a size column.
const OLD_FORMAT_NON_SIZE_HEADERS = new Set([
  "LOTNUMBER", "BEGINDT", "VARIETY", "AVG", "WEIGHT",
]);

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

// One parsed data row. `byName` is convenient for columns that never repeat
// (LOTNUMBER, VARIETY, BEGINDT, MARKET, SIZE1, ...) — for those, "last column
// with this name wins" is a non-issue since the name only appears once.
// `cells` is the raw, trimmed, POSITION-preserving value list, required for
// any column that CAN repeat (WEIGHT/AVG/PCS appear twice in real FlowMaster
// exports) — looking those up by name would silently collapse to whichever
// occurrence happens to be parsed last, which is the root cause of the
// "lot total repeated for every size" bug this file fixes.
type CsvParsedRow = {
  byName: Record<string, string>;
  cells: string[];
};

type CsvParsed = {
  // Raw header list in original column order (may contain duplicates).
  headers: string[];
  rows: CsvParsedRow[];
};

function parseCsvRows(content: string): CsvParsed {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return { headers: [], rows: [] };

  const rawHeaders = parseCsvLine(lines[0]);
  const headers = rawHeaders.map((h) => h.trim().toUpperCase());

  const rows: CsvParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const rawCells = parseCsvLine(line);
    const cells = headers.map((_, j) => (rawCells[j] ?? "").trim());
    const byName: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      byName[headers[j]] = cells[j];
    }
    rows.push({ byName, cells });
  }
  return { headers, rows };
}

// Parses DDMMYYYY[ HH:mm[:ss]] → "YYYY-MM-DD HH:mm" (same shape as PDF parser
// output). Time is optional: FlowMaster CSV exports are frequently date-only,
// and a missing clock time is not a reason to reject the row or claim the
// start time itself is "not found" — only the seconds/minutes precision is
// unknown, so it defaults to midnight.
function parseBegindtToIso(value: string): string | null {
  const withTime = value.match(/^(\d{2})(\d{2})(\d{4})\s+(\d{2}:\d{2})/);
  if (withTime) {
    const [, dd, mm, yyyy, time] = withTime;
    return `${yyyy}-${mm}-${dd} ${time}`;
  }

  const dateOnly = value.match(/^(\d{2})(\d{2})(\d{4})\s*$/);
  if (dateOnly) {
    const [, dd, mm, yyyy] = dateOnly;
    return `${yyyy}-${mm}-${dd} 00:00`;
  }

  return null;
}

function toIsoYearWeek(dateStr: string): { isoYear: number; isoWeek: number } | null {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { isoYear: utc.getUTCFullYear(), isoWeek };
}

function parseKg(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

// Case/space/brace-insensitive matching key. "{oversized}", " Oversized ",
// and "OVERSIZED" must all resolve to the same ignoredSet/alias entry, while
// the original label (whatever was actually uppercase-trimmed from the CSV)
// is kept as-is everywhere it's displayed (sizeKg keys, unknownSizes,
// warnings, csvSizes) so the user still recognizes their own data.
// Exported for reuse by flowMasterCsvRuleResolver.ts.
export function normalizeForMatch(label: string): string {
  return label.trim().toUpperCase().replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

// ─── New format (MARKET / SIZE1 / duplicate WEIGHT,AVG,PCS layout) ────────────
//
// Real FlowMaster CSV exports repeat the WEIGHT,AVG,PCS column group twice:
// once immediately after SIZE1/SIZE2 (the per-row values for that specific
// market/size line) and again at the very end of the row (the lot-level
// totals, identical on every row for the same lot). Both groups are literally
// named "WEIGHT"/"AVG"/"PCS" with no disambiguating suffix in real exports —
// detectNewFormat locates the FIRST occurrence of each after SIZE1's column
// index (by position, not name) so the per-row group is used and the
// repeated lot total is never mistaken for it.
//
// Multiple data rows share the same LOTNUMBER (one row per market/size). All
// rows for a given LOTNUMBER are grouped and reduced into a single
// FlowMasterParseResult.
//
// REPACK skip: rows where LOTID contains "repack" (case-insensitive substring).

type NewFormatColumns = {
  weightIdx: number;
  avgIdx: number; // -1 if no AVG column found after SIZE1
  pcsIdx: number; // -1 if no PCS column found after SIZE1
};

function firstMatchingIndexAfter(headers: string[], afterIndex: number, baseName: string): number {
  const re = new RegExp(`^${baseName}(\\.\\d+)?$`);
  for (let i = afterIndex + 1; i < headers.length; i++) {
    if (re.test(headers[i])) return i;
  }
  return -1;
}

// Scans the raw header array (original column order, duplicates preserved) to
// find the per-row WEIGHT/AVG/PCS columns — the first occurrence of each that
// comes after SIZE1's column index. Any occurrence before SIZE1 is lot-level
// and deliberately ignored.
function detectNewFormat(headers: string[]): NewFormatColumns | null {
  const size1Idx = headers.indexOf("SIZE1");
  if (size1Idx < 0) return null;

  const weightIdx = firstMatchingIndexAfter(headers, size1Idx, "WEIGHT");
  if (weightIdx < 0) return null;

  return {
    weightIdx,
    avgIdx: firstMatchingIndexAfter(headers, size1Idx, "AVG"),
    pcsIdx: firstMatchingIndexAfter(headers, size1Idx, "PCS"),
  };
}

// True if `label` has SOME configured resolution mechanism (an ignore entry,
// an alias, or — when the caller is rules-aware — a saved flowmaster_size_rules
// row). Used purely to decide MARKET-vs-SIZE1 priority in classifyNewFormatRow;
// the actual resolution (what the label maps to) happens separately via
// resolveLabel/applySizeRules once the winning label is chosen.
export type LabelOverrideCheck = (label: string) => boolean;

// Resolves the single MARKET/SIZE1 hierarchy this row should be filed under:
//   1. MARKET has an explicit configured resolution (ignore/alias/rule) →
//      MARKET wins outright, even over a row whose SIZE1 is already a direct
//      recognized size code. This is what lets an org configure e.g. a
//      "waste" MARKET as Ignore and have it suppress the row regardless of
//      what SIZE1 says.
//   2. Otherwise, if SIZE1 is a real pepper size marker (non-empty, not "All
//      Weight") → SIZE1 is the row's label (a direct SM/MD/LG/SXL/XL/XXL
//      code, or a special sub-label like "underweight"/"{oversized}" that
//      needs its own saved rule). This is the common case — MARKET being a
//      plain grade/category like "Class 1" with no rule of its own.
//   3. Otherwise (SIZE1 is "All Weight"/blank and MARKET had no rule) →
//      MARKET is the row's label anyway, since it's the only thing
//      distinguishing one such summary row from another (e.g. "24ct").
//
// `hasOverride` is injected so this same priority logic can run twice: once
// inside the pure parser (checking only the org's static ignoredSizeLabels/
// sizeAliases settings, since that's all a DB-free function can see), and
// again later in flowMasterCsvRuleResolver.ts once saved flowmaster_size_rules
// have actually been loaded — see CsvRowKg on FlowMasterParseResult.
export function classifyNewFormatRow(
  marketRaw: string,
  size1Raw: string,
  hasOverride: LabelOverrideCheck
): string {
  const marketUpper = marketRaw.trim().toUpperCase();
  const size1Upper = size1Raw.trim().toUpperCase();

  if (marketUpper && hasOverride(marketUpper)) {
    return marketUpper;
  }

  if (size1Upper && !SIZE1_SUMMARY_VALUES.has(normalizeForMatch(size1Upper))) {
    return size1Upper;
  }

  return marketUpper || size1Upper;
}

export type LabelResolution =
  | { kind: "ignored" }
  | { kind: "known"; sizeName: string }
  | { kind: "unresolved" };

export function resolveLabel(
  label: string,
  ignoredSet: Set<string>,
  mergedAliasesNormalized: Record<string, string>
): LabelResolution {
  const matchKey = normalizeForMatch(label);

  if (ignoredSet.has(matchKey)) {
    return { kind: "ignored" };
  }

  const aliasTarget = mergedAliasesNormalized[matchKey];
  if (aliasTarget !== undefined) {
    return { kind: "known", sizeName: aliasTarget };
  }

  const builtIn = SIZE_LABEL_MAP[label];
  if (builtIn !== undefined) {
    return { kind: "known", sizeName: builtIn };
  }

  return { kind: "unresolved" };
}

function buildNewFormatResult(
  lotNumber: string,
  rows: CsvParsedRow[],
  columns: NewFormatColumns,
  ignoredSet: Set<string>,
  mergedAliasesNormalized: Record<string, string>,
  sourceFile: string
): FlowMasterParseResult {
  const firstRow = rows[0];
  const warnings: string[] = [];
  const unknownSizes: string[] = [];
  const sizeKg: Record<string, number> = {};

  const varietyName = firstRow.byName["VARIETY"]?.trim() || null;

  const begindtRaw = (firstRow.byName["BEGINDT"] ?? "").trim();
  const startTime = begindtRaw ? parseBegindtToIso(begindtRaw) : null;
  if (begindtRaw && !startTime) {
    warnings.push(`Could not parse BEGINDT: "${begindtRaw}".`);
  }
  const startDate = startTime ? startTime.slice(0, 10) : null;
  const isoYW = startDate ? toIsoYearWeek(startDate) : null;

  // MARKET has "an override" for this parser's own (rules-unaware) pass if
  // it's explicitly ignored or aliased via the org's static CSV settings.
  // flowMasterCsvRuleResolver.ts reruns classifyNewFormatRow later with an
  // hasOverride that ALSO checks saved flowmaster_size_rules, once those are
  // loaded — see csvRowKg below.
  const hasOverride: LabelOverrideCheck = (label) => {
    const matchKey = normalizeForMatch(label);
    return ignoredSet.has(matchKey) || mergedAliasesNormalized[matchKey] !== undefined;
  };

  const csvSizesMap = new Map<string, { mappedSizeName: string | null; kg: number }>();
  const csvRowKg: CsvRowKg[] = [];

  // Combined average fruit weight = total included kg / total included piece
  // count — a mass-weighted harmonic combination, not a repeat of the lot's
  // AVG value on every row. Only rows that resolve to a real, known size
  // contribute (matching what "included" means for the SM–XXL totals below);
  // an unresolved/ignored row's kg isn't a reliable fruit-size sample yet.
  // PCS (first group) is preferred; if it's missing or zero for a row, an
  // estimated piece count is derived from that row's own first-group AVG
  // instead, so a gap in one optional column doesn't blank the whole figure.
  let includedKg = 0;
  let includedPieces = 0;

  for (const row of rows) {
    const market = row.byName["MARKET"] ?? "";
    const size1 = row.byName["SIZE1"] ?? "";

    const weightRaw = (row.cells[columns.weightIdx] ?? "").trim();
    if (!weightRaw) continue;
    const kg = parseKg(weightRaw);
    if (kg === null || kg === 0) continue;

    const pcsRaw = columns.pcsIdx >= 0 ? (row.cells[columns.pcsIdx] ?? "").trim() : "";
    const pcs = pcsRaw ? parseKg(pcsRaw) : null;
    const avgRaw = columns.avgIdx >= 0 ? (row.cells[columns.avgIdx] ?? "").trim() : "";
    const avg = avgRaw ? parseKg(avgRaw) : null;

    // Raw per-row facts, captured for every row regardless of how (or
    // whether) this parser pass resolves it — see CsvRowKg's doc comment.
    csvRowKg.push({
      marketLabel: market.trim().toUpperCase(),
      size1Label: size1.trim().toUpperCase(),
      kg,
      avg,
      pcs,
    });

    const label = classifyNewFormatRow(market, size1, hasOverride);
    if (!label) continue;

    const resolution = resolveLabel(label, ignoredSet, mergedAliasesNormalized);
    const mappedSizeName = resolution.kind === "known" ? resolution.sizeName : null;
    const existingCsvSize = csvSizesMap.get(label);
    if (existingCsvSize) { existingCsvSize.kg += kg; } else { csvSizesMap.set(label, { mappedSizeName, kg }); }

    if (resolution.kind === "ignored") continue;

    if (resolution.kind === "unresolved") {
      if (!unknownSizes.includes(label)) {
        unknownSizes.push(label);
        warnings.push(`New size found: ${label}. Add this size in GrowLink before importing.`);
      }
      sizeKg[label] = (sizeKg[label] ?? 0) + kg;
      continue;
    }

    sizeKg[resolution.sizeName] = (sizeKg[resolution.sizeName] ?? 0) + kg;

    if (pcs !== null && pcs > 0) {
      includedKg += kg;
      includedPieces += pcs;
    } else if (avg !== null && avg > 0) {
      includedKg += kg;
      includedPieces += (kg * 1000) / avg;
    }
  }

  const csvSizes: CsvSizeEntry[] = Array.from(csvSizesMap.entries()).map(([rawLabel, d]) => ({
    rawLabel, mappedSizeName: d.mappedSizeName, kg: d.kg,
  }));

  const averageFruitWeightG = includedPieces > 0 ? (includedKg * 1000) / includedPieces : null;

  const totalKg =
    Object.keys(sizeKg).length > 0
      ? Object.values(sizeKg).reduce((s, k) => s + k, 0)
      : null;

  if (!varietyName) warnings.push("Variety not found in CSV.");
  if (!startTime) warnings.push("Start time not found in CSV.");
  if (Object.keys(sizeKg).length === 0) warnings.push("No size data found in CSV row.");

  return {
    sourceFile,
    lotNumber,
    varietyName,
    startTime,
    startDate,
    isoYear: isoYW?.isoYear ?? null,
    isoWeek: isoYW?.isoWeek ?? null,
    averageFruitWeightG,
    totalKg,
    sizeKg,
    unknownSizes,
    warnings,
    csvSizes,
    csvRowKg,
  };
}

function parseNewFormat(
  rows: CsvParsedRow[],
  columns: NewFormatColumns,
  ignoredSet: Set<string>,
  mergedAliasesNormalized: Record<string, string>,
  sourceFile: string
): FlowMasterParseResult[] {
  const grouped = new Map<string, CsvParsedRow[]>();

  for (const row of rows) {
    const lotId = row.byName["LOTID"] ?? "";
    if (lotId.toLowerCase().includes("repack")) continue;
    const lotNumber = (row.byName["LOTNUMBER"] ?? "").trim();
    if (!lotNumber) continue;
    if (!grouped.has(lotNumber)) grouped.set(lotNumber, []);
    grouped.get(lotNumber)!.push(row);
  }

  return Array.from(grouped.entries()).map(([lotNumber, lotRows]) =>
    buildNewFormatResult(lotNumber, lotRows, columns, ignoredSet, mergedAliasesNormalized, sourceFile)
  );
}

// ─── Old format (SM / MD / LG column-header layout) ──────────────────────────
// One row per lot; size column headers are anything not in OLD_FORMAT_NON_SIZE_HEADERS.
// REPACK detection compares LOTNUMBER === "repack" (case-insensitive, exact match).
// Single AVG/WEIGHT columns only — the duplicate-header issue does not apply here.

function rowToResult(
  row: CsvParsedRow,
  sizeHeaders: string[],
  mergedAliasesNormalized: Record<string, string>,
  sourceFile: string
): FlowMasterParseResult {
  const warnings: string[] = [];
  const unknownSizes: string[] = [];
  const sizeKg: Record<string, number> = {};

  const lotNumber = row.byName["LOTNUMBER"] || null;
  const varietyName = row.byName["VARIETY"] || null;

  const avgRaw = row.byName["AVG"];
  const averageFruitWeightG = avgRaw ? parseKg(avgRaw) : null;

  const begindtRaw = row.byName["BEGINDT"] ?? "";
  const startTime = begindtRaw ? parseBegindtToIso(begindtRaw) : null;
  if (begindtRaw && !startTime) {
    warnings.push(`Could not parse BEGINDT: "${begindtRaw}".`);
  }

  const startDate = startTime ? startTime.slice(0, 10) : null;
  const isoYW = startDate ? toIsoYearWeek(startDate) : null;

  // Build csvSizes from all size columns (for UI toggle checkboxes).
  const csvSizes: CsvSizeEntry[] = sizeHeaders
    .map((header): CsvSizeEntry | null => {
      const rawKg = row.byName[header];
      if (!rawKg) return null;
      const kg = parseKg(rawKg);
      if (kg === null || kg === 0) return null;
      const mappedSizeName: string | null =
        mergedAliasesNormalized[normalizeForMatch(header)] ?? SIZE_LABEL_MAP[header] ?? null;
      return { rawLabel: header, mappedSizeName, kg };
    })
    .filter((e): e is CsvSizeEntry => e !== null);

  for (const header of sizeHeaders) {
    const rawKg = row.byName[header];
    if (!rawKg) continue;
    const kg = parseKg(rawKg);
    if (kg === null || kg === 0) continue;

    const aliasName = mergedAliasesNormalized[normalizeForMatch(header)];
    if (aliasName !== undefined) {
      sizeKg[aliasName] = (sizeKg[aliasName] ?? 0) + kg;
    } else {
      const growlinkName = SIZE_LABEL_MAP[header];
      if (growlinkName !== undefined) {
        sizeKg[growlinkName] = (sizeKg[growlinkName] ?? 0) + kg;
      } else {
        if (!unknownSizes.includes(header)) {
          unknownSizes.push(header);
          warnings.push(`New size found: ${header}. Add this size in GrowLink before importing.`);
        }
        sizeKg[header] = (sizeKg[header] ?? 0) + kg;
      }
    }
  }

  const totalKg =
    Object.keys(sizeKg).length > 0
      ? Object.values(sizeKg).reduce((s, k) => s + k, 0)
      : null;

  if (!varietyName) warnings.push("Variety not found in CSV.");
  if (!startTime) warnings.push("Start time not found in CSV.");
  if (!lotNumber) warnings.push("Lot number missing. Duplicate detection may be limited.");
  if (Object.keys(sizeKg).length === 0) warnings.push("No size data found in CSV row.");

  return {
    sourceFile,
    lotNumber,
    varietyName,
    startTime,
    startDate,
    isoYear: isoYW?.isoYear ?? null,
    isoWeek: isoYW?.isoWeek ?? null,
    averageFruitWeightG,
    totalKg,
    sizeKg,
    unknownSizes,
    warnings,
    csvSizes,
    csvRowKg: [],
  };
}

// Merges DEFAULT_SIZE_ALIASES with caller-provided aliases; both keyed by
// normalizeForMatch() so case/space/brace variants of the same label share
// one entry regardless of which exact form the caller or CSV used. Exported
// so flowMasterCsvRuleResolver.ts builds the identical alias map when
// re-resolving rows later.
export function buildMergedAliasesNormalized(sizeAliases: Record<string, string>): Record<string, string> {
  const mergedAliasesNormalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(DEFAULT_SIZE_ALIASES)) {
    mergedAliasesNormalized[normalizeForMatch(k)] = v.trim();
  }
  for (const [k, v] of Object.entries(sizeAliases)) {
    mergedAliasesNormalized[normalizeForMatch(k)] = v.trim();
  }
  return mergedAliasesNormalized;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseFlowMasterCsv(
  csvContent: string,
  sourceFile: string,
  ignoredSizeLabels: string[] = [],
  sizeAliases: Record<string, string> = {}
): FlowMasterParseResult[] {
  const { headers, rows } = parseCsvRows(csvContent);
  if (rows.length === 0) return [];

  const mergedAliasesNormalized = buildMergedAliasesNormalized(sizeAliases);
  const ignoredSet = new Set(ignoredSizeLabels.map((l) => normalizeForMatch(l)));

  const newFormatColumns = detectNewFormat(headers);
  if (newFormatColumns) {
    return parseNewFormat(rows, newFormatColumns, ignoredSet, mergedAliasesNormalized, sourceFile);
  }

  // Old format: collect unique size headers (deduplicated in case of repeated column names).
  const seenHeaders = new Set<string>();
  const sizeHeaders: string[] = [];
  for (const h of headers) {
    if (!OLD_FORMAT_NON_SIZE_HEADERS.has(h) && !seenHeaders.has(h)) {
      seenHeaders.add(h);
      sizeHeaders.push(h);
    }
  }

  const results: FlowMasterParseResult[] = [];
  for (const row of rows) {
    const lotNumber = row.byName["LOTNUMBER"] ?? "";
    if (lotNumber.toLowerCase() === "repack") continue;
    results.push(rowToResult(row, sizeHeaders, mergedAliasesNormalized, sourceFile));
  }

  return results;
}

export function parseFlowMasterCsvBuffer(
  buffer: Buffer,
  fileName: string,
  ignoredSizeLabels: string[] = [],
  sizeAliases: Record<string, string> = {}
): FlowMasterParseResult[] {
  return parseFlowMasterCsv(buffer.toString("utf-8"), fileName, ignoredSizeLabels, sizeAliases);
}
