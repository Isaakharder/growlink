// Generic, delimiter/encoding-agnostic CSV grid parser for the CSV Import
// Template Builder. Independent of flowMasterCsvParser.ts's hand-rolled,
// comma-only, per-line parser — that one stays pinned to the FlowMaster
// pipeline. This one is a single-pass state machine that (a) supports
// configurable delimiters, (b) correctly handles quoted fields containing
// embedded newlines/delimiters, and (c) never interprets cell content as
// anything but plain text (no formula/HTML evaluation of any kind — cells
// are always returned as raw strings).
import type { CsvGridParseResult } from "./csvTemplateTypes";

const DELIMITER_CANDIDATES = [",", ";", "\t", "|"];

/** Tokenizes `text` into rows of raw string cells using `delimiter`. CRLF and LF line endings are both accepted. */
export function tokenizeCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function scoreDelimiter(rows: string[][]): number {
  const nonEmptyRows = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmptyRows.length === 0) return -Infinity;

  const colCounts = nonEmptyRows.map((r) => r.length);
  const avgCols = colCounts.reduce((sum, c) => sum + c, 0) / colCounts.length;
  if (avgCols <= 1) return -Infinity;

  const counts = new Map<number, number>();
  for (const c of colCounts) counts.set(c, (counts.get(c) ?? 0) + 1);
  const modalCount = Math.max(...counts.values());
  const consistency = modalCount / colCounts.length;

  return avgCols * consistency;
}

/** Picks the delimiter whose tokenization yields the most columns most consistently, using only the first `sampleLines` lines. */
export function detectDelimiter(text: string, sampleLines = 20): string {
  const sample = text.split("\n").slice(0, sampleLines).join("\n");

  let best = DELIMITER_CANDIDATES[0];
  let bestScore = -Infinity;

  for (const candidate of DELIMITER_CANDIDATES) {
    const rows = tokenizeCsvRows(sample, candidate);
    const score = scoreDelimiter(rows);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

export type DecodedCsvBuffer = { text: string; encoding: string; hadBom: boolean };

/** Detects UTF-8/UTF-16LE/UTF-16BE BOMs and strips them; otherwise decodes as UTF-8. */
export function decodeCsvBuffer(buffer: Buffer): DecodedCsvBuffer {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf-8"), encoding: "utf-8", hadBom: true };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf-16le", hadBom: true };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node has no native UTF-16BE decoder — byte-swap into LE order first.
    const body = buffer.subarray(2);
    const swapped = Buffer.alloc(body.length - (body.length % 2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return { text: swapped.toString("utf16le"), encoding: "utf-16be", hadBom: true };
  }

  return { text: buffer.toString("utf-8"), encoding: "utf-8", hadBom: false };
}

/** Parses already-decoded CSV text into a grid. Pass `delimiterOverride` to skip auto-detection (e.g. re-parsing against a saved template's configured delimiter). */
export function parseCsvGrid(text: string, delimiterOverride?: string): Omit<CsvGridParseResult, "encoding" | "hadBom"> {
  const delimiter = delimiterOverride ?? detectDelimiter(text);
  const rows = tokenizeCsvRows(text, delimiter);
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);

  return { rows, rowCount: rows.length, columnCount, delimiter };
}

/** End-to-end: raw uploaded bytes -> full grid parse result, including encoding/BOM detection. */
export function parseCsvGridFromBuffer(buffer: Buffer, delimiterOverride?: string): CsvGridParseResult {
  const { text, encoding, hadBom } = decodeCsvBuffer(buffer);
  const grid = parseCsvGrid(text, delimiterOverride);
  return { ...grid, encoding, hadBom };
}
