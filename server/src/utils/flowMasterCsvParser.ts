import { type FlowMasterParseResult, type CsvSizeEntry } from "./flowMasterPdfParser";

export type { FlowMasterParseResult, CsvSizeEntry };

const SIZE_LABEL_MAP: Record<string, string> = {
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
// Caller-provided sizeAliases extend (and override) these.
const DEFAULT_SIZE_ALIASES: Record<string, string> = {
  "X-L": "SXL",
};

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

type CsvParsed = {
  // Raw header list in original column order (may contain duplicates).
  // Kept separate from row records so detectNewFormat can use true column indices.
  headers: string[];
  rows: Array<Record<string, string>>;
};

function parseCsvRows(content: string): CsvParsed {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return { headers: [], rows: [] };

  const rawHeaders = parseCsvLine(lines[0]);
  const headers = rawHeaders.map((h) => h.trim().toUpperCase());

  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? "").trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

// Parses DDMMYYYY HH:mm:ss → "YYYY-MM-DD HH:mm" (same shape as PDF parser output).
function parseBegindtToIso(value: string): string | null {
  const m = value.match(/^(\d{2})(\d{2})(\d{4})\s+(\d{2}:\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, time] = m;
  return `${yyyy}-${mm}-${dd} ${time}`;
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

// ─── New format (SIZE1 / WEIGHT-after-SIZE1 layout) ───────────────────────────
//
// Detected by:
//   1. A SIZE1 column exists in the header row.
//   2. A WEIGHT-variant column (matching /^WEIGHT(\.\d+)?$/) exists at a column
//      index *after* SIZE1. This is the per-size weight; any WEIGHT column that
//      appears before SIZE1 is the lot-level total and is deliberately ignored.
//
// Multiple data rows share the same LOTNUMBER (one row per size). All rows for a
// given LOTNUMBER are grouped and reduced into a single FlowMasterParseResult.
//
// REPACK skip: rows where LOTID contains "repack" (case-insensitive substring).
// AVG: read from the first row of the lot group for averageFruitWeightG.

type NewFormatInfo = {
  sizeWeightHeader: string; // e.g. "WEIGHT.1" or "WEIGHT" — whatever appears after SIZE1
};

// Scans the raw header array (original column order, duplicates preserved) to
// find the first WEIGHT-variant column that comes after SIZE1's column index.
function detectNewFormat(headers: string[]): NewFormatInfo | null {
  const size1Idx = headers.indexOf("SIZE1");
  if (size1Idx < 0) return null;

  for (let i = size1Idx + 1; i < headers.length; i++) {
    if (/^WEIGHT(\.\d+)?$/.test(headers[i])) {
      return { sizeWeightHeader: headers[i] };
    }
  }
  return null;
}

function buildNewFormatResult(
  lotNumber: string,
  rows: Record<string, string>[],
  sizeWeightHeader: string,
  ignoredSet: Set<string>,
  mergedAliases: Record<string, string>,
  sourceFile: string
): FlowMasterParseResult {
  const firstRow = rows[0];
  const warnings: string[] = [];
  const unknownSizes: string[] = [];
  const sizeKg: Record<string, number> = {};

  const varietyName = firstRow["VARIETY"]?.trim() || null;

  const begindtRaw = (firstRow["BEGINDT"] ?? "").trim();
  const startTime = begindtRaw ? parseBegindtToIso(begindtRaw) : null;
  if (begindtRaw && !startTime) {
    warnings.push(`Could not parse BEGINDT: "${begindtRaw}".`);
  }
  const startDate = startTime ? startTime.slice(0, 10) : null;
  const isoYW = startDate ? toIsoYearWeek(startDate) : null;

  const avgRaw = (firstRow["AVG"] ?? "").trim();
  const averageFruitWeightG = avgRaw ? parseKg(avgRaw) : null;

  // Pre-scan ALL rows (before ignored filter) to build csvSizes for UI toggles.
  const csvSizesMap = new Map<string, { mappedSizeName: string | null; kg: number }>();
  for (const row of rows) {
    const size1 = (row["SIZE1"] ?? "").trim().toUpperCase();
    if (!size1) continue;
    const weightRaw = (row[sizeWeightHeader] ?? "").trim();
    if (!weightRaw) continue;
    const kg = parseKg(weightRaw);
    if (kg === null || kg === 0) continue;
    const mappedSizeName = mergedAliases[size1] ?? SIZE_LABEL_MAP[size1] ?? null;
    const existing = csvSizesMap.get(size1);
    if (existing) { existing.kg += kg; } else { csvSizesMap.set(size1, { mappedSizeName, kg }); }
  }
  const csvSizes: CsvSizeEntry[] = Array.from(csvSizesMap.entries()).map(([rawLabel, d]) => ({
    rawLabel, mappedSizeName: d.mappedSizeName, kg: d.kg,
  }));

  for (const row of rows) {
    const size1 = (row["SIZE1"] ?? "").trim().toUpperCase();
    if (!size1) continue;
    if (ignoredSet.has(size1)) continue;

    const weightRaw = (row[sizeWeightHeader] ?? "").trim();
    if (!weightRaw) continue;
    const kg = parseKg(weightRaw);
    if (kg === null || kg === 0) continue;

    const aliasName = mergedAliases[size1];
    if (aliasName !== undefined) {
      sizeKg[aliasName] = (sizeKg[aliasName] ?? 0) + kg;
    } else {
      const growlinkName = SIZE_LABEL_MAP[size1];
      if (growlinkName !== undefined) {
        sizeKg[growlinkName] = (sizeKg[growlinkName] ?? 0) + kg;
      } else {
        if (!unknownSizes.includes(size1)) {
          unknownSizes.push(size1);
          warnings.push(`New size found: ${size1}. Add this size in GrowLink before importing.`);
        }
        sizeKg[size1] = (sizeKg[size1] ?? 0) + kg;
      }
    }
  }

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
  };
}

function parseNewFormat(
  rows: Record<string, string>[],
  sizeWeightHeader: string,
  ignoredSet: Set<string>,
  mergedAliases: Record<string, string>,
  sourceFile: string
): FlowMasterParseResult[] {
  const grouped = new Map<string, Record<string, string>[]>();

  for (const row of rows) {
    const lotId = row["LOTID"] ?? "";
    if (lotId.toLowerCase().includes("repack")) continue;
    const lotNumber = (row["LOTNUMBER"] ?? "").trim();
    if (!lotNumber) continue;
    if (!grouped.has(lotNumber)) grouped.set(lotNumber, []);
    grouped.get(lotNumber)!.push(row);
  }

  return Array.from(grouped.entries()).map(([lotNumber, lotRows]) =>
    buildNewFormatResult(lotNumber, lotRows, sizeWeightHeader, ignoredSet, mergedAliases, sourceFile)
  );
}

// ─── Old format (SM / MD / LG column-header layout) ──────────────────────────
// One row per lot; size column headers are anything not in OLD_FORMAT_NON_SIZE_HEADERS.
// REPACK detection compares LOTNUMBER === "repack" (case-insensitive, exact match).

function rowToResult(
  row: Record<string, string>,
  sizeHeaders: string[],
  mergedAliases: Record<string, string>,
  sourceFile: string
): FlowMasterParseResult {
  const warnings: string[] = [];
  const unknownSizes: string[] = [];
  const sizeKg: Record<string, number> = {};

  const lotNumber = row["LOTNUMBER"] || null;
  const varietyName = row["VARIETY"] || null;

  const avgRaw = row["AVG"];
  const averageFruitWeightG = avgRaw ? parseKg(avgRaw) : null;

  const begindtRaw = row["BEGINDT"] ?? "";
  const startTime = begindtRaw ? parseBegindtToIso(begindtRaw) : null;
  if (begindtRaw && !startTime) {
    warnings.push(`Could not parse BEGINDT: "${begindtRaw}".`);
  }

  const startDate = startTime ? startTime.slice(0, 10) : null;
  const isoYW = startDate ? toIsoYearWeek(startDate) : null;

  // Build csvSizes from all size columns (for UI toggle checkboxes).
  const csvSizes: CsvSizeEntry[] = sizeHeaders
    .map((header): CsvSizeEntry | null => {
      const rawKg = row[header];
      if (!rawKg) return null;
      const kg = parseKg(rawKg);
      if (kg === null || kg === 0) return null;
      const mappedSizeName: string | null = mergedAliases[header] ?? SIZE_LABEL_MAP[header] ?? null;
      return { rawLabel: header, mappedSizeName, kg };
    })
    .filter((e): e is CsvSizeEntry => e !== null);

  for (const header of sizeHeaders) {
    const rawKg = row[header];
    if (!rawKg) continue;
    const kg = parseKg(rawKg);
    if (kg === null || kg === 0) continue;

    const aliasName = mergedAliases[header];
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
  };
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

  // Merge DEFAULT_SIZE_ALIASES with caller-provided aliases; both keyed by uppercase raw label.
  const mergedAliases: Record<string, string> = { ...DEFAULT_SIZE_ALIASES };
  for (const [k, v] of Object.entries(sizeAliases)) {
    mergedAliases[k.trim().toUpperCase()] = v.trim();
  }

  const newFormatInfo = detectNewFormat(headers);
  if (newFormatInfo) {
    const ignoredSet = new Set(ignoredSizeLabels.map((l) => l.trim().toUpperCase()));
    return parseNewFormat(rows, newFormatInfo.sizeWeightHeader, ignoredSet, mergedAliases, sourceFile);
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
    const lotNumber = row["LOTNUMBER"] ?? "";
    if (lotNumber.toLowerCase() === "repack") continue;
    results.push(rowToResult(row, sizeHeaders, mergedAliases, sourceFile));
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
