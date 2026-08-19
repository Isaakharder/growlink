import { type FlowMasterParseResult } from "./flowMasterPdfParser";

export type ColumnMappings = {
  unique_key_column: string;
  date_column?: string | null;
  variety_column?: string | null;
  kg_total_column?: string | null;
  size_columns?: Record<string, string>;
};

// Parses a single CSV line, handling double-quoted fields and embedded commas.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// Parses CSV text into { headers, rows }.
// Returns an empty result on completely empty input.
export function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(nonEmpty[0]);
  const rows = nonEmpty.slice(1).map((l) => parseCsvLine(l));
  return { headers, rows };
}

// Returns only the header row from a CSV buffer.
export function extractCsvHeaders(buffer: Buffer): string[] {
  const text = buffer.toString("utf-8");
  const { headers } = parseCsvText(text);
  return headers;
}

// Derives ISO year and week number from a date string.
// Tries Date.parse first; falls back to DD/MM/YYYY.
function parseIsoWeek(
  value: string
): { isoYear: number; isoWeek: number } | null {
  let d = new Date(value);

  if (isNaN(d.getTime())) {
    // Try DD/MM/YYYY
    const parts = value.trim().split(/[\/\-\.]/);
    if (parts.length === 3) {
      const [a, b, c] = parts;
      d = new Date(`${c}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`);
    }
  }

  if (isNaN(d.getTime())) return null;

  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { isoYear: utc.getUTCFullYear(), isoWeek };
}

// Parses a CSV buffer using the provided column mappings and returns one
// FlowMasterParseResult per unique_key value found in the file.
// Rows with the same unique_key are merged (size_kg values are summed).
export function parseGenericCsvBuffer(
  buffer: Buffer,
  sourceFile: string,
  mappings: ColumnMappings
): FlowMasterParseResult[] {
  const text = buffer.toString("utf-8");
  const { headers, rows } = parseCsvText(text);

  if (headers.length === 0) {
    throw new Error("CSV file is empty or has no header row.");
  }

  const headerIndex = new Map<string, number>();
  headers.forEach((h, i) => headerIndex.set(h, i));

  const colIdx = (name: string | null | undefined): number => {
    if (!name) return -1;
    return headerIndex.get(name) ?? -1;
  };

  const uniqueKeyIdx = colIdx(mappings.unique_key_column);
  if (uniqueKeyIdx === -1) {
    throw new Error(
      `Unique key column "${mappings.unique_key_column}" not found in CSV. ` +
        `Available columns: ${headers.join(", ")}`
    );
  }

  const dateIdx = colIdx(mappings.date_column);
  const varietyIdx = colIdx(mappings.variety_column);
  const totalKgIdx = colIdx(mappings.kg_total_column);

  const sizeIndices: Record<string, number> = {};
  for (const [sizeName, colName] of Object.entries(mappings.size_columns ?? {})) {
    const idx = colIdx(colName);
    if (idx !== -1) sizeIndices[sizeName] = idx;
  }

  type Accumulator = {
    lotNumber: string;
    varietyName: string | null;
    isoYear: number | null;
    isoWeek: number | null;
    startTime: string | null;
    sizeKg: Record<string, number>;
    totalKg: number | null;
    warnings: string[];
  };

  const accumulated = new Map<string, Accumulator>();

  rows.forEach((row, rowIdx) => {
    const rawKey = row[uniqueKeyIdx];
    if (!rawKey || rawKey.trim() === "") {
      return;
    }
    const key = rawKey.trim();

    let acc = accumulated.get(key);
    if (!acc) {
      acc = {
        lotNumber: key,
        varietyName: null,
        isoYear: null,
        isoWeek: null,
        startTime: null,
        sizeKg: {},
        totalKg: null,
        warnings: [],
      };
      accumulated.set(key, acc);
    }

    // Variety — take first non-empty value seen for this key.
    if (varietyIdx !== -1 && acc.varietyName === null) {
      const raw = row[varietyIdx]?.trim();
      if (raw) acc.varietyName = raw;
    }

    // Date — take first parseable value seen for this key.
    if (dateIdx !== -1 && acc.isoYear === null) {
      const raw = row[dateIdx]?.trim();
      if (raw) {
        const parsed = parseIsoWeek(raw);
        if (parsed) {
          acc.isoYear = parsed.isoYear;
          acc.isoWeek = parsed.isoWeek;
          acc.startTime = raw;
        } else {
          acc.warnings.push(`Row ${rowIdx + 2}: could not parse date "${raw}".`);
        }
      }
    }

    // Size columns — sum across rows with the same key.
    for (const [sizeName, idx] of Object.entries(sizeIndices)) {
      const raw = row[idx]?.trim();
      if (raw) {
        const kg = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
        if (Number.isFinite(kg) && kg >= 0) {
          acc.sizeKg[sizeName] = (acc.sizeKg[sizeName] ?? 0) + kg;
        }
      }
    }

    // Total KG — sum if multiple rows share the same key.
    if (totalKgIdx !== -1) {
      const raw = row[totalKgIdx]?.trim();
      if (raw) {
        const kg = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
        if (Number.isFinite(kg) && kg >= 0) {
          acc.totalKg = (acc.totalKg ?? 0) + kg;
        }
      }
    }
  });

  if (accumulated.size === 0) {
    throw new Error(
      `CSV parsed successfully but found no rows with a value in column "${mappings.unique_key_column}".`
    );
  }

  return Array.from(accumulated.values()).map((acc) => ({
    sourceFile,
    lotNumber: acc.lotNumber,
    varietyName: acc.varietyName,
    startTime: acc.startTime,
    startDate: acc.startTime?.slice(0, 10) ?? null,
    isoYear: acc.isoYear,
    isoWeek: acc.isoWeek,
    averageFruitWeightG: null,
    totalKg: acc.totalKg ?? (Object.values(acc.sizeKg).reduce((s, v) => s + v, 0) || null),
    sizeKg: acc.sizeKg,
    unknownSizes: [],
    warnings: acc.warnings,
    csvSizes: [],
    csvRowKg: [],
  }));
}
