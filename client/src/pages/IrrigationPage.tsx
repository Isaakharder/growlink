import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type GroupType = "phase" | "zone" | "color";

type EquipmentReading = {
  id: string;
  name: string;
  volume_ml: number | null;
  dripper_count?: number | null;
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

type SummaryTab = "summary" | "raw";

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

function calculateDrainPercent(params: {
  feedVolume: number;
  feedDripperCount: number | null | undefined;
  drainVolume: number;
  drainDripperCount: number | null | undefined;
}) {
  const safeFeedDrippers = Number(params.feedDripperCount) > 0 ? Number(params.feedDripperCount) : 1;
  const safeDrainDrippers = Number(params.drainDripperCount) > 0 ? Number(params.drainDripperCount) : 1;

  const feedPerDripper = Number(params.feedVolume) / safeFeedDrippers;
  const drainPerDripper = Number(params.drainVolume) / safeDrainDrippers;

  if (!Number.isFinite(feedPerDripper) || feedPerDripper <= 0) {
    return 0;
  }

  if (!Number.isFinite(drainPerDripper) || drainPerDripper < 0) {
    return 0;
  }

  return (drainPerDripper / feedPerDripper) * 100;
}

function parseReadingVolumesPerDripper(readings: EquipmentReading[] | undefined): number[] {
  return (readings ?? [])
    .map((reading) => {
      const volume = reading.volume_ml;
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0) {
        return null;
      }

      const dripperCount = Number(reading.dripper_count) > 0 ? Number(reading.dripper_count) : 1;
      return volume / dripperCount;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
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
  const feedValuesPerDripper = parseReadingVolumesPerDripper(log.feed_valve_readings);
  const drainValuesPerDripper = parseReadingVolumesPerDripper(log.drain_bucket_readings);

  const avgFeedMl = averageOf(feedValues);
  const avgDrainMl = averageOf(drainValues);
  const avgFeedMlPerDripper = averageOf(feedValuesPerDripper);
  const avgDrainMlPerDripper = averageOf(drainValuesPerDripper);
  const drainPercent =
    avgFeedMlPerDripper !== null && avgDrainMlPerDripper !== null
      ? calculateDrainPercent({
          feedVolume: avgFeedMlPerDripper,
          feedDripperCount: 1,
          drainVolume: avgDrainMlPerDripper,
          drainDripperCount: 1
        })
      : null;

  return {
    avgFeedMl,
    avgDrainMl,
    avgFeedMlPerDripper,
    avgDrainMlPerDripper,
    drainPercent
  };
}

function formatLogDate(value: string | null): string {
  if (!value) return "--";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleDateString();
}

export function IrrigationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<IrrigationLogRecord[]>([]);
  const [activeTab, setActiveTab] = useState<SummaryTab>("summary");

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
        <p>Drain % is normalized by configured dripper counts.</p>
      </header>

      <div className="coming-soon-card">
        <h2>Latest 30 Day Logs</h2>

        <div className="tab-navigation" style={{ marginTop: "0.85rem" }}>
          <button
            type="button"
            className={`tab-button${activeTab === "summary" ? " active" : ""}`}
            onClick={() => setActiveTab("summary")}
          >
            Summary
          </button>
          <button
            type="button"
            className={`tab-button${activeTab === "raw" ? " active" : ""}`}
            onClick={() => setActiveTab("raw")}
          >
            Raw Data
          </button>
        </div>

        {loading ? <p>Loading...</p> : null}
        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && logs.length === 0 ? (
          <p>No irrigation logs in the last 30 days.</p>
        ) : null}

        {!loading && !error && logs.length > 0 && activeTab === "summary" ? (
          <>
            <div className="irrigation-summary-grid">
              {summary.map((metric) => (
                <div key={metric.label} className="irrigation-summary-card">
                  <p className="irrigation-summary-label">{metric.label}</p>
                  <p className="irrigation-summary-value">{metric.value}</p>
                </div>
              ))}
            </div>

            <div className="varieties-table-wrapper irrigation-raw-table-wrapper">
              <table className="varieties-table irrigation-raw-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Phase / Zone / Group</th>
                    <th>Avg Feed ml</th>
                    <th>Avg Drain ml</th>
                    <th>Drain %</th>
                    <th>Feed EC</th>
                    <th>Feed pH</th>
                    <th>Drain EC</th>
                    <th>Drain pH</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsWithMetrics.map(({ log, metrics }) => (
                    <tr key={`summary-${log.id}`}>
                      <td>{formatLogDate(log.log_date)}</td>
                      <td>{capitalize(log.tracking_mode)}: {log.group_name}</td>
                      <td>{formatNumber(metrics.avgFeedMl)}</td>
                      <td>{formatNumber(metrics.avgDrainMl)}</td>
                      <td>{formatPercent(metrics.drainPercent)}</td>
                      <td>{formatNumber(log.feed_ec, 3)}</td>
                      <td>{formatNumber(log.feed_ph, 3)}</td>
                      <td>{formatNumber(log.drain_ec, 3)}</td>
                      <td>{formatNumber(log.drain_ph, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {!loading && !error && logs.length > 0 && activeTab === "raw" ? (
          <div className="varieties-table-wrapper irrigation-raw-table-wrapper">
            <table className="varieties-table irrigation-raw-table">
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
                    <td>{formatLogDate(log.log_date)}</td>
                    <td>{capitalize(log.tracking_mode)}</td>
                    <td>{log.group_name}</td>
                    <td>
                      {(log.feed_valve_readings ?? []).length === 0 ? (
                        "--"
                      ) : (
                        <div className="irrigation-reading-compact">
                          {(log.feed_valve_readings ?? []).map((reading) => (
                            <span key={`feed-${log.id}-${reading.id}`} className="irrigation-reading-pill">
                              {reading.name}: {formatNumber(reading.volume_ml)} ml
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {(log.drain_bucket_readings ?? []).length === 0 ? (
                        "--"
                      ) : (
                        <div className="irrigation-reading-compact">
                          {(log.drain_bucket_readings ?? []).map((reading) => (
                            <span key={`drain-${log.id}-${reading.id}`} className="irrigation-reading-pill">
                              {reading.name}: {formatNumber(reading.volume_ml)} ml
                            </span>
                          ))}
                        </div>
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
