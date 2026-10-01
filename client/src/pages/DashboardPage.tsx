
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../hooks/usePermissions";
import { ModalOverlay } from "../components/ModalOverlay";
import { ExpandChartButton, FullscreenChartOverlay, useFullscreenChart } from "../components/charts/FullscreenChart";
import { formatWeekAxisTick } from "../components/charts/weekAxis";
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  getBackendHealth,
  getForecastingStatus,
  getOrganizationId,
  type ApiResult,
  apiFetch
} from "../lib/api";
import { roundTo } from "../lib/roundTo";
import {
  TRACKING_LABELS,
  formatSnapshotNumber,
  getAvgFeedMl,
  getDrainPercent,
  getLastReadingDate,
  pairGreenhouseSnapshots,
  selectGreenhouseSnapshotGroups,
  type IrrigationGroup,
  type IrrigationGroupType,
  type IrrigationLogRecord
} from "../lib/dashboard/greenhouseSnapshots";
import {
  COLOR_ORDER,
  buildColorYieldSummary,
  buildYieldPieSlices,
  buildYieldTrendPoints,
  formatColorKgPerM2,
  normalizeColorCaseEntries,
  normalizeYieldEntries,
  type ColorYieldEntry,
  type ColorYieldSummary,
  type ColorYieldVariety,
  type VarietyColor,
  type YieldPieSlice,
  type YieldTrendPoint
} from "../lib/dashboard/yieldByColor";

type ServiceState = {
  loading: boolean;
  status: "connected" | "disconnected";
  response: ApiResult | null;
};

type DashboardOtherSectionKey =
  | "backendStatus"
  | "forecastingService";

type DashboardOtherSections = Record<DashboardOtherSectionKey, boolean>;

type DashboardCardVisibility = Record<string, boolean>;

type YieldTrendsPreferences = {
  showLineGraph: boolean;
  showPieChart: boolean;
  lineColors: DashboardCardVisibility;
  pieColors: DashboardCardVisibility;
};

type DashboardPreferences = {
  otherSections: DashboardOtherSections;
  irrigationCards: DashboardCardVisibility;
  yieldColorCards: DashboardCardVisibility;
  yieldTrends: YieldTrendsPreferences;
};

type StoredDashboardPreferences = Partial<Omit<DashboardPreferences, "yieldTrends">> & {
  yieldTrends?: YieldTrendsPreferences | boolean;
  greenhouseSnapshot?: boolean;
  yieldByColor?: boolean;
  backendStatus?: boolean;
  forecastingService?: boolean;
};

type SetupResponse = {
  groups: IrrigationGroup[];
};

const INITIAL_SERVICE_STATE: ServiceState = {
  loading: true,
  status: "disconnected",
  response: null
};

const IRRIGATION_SETUP_URL = "/api/irrigation-setup";
const IRRIGATION_LOGS_URL = "/api/irrigation/logs?days=365";
const YIELD_ENTRIES_URL = "/api/yield-entries";
const VARIETIES_URL = "/api/varieties";
const COLOR_CASE_ENTRIES_URL = "/api/color-case-entries";
const YIELD_PROJECTION_URL = "/api/mobile/daily-yield/today-projection";
const RECOMMENDED_MINIMUM_SAMPLE_COUNT = 4;

/**
 * Generate an organization-scoped storage key for dashboard preferences.
 * This ensures dashboard settings are never shared between different organizations.
 * Falls back gracefully if organization ID is "unknown".
 */
function getDashboardStorageKey(organizationId: string): string {
  return `growlink.dashboard.layout:${organizationId}`;
}

const COLOR_STROKES: Record<VarietyColor, string> = {
  red: "#dc2626",
  orange: "#d97706",
  yellow: "#ca8a04",
  green: "#0f7660"
};

const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  otherSections: {
    backendStatus: true,
    forecastingService: true
  },
  irrigationCards: {},
  yieldColorCards: {},
  yieldTrends: {
    showLineGraph: true,
    showPieChart: true,
    lineColors: {},
    pieColors: {}
  }
};

function statusColor(status: ServiceState["status"]) {
  return status === "connected" ? "#0f7660" : "#b42318";
}

/**
 * Weekly kg by Color, used by the card and its full-screen view so both show
 * the same series. Lines only: no point markers, normal or active; the
 * tooltip still follows the pointer and touch along the x axis.
 */
function WeeklyKgByColorChart({
  points,
  colors,
  height
}: {
  points: YieldTrendPoint[];
  colors: VarietyColor[];
  height: number | "100%";
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart
        data={points}
        margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
        <XAxis
          dataKey="label"
          tickFormatter={formatWeekAxisTick}
          tick={{ fill: "var(--text-muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
        />
        <YAxis
          tick={{ fill: "var(--text-muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) => String(roundTo(value, 0))}
          label={{
            value: "total kg",
            angle: -90,
            position: "insideLeft",
            offset: 12,
            style: { fill: "var(--text-muted)", fontSize: 12 }
          }}
          width={64}
        />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 13
          }}
          formatter={(value, name) => {
            const color = String(name);
            return [
              `${roundTo(Number(value), 2)} kg`,
              color.charAt(0).toUpperCase() + color.slice(1)
            ];
          }}
          labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
        />
        <Legend
          formatter={(value: string) =>
            value.charAt(0).toUpperCase() + value.slice(1)
          }
          wrapperStyle={{ fontSize: 13, paddingTop: 8 }}
        />
        {colors.map((color) => (
          <Line
            key={color}
            type="monotone"
            dataKey={color}
            stroke={COLOR_STROKES[color]}
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function formatSampleTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} at ${timePart}`;
}

function readDashboardPreferences(organizationId: string): DashboardPreferences {
  const storageKey = getDashboardStorageKey(organizationId);
  const saved = localStorage.getItem(storageKey);

  if (!saved) {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(saved) as StoredDashboardPreferences;
    const parsedYieldTrends =
      parsed.yieldTrends && typeof parsed.yieldTrends === "object"
        ? parsed.yieldTrends
        : null;
    const legacyOtherSections =
      parsed.otherSections && typeof parsed.otherSections === "object"
        ? (parsed.otherSections as Record<string, unknown>)
        : undefined;

    const irrigationCards: DashboardCardVisibility =
      parsed.irrigationCards && typeof parsed.irrigationCards === "object"
        ? Object.fromEntries(
            Object.entries(parsed.irrigationCards).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
            )
          )
        : {};

    const yieldColorCards: DashboardCardVisibility =
      parsed.yieldColorCards && typeof parsed.yieldColorCards === "object"
        ? Object.fromEntries(
            Object.entries(parsed.yieldColorCards).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
            )
          )
        : {};

    const lineColors: DashboardCardVisibility =
      parsedYieldTrends?.lineColors && typeof parsedYieldTrends.lineColors === "object"
        ? Object.fromEntries(
            Object.entries(parsedYieldTrends.lineColors).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
            )
          )
        : {};

    const pieColors: DashboardCardVisibility =
      parsedYieldTrends?.pieColors && typeof parsedYieldTrends.pieColors === "object"
        ? Object.fromEntries(
            Object.entries(parsedYieldTrends.pieColors).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
            )
          )
        : {};

    const legacyGreenhouseSnapshot =
      typeof parsed.greenhouseSnapshot === "boolean"
        ? parsed.greenhouseSnapshot
        : undefined;
    const legacyYieldByColor =
      typeof parsed.yieldByColor === "boolean" ? parsed.yieldByColor : undefined;
    const legacyYieldTrends =
      typeof parsed.yieldTrends === "boolean" ? parsed.yieldTrends : undefined;
    const legacyYieldTrendsFromOtherSections =
      typeof legacyOtherSections?.yieldTrends === "boolean"
        ? legacyOtherSections.yieldTrends
        : undefined;
    const legacyYieldTrendsVisible =
      legacyYieldTrends ?? legacyYieldTrendsFromOtherSections;

    if (legacyGreenhouseSnapshot !== undefined && Object.keys(irrigationCards).length === 0) {
      irrigationCards.__all__ = legacyGreenhouseSnapshot;
    }

    if (legacyYieldByColor !== undefined && Object.keys(yieldColorCards).length === 0) {
      for (const color of COLOR_ORDER) {
        yieldColorCards[color] = legacyYieldByColor;
      }
    }

    if (legacyYieldTrendsVisible !== undefined) {
      if (parsedYieldTrends) {
        // keep explicit values from new shape
      } else {
        for (const color of COLOR_ORDER) {
          if (typeof lineColors[color] !== "boolean") {
            lineColors[color] = true;
          }

          if (typeof pieColors[color] !== "boolean") {
            pieColors[color] = true;
          }
        }
      }
    }

    return {
      otherSections: {
        backendStatus:
          parsed.otherSections?.backendStatus ?? parsed.backendStatus ?? true,
        forecastingService:
          parsed.otherSections?.forecastingService ?? parsed.forecastingService ?? true
      },
      irrigationCards,
      yieldColorCards,
      yieldTrends: {
        showLineGraph:
          parsedYieldTrends
            ? parsedYieldTrends.showLineGraph ?? true
            : legacyYieldTrendsVisible ?? true,
        showPieChart:
          parsedYieldTrends
            ? parsedYieldTrends.showPieChart ?? true
            : legacyYieldTrendsVisible ?? true,
        lineColors,
        pieColors
      }
    };
  } catch {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }
}

function withDefaultVisibility(
  current: DashboardCardVisibility,
  keys: string[]
): DashboardCardVisibility {
  const next = { ...current };
  const fallbackVisible = current.__all__;

  for (const key of keys) {
    if (typeof next[key] !== "boolean") {
      next[key] = typeof fallbackVisible === "boolean" ? fallbackVisible : true;
    }
  }

  delete next.__all__;

  return next;
}

function buildBalancedRows<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  let cursor = 0;
  let remaining = items.length;

  while (remaining > 0) {
    let rowSize = 0;

    if (remaining <= 4) {
      rowSize = remaining;
    } else if (remaining === 5 || remaining === 6) {
      rowSize = 3;
    } else if (remaining === 7 || remaining === 8) {
      rowSize = 4;
    } else {
      rowSize = remaining % 4 === 1 ? 3 : 4;
    }

    rows.push(items.slice(cursor, cursor + rowSize));
    cursor += rowSize;
    remaining -= rowSize;
  }

  return rows;
}


type YieldProjectionEntry = {
  varietyId: string;
  varietyName: string;
  color: string;
  projectedKg: number;
  projectedCases: number;
  sampledRowCount: number;
  lastSampleDate: string;
  lastUpdatedAt: string;
  lastEnteredByName: string | null;
  lastEnteredByInitials: string | null;
};

type YieldProjectionSummary =
  | { hasProjection: false }
  | {
      hasProjection: true;
      sessionYear: number;
      sessionWeek: number;
      sampledRowCount: number;
      byVariety: YieldProjectionEntry[];
      byColor: Array<{ color: string; totalCases: number }>;
      grandTotal: number;
    };

// ── Pest reminder types & helpers ────────────────────────────────────────────

type PestReminder = {
  id: string;
  type: "spray" | "drench";
  status: "pending" | "in_progress";
  application_date: string | null;
  chemical_snapshot: { name?: string } | null;
  target_snapshot: {
    target_mode?: string;
    valve_names?: string[];
    group_names?: string[];
  } | null;
};

// Returns the number of calendar days between today (local midnight) and the
// application date. Negative = overdue. Uses local date construction to avoid
// UTC-offset bugs (e.g. a YYYY-MM-DD stored as midnight UTC appearing as the
// previous day for North American timezones).
function daysUntilApplication(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split("-").map(Number);
  const appDate = new Date(y, m - 1, d); // local midnight
  return Math.round((appDate.getTime() - today.getTime()) / 86_400_000);
}

function pestReminderLabel(days: number): string {
  if (days < 0) return `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function pestTargetSummary(
  target: { target_mode?: string; valve_names?: string[]; group_names?: string[] } | null
): string {
  if (!target) return "—";
  if (target.target_mode === "valve" && target.valve_names?.length) {
    const n = target.valve_names;
    return n.length <= 3 ? n.join(", ") : `${n.length} valves`;
  }
  if (target.group_names?.length) {
    const n = target.group_names;
    return n.length <= 3 ? n.join(", ") : `${n.length} groups`;
  }
  return "—";
}

export function DashboardPage() {
  const [organizationId, setOrganizationId] = useState<string>("unknown");
  const [backend, setBackend] = useState<ServiceState>(INITIAL_SERVICE_STATE);
  const [forecasting, setForecasting] = useState<ServiceState>(INITIAL_SERVICE_STATE);

  // Irrigation snapshot state
  const [irrigationLoading, setIrrigationLoading] = useState(true);
  const [irrigationError, setIrrigationError] = useState<string | null>(null);
  const [irrigationGroups, setIrrigationGroups] = useState<IrrigationGroup[]>([]);
  const [trackingMode, setTrackingMode] = useState<IrrigationGroupType | null>(null);
  const [latestLogsByGroupId, setLatestLogsByGroupId] = useState<Map<string, IrrigationLogRecord>>(
    new Map()
  );
  const [yieldLoading, setYieldLoading] = useState(true);
  const [yieldError, setYieldError] = useState<string | null>(null);
  const [colorYieldSummary, setColorYieldSummary] = useState<ColorYieldSummary[]>([]);
  const [yieldEntries, setYieldEntries] = useState<ColorYieldEntry[]>([]);
  const [varieties, setVarieties] = useState<ColorYieldVariety[]>([]);
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [preferences, setPreferences] = useState<DashboardPreferences>(() =>
    readDashboardPreferences(organizationId)
  );
  const [draftPreferences, setDraftPreferences] = useState<DashboardPreferences>(() =>
    readDashboardPreferences(organizationId)
  );
  const [yieldProjection, setYieldProjection] = useState<YieldProjectionSummary | null>(null);

  // Pest reminders
  const { canAny } = usePermissions();
  const [pestTodos, setPestTodos] = useState<PestReminder[]>([]);
  const [pestLoading, setPestLoading] = useState(false);

  // Fetch organization ID on mount to scope all dashboard settings
  useEffect(() => {
    let active = true;
    async function loadOrganizationId() {
      const orgId = await getOrganizationId();
      if (active) {
        setOrganizationId(orgId);
      }
    }
    void loadOrganizationId();
    return () => { active = false; };
  }, []);

  // Fetch backend/forecasting status
  useEffect(() => {
    let active = true;
    async function loadStatuses() {
      const [backendResult, forecastingResult] = await Promise.all([
        getBackendHealth(),
        getForecastingStatus()
      ]);
      if (!active) return;
      setBackend({
        loading: false,
        status: backendResult.success ? "connected" : "disconnected",
        response: backendResult
      });
      setForecasting({
        loading: false,
        status: forecastingResult.success ? "connected" : "disconnected",
        response: forecastingResult
      });
    }
    void loadStatuses();
    return () => { active = false; };
  }, []);

  // When organization ID is available, reload preferences for that org
  useEffect(() => {
    if (organizationId && organizationId !== "unknown") {
      const orgPreferences = readDashboardPreferences(organizationId);
      setPreferences(orgPreferences);
      setDraftPreferences(orgPreferences);
    }
  }, [organizationId]);

  useEffect(() => {
    localStorage.setItem(
      getDashboardStorageKey(organizationId),
      JSON.stringify(preferences)
    );
  }, [preferences, organizationId]);

  useEffect(() => {
    let active = true;

    async function fetchYieldProjection() {
      try {
        const res = await apiFetch(YIELD_PROJECTION_URL);
        if (!res.ok || !active) return;
        const data = (await res.json()) as YieldProjectionSummary;
        if (active) setYieldProjection(data);
      } catch {
        // Non-critical — silently skip if projection is unavailable
      }
    }

    void fetchYieldProjection();
    return () => { active = false; };
  }, []);

  // Fetch active pest todos for the reminder card.
  // canAny returns true while membership is loading (optimistic), so the fetch
  // fires on mount. The server enforces permission; a 403 is silently ignored.
  useEffect(() => {
    let active = true;
    async function fetchPestReminders() {
      setPestLoading(true);
      try {
        const res = await apiFetch("/api/pest/todos?status=active");
        if (!res.ok || !active) return;
        const data = (await res.json()) as PestReminder[];
        if (active) setPestTodos(data);
      } catch {
        // Non-critical — silently skip
      } finally {
        if (active) setPestLoading(false);
      }
    }
    void fetchPestReminders();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;

    async function fetchIrrigationSnapshot() {
      setIrrigationLoading(true);
      setIrrigationError(null);

      try {
        const [setupRes, logsRes] = await Promise.all([
          apiFetch(IRRIGATION_SETUP_URL),
          apiFetch(IRRIGATION_LOGS_URL)
        ]);

        if (!setupRes.ok) throw new Error("Failed to fetch irrigation setup");

        if (!logsRes.ok) throw new Error("Failed to fetch irrigation logs");

        const setupData = (await setupRes.json()) as SetupResponse;
        const irrigationLogs = (await logsRes.json()) as IrrigationLogRecord[];
        const {
          trackingMode: mode,
          groups: displayGroups,
          latestLogsByGroupId: nextLatestLogsByGroupId
        } = selectGreenhouseSnapshotGroups(setupData.groups, irrigationLogs);

        if (active) {
          setIrrigationGroups(displayGroups);
          setTrackingMode(mode);
          setLatestLogsByGroupId(nextLatestLogsByGroupId);
        }
      } catch (err) {
        if (active) setIrrigationError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setIrrigationLoading(false);
      }
    }

    void fetchIrrigationSnapshot();
  }, []);

  useEffect(() => {
    let active = true;

    async function fetchYieldByColor() {
      setYieldLoading(true);
      setYieldError(null);

      try {
        const [entriesRes, varietiesRes, colorCaseEntriesRes] = await Promise.all([
          apiFetch(YIELD_ENTRIES_URL),
          apiFetch(VARIETIES_URL),
          apiFetch(COLOR_CASE_ENTRIES_URL)
        ]);

        if (!entriesRes.ok) {
          throw new Error("Failed to fetch yield entries");
        }

        if (!varietiesRes.ok) {
          throw new Error("Failed to fetch varieties");
        }

        if (!colorCaseEntriesRes.ok) {
          throw new Error("Failed to fetch color case entries");
        }

        const entriesRaw = (await entriesRes.json()) as unknown;
        const entries = normalizeYieldEntries(entriesRaw);
        const varieties = (await varietiesRes.json()) as ColorYieldVariety[];
        const colorCaseEntriesRaw = (await colorCaseEntriesRes.json()) as unknown;
        const colorCaseEntries = normalizeColorCaseEntries(colorCaseEntriesRaw);
        const nextSummary = buildColorYieldSummary(entries, varieties ?? [], colorCaseEntries);

        if (active) {
          setYieldEntries(entries);
          setVarieties(varieties ?? []);
          setColorYieldSummary(nextSummary);
        }
      } catch (error) {
        if (active) {
          setYieldError(error instanceof Error ? error.message : "Failed to load yield by color");
        }
      } finally {
        if (active) {
          setYieldLoading(false);
        }
      }
    }

    void fetchYieldByColor();
  }, []);

  const greenhouseSnapshots = useMemo(
    () => pairGreenhouseSnapshots(irrigationGroups, latestLogsByGroupId),
    [irrigationGroups, latestLogsByGroupId]
  );

  useEffect(() => {
    const groupIds = irrigationGroups.map((group) => group.id);

    if (groupIds.length === 0) {
      return;
    }

    setPreferences((current) => ({
      ...current,
      irrigationCards: withDefaultVisibility(current.irrigationCards, groupIds)
    }));
    setDraftPreferences((current) => ({
      ...current,
      irrigationCards: withDefaultVisibility(current.irrigationCards, groupIds)
    }));
  }, [irrigationGroups]);

  useEffect(() => {
    const colorKeys = COLOR_ORDER.map((color) => color);

    setPreferences((current) => ({
      ...current,
      yieldColorCards: withDefaultVisibility(current.yieldColorCards, colorKeys),
      yieldTrends: {
        ...current.yieldTrends,
        lineColors: withDefaultVisibility(current.yieldTrends.lineColors, colorKeys),
        pieColors: withDefaultVisibility(current.yieldTrends.pieColors, colorKeys)
      }
    }));
    setDraftPreferences((current) => ({
      ...current,
      yieldColorCards: withDefaultVisibility(current.yieldColorCards, colorKeys),
      yieldTrends: {
        ...current.yieldTrends,
        lineColors: withDefaultVisibility(current.yieldTrends.lineColors, colorKeys),
        pieColors: withDefaultVisibility(current.yieldTrends.pieColors, colorKeys)
      }
    }));
  }, []);

  const visibleGreenhouseSnapshots = useMemo(
    () =>
      greenhouseSnapshots.filter(
        ({ group }) => preferences.irrigationCards[group.id] !== false
      ),
    [greenhouseSnapshots, preferences.irrigationCards]
  );

  const visibleColorYieldSummary = useMemo(
    () =>
      colorYieldSummary.filter(
        (entry) => preferences.yieldColorCards[entry.color] !== false
      ),
    [colorYieldSummary, preferences.yieldColorCards]
  );

  const greenhouseSnapshotRows = useMemo(
    () => buildBalancedRows(visibleGreenhouseSnapshots),
    [visibleGreenhouseSnapshots]
  );

  const yieldTrendPoints = useMemo<YieldTrendPoint[]>(
    () => buildYieldTrendPoints(yieldEntries, varieties),
    [yieldEntries, varieties]
  );

  const yieldPieSlices = useMemo<YieldPieSlice[]>(
    () => buildYieldPieSlices(colorYieldSummary),
    [colorYieldSummary]
  );

  const visibleTrendLineColors = useMemo(
    () => COLOR_ORDER.filter((color) => preferences.yieldTrends.lineColors[color] !== false),
    [preferences.yieldTrends.lineColors]
  );

  const visibleTrendPieSlices = useMemo(
    () =>
      yieldPieSlices.filter(
        (slice) => preferences.yieldTrends.pieColors[slice.color] !== false
      ),
    [preferences.yieldTrends.pieColors, yieldPieSlices]
  );

  // Jobs with an application_date that is overdue or within the next 7 days,
  // sorted: most-overdue first, then due today, then soonest upcoming.
  const upcomingReminders = useMemo(() => {
    const WINDOW = 7;
    return pestTodos
      .filter((t) => {
        if (!t.application_date) return false;
        const days = daysUntilApplication(t.application_date);
        return days <= WINDOW;
      })
      .map((t) => ({ ...t, daysUntil: daysUntilApplication(t.application_date!) }))
      .sort((a, b) => a.daysUntil - b.daysUntil);
  }, [pestTodos]);

  const hasYieldTrendData = yieldTrendPoints.length > 0;
  /** Weekly kg by Color full-screen view; it renders the same memoised points as the card. */
  const fullscreenChart = useFullscreenChart<"weeklyKgByColor">();
  const hasYieldPieData = visibleTrendPieSlices.some((slice) => slice.kg > 0);
  const showYieldTrendsSection =
    preferences.yieldTrends.showLineGraph || preferences.yieldTrends.showPieChart;

  function openCustomizeModal() {
    setDraftPreferences(preferences);
    setIsCustomizeOpen(true);
  }

  function closeCustomizeModal() {
    setDraftPreferences(preferences);
    setIsCustomizeOpen(false);
  }

  function saveCustomizeModal() {
    setPreferences(draftPreferences);
    setIsCustomizeOpen(false);
  }

  return (
    <section className="page-shell">
      <header className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p>Greenhouse operations overview — irrigation, crop yield, and analytics.</p>
        </div>

        <button
          type="button"
          className="dashboard-edit-button"
          onClick={openCustomizeModal}
        >
          Edit
        </button>
      </header>

      {/* ── Upcoming Pest Applications ──────────────────────────────────────── */}
      {canAny(["pest:view", "pest:edit"]) ? (
        <div className="coming-soon-card">
          <h2>Upcoming Pest Applications</h2>

          {pestLoading ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.9em", marginTop: "0.5rem" }}>
              Loading…
            </p>
          ) : upcomingReminders.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.9em", marginTop: "0.5rem" }}>
              No pest applications due in the next 7 days.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "0.75rem" }}>
              {upcomingReminders.map((todo) => {
                const chemName = todo.chemical_snapshot?.name ?? "Unknown chemical";
                const target   = pestTargetSummary(todo.target_snapshot);
                const label    = pestReminderLabel(todo.daysUntil);
                const isOverdue = todo.daysUntil < 0;
                const isToday   = todo.daysUntil === 0;
                const accentColor = isOverdue
                  ? "#b42318"
                  : isToday
                    ? "var(--brand, #0f7660)"
                    : "var(--text-muted)";

                return (
                  <div
                    key={todo.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "0.75rem",
                      padding: "0.65rem 0.85rem",
                      borderRadius: "10px",
                      background: isOverdue
                        ? "#fff5f5"
                        : isToday
                          ? "var(--brand-soft, #d8f3eb)"
                          : "var(--surface-soft, #f2f6f4)",
                      border: `1px solid ${isOverdue ? "#fecdca" : isToday ? "var(--brand, #0f7660)" : "var(--border)"}`,
                    }}
                  >
                    {/* Time indicator */}
                    <div style={{ flexShrink: 0, minWidth: "120px" }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.78em",
                          fontWeight: 700,
                          color: accentColor,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        {label}
                      </span>
                      <span style={{ display: "block", fontSize: "0.78em", color: "var(--text-muted)", marginTop: "0.1rem" }}>
                        {todo.application_date}
                      </span>
                    </div>

                    {/* Details */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: "0.9em" }}>
                        <strong>{chemName}</strong>
                        {" "}
                        <span className="pest-todo-type-badge" data-type={todo.type} style={{ fontSize: "0.75em", verticalAlign: "middle" }}>
                          {todo.type === "spray" ? "Spray" : "Drench"}
                        </span>
                        {" "}
                        <span style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                          for {target}
                        </span>
                      </p>
                    </div>

                    {/* Status badge */}
                    <div style={{ flexShrink: 0 }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.15rem 0.5rem",
                          borderRadius: "999px",
                          fontSize: "0.72em",
                          fontWeight: 600,
                          background: todo.status === "in_progress" ? "var(--brand-soft, #d8f3eb)" : "var(--surface, #fff)",
                          color: todo.status === "in_progress" ? "var(--brand, #0f7660)" : "var(--text-muted)",
                          border: "1px solid var(--border)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {todo.status === "in_progress" ? "In Progress" : "Not Started"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {visibleGreenhouseSnapshots.length > 0 ? (
        <div className="coming-soon-card">
          <h2>Greenhouse Snapshot</h2>
          <p className="dashboard-section-subtitle">
            Latest irrigation readings by {trackingMode ? TRACKING_LABELS[trackingMode].toLowerCase() : "phase/zone"}.
          </p>

          {irrigationLoading ? <p>Loading...</p> : null}
          {irrigationError ? <p className="form-error">{irrigationError}</p> : null}
          {!irrigationLoading && !irrigationError && greenhouseSnapshots.length === 0 ? (
            <p>No active irrigation groups found. Add active groups in Irrigation Setup first.</p>
          ) : null}
          {!irrigationLoading && !irrigationError && visibleGreenhouseSnapshots.length > 0 ? (
            <div className="dashboard-snapshot-rows">
              {greenhouseSnapshotRows.map((row, rowIndex) => (
                <div
                  key={`snapshot-row-${rowIndex}`}
                  className="dashboard-snapshot-row"
                  style={{
                    ["--dashboard-snapshot-row-columns" as string]: String(
                      Math.min(4, Math.max(1, row.length))
                    )
                  }}
                >
                  {row.map(({ group, log }) => (
                    <article key={group.id} className="dashboard-snapshot-card">
                      <div className="dashboard-snapshot-title-row">
                        <h3>{group.name}</h3>
                        <span className="dashboard-snapshot-type-badge">
                          {TRACKING_LABELS[group.type]}
                        </span>
                      </div>

                      <div className="dashboard-snapshot-columns">
                        <div className="dashboard-snapshot-column">
                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Feed EC</span>
                            <span className="dashboard-snapshot-value">
                              {formatSnapshotNumber(log?.feed_ec, 2)}
                            </span>
                          </div>

                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Feed pH</span>
                            <span className="dashboard-snapshot-value">
                              {formatSnapshotNumber(log?.feed_ph, 2)}
                            </span>
                          </div>
                        </div>

                        <div className="dashboard-snapshot-column">
                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Drain EC</span>
                            <span className="dashboard-snapshot-value">
                              {formatSnapshotNumber(log?.drain_ec, 2)}
                            </span>
                          </div>

                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Drain pH</span>
                            <span className="dashboard-snapshot-value">
                              {formatSnapshotNumber(log?.drain_ph, 2)}
                            </span>
                          </div>
                        </div>

                        <div className="dashboard-snapshot-column">
                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Avg Feed ml</span>
                            <span className="dashboard-snapshot-value">{getAvgFeedMl(log)}</span>
                          </div>

                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Drain %</span>
                            <span className="dashboard-snapshot-value">{getDrainPercent(log)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="dashboard-snapshot-footer">
                        <span className="dashboard-snapshot-label">Last Reading</span>
                        <span className="dashboard-snapshot-value dashboard-snapshot-date">
                          {getLastReadingDate(log)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {visibleColorYieldSummary.length > 0 ? (
        <div className="coming-soon-card dashboard-yield-card">
          <h2>Yield by Color</h2>
          <p className="dashboard-section-subtitle">Total kg/m2 by color.</p>

          {yieldLoading ? <p>Loading...</p> : null}
          {yieldError ? <p className="form-error">{yieldError}</p> : null}

          {!yieldLoading && !yieldError ? (
            <div
              className="dashboard-card-grid dashboard-yield-color-row"
              style={{
                ["--dashboard-card-columns" as string]: String(
                  Math.min(4, Math.max(1, visibleColorYieldSummary.length))
                )
              }}
            >
              {visibleColorYieldSummary.map((entry) => (
                <div key={entry.color} className="dashboard-yield-color-pill">
                  <span className={`color-badge ${entry.color}`}>
                    {entry.color.charAt(0).toUpperCase() + entry.color.slice(1)}
                  </span>

                  <div className="dashboard-yield-color-metrics">
                    <div className="dashboard-yield-color-metric">
                      <span className="dashboard-yield-color-metric-label">Harvested</span>
                      <span className="dashboard-yield-color-metric-value">
                        {formatColorKgPerM2(entry.harvestedKgPerM2)}
                      </span>
                    </div>

                    <div className="dashboard-yield-color-metric">
                      <span className="dashboard-yield-color-metric-label">Shipped (kg/m²)</span>
                      <span className="dashboard-yield-color-metric-value">
                        {formatColorKgPerM2(entry.exportedKgPerM2)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {showYieldTrendsSection ? (
        <div className="coming-soon-card dashboard-trends-card">
          <h2>Yield Trends</h2>

          {yieldLoading ? <p>Loading...</p> : null}
          {yieldError ? <p className="form-error">{yieldError}</p> : null}

          {!yieldLoading && !yieldError ? (
            <div
              className={`dashboard-trends-grid ${
                preferences.yieldTrends.showLineGraph !== preferences.yieldTrends.showPieChart
                  ? "single"
                  : ""
              }`}
            >
              {preferences.yieldTrends.showLineGraph ? (
                <section className="dashboard-trend-panel dashboard-trend-panel-wide">
                  <div className="dashboard-trend-panel-header dashboard-trend-panel-header--with-action">
                    <h3>Weekly kg by Color</h3>
                    {visibleTrendLineColors.length > 0 && hasYieldTrendData ? (
                      <ExpandChartButton
                        title="Weekly kg by Color"
                        onClick={() => fullscreenChart.open("weeklyKgByColor")}
                        buttonRef={fullscreenChart.buttonRef("weeklyKgByColor")}
                      />
                    ) : null}
                  </div>

                  {visibleTrendLineColors.length === 0 ? (
                    <p>No graph colors selected.</p>
                  ) : !hasYieldTrendData ? (
                    <p>No yield data available yet.</p>
                  ) : (
                    <div className="dashboard-chart-wrapper">
                      <WeeklyKgByColorChart points={yieldTrendPoints} colors={visibleTrendLineColors} height={280} />
                    </div>
                  )}
                </section>
              ) : null}

              {fullscreenChart.expanded === "weeklyKgByColor" ? (
                <FullscreenChartOverlay title="Weekly kg by Color" onClose={fullscreenChart.close}>
                  <WeeklyKgByColorChart points={yieldTrendPoints} colors={visibleTrendLineColors} height="100%" />
                </FullscreenChartOverlay>
              ) : null}

              {preferences.yieldTrends.showPieChart ? (
                <section className="dashboard-trend-panel">
                  <div className="dashboard-trend-panel-header">
                    <h3>Total Picked by Color</h3>
                  </div>

                  {visibleTrendPieSlices.length === 0 ? (
                    <p>No pie colors selected.</p>
                  ) : !hasYieldPieData ? (
                    <p>No yield data available yet.</p>
                  ) : (
                    <div className="dashboard-chart-wrapper dashboard-pie-layout">
                      <div className="dashboard-pie-side dashboard-pie-labels">
                        {visibleTrendPieSlices.map((slice) => (
                          <div key={`label-${slice.color}`} className="dashboard-pie-row">
                            <span className={`color-badge ${slice.color}`}>
                              {slice.color.charAt(0).toUpperCase() + slice.color.slice(1)}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="dashboard-pie-wrapper">
                        <ResponsiveContainer width="100%" height={260}>
                          <PieChart>
                            <Pie
                              data={visibleTrendPieSlices}
                              dataKey="kg"
                              nameKey="color"
                              innerRadius={52}
                              outerRadius={86}
                              paddingAngle={2}
                            >
                              {visibleTrendPieSlices.map((slice) => (
                                <Cell key={slice.color} fill={COLOR_STROKES[slice.color]} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={{
                                background: "var(--surface)",
                                border: "1px solid var(--border)",
                                borderRadius: 10,
                                fontSize: 13
                              }}
                              formatter={(value, name, item) => {
                                const payload = item.payload as YieldPieSlice;
                                const label = String(name);
                                return [
                                  `${roundTo(Number(value), 2)} kg (${payload.percent}%)`,
                                  label.charAt(0).toUpperCase() + label.slice(1)
                                ];
                              }}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="dashboard-pie-side dashboard-pie-values">
                        {visibleTrendPieSlices.map((slice) => (
                          <div key={`value-${slice.color}`} className="dashboard-pie-row">
                            <span className="dashboard-pie-legend-value">
                              {slice.kg} kg | {slice.percent}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {preferences.otherSections.backendStatus ? (
        <div className="coming-soon-card">
          <h2>Backend Status</h2>
          <p>
            {backend.loading ? (
              "Loading..."
            ) : (
              <span style={{ color: statusColor(backend.status), fontWeight: 600 }}>
                {backend.status === "connected" ? "Connected" : "Disconnected"}
              </span>
            )}
          </p>
        </div>
      ) : null}

      {preferences.otherSections.forecastingService ? (
        <div className="coming-soon-card">
          <h2>Forecasting Service</h2>
          <p>
            {forecasting.loading ? (
              "Loading..."
            ) : (
              <span
                style={{ color: statusColor(forecasting.status), fontWeight: 600 }}
              >
                {forecasting.status === "connected" ? "Connected" : "Disconnected"}
              </span>
            )}
          </p>
        </div>
      ) : null}

      {yieldProjection?.hasProjection ? (
        <div className="coming-soon-card dashboard-daily-yield-projection-card">
          <h2>Daily Yield Projection</h2>
          <p className="dashboard-section-subtitle">
            Estimated cases from mobile bin sampling — Week {yieldProjection.sessionWeek}, {yieldProjection.sessionYear}.
            Not recorded/actual yield.
          </p>

          <div className="dashboard-daily-yield-projection-grid">
            {yieldProjection.byVariety.map((entry) => {
              const isProjectionReady = entry.sampledRowCount >= RECOMMENDED_MINIMUM_SAMPLE_COUNT;
              const rowsNeeded = RECOMMENDED_MINIMUM_SAMPLE_COUNT - entry.sampledRowCount;

              return (
                <div
                  key={entry.varietyId}
                  className="dyp-card"
                  style={{ borderLeftColor: COLOR_STROKES[entry.color as VarietyColor] ?? "#5c6b66" }}
                >
                  <div className="dyp-card-header">
                    <span className={`color-badge ${entry.color}`}>{entry.varietyName}</span>
                    <span className="dyp-card-sample-count">
                      {entry.sampledRowCount} sampled {entry.sampledRowCount === 1 ? "row" : "rows"}
                    </span>
                  </div>

                  <div className="dyp-card-metrics">
                    <div className="dyp-card-metric">
                      <span className="dyp-card-metric-value">
                        {Math.round(entry.projectedKg).toLocaleString()} kg
                      </span>
                      <span className="dyp-card-metric-label">Projected kg</span>
                    </div>
                    <div className="dyp-card-metric">
                      <span className="dyp-card-metric-value">
                        {Math.round(entry.projectedCases).toLocaleString()} cases
                      </span>
                      <span className="dyp-card-metric-label">Projected cases</span>
                    </div>
                  </div>

                  {isProjectionReady ? (
                    <p className="dyp-card-status dyp-card-status-ready">✓ Projection Ready</p>
                  ) : (
                    <p className="dyp-card-status dyp-card-status-preliminary">
                      ⚠ Preliminary Projection
                      <br />
                      Sample {rowsNeeded} more {rowsNeeded === 1 ? "row" : "rows"} for a more reliable estimate.
                    </p>
                  )}

                  <p className="dyp-card-meta">
                    Last sample: {entry.lastUpdatedAt ? formatSampleTimestamp(entry.lastUpdatedAt) : "—"}
                    {entry.lastEnteredByName ? ` · ${entry.lastEnteredByName}` : ""}
                  </p>
                </div>
              );
            })}
          </div>

          <Link className="dashboard-daily-yield-view-samples-link" to="/yield/daily-yield-samples">
            View Samples →
          </Link>
        </div>
      ) : null}

      {isCustomizeOpen ? (
        <ModalOverlay
          onClose={closeCustomizeModal}
          contentClassName="variety-modal dashboard-customize-modal"
          titleId="dashboard-customize-title"
        >
            <h2 id="dashboard-customize-title">Customize Dashboard</h2>
            <p className="dashboard-customize-copy">
              Choose which sections appear on the desktop dashboard.
            </p>

            <div className="dashboard-customize-content">
              <div className="dashboard-checkbox-columns">
                <div className="dashboard-checkbox-column">
                  <section className="dashboard-checkbox-group">
                    <h3>Yield Color Cards</h3>
                    <div className="dashboard-checkbox-list">
                      {COLOR_ORDER.map((color) => (
                        <label key={color} className="dashboard-checkbox-row">
                          <input
                            type="checkbox"
                            checked={draftPreferences.yieldColorCards[color] !== false}
                            onChange={(event) =>
                              setDraftPreferences((current) => ({
                                ...current,
                                yieldColorCards: {
                                  ...current.yieldColorCards,
                                  [color]: event.target.checked
                                }
                              }))
                            }
                          />
                          <span>{color.charAt(0).toUpperCase() + color.slice(1)}</span>
                        </label>
                      ))}
                    </div>
                  </section>

                  <section className="dashboard-checkbox-group">
                    <h3>Yield Trends</h3>

                    <p className="dashboard-checkbox-subtitle">Charts</p>
                    <div className="dashboard-checkbox-list dashboard-checkbox-list-tight">
                      <label className="dashboard-checkbox-row">
                        <input
                          type="checkbox"
                          checked={draftPreferences.yieldTrends.showLineGraph}
                          onChange={(event) =>
                            setDraftPreferences((current) => ({
                              ...current,
                              yieldTrends: {
                                ...current.yieldTrends,
                                showLineGraph: event.target.checked
                              }
                            }))
                          }
                        />
                        <span>Weekly kg by Color graph</span>
                      </label>

                      <label className="dashboard-checkbox-row">
                        <input
                          type="checkbox"
                          checked={draftPreferences.yieldTrends.showPieChart}
                          onChange={(event) =>
                            setDraftPreferences((current) => ({
                              ...current,
                              yieldTrends: {
                                ...current.yieldTrends,
                                showPieChart: event.target.checked
                              }
                            }))
                          }
                        />
                        <span>Total Picked by Color pie chart</span>
                      </label>
                    </div>

                    <p className="dashboard-checkbox-subtitle">Weekly graph colors</p>
                    <div className="dashboard-checkbox-list dashboard-checkbox-list-tight">
                      {COLOR_ORDER.map((color) => (
                        <label key={`line-${color}`} className="dashboard-checkbox-row">
                          <input
                            type="checkbox"
                            checked={draftPreferences.yieldTrends.lineColors[color] !== false}
                            onChange={(event) =>
                              setDraftPreferences((current) => ({
                                ...current,
                                yieldTrends: {
                                  ...current.yieldTrends,
                                  lineColors: {
                                    ...current.yieldTrends.lineColors,
                                    [color]: event.target.checked
                                  }
                                }
                              }))
                            }
                          />
                          <span>{color.charAt(0).toUpperCase() + color.slice(1)}</span>
                        </label>
                      ))}
                    </div>
                  </section>
                </div>

                <div className="dashboard-checkbox-column">
                  <section className="dashboard-checkbox-group">
                    <h3>Pie chart colors</h3>
                    <div className="dashboard-checkbox-list dashboard-checkbox-list-tight">
                      {COLOR_ORDER.map((color) => (
                        <label key={`pie-${color}`} className="dashboard-checkbox-row">
                          <input
                            type="checkbox"
                            checked={draftPreferences.yieldTrends.pieColors[color] !== false}
                            onChange={(event) =>
                              setDraftPreferences((current) => ({
                                ...current,
                                yieldTrends: {
                                  ...current.yieldTrends,
                                  pieColors: {
                                    ...current.yieldTrends.pieColors,
                                    [color]: event.target.checked
                                  }
                                }
                              }))
                            }
                          />
                          <span>{color.charAt(0).toUpperCase() + color.slice(1)}</span>
                        </label>
                      ))}
                    </div>
                  </section>

                  <section className="dashboard-checkbox-group">
                    <h3>Irrigation Cards</h3>
                    <div className="dashboard-checkbox-list">
                      {irrigationGroups.map((group) => (
                        <label key={group.id} className="dashboard-checkbox-row">
                          <input
                            type="checkbox"
                            checked={draftPreferences.irrigationCards[group.id] !== false}
                            onChange={(event) =>
                              setDraftPreferences((current) => ({
                                ...current,
                                irrigationCards: {
                                  ...current.irrigationCards,
                                  [group.id]: event.target.checked
                                }
                              }))
                            }
                          />
                          <span>{group.name}</span>
                        </label>
                      ))}
                    </div>
                  </section>

                  <section className="dashboard-checkbox-group">
                    <h3>Other Sections</h3>
                    <div className="dashboard-checkbox-list">
                      <label className="dashboard-checkbox-row">
                        <input
                          type="checkbox"
                          checked={draftPreferences.otherSections.backendStatus}
                          onChange={(event) =>
                            setDraftPreferences((current) => ({
                              ...current,
                              otherSections: {
                                ...current.otherSections,
                                backendStatus: event.target.checked
                              }
                            }))
                          }
                        />
                        <span>Backend Status</span>
                      </label>

                      <label className="dashboard-checkbox-row">
                        <input
                          type="checkbox"
                          checked={draftPreferences.otherSections.forecastingService}
                          onChange={(event) =>
                            setDraftPreferences((current) => ({
                              ...current,
                              otherSections: {
                                ...current.otherSections,
                                forecastingService: event.target.checked
                              }
                            }))
                          }
                        />
                        <span>Forecasting Service</span>
                      </label>
                    </div>
                  </section>
                </div>
              </div>
            </div>

            <div className="form-actions dashboard-customize-actions">
              <button type="button" onClick={saveCustomizeModal}>
                Save
              </button>
              <button type="button" className="secondary" onClick={closeCustomizeModal}>
                Cancel
              </button>
            </div>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
