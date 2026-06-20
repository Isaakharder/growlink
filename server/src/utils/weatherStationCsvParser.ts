import { createHash } from "crypto";
import { parseCsvText } from "./genericCsvParser";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WeatherStationMappings = {
  station_name_key?: string | null;
  radiation_sum_key?: string | null;
  radiation_intensity_key?: string | null;
  temperature_key?: string | null;
  rh_key?: string | null;
  rain_intensity_key?: string | null;
  barometric_pressure_key?: string | null;
};

export type WeatherStationReading = {
  metric_name: string;
  metric_value: number;
  unit: string;
  zone_label: string | null;
};

export type WeatherStationParseResult = {
  exportTimestamp: string;   // ISO 8601 UTC, extracted from filename
  stationName: string | null;
  fileHash: string;          // SHA-256 of CSV text, used for climate_imports dedup
  readings: WeatherStationReading[];
};

// ── Metric definitions ────────────────────────────────────────────────────────

// Maps each mapping key to the metric_name and unit stored in climate_readings.
const METRIC_DEFINITIONS: Array<{
  key: keyof WeatherStationMappings;
  metricName: string;
  unit: string;
}> = [
  { key: "radiation_sum_key",       metricName: "radiation_sum",       unit: "J/cm²"  },
  { key: "radiation_intensity_key", metricName: "radiation_intensity", unit: "W/m²"   },
  { key: "temperature_key",         metricName: "outside_temp",        unit: "°C"     },
  { key: "rh_key",                  metricName: "rh",                  unit: "%"      },
  { key: "rain_intensity_key",      metricName: "rain_intensity",      unit: "mm/h"   },
  { key: "barometric_pressure_key", metricName: "barometric_pressure", unit: "hPa"    },
];

// ── Timestamp extraction ──────────────────────────────────────────────────────

// Extracts a UTC timestamp from filenames matching *_YYYYMMDD_HHMMSS.*.
// Example: "Weather stations_20260613_210007.csv" → "2026-06-13T21:00:07.000Z"
// Returns null if the pattern is not found or the date is invalid.
export function extractTimestampFromFilename(filename: string): string | null {
  const match = /(\d{8})_(\d{6})(?:\.\w+)?(?:$|[^0-9])/.exec(filename);
  if (!match) return null;
  const d = match[1];
  const t = match[2];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}.000Z`;
  return isNaN(Date.parse(iso)) ? null : iso;
}

// ── Row-key extraction (used by admin template page) ─────────────────────────

// Returns every first-column value from a key/value CSV buffer (including what
// parseCsvText treats as the header row, since for this format it is a data row).
export function extractWeatherStationRowKeys(buffer: Buffer): string[] {
  const text = buffer.toString("utf-8");
  const { headers, rows } = parseCsvText(text);
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const k = v.trim();
    if (k && !seen.has(k)) { seen.add(k); keys.push(k); }
  };
  if (headers.length >= 1) push(headers[0]);
  for (const row of rows) { if (row.length >= 1) push(row[0]); }
  return keys;
}

// ── Parser ────────────────────────────────────────────────────────────────────

// Parses a key/value weather station CSV (two columns: label, value).
// Throws if the timestamp cannot be extracted from the filename.
// Non-throwing: missing or non-numeric metric rows are silently skipped.
export function parseWeatherStationCsv(
  buffer: Buffer,
  filename: string,
  mappings: WeatherStationMappings
): WeatherStationParseResult {
  const text = buffer.toString("utf-8");
  const fileHash = createHash("sha256").update(text).digest("hex");

  const exportTimestamp = extractTimestampFromFilename(filename);
  if (!exportTimestamp) {
    throw new Error(
      `Cannot extract timestamp from filename "${filename}". ` +
        `Expected pattern *_YYYYMMDD_HHMMSS.csv (e.g. Weather stations_20260613_210007.csv).`
    );
  }

  // Build a label→value map. parseCsvText treats row 0 as headers; for this
  // key/value format the "header" row is also data (e.g. "Measured"→station name).
  const { headers, rows } = parseCsvText(text);
  const kvMap = new Map<string, string>();
  const addRow = (cols: string[]) => {
    if (cols.length >= 2) {
      const k = cols[0].trim();
      if (k && !kvMap.has(k)) kvMap.set(k, cols[1].trim());
    }
  };
  addRow(headers);
  for (const row of rows) addRow(row);

  // Station name: value of the configured row key, or the first row's value.
  let stationName: string | null = null;
  const snKey = mappings.station_name_key?.trim();
  if (snKey) {
    stationName = kvMap.get(snKey) ?? null;
  }
  if (!stationName && headers.length >= 2 && headers[1].trim()) {
    stationName = headers[1].trim();
  }

  // Build readings for each configured metric.
  const readings: WeatherStationReading[] = [];
  for (const def of METRIC_DEFINITIONS) {
    const rowKey = mappings[def.key]?.trim();
    if (!rowKey) continue;
    const rawVal = kvMap.get(rowKey);
    if (rawVal === undefined) continue;
    const numeric = parseFloat(rawVal.replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(numeric)) continue;
    readings.push({
      metric_name: def.metricName,
      metric_value: numeric,
      unit: def.unit,
      zone_label: stationName,
    });
  }

  return { exportTimestamp, stationName, fileHash, readings };
}
