import { parse } from "csv-parse/sync";
import { BLOCK_SUMMARY_METRICS } from "./metricConfig";
import { ParsedReading } from "./types";

// "-" is the placeholder Ridder uses for "no sensor/no value" in metric
// rows; it never appears in header rows, so it's excluded from the
// header-shape check below.
function looksLikeDataCell(cell: string): boolean {
  if (cell === "-") return true;
  return Number.isFinite(Number(cell));
}

// Block summary CSV is a stack of category blocks (Temperature, Humidity,
// Heating setpoint (CH), ...), each introduced by a header row whose
// columns are zone/room labels. The column set differs per block (e.g.
// "Heating setpoint (CH)" omits Boiler Room Downstairs), so the header
// immediately above a metric row is the only valid source of column
// labels for that row -- never assume a fixed, file-wide column list.
export function parseBlockSummaryCsv(content: string): ParsedReading[] {
  const rows: string[][] = parse(content, { relax_column_count: true });
  const readings: ParsedReading[] = [];
  let columnLabels: string[] = [];

  for (const row of rows) {
    if (row.length === 0) continue;
    const first = (row[0] ?? "").trim();
    if (first === "") continue;

    const rest = row.slice(1).map((cell) => (cell ?? "").trim());
    const isHeaderRow = rest.length > 0 && rest.every((cell) => cell === "" || !looksLikeDataCell(cell));

    if (isHeaderRow) {
      columnLabels = rest;
      continue;
    }

    const mapping = BLOCK_SUMMARY_METRICS[first.toLowerCase()];
    if (!mapping) continue;

    for (let i = 0; i < columnLabels.length; i++) {
      const label = columnLabels[i];
      if (!label) continue; // blank trailing header cell -> no real column for this block
      const raw = rest[i] ?? "";
      if (raw === "" || raw === "-") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;

      readings.push({
        zone_label: label,
        metric_name: mapping.metricName,
        metric_value: value,
        unit: mapping.unit,
      });
    }
  }

  return readings;
}
