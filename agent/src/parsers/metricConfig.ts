// Declarative map of raw CSV label (lowercased) -> normalized metric name + unit.
// Adding a metric for v2 is a one-line addition here, no parser changes needed.

interface MetricMapping {
  metricName: string;
  unit: string;
}

export const WEATHER_STATION_METRICS: Record<string, MetricMapping> = {
  "radiation sum [j/cm²]": { metricName: "radiation_sum", unit: "J/cm²" },
};

export const BLOCK_SUMMARY_METRICS: Record<string, MetricMapping> = {
  "air temperature [°c]": { metricName: "air_temperature", unit: "°C" },
  "calculated heating setpoint (ch) [°c]": { metricName: "heating_setpoint_ch", unit: "°C" },
  "rh [%]": { metricName: "rh", unit: "%" },
};
