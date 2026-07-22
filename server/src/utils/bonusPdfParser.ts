import { PDFParse } from "pdf-parse";
import { CheckType } from "./bonusCalc";

// Parses the weekly production-report PDF used to import Bonus Entry data.
// Two report variants exist, distinguished by their speed column/unit — the
// unit itself is the job signal, there is no separate "Activity" column:
//
//   Kg/Hr        -> Picking (matches the existing kg/hr Picking Setup unit)
//   Plants/Hr    -> Winding/Pruning (1 plant = 1 head; matches heads/hr)
//
//   Period: 2026-07-12 - 2026-07-18
//   Filter:
//   Company: First Light
//
//   Employee                 Kg/Hr      Paid time   #rows
//   Ramos, Ricardo, Melo     99.2 Kg/Hr 5:23         7.67
//   ...
//   Grand Total              184.6 Kg/Hr 203:42      326.54
//
// Row parsing is anchored on the literal unit token and the "H:MM" paid-time
// suffix rather than a fixed column/tab position, since pdf-parse's text
// extraction for a bordered table is not guaranteed to preserve consistent
// tab/column spacing. The trailing "#rows" column (only present in the
// Picking variant) is ignored — it isn't part of the bonus calculation.

export type BonusPdfRow = {
  rawName: string;
  checkType: CheckType;
  enteredSpeed: number;
  rawUnit: string;
  rawPaidTime: string;
  hoursWorked: number;
};

export type BonusPdfParseResult = {
  sourceFile: string;
  periodStart: string | null;
  periodEnd: string | null;
  company: string | null;
  checkType: CheckType | null; // the job detected from the file's rows; null if mixed/undetected
  rows: BonusPdfRow[];
  grandTotal: { enteredSpeed: number; hoursWorked: number } | null;
  warnings: string[];
};

const ROW_PATTERN = /^(.+?)\s+([\d,.]+)\s*(Kg\/Hr|Plants\/Hr)\s+(\d{1,4}):(\d{2})(?:\s+[\d,.]+)?\s*$/i;

function unitToCheckType(unit: string): CheckType {
  return unit.toLowerCase() === "kg/hr" ? "picking_peppers" : "winding_pruning";
}

function parsePaidTime(hh: string, mm: string): number {
  const hours = parseInt(hh, 10);
  const minutes = parseInt(mm, 10);
  return Math.round((hours + minutes / 60) * 100) / 100;
}

function parseNumber(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractFromText(text: string, sourceFile: string): BonusPdfParseResult {
  const warnings: string[] = [];
  const rows: BonusPdfRow[] = [];
  let grandTotal: { enteredSpeed: number; hoursWorked: number } | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let company: string | null = null;

  const periodMatch = text.match(/Period:\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  if (periodMatch) {
    periodStart = periodMatch[1];
    periodEnd = periodMatch[2];
  }

  const companyMatch = text.match(/Company:\s*(.+)/);
  if (companyMatch) {
    company = companyMatch[1].trim() || null;
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(ROW_PATTERN);
    if (!match) continue;

    const [, rawName, speedStr, unit, hh, mm] = match;
    const name = rawName.trim();
    const speed = parseNumber(speedStr);
    if (speed === null) {
      warnings.push(`Could not parse speed on row: "${line}".`);
      continue;
    }
    const hoursWorked = parsePaidTime(hh, mm);
    const checkType = unitToCheckType(unit);

    if (name.toLowerCase() === "grand total") {
      grandTotal = { enteredSpeed: speed, hoursWorked };
      continue;
    }

    rows.push({
      rawName: name,
      checkType,
      enteredSpeed: speed,
      rawUnit: unit,
      rawPaidTime: `${hh}:${mm}`,
      hoursWorked
    });
  }

  const detectedTypes = new Set(rows.map((r) => r.checkType));
  const checkType = detectedTypes.size === 1 ? [...detectedTypes][0] : null;
  if (detectedTypes.size > 1) {
    warnings.push("This file mixes Kg/Hr and Plants/Hr rows — could not determine a single job for the import.");
  }

  if (!periodStart || !periodEnd) warnings.push("Report period not found in PDF.");
  if (rows.length === 0) warnings.push("No employee rows could be parsed from the PDF.");

  if (grandTotal) {
    const hoursSum = rows.reduce((s, r) => s + r.hoursWorked, 0);
    if (Math.abs(hoursSum - grandTotal.hoursWorked) > 0.5) {
      warnings.push(
        `Paid time mismatch: PDF Grand Total is ${grandTotal.hoursWorked} hrs, but parsed rows sum to ${Math.round(hoursSum * 100) / 100} hrs.`
      );
    }
  } else {
    warnings.push("Grand Total row not found — could not cross-check parsed totals.");
  }

  return { sourceFile, periodStart, periodEnd, company, checkType, rows, grandTotal, warnings };
}

export async function parseBonusPdfBuffer(buffer: Buffer, fileName: string): Promise<BonusPdfParseResult> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return extractFromText(result.text, fileName);
}

// Exported for unit testing the row/unit-detection logic directly against
// sample report text, without needing a real PDF fixture file on disk.
export { extractFromText as extractBonusPdfFromText };
