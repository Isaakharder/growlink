import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type GroupType = "phase" | "zone" | "color";

type EquipmentReading = {
  id: string;
  name: string;
  volume_ml: number | null;
};

type IrrigationLogRecord = {
  id: string;
  log_date: string;
  tracking_mode: GroupType;
  group_name: string;
  feed_valve_readings?: EquipmentReading[];
  drain_bucket_readings?: EquipmentReading[];
  feed_ec: number | null;
  feed_ph: number | null;
  drain_ec: number | null;
  drain_ph: number | null;
  notes: string | null;
};

type SummaryMetric = {
  label: string;
  value: string;
};

const IRRIGATION_LOGS_URL = "/api/irrigation/logs?days=30";

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseReadingVolumes(readings: EquipmentReading[] | undefined): number[] {
  return (readings ?? [])
    .map((reading) => reading.volume_ml)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function averageOf(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function formatNumber(value: number | null, decimals = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return String(roundTo(value, decimals));
}

function formatPercent(value: number | null, decimals = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return `${roundTo(value, decimals)}%`;
}

function capitalize(value: string) {
  if (!value) {
    return value;
  }

  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function computeRowMetrics(log: IrrigationLogRecord) {
  const feedValues = parseReadingVolumes(log.feed_valve_readings);
  const drainValues = parseReadingVolumes(log.drain_bucket_readings);

  const avgFeedMl = averageOf(feedValues);
  const avgDrainMl = averageOf(drainValues);
  const drainPercent =
    avgFeedMl !== null && avgFeedMl > 0 && avgDrainMl !== null
      ? (avgDrainMl / avgFeedMl) * 100
      : null;

  return {
    avgFeedMl,
    avgDrainMl,
    drainPercent
  };
}

export function IrrigationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<IrrigationLogRecord[]>([]);

  useEffect(() => {
    let active = true;

    async function fetchLogs() {
      setLoading(true);
      setError(null);

      try {
        const response = await apiFetch(IRRIGATION_LOGS_URL);

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `Failed to load irrigation logs (${response.status})`);
        }

        const data = (await response.json()) as IrrigationLogRecord[];

        if (active) {
          setLogs(data ?? []);
        }
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load irrigation logs");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void fetchLogs();

    return () => {
      active = false;
    };
  }, []);

  const rowsWithMetrics = useMemo(
    () => logs.map((log) => ({ log, metrics: computeRowMetrics(log) })),
    [logs]
  );

  const summary = useMemo(() => {
    const avgFeedValues = rowsWithMetrics
      .map((entry) => entry.metrics.avgFeedMl)
      .filter((value): value is number => value !== null);

    const avgDrainValues = rowsWithMetrics
      .map((entry) => entry.metrics.avgDrainMl)
      .filter((value): value is number => value !== null);

    const drainPercentValues = rowsWithMetrics
      .map((entry) => entry.metrics.drainPercent)
      .filter((value): value is number => value !== null);

    const feedEcValues = logs
      .map((entry) => entry.feed_ec)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const feedPhValues = logs
      .map((entry) => entry.feed_ph)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const drainEcValues = logs
      .map((entry) => entry.drain_ec)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const drainPhValues = logs
      .map((entry) => entry.drain_ph)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const metrics: SummaryMetric[] = [
      { label: "Avg feed ml", value: formatNumber(averageOf(avgFeedValues)) },
      { label: "Avg drain ml", value: formatNumber(averageOf(avgDrainValues)) },
      { label: "Avg drain %", value: formatPercent(averageOf(drainPercentValues)) },
      { label: "Avg feed EC", value: formatNumber(averageOf(feedEcValues), 3) },
      { label: "Avg feed pH", value: formatNumber(averageOf(feedPhValues), 3) },
      { label: "Avg drain EC", value: formatNumber(averageOf(drainEcValues), 3) },
      { label: "Avg drain pH", value: formatNumber(averageOf(drainPhValues), 3) }
    ];

    return metrics;
  }, [logs, rowsWithMetrics]);

  return (
    <section className="page-shell">
      <header>
        <h1>Irrigation</h1>
        <p>Last 30 days of mobile irrigation logs with summary metrics.</p>
      </header>

      <div className="coming-soon-card">
        <h2>30-Day Summary</h2>

        {loading ? <p>Loading...</p> : null}
        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && logs.length === 0 ? (
          <p>No irrigation logs in the last 30 days.</p>
        ) : null}

        {!loading && !error && logs.length > 0 ? (
          <div className="irrigation-summary-grid">
            {summary.map((metric) => (
              <div key={metric.label} className="irrigation-summary-card">
                <p className="irrigation-summary-label">{metric.label}</p>
                <p className="irrigation-summary-value">{metric.value}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="coming-soon-card">
        <h2>Raw Logs (Last 30 Days)</h2>

        {loading ? <p>Loading...</p> : null}
        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && logs.length === 0 ? (
          <p>No irrigation logs available to display.</p>
        ) : null}

        {!loading && !error && logs.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Tracking Mode</th>
                  <th>Group</th>
                  <th>Feed Valve Readings</th>
                  <th>Drain Bucket Readings</th>
                  <th>Avg Feed ml</th>
                  <th>Avg Drain ml</th>
                  <th>Drain %</th>
                  <th>Feed EC / pH</th>
                  <th>Drain EC / pH</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rowsWithMetrics.map(({ log, metrics }) => (
                  <tr key={log.id}>
                    <td>{log.log_date}</td>
                    <td>{capitalize(log.tracking_mode)}</td>
                    <td>{log.group_name}</td>
                    <td>
                      {(log.feed_valve_readings ?? []).length === 0 ? (
                        "--"
                      ) : (
                        <ul className="irrigation-reading-list">
                          {(log.feed_valve_readings ?? []).map((reading) => (
                            <li key={`feed-${log.id}-${reading.id}`}>
                              {reading.name}: {formatNumber(reading.volume_ml)} ml
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      {(log.drain_bucket_readings ?? []).length === 0 ? (
                        "--"
                      ) : (
                        <ul className="irrigation-reading-list">
                          {(log.drain_bucket_readings ?? []).map((reading) => (
                            <li key={`drain-${log.id}-${reading.id}`}>
                              {reading.name}: {formatNumber(reading.volume_ml)} ml
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>{formatNumber(metrics.avgFeedMl)}</td>
                    <td>{formatNumber(metrics.avgDrainMl)}</td>
                    <td>{formatPercent(metrics.drainPercent)}</td>
                    <td>
                      EC: {formatNumber(log.feed_ec, 3)}
                      <br />
                      pH: {formatNumber(log.feed_ph, 3)}
                    </td>
                    <td>
                      EC: {formatNumber(log.drain_ec, 3)}
                      <br />
                      pH: {formatNumber(log.drain_ph, 3)}
                    </td>
                    <td>{log.notes?.trim() ? log.notes : "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
