import { parse } from "csv-parse/sync";
import { WEATHER_STATION_METRICS } from "./metricConfig";
import { ParsedReading } from "./types";

const SECTION_NAMES = new Set(["measured", "totals", "status"]);

// Weather stations CSV is a stack of sections (Measured / Totals / Status),
// each introduced by a header row naming the station columns. Station name
// becomes zone_label so multiple stations at one site don't collide.
export function parseWeatherStationCsv(content: string): ParsedReading[] {
  const rows: string[][] = parse(content, { relax_column_count: true });
  const readings: ParsedReading[] = [];
  let stationNames: string[] = [];

  for (const row of rows) {
    if (row.length === 0) continue;
    const first = (row[0] ?? "").trim();
    if (first === "") continue;

    if (SECTION_NAMES.has(first.toLowerCase())) {
      stationNames = row.slice(1).map((cell) => (cell ?? "").trim());
      continue;
    }

    const mapping = WEATHER_STATION_METRICS[first.toLowerCase()];
    if (!mapping) continue;

    for (let i = 0; i < stationNames.length; i++) {
      const stationName = stationNames[i];
      if (!stationName) continue;
      const raw = (row[i + 1] ?? "").trim();
      if (raw === "" || raw === "-") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;

      readings.push({
        zone_label: stationName,
        metric_name: mapping.metricName,
        metric_value: value,
        unit: mapping.unit,
      });
    }
  }

  return readings;
}
