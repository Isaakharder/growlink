export interface ParsedReading {
  zone_label: string | null;
  metric_name: string;
  metric_value: number;
  unit: string;
}

export type ClimateFileType = "weather_station" | "block_summary";
