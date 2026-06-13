import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
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
type TrendMetricKey = "drainEc" | "drainPh" | "feedEc" | "feedPh" | "drain" | "feedVolume";

type MetricLimit = {
  lower: number;
  upper: number;
};

type TrendPoint = {
  dateKey: string;
  dateLabel: string;
  drainEcScaled: number | null;
  drainPhScaled: number | null;
  feedEcScaled: number | null;
  feedPhScaled: number | null;
  drainScaled: number | null;
  feedVolumeScaled: number | null;
  drainEcRaw: number | null;
  drainPhRaw: number | null;
  feedEcRaw: number | null;
  feedPhRaw: number | null;
  drainRaw: number | null;
  feedVolumeRaw: number | null;
};

type DailyLightLog = {
  id: string;
  log_date: string;
  joules_per_cm2: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const IRRIGATION_LOGS_URL = "/api/irrigation/logs?days=30";
const DAILY_LIGHT_URL = "/api/daily-light?days=1095";
const LIGHT_YEAR_COLOR_PALETTE = ["#2f6fed", "#0f766e", "#d97706", "#7c3aed", "#c026d3", "#b45309"];
const TREND_LIMITS: Record<"ec" | "ph" | "drain" | "feedVolume", MetricLimit> = {
  ec: { lower: 2, upper: 5 },
  ph: { lower: 5, upper: 7 },
  drain: { lower: 0, upper: 50 },
  feedVolume: { lower: 0, upper: 7000 }
};

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

function scaleToDisplayRange(value: number | null, limit: MetricLimit): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const span = limit.upper - limit.lower;
  if (!Number.isFinite(span) || span <= 0) {
    return null;
  }

  const scaled = ((value - limit.lower) / span) * 100;
  return roundTo(Math.max(0, Math.min(100, scaled)), 2);
}

function getDateKey(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function formatDateLabel(dateKey: string): string {
  const timestamp = Date.parse(`${dateKey}T00:00:00`);
  if (!Number.isFinite(timestamp)) {
    return dateKey;
  }

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getISOWeekLabel(date: Date): string {
  // ISO 8601: week 1 = week containing the first Thursday; weeks start Monday
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `W${String(weekNum).padStart(2, "0")}`;
}

function getDefaultTrendDateRange() {
  const endDate = new Date();
  endDate.setHours(0, 0, 0, 0);

  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);

  return {
    startDate: formatDateInputValue(startDate),
    endDate: formatDateInputValue(endDate)
  };
}

export function IrrigationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<IrrigationLogRecord[]>([]);
  const [pageTab, setPageTab] = useState<"irrigation" | "climate">("irrigation");
  const [activeTab, setActiveTab] = useState<SummaryTab>("summary");
  const [selectedTrendMetrics, setSelectedTrendMetrics] = useState<Record<TrendMetricKey, boolean>>({
    drainEc: true,
    drainPh: true,
    feedEc: true,
    feedPh: true,
    drain: true,
    feedVolume: false
  });
  const [selectedPhaseColor, setSelectedPhaseColor] = useState("all");
  const [trendDateRange, setTrendDateRange] = useState(() => getDefaultTrendDateRange());
  const [lightLogs, setLightLogs] = useState<DailyLightLog[]>([]);
  const [lightLoading, setLightLoading] = useState(false);
  const [lightError, setLightError] = useState<string | null>(null);
  const [lightSaving, setLightSaving] = useState(false);
  const [lightSaveError, setLightSaveError] = useState<string | null>(null);
  const [lightDeleteError, setLightDeleteError] = useState<string | null>(null);
  const [lightFetchKey, setLightFetchKey] = useState(0);
  const [lightForm, setLightForm] = useState({
    log_date: formatDateInputValue(new Date()),
    joules_per_cm2: ""
  });
  const [checkedLightYears, setCheckedLightYears] = useState<Set<number>>(
    () => new Set([new Date().getFullYear()])
  );

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

  useEffect(() => {
    if (pageTab !== "climate") return;

    let active = true;
    setLightLoading(true);
    setLightError(null);

    async function fetchLightLogs() {
      try {
        const response = await apiFetch(DAILY_LIGHT_URL);

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `Failed to load daily light logs (${response.status})`);
        }

        const data = (await response.json()) as DailyLightLog[];

        if (active) {
          setLightLogs(data ?? []);
        }
      } catch (fetchError) {
        if (active) {
          setLightError(fetchError instanceof Error ? fetchError.message : "Failed to load daily light logs");
        }
      } finally {
        if (active) {
          setLightLoading(false);
        }
      }
    }

    void fetchLightLogs();

    return () => {
      active = false;
    };
  }, [pageTab, lightFetchKey]);

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

  const phaseColorOptions = useMemo(() => {
    const options = new Map<string, string>();

    for (const { log } of rowsWithMetrics) {
      if ((log.tracking_mode !== "phase" && log.tracking_mode !== "color") || !log.group_name?.trim()) {
        continue;
      }

      const key = `${log.tracking_mode}::${log.group_name}`;
      options.set(key, `${capitalize(log.tracking_mode)}: ${log.group_name}`);
    }

    return Array.from(options.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rowsWithMetrics]);

  useEffect(() => {
    if (selectedPhaseColor === "all") {
      return;
    }

    const isValid = phaseColorOptions.some((option) => option.value === selectedPhaseColor);
    if (!isValid) {
      setSelectedPhaseColor("all");
    }
  }, [phaseColorOptions, selectedPhaseColor]);

  const filteredRowsForTrend = useMemo(() => {
    if (selectedPhaseColor === "all") {
      return rowsWithMetrics;
    }

    return rowsWithMetrics.filter(
      ({ log }) => `${log.tracking_mode}::${log.group_name}` === selectedPhaseColor
    );
  }, [rowsWithMetrics, selectedPhaseColor]);

  const dailyTrendData = useMemo(() => {
    const buckets = new Map<
      string,
      {
        drainEc: number[];
        drainPh: number[];
        feedEc: number[];
        feedPh: number[];
        drain: number[];
        feedVolume: number[];
      }
    >();

    for (const { log, metrics } of filteredRowsForTrend) {
      const dateKey = getDateKey(log.log_date);
      if (!dateKey) {
        continue;
      }

      const bucket = buckets.get(dateKey) ?? {
        drainEc: [],
        drainPh: [],
        feedEc: [],
        feedPh: [],
        drain: [],
        feedVolume: []
      };

      if (typeof log.drain_ec === "number" && Number.isFinite(log.drain_ec)) {
        bucket.drainEc.push(log.drain_ec);
      }

      if (typeof log.drain_ph === "number" && Number.isFinite(log.drain_ph)) {
        bucket.drainPh.push(log.drain_ph);
      }

      if (typeof log.feed_ec === "number" && Number.isFinite(log.feed_ec)) {
        bucket.feedEc.push(log.feed_ec);
      }

      if (typeof log.feed_ph === "number" && Number.isFinite(log.feed_ph)) {
        bucket.feedPh.push(log.feed_ph);
      }

      if (metrics.drainPercent !== null && Number.isFinite(metrics.drainPercent)) {
        bucket.drain.push(metrics.drainPercent);
      }

      if (metrics.avgFeedMl !== null && Number.isFinite(metrics.avgFeedMl)) {
        bucket.feedVolume.push(metrics.avgFeedMl);
      }

      buckets.set(dateKey, bucket);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, metricValues]): TrendPoint => {
        const drainEcRaw = averageOf(metricValues.drainEc);
        const drainPhRaw = averageOf(metricValues.drainPh);
        const feedEcRaw = averageOf(metricValues.feedEc);
        const feedPhRaw = averageOf(metricValues.feedPh);
        const drainRaw = averageOf(metricValues.drain);
        const feedVolumeRaw = averageOf(metricValues.feedVolume);

        return {
          dateKey,
          dateLabel: formatDateLabel(dateKey),
          drainEcRaw,
          drainPhRaw,
          feedEcRaw,
          feedPhRaw,
          drainRaw,
          feedVolumeRaw,
          drainEcScaled: scaleToDisplayRange(drainEcRaw, TREND_LIMITS.ec),
          drainPhScaled: scaleToDisplayRange(drainPhRaw, TREND_LIMITS.ph),
          feedEcScaled: scaleToDisplayRange(feedEcRaw, TREND_LIMITS.ec),
          feedPhScaled: scaleToDisplayRange(feedPhRaw, TREND_LIMITS.ph),
          drainScaled: scaleToDisplayRange(drainRaw, TREND_LIMITS.drain),
          feedVolumeScaled: scaleToDisplayRange(feedVolumeRaw, TREND_LIMITS.feedVolume)
        };
      });
  }, [filteredRowsForTrend]);

  const dailyTrendDataInRange = useMemo(() => {
    const startTime = Date.parse(`${trendDateRange.startDate}T00:00:00`);
    const endTime = Date.parse(`${trendDateRange.endDate}T00:00:00`);

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
      return [];
    }

    return dailyTrendData.filter((point) => {
      const pointTime = Date.parse(`${point.dateKey}T00:00:00`);
      return Number.isFinite(pointTime) && pointTime >= startTime && pointTime <= endTime;
    });
  }, [dailyTrendData, trendDateRange.endDate, trendDateRange.startDate]);

  const hasTrendData = dailyTrendDataInRange.length > 0;
  const hasAnyTrendMetricSelected = Object.values(selectedTrendMetrics).some(Boolean);

  const selectedPhaseColorLabel =
    selectedPhaseColor === "all"
      ? null
      : phaseColorOptions.find((option) => option.value === selectedPhaseColor)?.label ?? null;

  const trendLegendItems = useMemo(() => {
    const suffix = selectedPhaseColorLabel ? ` (${selectedPhaseColorLabel})` : "";
    const items = [
      { key: "drainEc" as TrendMetricKey, label: `Drain EC${suffix}`, color: "#2f6fed" },
      { key: "drainPh" as TrendMetricKey, label: `Drain pH${suffix}`, color: "#d97706" },
      { key: "feedEc" as TrendMetricKey, label: `Feed EC${suffix}`, color: "#7c3aed" },
      { key: "feedPh" as TrendMetricKey, label: `Feed pH${suffix}`, color: "#c026d3" },
      { key: "drain" as TrendMetricKey, label: `Drain %${suffix}`, color: "#0f766e" },
      { key: "feedVolume" as TrendMetricKey, label: `Feed Volume${suffix}`, color: "#b45309" }
    ];

    return items.filter((item) => selectedTrendMetrics[item.key]);
  }, [selectedPhaseColorLabel, selectedTrendMetrics]);

  const joulesInputRef = useRef<HTMLInputElement>(null);

  const lightLogYears = useMemo(() => {
    const years = new Set<number>();
    years.add(new Date().getFullYear());
    for (const log of lightLogs) {
      years.add(new Date(`${log.log_date}T00:00:00`).getFullYear());
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [lightLogs]);

  const lightYearColors = useMemo(() => {
    const result: Record<number, string> = {};
    lightLogYears.forEach((year, index) => {
      result[year] = LIGHT_YEAR_COLOR_PALETTE[index % LIGHT_YEAR_COLOR_PALETTE.length];
    });
    return result;
  }, [lightLogYears]);

  const lightYearComparison = useMemo(() => {
    const selectedDate = lightForm.log_date;
    if (!selectedDate) return null;
    const ts = Date.parse(`${selectedDate}T00:00:00`);
    if (!Number.isFinite(ts)) return null;

    const date = new Date(ts);
    const year = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const thisYearStart = `${year}-01-01`;
    const lastYearStart = `${year - 1}-01-01`;
    const lastYearEnd = `${year - 1}-${mm}-${dd}`;

    let thisYearTotal = 0;
    let lastYearTotal = 0;
    let thisYearHasData = false;
    let lastYearHasData = false;

    for (const log of lightLogs) {
      const d = log.log_date;
      if (d >= thisYearStart && d <= selectedDate) {
        thisYearTotal += log.joules_per_cm2;
        thisYearHasData = true;
      }
      if (d >= lastYearStart && d <= lastYearEnd) {
        lastYearTotal += log.joules_per_cm2;
        lastYearHasData = true;
      }
    }

    const diff = thisYearTotal - lastYearTotal;
    const percentDiff =
      lastYearHasData && lastYearTotal > 0 ? (diff / lastYearTotal) * 100 : null;

    return { thisYearTotal, lastYearTotal, thisYearHasData, lastYearHasData, diff, percentDiff, year };
  }, [lightLogs, lightForm.log_date]);

  const weeklyLightChartData = useMemo(() => {
    type WeekEntry = { xLabel: string; values: Map<number, number> };
    const byWeek = new Map<string, WeekEntry>();

    for (const log of lightLogs) {
      const date = new Date(`${log.log_date}T00:00:00`);
      const year = date.getFullYear();
      if (!checkedLightYears.has(year)) continue;

      const weekLabel = getISOWeekLabel(date);
      if (!byWeek.has(weekLabel)) {
        byWeek.set(weekLabel, { xLabel: weekLabel, values: new Map() });
      }
      const entry = byWeek.get(weekLabel)!;
      entry.values.set(year, (entry.values.get(year) ?? 0) + log.joules_per_cm2);
    }

    return Array.from(byWeek.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, entry]) => {
        const point: Record<string, unknown> = { xLabel: entry.xLabel };
        for (const year of checkedLightYears) {
          point[String(year)] = entry.values.get(year) ?? null;
        }
        return point;
      });
  }, [lightLogs, checkedLightYears]);

  const lightChartData = useMemo(() => {
    type MonthDayEntry = { xLabel: string; values: Map<number, number> };
    const byMonthDay = new Map<string, MonthDayEntry>();

    for (const log of lightLogs) {
      const date = new Date(`${log.log_date}T00:00:00`);
      const year = date.getFullYear();
      if (!checkedLightYears.has(year)) continue;

      const mmdd = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const xLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

      if (!byMonthDay.has(mmdd)) {
        byMonthDay.set(mmdd, { xLabel, values: new Map() });
      }

      byMonthDay.get(mmdd)!.values.set(year, log.joules_per_cm2);
    }

    return Array.from(byMonthDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, entry]) => {
        const point: Record<string, unknown> = { xLabel: entry.xLabel };
        for (const year of checkedLightYears) {
          point[String(year)] = entry.values.get(year) ?? null;
        }
        return point;
      });
  }, [lightLogs, checkedLightYears]);

  function shiftLightDate(days: number) {
    setLightForm((current) => {
      const timestamp = Date.parse(`${current.log_date}T00:00:00`);
      if (!Number.isFinite(timestamp)) return current;
      const next = new Date(timestamp);
      next.setDate(next.getDate() + days);
      return { ...current, log_date: formatDateInputValue(next) };
    });
  }

  async function handleSaveLight() {
    const joules = Number(lightForm.joules_per_cm2);
    if (!lightForm.log_date || !Number.isFinite(joules) || joules < 0) {
      setLightSaveError("Date and a valid Joules/cm\u00b2 value (0 or greater) are required.");
      return;
    }

    setLightSaving(true);
    setLightSaveError(null);

    try {
      const response = await apiFetch("/api/daily-light", {
        method: "POST",
        body: JSON.stringify({
          log_date: lightForm.log_date,
          joules_per_cm2: joules
        })
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Save failed (${response.status})`);
      }

      // Advance date by one day, clear joules, focus joules for fast sequential entry
      setLightForm((current) => {
        const timestamp = Date.parse(`${current.log_date}T00:00:00`);
        const next = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
        next.setDate(next.getDate() + 1);
        return { log_date: formatDateInputValue(next), joules_per_cm2: "" };
      });
      setLightFetchKey((k) => k + 1);
      setTimeout(() => joulesInputRef.current?.focus(), 0);
    } catch (saveError) {
      setLightSaveError(saveError instanceof Error ? saveError.message : "Failed to save.");
    } finally {
      setLightSaving(false);
    }
  }

  async function handleDeleteLight(id: string) {
    setLightDeleteError(null);

    try {
      const response = await apiFetch(`/api/daily-light/${id}`, { method: "DELETE" });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Delete failed (${response.status})`);
      }

      setLightFetchKey((k) => k + 1);
    } catch (deleteError) {
      setLightDeleteError(deleteError instanceof Error ? deleteError.message : "Failed to delete.");
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Environment</h1>
      </header>

      <div className="tab-navigation" style={{ marginBottom: "0.5rem" }}>
        <button
          type="button"
          className={`tab-button${pageTab === "irrigation" ? " active" : ""}`}
          onClick={() => setPageTab("irrigation")}
        >
          Irrigation
        </button>
        <button
          type="button"
          className={`tab-button${pageTab === "climate" ? " active" : ""}`}
          onClick={() => setPageTab("climate")}
        >
          Climate
        </button>
      </div>

      {pageTab === "climate" ? (
        <>
          <div className="coming-soon-card">
            <h2>Log Daily Light</h2>

            {lightYearComparison !== null ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.65rem",
                  marginTop: "0.75rem",
                  marginBottom: "0.1rem"
                }}
              >
                {/* Last Year Total */}
                <div
                  style={{
                    flex: "1 1 140px",
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    padding: "0.6rem 0.85rem",
                    background: "var(--surface)"
                  }}
                >
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.18rem" }}>
                    Last Year Total
                  </div>
                  <div style={{ fontWeight: 700, fontSize: "1rem" }}>
                    {lightYearComparison.lastYearHasData
                      ? `${Math.round(lightYearComparison.lastYearTotal).toLocaleString()} J/cm²`
                      : "No data"}
                  </div>
                </div>

                {/* This Year Total */}
                <div
                  style={{
                    flex: "1 1 140px",
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    padding: "0.6rem 0.85rem",
                    background: "var(--surface)"
                  }}
                >
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.18rem" }}>
                    This Year Total
                  </div>
                  <div style={{ fontWeight: 700, fontSize: "1rem" }}>
                    {lightYearComparison.thisYearHasData
                      ? `${Math.round(lightYearComparison.thisYearTotal).toLocaleString()} J/cm²`
                      : "No data"}
                  </div>
                </div>

                {/* Difference */}
                <div
                  style={{
                    flex: "1 1 160px",
                    border: `1px solid ${
                      !lightYearComparison.lastYearHasData
                        ? "var(--border)"
                        : lightYearComparison.diff > 0
                        ? "#16a34a"
                        : lightYearComparison.diff < 0
                        ? "#dc2626"
                        : "var(--border)"
                    }`,
                    borderRadius: "10px",
                    padding: "0.6rem 0.85rem",
                    background: "var(--surface)"
                  }}
                >
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.18rem" }}>
                    Difference
                  </div>
                  {!lightYearComparison.lastYearHasData ? (
                    <div style={{ fontSize: "0.88rem", color: "var(--text-muted)", fontWeight: 600 }}>
                      No last year data
                    </div>
                  ) : lightYearComparison.diff === 0 ? (
                    <div style={{ fontWeight: 700, fontSize: "1rem" }}>Same as last year</div>
                  ) : (
                    <>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: "1rem",
                          color: lightYearComparison.diff > 0 ? "#16a34a" : "#dc2626"
                        }}
                      >
                        {lightYearComparison.diff > 0 ? "+" : ""}
                        {Math.round(lightYearComparison.diff).toLocaleString()} J/cm²
                        {lightYearComparison.percentDiff !== null ? (
                          <span style={{ fontSize: "0.8rem", marginLeft: "0.4rem", fontWeight: 600 }}>
                            ({lightYearComparison.diff > 0 ? "+" : ""}
                            {roundTo(lightYearComparison.percentDiff, 1)}%)
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
                        {lightYearComparison.diff > 0 ? "More sunlight this year" : "Less sunlight this year"}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.6rem",
                alignItems: "flex-end",
                marginTop: "0.75rem"
              }}
            >
              {/* Date with prev/next arrows */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexShrink: 0 }}>
                <button
                  type="button"
                  aria-label="Previous day"
                  onClick={() => shiftLightDate(-1)}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    background: "var(--surface)",
                    color: "var(--text)",
                    font: "inherit",
                    fontWeight: 700,
                    fontSize: "1rem",
                    lineHeight: 1,
                    padding: "0.38rem 0.6rem",
                    cursor: "pointer"
                  }}
                >
                  &#9664;
                </button>
                <input
                  type="date"
                  value={lightForm.log_date}
                  onChange={(event) =>
                    setLightForm((current) => ({ ...current, log_date: event.target.value }))
                  }
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    background: "var(--surface)",
                    color: "var(--text)",
                    font: "inherit",
                    fontSize: "0.92rem",
                    padding: "0.52rem 0.6rem"
                  }}
                />
                <button
                  type="button"
                  aria-label="Next day"
                  onClick={() => shiftLightDate(1)}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    background: "var(--surface)",
                    color: "var(--text)",
                    font: "inherit",
                    fontWeight: 700,
                    fontSize: "1rem",
                    lineHeight: 1,
                    padding: "0.38rem 0.6rem",
                    cursor: "pointer"
                  }}
                >
                  &#9654;
                </button>
              </div>

              {/* Joules field */}
              <label
                style={{
                  display: "grid",
                  gap: "0.35rem",
                  fontSize: "0.92rem",
                  color: "var(--text-muted)",
                  flexShrink: 0
                }}
              >
                Joules/cm²
                <input
                  ref={joulesInputRef}
                  type="number"
                  min="0"
                  step="any"
                  placeholder="e.g. 1200"
                  value={lightForm.joules_per_cm2}
                  onChange={(event) =>
                    setLightForm((current) => ({ ...current, joules_per_cm2: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSaveLight();
                  }}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    background: "var(--surface)",
                    color: "var(--text)",
                    font: "inherit",
                    fontSize: "0.92rem",
                    padding: "0.52rem 0.6rem",
                    width: "130px"
                  }}
                />
              </label>
            </div>

            {lightSaveError ? <p className="form-error">{lightSaveError}</p> : null}

            <button
              type="button"
              onClick={() => void handleSaveLight()}
              disabled={lightSaving}
              style={{
                marginTop: "0.75rem",
                border: "1px solid var(--border)",
                borderRadius: "10px",
                background: "var(--surface)",
                color: "var(--text)",
                font: "inherit",
                fontWeight: 600,
                padding: "0.55rem 1.1rem",
                cursor: lightSaving ? "not-allowed" : "pointer"
              }}
            >
              {lightSaving ? "Saving..." : "Save"}
            </button>
          </div>

          <div className="coming-soon-card">
            <h2>Weekly Sunlight Totals</h2>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem 0.75rem", marginBottom: "0.65rem" }}>
              {lightLogYears.map((year) => (
                <label
                  key={year}
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.9rem" }}
                >
                  <input
                    type="checkbox"
                    checked={checkedLightYears.has(year)}
                    onChange={() => {
                      setCheckedLightYears((current) => {
                        const next = new Set(current);
                        if (next.has(year)) {
                          next.delete(year);
                        } else {
                          next.add(year);
                        }
                        return next;
                      });
                    }}
                  />
                  {year}
                </label>
              ))}
            </div>

            {lightLoading ? <p>Loading...</p> : null}
            {lightError ? <p className="form-error">{lightError}</p> : null}

            {!lightLoading && !lightError && checkedLightYears.size === 0 ? (
              <p>Select at least one year to display the chart.</p>
            ) : null}

            {!lightLoading && !lightError && checkedLightYears.size > 0 && weeklyLightChartData.length === 0 ? (
              <p>No daily light data for the selected year(s).</p>
            ) : null}

            {!lightLoading && !lightError && checkedLightYears.size > 0 && weeklyLightChartData.length > 0 ? (
              <div className="dashboard-chart-wrapper">
                <ResponsiveContainer width="100%" height={290}>
                  <LineChart data={weeklyLightChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
                    <XAxis
                      dataKey="xLabel"
                      tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--border)" }}
                    />
                    <YAxis
                      tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                      label={{
                        value: "J/cm²",
                        angle: -90,
                        position: "insideLeft",
                        offset: 14,
                        style: { fill: "var(--text-muted)", fontSize: 12 }
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        fontSize: 13
                      }}
                      formatter={(value: unknown, name: unknown) => [
                        typeof value === "number" ? `${Math.round(value).toLocaleString()} J/cm²` : "--",
                        String(name)
                      ]}
                      labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
                    />
                    {Array.from(checkedLightYears)
                      .sort((a, b) => a - b)
                      .map((year) => (
                        <Line
                          key={year}
                          type="monotone"
                          dataKey={String(year)}
                          name={String(year)}
                          stroke={lightYearColors[year] ?? "#2f6fed"}
                          strokeWidth={2.2}
                          dot={{ r: 3 }}
                          activeDot={{ r: 5 }}
                          connectNulls={false}
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>

                <div
                  aria-label="Weekly sunlight chart legend"
                  style={{
                    marginTop: "0.55rem",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.45rem 0.7rem",
                    alignItems: "center"
                  }}
                >
                  {Array.from(checkedLightYears)
                    .sort((a, b) => b - a)
                    .map((year) => (
                      <span
                        key={year}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          fontSize: "0.83rem",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap"
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: "inline-block",
                            width: "18px",
                            height: "3px",
                            borderRadius: "999px",
                            background: lightYearColors[year] ?? "#2f6fed"
                          }}
                        />
                        {year}
                      </span>
                    ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="coming-soon-card">
            <h2>Daily Sunlight</h2>

            {lightLoading ? <p>Loading...</p> : null}
            {lightError ? <p className="form-error">{lightError}</p> : null}

            {!lightLoading && !lightError && checkedLightYears.size === 0 ? (
              <p>Select at least one year to display the chart.</p>
            ) : null}

            {!lightLoading && !lightError && checkedLightYears.size > 0 && lightChartData.length === 0 ? (
              <p>No daily light data for the selected year(s).</p>
            ) : null}

            {!lightLoading && !lightError && checkedLightYears.size > 0 && lightChartData.length > 0 ? (
              <div className="dashboard-chart-wrapper">
                <ResponsiveContainer width="100%" height={290}>
                  <LineChart data={lightChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
                    <XAxis
                      dataKey="xLabel"
                      tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--border)" }}
                    />
                    <YAxis
                      tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                      label={{
                        value: "J/cm²",
                        angle: -90,
                        position: "insideLeft",
                        offset: 14,
                        style: { fill: "var(--text-muted)", fontSize: 12 }
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        fontSize: 13
                      }}
                      formatter={(value: unknown, name: unknown) => [
                        typeof value === "number" ? `${roundTo(value, 1)} J/cm²` : "--",
                        String(name)
                      ]}
                      labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
                    />
                    {Array.from(checkedLightYears)
                      .sort((a, b) => a - b)
                      .map((year) => (
                        <Line
                          key={year}
                          type="monotone"
                          dataKey={String(year)}
                          name={String(year)}
                          stroke={lightYearColors[year] ?? "#2f6fed"}
                          strokeWidth={2.2}
                          dot={{ r: 3 }}
                          activeDot={{ r: 5 }}
                          connectNulls={false}
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>

                <div
                  aria-label="Daily sunlight chart legend"
                  style={{
                    marginTop: "0.55rem",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.45rem 0.7rem",
                    alignItems: "center"
                  }}
                >
                  {Array.from(checkedLightYears)
                    .sort((a, b) => b - a)
                    .map((year) => (
                      <span
                        key={year}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          fontSize: "0.83rem",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap"
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: "inline-block",
                            width: "18px",
                            height: "3px",
                            borderRadius: "999px",
                            background: lightYearColors[year] ?? "#2f6fed"
                          }}
                        />
                        {year}
                      </span>
                    ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="coming-soon-card">
            <h2>Recent Daily Light Entries</h2>

            {lightDeleteError ? <p className="form-error">{lightDeleteError}</p> : null}
            {lightLoading ? <p>Loading...</p> : null}

            {!lightLoading && lightLogs.length === 0 ? (
              <p>No daily light entries yet. Use the form above to add the first entry.</p>
            ) : null}

            {!lightLoading && lightLogs.length > 0 ? (
              <div className="varieties-table-wrapper irrigation-raw-table-wrapper">
                <table className="varieties-table irrigation-raw-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Joules/cm²</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lightLogs.slice(0, 60).map((log) => (
                      <tr key={log.id}>
                        <td>{formatLogDate(log.log_date)}</td>
                        <td>{roundTo(log.joules_per_cm2, 1)}</td>
                        <td>
                          <button
                            type="button"
                            onClick={() => void handleDeleteLight(log.id)}
                            title="Delete entry"
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: "8px",
                              background: "var(--surface)",
                              color: "var(--text-muted)",
                              font: "inherit",
                              fontSize: "0.8rem",
                              padding: "0.2rem 0.55rem",
                              cursor: "pointer"
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {pageTab === "irrigation" ? <>
      <div className="coming-soon-card">
        <h2>Daily Irrigation Trends</h2>

        <div className="varieties-toolbar irrigation-toolbar">
          <label className="irrigation-filter-label">
            Start Date
            <input
              type="date"
              value={trendDateRange.startDate}
              max={trendDateRange.endDate}
              onChange={(event) =>
                setTrendDateRange((current) => ({ ...current, startDate: event.target.value }))
              }
            />
          </label>

          <label className="irrigation-filter-label">
            End Date
            <input
              type="date"
              value={trendDateRange.endDate}
              min={trendDateRange.startDate}
              onChange={(event) =>
                setTrendDateRange((current) => ({ ...current, endDate: event.target.value }))
              }
            />
          </label>

          <div className="irrigation-filter-label">
            Metric
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.35rem 0.75rem"
              }}
            >
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <input
                  type="checkbox"
                  checked={selectedTrendMetrics.drainEc}
                  onChange={(event) =>
                    setSelectedTrendMetrics((current) => ({ ...current, drainEc: event.target.checked }))
                  }
                />
                Drain EC
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <input
                  type="checkbox"
                  checked={selectedTrendMetrics.drainPh}
                  onChange={(event) =>
                    setSelectedTrendMetrics((current) => ({ ...current, drainPh: event.target.checked }))
                  }
                />
                Drain pH
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <input
                  type="checkbox"
                  checked={selectedTrendMetrics.feedEc}
                  onChange={(event) =>
                    setSelectedTrendMetrics((current) => ({ ...current, feedEc: event.target.checked }))
                  }
                />
                Feed EC
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <input
                  type="checkbox"
                  checked={selectedTrendMetrics.feedPh}
                  onChange={(event) =>
                    setSelectedTrendMetrics((current) => ({ ...current, feedPh: event.target.checked }))
                  }
                />
                Feed pH
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <input
                  type="checkbox"
                  checked={selectedTrendMetrics.drain}
                  onChange={(event) =>
                    setSelectedTrendMetrics((current) => ({ ...current, drain: event.target.checked }))
                  }
                />
                Drain %
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <input
                  type="checkbox"
                  checked={selectedTrendMetrics.feedVolume}
                  onChange={(event) =>
                    setSelectedTrendMetrics((current) => ({ ...current, feedVolume: event.target.checked }))
                  }
                />
                Feed Volume
              </label>
            </div>
          </div>

          <label className="irrigation-filter-label">
            Phase / Color
            <select
              value={selectedPhaseColor}
              onChange={(event) => setSelectedPhaseColor(event.target.value)}
              disabled={phaseColorOptions.length === 0}
            >
              <option value="all">All</option>
              {phaseColorOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loading ? <p>Loading...</p> : null}
        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && !hasAnyTrendMetricSelected ? (
          <p>Select at least one metric to display the chart.</p>
        ) : null}

        {!loading && !error && hasAnyTrendMetricSelected && !hasTrendData ? (
          <p>No trend data available for the selected filters.</p>
        ) : null}

        {!loading && !error && hasAnyTrendMetricSelected && hasTrendData ? (
          <div className="dashboard-chart-wrapper">
            <ResponsiveContainer width="100%" height={290}>
              <LineChart data={dailyTrendDataInRange} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
                <XAxis
                  dataKey="dateLabel"
                  tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 13
                  }}
                  formatter={(_, name, item) => {
                    const point = item.payload as TrendPoint;
                    if (name === "Drain EC") {
                      return [formatNumber(point.drainEcRaw, 3), "Drain EC"];
                    }

                    if (name === "Drain pH") {
                      return [formatNumber(point.drainPhRaw, 3), "Drain pH"];
                    }

                    if (name === "Feed EC") {
                      return [formatNumber(point.feedEcRaw, 3), "Feed EC"];
                    }

                    if (name === "Feed pH") {
                      return [formatNumber(point.feedPhRaw, 3), "Feed pH"];
                    }

                    if (name === "Feed Volume") {
                      return [`${formatNumber(point.feedVolumeRaw, 2)} ml`, "Feed Volume"];
                    }

                    return [formatPercent(point.drainRaw, 2), "Drain %"];
                  }}
                  labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
                />
                {selectedTrendMetrics.drainEc ? (
                  <Line
                    type="monotone"
                    dataKey="drainEcScaled"
                    name="Drain EC"
                    stroke="#2f6fed"
                    strokeWidth={2.2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ) : null}
                {selectedTrendMetrics.drainPh ? (
                  <Line
                    type="monotone"
                    dataKey="drainPhScaled"
                    name="Drain pH"
                    stroke="#d97706"
                    strokeWidth={2.2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ) : null}
                {selectedTrendMetrics.feedEc ? (
                  <Line
                    type="monotone"
                    dataKey="feedEcScaled"
                    name="Feed EC"
                    stroke="#7c3aed"
                    strokeWidth={2.2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ) : null}
                {selectedTrendMetrics.feedPh ? (
                  <Line
                    type="monotone"
                    dataKey="feedPhScaled"
                    name="Feed pH"
                    stroke="#c026d3"
                    strokeWidth={2.2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ) : null}
                {selectedTrendMetrics.drain ? (
                  <Line
                    type="monotone"
                    dataKey="drainScaled"
                    name="Drain %"
                    stroke="#0f766e"
                    strokeWidth={2.2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ) : null}
                {selectedTrendMetrics.feedVolume ? (
                  <Line
                    type="monotone"
                    dataKey="feedVolumeScaled"
                    name="Feed Volume"
                    stroke="#b45309"
                    strokeWidth={2.2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
            <div
              aria-label="Daily irrigation trends legend"
              style={{
                marginTop: "0.55rem",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.45rem 0.7rem",
                alignItems: "center"
              }}
            >
              {trendLegendItems.map((item) => (
                <span
                  key={item.key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.83rem",
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap"
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: "18px",
                      height: "3px",
                      borderRadius: "999px",
                      background: item.color
                    }}
                  />
                  {item.label}
                </span>
              ))}
            </div>
            <p>Values are scaled to a 0-100 display range. Tooltip values show raw daily averages.</p>
          </div>
        ) : null}
      </div>

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
    </> : null}
    </section>
  );
}
