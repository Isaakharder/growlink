import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";

export type CsvSizeEntry = {
  rawLabel: string;       // normalized uppercase raw label from CSV (e.g. "X-L", "{OVERSIZED}")
  mappedSizeName: string | null; // resolved GrowLink name, null if unknown
  kg: number;             // total kg for this label across all rows in the lot
};

export type FlowMasterParseResult = {
  sourceFile: string;
  lotNumber: string | null;
  varietyName: string | null;
  startTime: string | null;
  startDate: string | null;
  isoYear: number | null;
  isoWeek: number | null;
  averageFruitWeightG: number | null;
  totalKg: number | null;
  sizeKg: Record<string, number>;
  unknownSizes: string[];
  warnings: string[];
  // Populated only for CSV files; empty for PDFs.
  // Includes ALL raw size labels (even ignored ones) so the UI can show toggle checkboxes.
  csvSizes: CsvSizeEntry[];
};

// Maps Flow Master PDF size labels → GrowLink size names.
// Extend this map when new sizes are added to GrowLink setup.
const SIZE_LABEL_MAP: Record<string, string> = {
  SM: "Small",
  MD: "Medium",
  LG: "Large",
  SXL: "SXL",
  XL: "XL",
  XXL: "XXL",
};

const IGNORED_NON_MARKET_SIZE_ROWS = new Set([
  "underweight",
  "overweight",
  "undersized",
  "oversized",
  "waste",
  "culls",
  "reject",
  "garbage"
]);

function normalizeSizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z]/g, "");
}

function toIsoYearWeek(dateStr: string): { isoYear: number; isoWeek: number } | null {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;

  // ISO 8601: week containing Thursday; Monday is day 1
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dow); // shift to Thursday of this week
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  return { isoYear: utc.getUTCFullYear(), isoWeek };
}

function parseKg(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

function extractFromText(text: string, sourceFile: string): FlowMasterParseResult {
  const warnings: string[] = [];
  const unknownSizes: string[] = [];
  const sizeKg: Record<string, number> = {};

  const lotMatch = text.match(/Product\s+Distribution\s+Lot\s+([A-Za-z0-9-]+)/i);
  const lotNumber = lotMatch?.[1]?.trim() ?? null;

  let varietyName: string | null = null;
  let startTime: string | null = null;
  let totalKg: number | null = null;
  let averageFruitWeightG: number | null = null;
  let inSizeTable = false;

  for (const rawLine of text.split("\n")) {
    const cols = rawLine.split("\t").map(c => c.trim());

    // Header field: "Variety" → next cell
    const vi = cols.indexOf("Variety");
    if (vi >= 0 && cols[vi + 1]) {
      varietyName = cols[vi + 1];
    }

    // Header field: "Start time" → next cell is "YYYY-MM-DD HH:MM"
    const sti = cols.indexOf("Start time");
    if (sti >= 0 && cols[sti + 1]) {
      const m = cols[sti + 1].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      if (m) startTime = m[1];
    }

    // Header field: "Total weight" → next cell is "N,NNN kg"
    const twi = cols.indexOf("Total weight");
    if (twi >= 0 && cols[twi + 1]) {
      const m = cols[twi + 1].match(/^([\d,]+)\s*kg/i);
      if (m) totalKg = parseKg(m[1]);
    }

    // Header field: "Average weight" → next cell is "NNN g"
    const awi = cols.indexOf("Average weight");
    if (awi >= 0 && cols[awi + 1]) {
      const m = cols[awi + 1].match(/^([\d,]+)\s*g/i);
      if (m) averageFruitWeightG = parseKg(m[1]);
    }

    // Detect the first Market/Size table header
    if (!inSizeTable && cols[0] === "Market" && cols.includes("Weight (kg)")) {
      inSizeTable = true;
      continue;
    }

    if (inSizeTable) {
      const label = cols[0];

      // Stop at Total row or page-2 Article table header
      if (!label || label === "Total" || label === "Article") {
        inSizeTable = false;
        continue;
      }

      // Skip "Market N" aggregate rows
      if (label.startsWith("Market")) continue;

      // Ignore known non-market rows (waste/culls/reject/etc.) completely.
      if (IGNORED_NON_MARKET_SIZE_ROWS.has(normalizeSizeLabel(label))) {
        continue;
      }

      // Size row layout: [label, avgG, pieces, weightKg, pct%]
      const kgStr = cols[3];
      if (!kgStr) continue;

      const kg = parseKg(kgStr);
      if (kg === null) {
        warnings.push(`Could not parse weight for size "${label}".`);
        continue;
      }

      const growlinkName = SIZE_LABEL_MAP[label];
      if (growlinkName !== undefined) {
        sizeKg[growlinkName] = kg;
      } else {
        unknownSizes.push(label);
        sizeKg[label] = kg;
        warnings.push(`New size found: ${label}. Add this size in GrowLink before importing.`);
      }
    }
  }

  if (!varietyName) warnings.push("Variety not found in PDF.");
  if (!startTime) warnings.push("Start time not found in PDF.");
  if (!lotNumber) {
    warnings.push("Lot number missing. Duplicate detection may be limited.");
  }
  if (Object.keys(sizeKg).length === 0) warnings.push("Size table could not be parsed.");

  if (totalKg !== null && Object.keys(sizeKg).length > 0) {
    const sizeSum = Object.values(sizeKg).reduce((a, b) => a + b, 0);
    if (Math.abs(sizeSum - totalKg) > 1) {
      warnings.push(
        `Total kg mismatch: PDF says ${totalKg} kg, but size sum is ${sizeSum} kg.`
      );
    }
  }

  const startDate = startTime ? startTime.slice(0, 10) : null;
  const isoYW = startDate ? toIsoYearWeek(startDate) : null;

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
    csvSizes: [],
  };
}

export async function parseFlowMasterPdf(filePath: string): Promise<FlowMasterParseResult> {
  const sourceFile = path.basename(filePath);
  const buffer = readFileSync(filePath);
  return parseFlowMasterPdfBuffer(buffer, sourceFile);
}

export async function parseFlowMasterPdfBuffer(
  buffer: Buffer,
  fileName: string
): Promise<FlowMasterParseResult> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return extractFromText(result.text, fileName);
}
