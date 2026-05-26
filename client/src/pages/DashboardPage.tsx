
import { useEffect, useMemo, useState } from "react";
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

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";

type IrrigationGroup = {
  id: string;
  type: GroupType;
  name: string;
  status: StatusType;
  created_at?: string;
};

type ExistingLog = {
  id: string;
  log_date: string;
  tracking_mode: GroupType;
  group_id: string | null;
  group_key: string;
  group_name: string;
  feed_valve_ids: string[];
  drain_bucket_ids: string[];
  feed_ph: number | null;
  feed_ec: number | null;
  drain_ph: number | null;
  drain_ec: number | null;
  feed_valve_readings?: Array<{ id: string; name: string; volume_ml: number | null; dripper_count?: number | null }>;
  drain_bucket_readings?: Array<{ id: string; name: string; volume_ml: number | null; dripper_count?: number | null }>;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type ServiceState = {
  loading: boolean;
  status: "connected" | "disconnected";
  response: ApiResult | null;
};

type VarietyColor = "red" | "orange" | "yellow" | "green";

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

type IrrigationLogRecord = ExistingLog;

type YieldEntryRecord = {
  variety_id: string;
  year: number;
  week: number;
  total_kg: number;
};

type VarietyRecord = {
  id: string;
  color: VarietyColor | string | null;
  area_m2: number;
  status: StatusType;
};

type ColorYieldSummary = {
  color: VarietyColor;
  totalKg: number;
  totalAreaM2: number;
  harvestedKgPerM2: number | null;
  exportedKg: number;
  exportedKgPerM2: number | null;
};

type ColorCaseEntryRecord = {
  color: VarietyColor | string | null;
  total_cases: number;
  case_weight_kg: number;
  total_kg: number;
};

type YieldTrendPoint = {
  label: string;
  sortKey: number;
  red: number;
  orange: number;
  yellow: number;
  green: number;
};

type YieldPieSlice = {
  color: VarietyColor;
  kg: number;
  percent: number;
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

/**
 * Generate an organization-scoped storage key for dashboard preferences.
 * This ensures dashboard settings are never shared between different organizations.
 * Falls back gracefully if organization ID is "unknown".
 */
function getDashboardStorageKey(organizationId: string): string {
  return `growlink.dashboard.layout:${organizationId}`;
}

const TRACKING_LABELS: Record<GroupType, string> = {
  phase: "Phase",
  zone: "Zone",
  color: "Color"
};

const COLOR_ORDER: VarietyColor[] = ["red", "orange", "yellow", "green"];
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

function resolveTrackingMode(groups: IrrigationGroup[]): GroupType | null {
  if (groups.length === 0) {
    return null;
  }

  const counts = new Map<GroupType, number>();
  const firstSeenOrder: GroupType[] = [];

  for (const group of groups) {
    const current = counts.get(group.type) ?? 0;
    counts.set(group.type, current + 1);

    if (current === 0) {
      firstSeenOrder.push(group.type);
    }
  }

  let selectedType = firstSeenOrder[0];
  let selectedCount = counts.get(selectedType) ?? 0;

  for (const type of firstSeenOrder) {
    const count = counts.get(type) ?? 0;

    if (count > selectedCount) {
      selectedType = type;
      selectedCount = count;
    }
  }

  return selectedType;
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeColor(value: unknown): VarietyColor | null {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (color === "red" || color === "orange" || color === "yellow" || color === "green") {
    return color;
  }

  return null;
}

function readNumberField(
  record: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const raw = record[key];
    const parsed = typeof raw === "number" ? raw : Number(raw);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function readStringField(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const raw = record[key];

    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return null;
}

function normalizeYieldEntries(input: unknown): YieldEntryRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: YieldEntryRecord[] = [];

  for (const rawEntry of input) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const varietyId = readStringField(entry, ["variety_id", "varietyId"]);
    const totalKg = readNumberField(entry, ["total_kg", "totalKg"]);
    const week = readNumberField(entry, ["week", "iso_week", "weekNumber"]);
    const year = readNumberField(entry, ["year", "iso_year"]);

    if (!varietyId || totalKg === null || week === null || year === null) {
      continue;
    }

    if (totalKg < 0) {
      continue;
    }

    const normalizedWeek = Math.trunc(week);
    const normalizedYear = Math.trunc(year);

    if (normalizedWeek < 1 || normalizedWeek > 53) {
      continue;
    }

    result.push({
      variety_id: varietyId,
      total_kg: totalKg,
      week: normalizedWeek,
      year: normalizedYear
    });
  }

  return result;
}

function normalizeColorCaseEntries(input: unknown): ColorCaseEntryRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: ColorCaseEntryRecord[] = [];

  for (const rawEntry of input) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const totalCases = readNumberField(entry, ["total_cases", "totalCases"]);
    const caseWeightKg = readNumberField(entry, ["case_weight_kg", "caseWeightKg"]);
    const totalKg = readNumberField(entry, ["total_kg", "totalKg"]) ?? 0;

    if (totalCases === null || caseWeightKg === null || totalCases < 0 || caseWeightKg < 0) {
      continue;
    }

    result.push({
      color: (entry.color as VarietyColor | string | null) ?? null,
      total_cases: totalCases,
      case_weight_kg: caseWeightKg,
      total_kg: totalKg
    });
  }

  return result;
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


export function DashboardPage() {
  const [organizationId, setOrganizationId] = useState<string>("unknown");
  const [backend, setBackend] = useState<ServiceState>(INITIAL_SERVICE_STATE);
  const [forecasting, setForecasting] = useState<ServiceState>(INITIAL_SERVICE_STATE);

  // Irrigation snapshot state
  const [irrigationLoading, setIrrigationLoading] = useState(true);
  const [irrigationError, setIrrigationError] = useState<string | null>(null);
  const [irrigationGroups, setIrrigationGroups] = useState<IrrigationGroup[]>([]);
  const [trackingMode, setTrackingMode] = useState<GroupType | null>(null);
  const [latestLogsByGroupId, setLatestLogsByGroupId] = useState<Map<string, IrrigationLogRecord>>(
    new Map()
  );
  const [yieldLoading, setYieldLoading] = useState(true);
  const [yieldError, setYieldError] = useState<string | null>(null);
  const [colorYieldSummary, setColorYieldSummary] = useState<ColorYieldSummary[]>([]);
  const [yieldEntries, setYieldEntries] = useState<YieldEntryRecord[]>([]);
  const [varieties, setVarieties] = useState<VarietyRecord[]>([]);
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [preferences, setPreferences] = useState<DashboardPreferences>(() =>
    readDashboardPreferences(organizationId)
  );
  const [draftPreferences, setDraftPreferences] = useState<DashboardPreferences>(() =>
    readDashboardPreferences(organizationId)
  );

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
        const activeGroups = (setupData.groups ?? []).filter(
          (group) => group.status === "active"
        );
        const mode = resolveTrackingMode(activeGroups);
        const displayGroups =
          mode === null ? [] : activeGroups.filter((group) => group.type === mode);
        const nextLatestLogsByGroupId = new Map<string, IrrigationLogRecord>();

        for (const log of irrigationLogs ?? []) {
          const groupId = typeof log.group_key === "string" ? log.group_key : "";

          if (!groupId || nextLatestLogsByGroupId.has(groupId)) {
            continue;
          }

          nextLatestLogsByGroupId.set(groupId, log);
        }

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
        const varieties = (await varietiesRes.json()) as VarietyRecord[];
        const colorCaseEntriesRaw = (await colorCaseEntriesRes.json()) as unknown;
        const colorCaseEntries = normalizeColorCaseEntries(colorCaseEntriesRaw);
        const activeVarieties = (varieties ?? []).filter(
          (variety) => variety.status === "active"
        );
        const varietyById = new Map<string, VarietyRecord>();
        const totalsByColor = new Map<
          VarietyColor,
          { totalKg: number; exportedKg: number; totalAreaM2: number }
        >();

        for (const color of COLOR_ORDER) {
          totalsByColor.set(color, { totalKg: 0, exportedKg: 0, totalAreaM2: 0 });
        }

        for (const variety of activeVarieties) {
          const color = normalizeColor(variety.color);
          if (!color) {
            continue;
          }

          varietyById.set(variety.id, variety);
          const bucket = totalsByColor.get(color)!;
          bucket.totalAreaM2 +=
            Number.isFinite(Number(variety.area_m2)) && Number(variety.area_m2) > 0
              ? Number(variety.area_m2)
              : 0;
        }

        for (const entry of entries ?? []) {
          const variety = varietyById.get(entry.variety_id);
          const color = normalizeColor(variety?.color);
          const totalKg = Number(entry.total_kg);

          if (!color || !Number.isFinite(totalKg) || totalKg < 0) {
            continue;
          }

          const bucket = totalsByColor.get(color)!;
          bucket.totalKg += totalKg;
        }

        for (const entry of colorCaseEntries ?? []) {
          const color = normalizeColor(entry.color);
          const totalCases = Number(entry.total_cases);
          const caseWeightKg = Number(entry.case_weight_kg);

          if (!color || !Number.isFinite(totalCases) || !Number.isFinite(caseWeightKg)) {
            continue;
          }

          if (totalCases < 0 || caseWeightKg < 0) {
            continue;
          }

          const bucket = totalsByColor.get(color)!;
          bucket.exportedKg += entry.total_kg;
        }

        const nextSummary = COLOR_ORDER.map((color) => {
          const bucket = totalsByColor.get(color)!;
          const harvestedKgPerM2 =
            bucket.totalAreaM2 > 0 ? bucket.totalKg / bucket.totalAreaM2 : null;
          const exportedKgPerM2 =
            bucket.totalAreaM2 > 0 ? bucket.exportedKg / bucket.totalAreaM2 : null;

          return {
            color,
            totalKg: bucket.totalKg,
            totalAreaM2: bucket.totalAreaM2,
            harvestedKgPerM2,
            exportedKg: bucket.exportedKg,
            exportedKgPerM2
          };
        });

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
    () =>
      irrigationGroups.map((group) => ({
        group,
        log: latestLogsByGroupId.get(group.id) ?? null
      })),
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

  const yieldTrendPoints = useMemo<YieldTrendPoint[]>(() => {
    const varietyColorById = new Map<string, VarietyColor>();

    for (const variety of varieties) {
      const color = normalizeColor(variety.color);
      if (color) {
        varietyColorById.set(variety.id, color);
      }
    }

    const byWeek = new Map<string, YieldTrendPoint>();

    for (const entry of yieldEntries) {
      const color = varietyColorById.get(entry.variety_id);
      const totalKg = Number(entry.total_kg);
      const year = Number(entry.year);
      const week = Number(entry.week);

      if (!color || !Number.isFinite(totalKg) || !Number.isFinite(year) || !Number.isFinite(week)) {
        continue;
      }

      const label = `W${week} ${year}`;
      const sortKey = year * 100 + week;

      if (!byWeek.has(label)) {
        byWeek.set(label, {
          label,
          sortKey,
          red: 0,
          orange: 0,
          yellow: 0,
          green: 0
        });
      }

      const point = byWeek.get(label)!;
      point[color] += totalKg;
    }

    return Array.from(byWeek.values())
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((point) => ({
        ...point,
        red: roundTo(point.red, 2),
        orange: roundTo(point.orange, 2),
        yellow: roundTo(point.yellow, 2),
        green: roundTo(point.green, 2)
      }));
  }, [yieldEntries, varieties]);

  const yieldPieSlices = useMemo<YieldPieSlice[]>(() => {
    const colorTotals = new Map<VarietyColor, number>();

    for (const color of COLOR_ORDER) {
      colorTotals.set(color, 0);
    }

    for (const entry of colorYieldSummary) {
      colorTotals.set(entry.color, entry.totalKg);
    }

    const greenhouseTotalKg = Array.from(colorTotals.values()).reduce(
      (sum, value) => sum + value,
      0
    );

    return COLOR_ORDER.map((color) => {
      const kg = colorTotals.get(color) ?? 0;
      return {
        color,
        kg: roundTo(kg, 2),
        percent: greenhouseTotalKg > 0 ? roundTo((kg / greenhouseTotalKg) * 100, 1) : 0
      };
    });
  }, [colorYieldSummary]);

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

  const hasYieldTrendData = yieldTrendPoints.length > 0;
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

  function formatNumber(val: number | null | undefined, decimals = 2) {
    if (val === null || val === undefined || !Number.isFinite(val)) return "—";
    return String(roundTo(Number(val), decimals));
  }

  function formatPercent(val: number | null | undefined, decimals = 2) {
    if (val === null || val === undefined || !Number.isFinite(val)) return "—";
    return `${roundTo(Number(val), decimals)}%`;
  }

  function getDrainPercent(log: ExistingLog | null) {
    if (!log) return "—";

    const feed = (log.feed_valve_readings ?? [])
      .map((reading) => ({
        volumeMl:
          typeof reading.volume_ml === "number" &&
          Number.isFinite(reading.volume_ml) &&
          reading.volume_ml >= 0
            ? reading.volume_ml
            : null,
        dripperCount:
          Number(reading.dripper_count) > 0 ? Number(reading.dripper_count) : 1
      }))
      .filter(
        (reading): reading is { volumeMl: number; dripperCount: number } =>
          reading.volumeMl !== null
      );
    const drain = (log.drain_bucket_readings ?? [])
      .map((reading) => ({
        volumeMl:
          typeof reading.volume_ml === "number" &&
          Number.isFinite(reading.volume_ml) &&
          reading.volume_ml >= 0
            ? reading.volume_ml
            : null,
        dripperCount:
          Number(reading.dripper_count) > 0 ? Number(reading.dripper_count) : 1
      }))
      .filter(
        (reading): reading is { volumeMl: number; dripperCount: number } =>
          reading.volumeMl !== null
      );

    if (!feed.length || !drain.length) return "—";

    // Normalise each reading by its own dripper count, then average.
    // Averaging raw volumes and dripper counts separately gives a wrong result
    // when readings have different dripper counts.
    const avgFeedPerDripper =
      feed.reduce((sum, r) => sum + r.volumeMl / r.dripperCount, 0) / feed.length;
    const avgDrainPerDripper =
      drain.reduce((sum, r) => sum + r.volumeMl / r.dripperCount, 0) / drain.length;

    if (!Number.isFinite(avgFeedPerDripper) || avgFeedPerDripper <= 0) return "—";
    if (!Number.isFinite(avgDrainPerDripper) || avgDrainPerDripper < 0) return "—";

    return formatPercent((avgDrainPerDripper / avgFeedPerDripper) * 100, 2);
  }

  function getAvgFeedMl(log: ExistingLog | null) {
    if (!log) return "—";

    const values = (log.feed_valve_readings ?? [])
      .map((reading) =>
        typeof reading.volume_ml === "number" &&
        Number.isFinite(reading.volume_ml) &&
        reading.volume_ml >= 0
          ? reading.volume_ml
          : null
      )
      .filter((value): value is number => value !== null);

    if (!values.length) return "—";

    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return String(Math.round(avg));
  }

  function getLastReadingDate(log: ExistingLog | null) {
    if (!log) return "No readings yet";
    return log.log_date || "—";
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
                              {formatNumber(log?.feed_ec, 2)}
                            </span>
                          </div>

                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Feed pH</span>
                            <span className="dashboard-snapshot-value">
                              {formatNumber(log?.feed_ph, 2)}
                            </span>
                          </div>
                        </div>

                        <div className="dashboard-snapshot-column">
                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Drain EC</span>
                            <span className="dashboard-snapshot-value">
                              {formatNumber(log?.drain_ec, 2)}
                            </span>
                          </div>

                          <div className="dashboard-snapshot-metric">
                            <span className="dashboard-snapshot-label">Drain pH</span>
                            <span className="dashboard-snapshot-value">
                              {formatNumber(log?.drain_ph, 2)}
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
                        {entry.harvestedKgPerM2 === null
                          ? "—"
                          : `${roundTo(entry.harvestedKgPerM2, 2)} kg/m2`}
                      </span>
                    </div>

                    <div className="dashboard-yield-color-metric">
                      <span className="dashboard-yield-color-metric-label">Shipped (kg/m²)</span>
                      <span className="dashboard-yield-color-metric-value">
                        {entry.exportedKgPerM2 === null
                          ? "—"
                          : `${roundTo(entry.exportedKgPerM2, 2)} kg/m2`}
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
                  <div className="dashboard-trend-panel-header">
                    <h3>Weekly kg by Color</h3>
                  </div>

                  {visibleTrendLineColors.length === 0 ? (
                    <p>No graph colors selected.</p>
                  ) : !hasYieldTrendData ? (
                    <p>No yield data available yet.</p>
                  ) : (
                    <div className="dashboard-chart-wrapper">
                      <ResponsiveContainer width="100%" height={280}>
                        <LineChart
                          data={yieldTrendPoints}
                          margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
                        >
                          <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
                          <XAxis
                            dataKey="label"
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
                          {visibleTrendLineColors.map((color) => (
                            <Line
                              key={color}
                              type="monotone"
                              dataKey={color}
                              stroke={COLOR_STROKES[color]}
                              strokeWidth={2.2}
                              dot={{ r: 3 }}
                              activeDot={{ r: 5 }}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </section>
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

      {isCustomizeOpen ? (
        <div className="modal-overlay" role="presentation" onClick={closeCustomizeModal}>
          <div
            className="variety-modal dashboard-customize-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-customize-title"
            onClick={(event) => event.stopPropagation()}
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
          </div>
        </div>
      ) : null}
    </section>
  );
}
