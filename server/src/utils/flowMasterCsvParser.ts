import { type FlowMasterParseResult } from "./flowMasterPdfParser";

export type { FlowMasterParseResult };

const SIZE_LABEL_MAP: Record<string, string> = {
  SM: "Small",
  MD: "Medium",
  LG: "Large",
  SXL: "SXL",
  XL: "XL",
  XXL: "XXL",
};

// Headers that are metadata, not size columns.
const NON_SIZE_HEADERS = new Set(["LOTNUMBER", "BEGINDT", "VARIETY", "AVG", "WEIGHT"]);

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

function parseCsvRows(content: string): Array<Record<string, string>> {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return [];

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
  return rows;
}

// Parses DDMMYYYY HH:mm:ss → "YYYY-MM-DD HH:mm" (same shape as PDF parser's startTime).
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

function rowToResult(
  row: Record<string, string>,
  sizeHeaders: string[],
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

  for (const header of sizeHeaders) {
    const rawKg = row[header];
    if (!rawKg) continue;
    const kg = parseKg(rawKg);
    if (kg === null || kg === 0) continue;

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
  };
}

export function parseFlowMasterCsv(
  csvContent: string,
  sourceFile: string
): FlowMasterParseResult[] {
  const rows = parseCsvRows(csvContent);
  if (rows.length === 0) return [];

  const sizeHeaders = Object.keys(rows[0]).filter((h) => !NON_SIZE_HEADERS.has(h));
  const results: FlowMasterParseResult[] = [];

  for (const row of rows) {
    const lotNumber = row["LOTNUMBER"] ?? "";
    if (lotNumber.toLowerCase() === "repack") continue;
    results.push(rowToResult(row, sizeHeaders, sourceFile));
  }

  return results;
}

export function parseFlowMasterCsvBuffer(
  buffer: Buffer,
  fileName: string
): FlowMasterParseResult[] {
  return parseFlowMasterCsv(buffer.toString("utf-8"), fileName);
}
