import { useEffect, useMemo, useState } from "react";
import {
  Legend,
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid
} from "recharts";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { downloadBlobFile } from "../lib/downloadFile";
import { apiFetch } from "../lib/api";
import { incompleteShippedText, type ShippedYieldResponse } from "../lib/shippedYield";
import { fetchShippedYield } from "../lib/shippedYieldApi";
import { ModalOverlay } from "../components/ModalOverlay";
import { ExpandChartButton, FullscreenChartOverlay, useFullscreenChart } from "../components/charts/FullscreenChart";
import { formatWeekAxisTick } from "../components/charts/weekAxis";
import { computeFarmKgPerM2, type AreaFootprints } from "../lib/yieldAnalytics/farmKgPerM2";

type YieldSize = {
  id: string;
  name: string;
  sort_order: number;
};

type AnalyticsRow = {
  variety_id: string;
  variety_name: string;
  entries_count: number;
  total_kg: number;
  waste_pct: number;
  avg_fruit_weight_g: number | null;
  kg_per_m2: number | null;
  size_pct: Record<string, number>;
};

type WasteImport = {
  id: string;
  variety_id: string | null;
  year: number;
  week: number;
  waste_kg: number;
};

/** An enabled product (crop) and what its yield records carry. */
type CropOption = {
  code: string;
  name: string;
  tracksColour: boolean;
  tracksSizes: boolean;
  status: "active" | "inactive";
  defaultUnitCode?: string;
};

type AnalyticsSummary = {
  sizes: YieldSize[];
  rows: AnalyticsRow[];
  products?: CropOption[];
};

type YieldEntry = {
  id: string;
  variety_id: string;
  variety_name: string;
  year: number;
  week: number;
  kg_per_m2: number;
  total_kg: number;
  average_fruit_weight_g: number | null;
  size_kg?: Record<string, number>;
  /** The variety's product; absent from a server that predates products. */
  product_code?: string | null;
  /** "pcs" for a piece count (migration 0151): its kg fields are null and never counted as kg. */
  unit_code?: "kg" | "pcs";
  total_pieces?: number;
  pieces_per_m2?: number | null;
};

/** One variety's piece counts for the selected period. */
type PieceRow = {
  variety_id: string;
  variety_name: string;
  entries_count: number;
  total_pieces: number;
  pieces_per_m2: number | null;
};

/** The Variety Summary as the screen, the preview, the CSV and the PDF all show it. */
type SummaryCell = string | number;
type SummaryTableRow = { key: string; cells: SummaryCell[] };
type SummaryTarget = "screen" | "pdf" | "csv";

type ChartPoint = {
  label: string;
  sortKey: number;
  [varietyId: string]: number | string;
};

type VarietyColor = "red" | "orange" | "yellow" | "green";

type VarietyMeta = {
  id: string;
  name: string;
  area_m2: number;
  color: VarietyColor | null;
  case_kg: number;
};

type ReconciliationRow = {
  color: VarietyColor;
  harvestedKg: number;
  /** Single-colour shipping cases (mixed packs are counted once, separately). */
  shippedCases: number;
  /** From the shipped-yield calculation: measured cases only. */
  shippedKg: number;
  remainingKg: number;
};

type WeekFilterMode = "full-year" | "single-week" | "week-range";
type ExportPreviewType = "pdf" | "csv";

const LINE_COLORS = [
  "#0f7660",
  "#2563eb",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#be185d",
  "#65a30d"
];

const CHART_TOOLTIP_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(31, 42, 46, 0.12)",
  fontSize: 13,
  padding: "0.5rem 0.75rem"
};
const CHART_TOOLTIP_LABEL_STYLE = { color: "var(--text)", fontWeight: 600, marginBottom: 4 };
const CHART_LEGEND_STYLE = { fontSize: 13, paddingTop: 8 };

const prefersReducedMotion =
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Placeholder rows shaped like a table, so the card keeps its size while data loads. */
function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="ya-table-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="ya-skeleton ya-skeleton--row" />
      ))}
    </div>
  );
}

type ChartId = "kgm2" | "afw" | "pcsm2";

type ChartDefinition = {
  id: ChartId;
  title: string;
  description: string;
  emptyTitle: string;
  emptyBody: string;
  axisLabel: string;
  tickDecimals: number;
  valueDecimals: number;
  unit: string;
};

const CHARTS: ChartDefinition[] = [
  {
    id: "kgm2",
    title: "kg / m² Over Time",
    description: "Weekly kg/m² per variety across all recorded weeks. Not affected by the filters.",
    emptyTitle: "No kg/m² data yet",
    emptyBody: "Add entries in Yield Data Entry to see this chart.",
    axisLabel: "kg / m²",
    tickDecimals: 2,
    valueDecimals: 3,
    unit: " kg/m²"
  },
  {
    id: "afw",
    title: "Average Fruit Weight Over Time",
    description: "Average fruit weight (g) by week across all varieties. Not affected by the filters.",
    emptyTitle: "No average fruit weight data yet",
    emptyBody: "It appears once entries include an average fruit weight.",
    axisLabel: "Avg fruit weight (g)",
    tickDecimals: 1,
    valueDecimals: 1,
    unit: " g"
  }
];

// Shown only for a crop with piece counts: pieces are a count, so they get
// their own chart rather than a line on the kg/m² one.
const PIECES_CHART: ChartDefinition = {
  id: "pcsm2",
  title: "Pieces / m² Over Time",
  description: "Weekly pieces/m² per variety across all recorded weeks, from piece counts. Not affected by the filters.",
  emptyTitle: "No pieces/m² data yet",
  emptyBody: "It appears once a piece count has a variety with an area.",
  axisLabel: "pieces / m²",
  tickDecimals: 1,
  valueDecimals: 2,
  unit: " pcs/m²"
};

/**
 * One trend chart, used by both the card and its full-screen view so they
 * always show the same series. Lines only: no point markers (normal or
 * active); the tooltip still follows the pointer/touch along the x axis.
 */
function TrendChart({
  chart,
  points,
  varietyIds,
  varietyNameById
}: {
  chart: ChartDefinition;
  points: ChartPoint[];
  varietyIds: string[];
  varietyNameById: Record<string, string>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
        <XAxis dataKey="label" tickFormatter={formatWeekAxisTick} tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={16} />
        <YAxis
          tick={{ fill: "var(--text-muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => String(roundTo(v, chart.tickDecimals))}
          label={{ value: chart.axisLabel, angle: -90, position: "insideLeft", offset: 12, style: { fill: "var(--text-muted)", fontSize: 12 } }}
          width={64}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(value, name) => [
            typeof value === "number" ? `${roundTo(value, chart.valueDecimals)}${chart.unit}` : String(value),
            typeof name === "string" ? (varietyNameById[name] ?? name) : String(name)
          ]}
          labelStyle={CHART_TOOLTIP_LABEL_STYLE}
        />
        <Legend formatter={(value: string) => varietyNameById[value] ?? value} iconType="circle" iconSize={8} wrapperStyle={CHART_LEGEND_STYLE} />
        {varietyIds.map((varietyId, index) => (
          <Line
            key={varietyId}
            type="monotone"
            dataKey={varietyId}
            name={varietyId}
            stroke={LINE_COLORS[index % LINE_COLORS.length]}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={false}
            connectNulls={false}
            isAnimationActive={!prefersReducedMotion}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const COLOR_ORDER: VarietyColor[] = ["red", "orange", "yellow", "green"];

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatWholePercent(value: number) {
  return `${Math.round(value || 0)}%`;
}

function formatKgPerM2(value: number | null) {
  if (value === null || !Number.isFinite(Number(value))) {
    return "-";
  }

  return Number(value).toFixed(1);
}

/** Numerator / denominator shown under the farm kg/m2 — grouped, with the precision the figures carry. */
function formatKgFigure(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatAreaFigure(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatWastePct(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatAvgFruitWeight(value: number | null) {
  if (value === null || !Number.isFinite(Number(value))) {
    return "-";
  }

  return String(Math.round(Number(value)));
}

function normalizeColor(value: unknown): VarietyColor | null {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (color === "red" || color === "orange" || color === "yellow" || color === "green") {
    return color;
  }

  return null;
}

function getWeekStartSunday(year: number, week: number) {
  const jan1 = new Date(year, 0, 1);
  const start = new Date(jan1);
  start.setDate(jan1.getDate() - jan1.getDay() + (week - 1) * 7);
  return start;
}

function formatMonthDay(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit"
  });
}

function createWeekOptions(year: number) {
  const options: Array<{ value: number; label: string }> = [];

  for (let week = 1; week <= 53; week += 1) {
    const start = getWeekStartSunday(year, week);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    options.push({
      value: week,
      label: `Week ${week} - ${formatMonthDay(start)} to ${formatMonthDay(end)}`
    });
  }

  return options;
}

function getCurrentWeek(year: number) {
  const now = new Date();
  const jan1 = new Date(year, 0, 1);
  const weekOneStart = new Date(jan1);
  weekOneStart.setDate(jan1.getDate() - jan1.getDay());

  const diffMs = now.getTime() - weekOneStart.getTime();
  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;

  return Math.min(Math.max(week, 1), 53);
}

function getWeekFilterLabel(mode: WeekFilterMode, singleWeek: number, fromWeek: number, toWeek: number) {
  if (mode === "single-week") {
    return `Week ${singleWeek}`;
  }

  if (mode === "week-range") {
    const start = Math.min(fromWeek, toWeek);
    const end = Math.max(fromWeek, toWeek);
    return `Weeks ${start}-${end}`;
  }

  return "Full Year";
}

// cropSlug is set only when the organization grows more than one crop, so a
// single-crop organization's file names are unchanged.
function getExportFileBaseName(year: number, mode: WeekFilterMode, singleWeek: number, fromWeek: number, toWeek: number, cropSlug: string | null = null) {
  const base = cropSlug ? `growlink-variety-summary-${cropSlug}` : "growlink-variety-summary";

  if (mode === "single-week") {
    return `${base}-${year}-week-${singleWeek}`;
  }

  if (mode === "week-range") {
    const start = Math.min(fromWeek, toWeek);
    const end = Math.max(fromWeek, toWeek);
    return `${base}-${year}-weeks-${start}-${end}`;
  }

  return `${base}-${year}`;
}

function cropSlugFor(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Bell Peppers when the organization grows them, else its first crop. */
function defaultCropCode(crops: CropOption[]) {
  return crops.find((crop) => crop.code === "bell_pepper")?.code ?? crops[0]?.code ?? null;
}

function toCsvCell(value: string | number) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}


function buildChartData(
  entries: YieldEntry[],
  valueOf: (entry: YieldEntry) => number | null | undefined = (entry) => entry.kg_per_m2
): { points: ChartPoint[]; varietyIds: string[] } {
  const labelMap = new Map<string, ChartPoint>();
  const varietyIdSet = new Set<string>();

  for (const entry of entries) {
    const label = `W${entry.week} ${entry.year}`;
    const sortKey = entry.year * 100 + entry.week;

    if (!labelMap.has(label)) {
      labelMap.set(label, { label, sortKey });
    }

    const point = labelMap.get(label)!;
    const value = valueOf(entry);
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
    point[entry.variety_id] = roundTo(Number(value), 3);
    varietyIdSet.add(entry.variety_id);
  }

  const points = Array.from(labelMap.values()).sort((a, b) => a.sortKey - b.sortKey);
  const varietyIds = Array.from(varietyIdSet);

  return { points, varietyIds };
}

function buildAverageFruitWeightChartData(
  entries: YieldEntry[]
): { points: ChartPoint[]; varietyIds: string[] } {
  type VarietyWeightAggregate = {
    weightedFruitWeightSum: number;
    weightedKgTotal: number;
    simpleFruitWeightSum: number;
    simpleCount: number;
  };

  type WeekAggregate = {
    label: string;
    sortKey: number;
    byVariety: Map<string, VarietyWeightAggregate>;
  };

  const byWeek = new Map<string, WeekAggregate>();

  for (const entry of entries) {
    const fruitWeight = Number(entry.average_fruit_weight_g);
    if (!Number.isFinite(fruitWeight)) {
      continue;
    }

    const weekKey = `${entry.year}-${entry.week}`;
    const label = `W${entry.week} ${entry.year}`;
    const sortKey = entry.year * 100 + entry.week;

    if (!byWeek.has(weekKey)) {
      byWeek.set(weekKey, {
        label,
        sortKey,
        byVariety: new Map<string, VarietyWeightAggregate>()
      });
    }

    const weekAggregate = byWeek.get(weekKey)!;
    if (!weekAggregate.byVariety.has(entry.variety_id)) {
      weekAggregate.byVariety.set(entry.variety_id, {
        weightedFruitWeightSum: 0,
        weightedKgTotal: 0,
        simpleFruitWeightSum: 0,
        simpleCount: 0
      });
    }

    const varietyAggregate = weekAggregate.byVariety.get(entry.variety_id)!;
    const totalKg = Number(entry.total_kg);

    if (Number.isFinite(totalKg) && totalKg > 0) {
      varietyAggregate.weightedFruitWeightSum += fruitWeight * totalKg;
      varietyAggregate.weightedKgTotal += totalKg;
    }

    varietyAggregate.simpleFruitWeightSum += fruitWeight;
    varietyAggregate.simpleCount += 1;
  }

  const varietyIdSet = new Set<string>();
  const points = Array.from(byWeek.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((weekAggregate) => {
      const point: ChartPoint = {
        label: weekAggregate.label,
        sortKey: weekAggregate.sortKey
      };

      for (const [varietyId, aggregate] of weekAggregate.byVariety.entries()) {
        const value = aggregate.weightedKgTotal > 0
          ? aggregate.weightedFruitWeightSum / aggregate.weightedKgTotal
          : aggregate.simpleCount > 0
            ? aggregate.simpleFruitWeightSum / aggregate.simpleCount
            : null;

        if (value !== null && Number.isFinite(value)) {
          point[varietyId] = roundTo(value, 3);
          varietyIdSet.add(varietyId);
        }
      }

      return point;
    });

  return {
    points,
    varietyIds: Array.from(varietyIdSet)
  };
}

export function YieldAnalyticsPage() {
  const currentYear = new Date().getFullYear();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [entries, setEntries] = useState<YieldEntry[]>([]);
  // Shipped totals for the selected period, from the one shipped-yield calculation.
  const [shipped, setShipped] = useState<ShippedYieldResponse | null>(null);
  const [shippedError, setShippedError] = useState<string | null>(null);
  const [varietyMeta, setVarietyMeta] = useState<VarietyMeta[]>([]);
  const [wasteImports, setWasteImports] = useState<WasteImport[]>([]);
  /** Physical growing-area footprints for farm-wide kg/m2; null when they could not be loaded. */
  const [areaFootprints, setAreaFootprints] = useState<AreaFootprints | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [weekFilterMode, setWeekFilterMode] = useState<WeekFilterMode>("full-year");
  const [selectedWeek, setSelectedWeek] = useState<number>(getCurrentWeek(currentYear));
  const [fromWeek, setFromWeek] = useState<number>(1);
  const [toWeek, setToWeek] = useState<number>(getCurrentWeek(currentYear));
  /** The crop every figure, chart and export on the page is for. */
  const [selectedCropCode, setSelectedCropCode] = useState<string | null>(null);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [exportPreviewType, setExportPreviewType] = useState<ExportPreviewType | null>(null);
  /** The graph open full-screen; it renders the same memoised data as its card. */
  const fullscreen = useFullscreenChart<ChartId>();
  /** Bumped by the error panel's Retry to re-run the same load. */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [summaryRes, entriesRes, varietiesRes, wasteRes, areasRes] = await Promise.all([
          apiFetch("/api/yield-analytics/summary"),
          // units=all: piece counts too, kept apart from kg below.
          apiFetch("/api/yield-entries?units=all"),
          apiFetch("/api/varieties"),
          apiFetch("/api/waste-imports"),
          apiFetch("/api/yield-analytics/area-footprints")
        ]);

        if (!summaryRes.ok) {
          throw new Error(`Failed to load analytics (${summaryRes.status})`);
        }
        if (!entriesRes.ok) {
          throw new Error(`Failed to load entries (${entriesRes.status})`);
        }

        const summaryData = (await summaryRes.json()) as AnalyticsSummary;
        const entriesData = (await entriesRes.json()) as YieldEntry[];

        let varietiesData: VarietyMeta[] = [];
        if (varietiesRes.ok) {
          const rawVarieties = (await varietiesRes.json()) as Array<{
            id: string;
            name: string;
            area_m2: number;
            color: unknown;
            case_kg: number;
          }>;
          varietiesData = rawVarieties
            .map((item) => {
              const color = normalizeColor(item.color);
              const caseKg = Number(item.case_kg);
              const areaM2 = Number(item.area_m2);

              if (!Number.isFinite(caseKg) || !Number.isFinite(areaM2)) {
                return null;
              }

              return {
                id: item.id,
                name: item.name,
                area_m2: areaM2,
                color,
                case_kg: caseKg
              };
            })
            .filter((item): item is VarietyMeta => item !== null);
        }

        let wasteData: WasteImport[] = [];
        if (wasteRes.ok) {
          wasteData = (await wasteRes.json()) as WasteImport[];
        }

        // Non-fatal like the other secondary loads: without it only the farm-wide kg/m2 is unavailable.
        let areasData: AreaFootprints | null = null;
        if (areasRes.ok) {
          areasData = (await areasRes.json()) as AreaFootprints;
        }

        if (active) {
          setAreaFootprints(areasData);
          setSummary(summaryData);
          setEntries(entriesData);
          setVarietyMeta(varietiesData);
          setWasteImports(wasteData);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load analytics");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Crops: the organization's enabled products. A server or organization
  // without products information is treated as one crop (no filtering).
  const crops = useMemo(() => summary?.products ?? [], [summary]);
  const showCropSelector = crops.length > 1;
  const cropCode = selectedCropCode && crops.some((crop) => crop.code === selectedCropCode)
    ? selectedCropCode
    : defaultCropCode(crops);
  const selectedCrop = crops.find((crop) => crop.code === cropCode) ?? null;

  // Every figure below — totals, kg/m², waste, size mix, charts, exports —
  // is computed from this one list, so they always agree and one crop's kg
  // never lands in another's.
  //
  // Piece counts are never in this list: they have no kg. They get their
  // own list, summary rows, KPIs and chart (cropPieceEntries below).
  const kgEntries = useMemo(() => entries.filter((entry) => entry.unit_code !== "pcs"), [entries]);
  const pieceEntries = useMemo(() => entries.filter((entry) => entry.unit_code === "pcs"), [entries]);

  const cropEntries = useMemo(() => {
    if (!cropCode) return kgEntries;
    return kgEntries.filter((entry) => (entry.product_code ?? "bell_pepper") === cropCode);
  }, [kgEntries, cropCode]);

  const cropPieceEntries = useMemo(() => {
    if (!cropCode) return pieceEntries;
    return pieceEntries.filter((entry) => (entry.product_code ?? "bell_pepper") === cropCode);
  }, [pieceEntries, cropCode]);

  const { points: pieceChartPoints, varietyIds: pieceVarietyIds } = useMemo(
    () => buildChartData(cropPieceEntries, (entry) => entry.pieces_per_m2),
    [cropPieceEntries]
  );

  const { points: chartPoints, varietyIds } = useMemo(
    () => buildChartData(cropEntries),
    [cropEntries]
  );

  const { points: fruitWeightChartPoints, varietyIds: fruitWeightVarietyIds } = useMemo(
    () => buildAverageFruitWeightChartData(cropEntries),
    [cropEntries]
  );

  const varietyNameById = useMemo(() => {
    const map: Record<string, string> = {};

    for (const variety of varietyMeta) {
      map[variety.id] = variety.name;
    }

    if (summary) {
      for (const row of summary.rows) {
        if (!map[row.variety_id]) {
          map[row.variety_id] = row.variety_name;
        }
      }
    }

    return map;
  }, [summary, varietyMeta]);

  const weekOptions = useMemo(() => createWeekOptions(selectedYear), [selectedYear]);

  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    years.add(currentYear);

    for (const entry of [...cropEntries, ...cropPieceEntries]) {
      const year = Number(entry.year);
      if (Number.isInteger(year)) {
        years.add(year);
      }
    }

    return Array.from(years).sort((a, b) => b - a);
  }, [cropEntries, cropPieceEntries, currentYear]);

  // The selected year and week filter, as one test for kg entries and piece counts alike.
  const inSelectedPeriod = useMemo(
    () => (entry: YieldEntry) => {
      const year = Number(entry.year);
      const week = Number(entry.week);
      if (!Number.isInteger(year) || !Number.isInteger(week) || year !== selectedYear) return false;
      if (weekFilterMode === "single-week") return week === selectedWeek;
      if (weekFilterMode === "week-range") {
        return week >= Math.min(fromWeek, toWeek) && week <= Math.max(fromWeek, toWeek);
      }
      return true;
    },
    [selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek]
  );

  const filteredPieceEntries = useMemo(() => cropPieceEntries.filter(inSelectedPeriod), [cropPieceEntries, inSelectedPeriod]);

  const filteredEntries = useMemo(() => {
    return cropEntries.filter((entry) => {
      const year = Number(entry.year);
      const week = Number(entry.week);

      if (!Number.isInteger(year) || !Number.isInteger(week)) {
        return false;
      }

      if (year !== selectedYear) {
        return false;
      }

      if (weekFilterMode === "single-week") {
        return week === selectedWeek;
      }

      if (weekFilterMode === "week-range") {
        const minWeek = Math.min(fromWeek, toWeek);
        const maxWeek = Math.max(fromWeek, toWeek);
        return week >= minWeek && week <= maxWeek;
      }

      return true;
    });
  }, [cropEntries, selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek]);

  const filteredWasteKgByVarietyId = useMemo(() => {
    const map = new Map<string, number>();

    for (const row of wasteImports) {
      if (!row.variety_id) continue;

      const year = Number(row.year);
      const week = Number(row.week);

      if (!Number.isInteger(year) || !Number.isInteger(week)) continue;
      if (year !== selectedYear) continue;

      if (weekFilterMode === "single-week" && week !== selectedWeek) continue;

      if (weekFilterMode === "week-range") {
        const minWeek = Math.min(fromWeek, toWeek);
        const maxWeek = Math.max(fromWeek, toWeek);
        if (week < minWeek || week > maxWeek) continue;
      }

      const wasteKg = Number(row.waste_kg);
      if (!Number.isFinite(wasteKg) || wasteKg < 0) continue;

      map.set(row.variety_id, (map.get(row.variety_id) ?? 0) + wasteKg);
    }

    return map;
  }, [wasteImports, selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek]);

  const farmKgPerM2 = useMemo(() => computeFarmKgPerM2(filteredEntries, areaFootprints), [filteredEntries, areaFootprints]);

  const filteredVarietySummary = useMemo(() => {
    if (!summary) {
      return { sizes: [] as YieldSize[], rows: [] as AnalyticsRow[], averageRow: null as AnalyticsRow | null };
    }

    // A crop without size buckets (Cucumbers) has no size mix columns.
    const sizes = selectedCrop && !selectedCrop.tracksSizes ? [] : summary.sizes ?? [];
    const varietiesById = new Map<string, VarietyMeta>();
    for (const variety of varietyMeta) {
      varietiesById.set(variety.id, variety);
    }

    type SummaryAccumulator = {
      variety_id: string;
      variety_name: string;
      entries_count: number;
      total_kg: number;
      weighted_fw_sum: number;
      weighted_fw_kg: number;
      fruit_count_sum: number;
      fruit_count_kg: number;
      area_m2: number;
      size_kg_sum: Record<string, number>;
    };

    const byVariety = new Map<string, SummaryAccumulator>();

    for (const entry of filteredEntries) {
      const varietyId = entry.variety_id;
      if (!varietyId) {
        continue;
      }

      const variety = varietiesById.get(varietyId);
      const totalKg = Number(entry.total_kg);
      const avgFruitWeightG = Number(entry.average_fruit_weight_g);

      if (!byVariety.has(varietyId)) {
        byVariety.set(varietyId, {
          variety_id: varietyId,
          variety_name: variety?.name ?? entry.variety_name ?? "-",
          entries_count: 0,
          total_kg: 0,
          weighted_fw_sum: 0,
          weighted_fw_kg: 0,
          fruit_count_sum: 0,
          fruit_count_kg: 0,
          area_m2: variety?.area_m2 ?? 0,
          size_kg_sum: {}
        });
      }

      const bucket = byVariety.get(varietyId)!;
      bucket.entries_count += 1;

      if (Number.isFinite(totalKg)) {
        bucket.total_kg += totalKg;
      }

      if (Number.isFinite(avgFruitWeightG) && Number.isFinite(totalKg) && totalKg > 0) {
        bucket.weighted_fw_sum += avgFruitWeightG * totalKg;
        bucket.weighted_fw_kg += totalKg;
      }

      // Fruit count derived per entry (kg -> g / AFW g-per-fruit), kept separate from the
      // arithmetic weighted_fw_sum/kg above since combining mass/count across entries requires
      // a harmonic-style ratio (total kg / total fruit count), not an average of AFW values.
      if (Number.isFinite(avgFruitWeightG) && avgFruitWeightG > 0 && Number.isFinite(totalKg) && totalKg > 0) {
        bucket.fruit_count_sum += (totalKg * 1000) / avgFruitWeightG;
        bucket.fruit_count_kg += totalKg;
      }

      const sizeKg = (entry.size_kg ?? {}) as Record<string, number>;
      for (const [sizeId, kgRaw] of Object.entries(sizeKg)) {
        const kg = Number(kgRaw);
        if (!Number.isFinite(kg)) {
          continue;
        }

        bucket.size_kg_sum[sizeId] = (bucket.size_kg_sum[sizeId] ?? 0) + kg;
      }
    }

    const rows: AnalyticsRow[] = Array.from(byVariety.values())
      .map((item) => {
        const sizePct: Record<string, number> = {};

        for (const size of sizes) {
          const sizeKg = item.size_kg_sum[size.id] ?? 0;
          sizePct[size.id] = item.total_kg > 0 ? (sizeKg / item.total_kg) * 100 : 0;
        }

        const wasteKg = filteredWasteKgByVarietyId.get(item.variety_id) ?? 0;
        const waste_pct = item.total_kg > 0 ? (wasteKg / item.total_kg) * 100 : 0;

        return {
          variety_id: item.variety_id,
          variety_name: item.variety_name,
          entries_count: item.entries_count,
          total_kg: item.total_kg,
          waste_pct,
          avg_fruit_weight_g:
            item.weighted_fw_kg > 0 ? item.weighted_fw_sum / item.weighted_fw_kg : null,
          kg_per_m2: item.area_m2 > 0 ? item.total_kg / item.area_m2 : null,
          size_pct: sizePct
        };
      })
      .sort((a, b) => a.variety_name.localeCompare(b.variety_name));

    let averageRow: AnalyticsRow | null = null;

    if (byVariety.size > 0) {
      let totalEntriesCount = 0;
      let totalKg = 0;
      let totalWasteKg = 0;
      let totalFruitCount = 0;
      let totalFruitCountKg = 0;
      const sizeKgTotals: Record<string, number> = {};

      for (const item of byVariety.values()) {
        totalEntriesCount += item.entries_count;
        totalKg += item.total_kg;
        totalWasteKg += filteredWasteKgByVarietyId.get(item.variety_id) ?? 0;
        totalFruitCount += item.fruit_count_sum;
        totalFruitCountKg += item.fruit_count_kg;

        for (const [sizeId, kg] of Object.entries(item.size_kg_sum)) {
          sizeKgTotals[sizeId] = (sizeKgTotals[sizeId] ?? 0) + kg;
        }
      }

      // Denominator is the total kg actually classified into a size bucket, not the
      // variety's overall total_kg (which can include waste/unclassified kg) — otherwise
      // the size percentages would under-total instead of summing to ~100%.
      let totalClassifiedSizeKg = 0;
      for (const size of sizes) {
        totalClassifiedSizeKg += sizeKgTotals[size.id] ?? 0;
      }

      const averageSizePct: Record<string, number> = {};
      for (const size of sizes) {
        const sizeKg = sizeKgTotals[size.id] ?? 0;
        averageSizePct[size.id] = totalClassifiedSizeKg > 0 ? (sizeKg / totalClassifiedSizeKg) * 100 : 0;
      }

      averageRow = {
        variety_id: "__average__",
        variety_name: "Average",
        entries_count: totalEntriesCount,
        total_kg: totalKg,
        waste_pct: totalKg > 0 ? (totalWasteKg / totalKg) * 100 : 0,
        // Combined AFW = total kg / total estimated fruit count (a mass-weighted harmonic
        // mean), not a simple kg-weighted average of AFW values — those diverge whenever
        // entries with very different fruit sizes are combined.
        avg_fruit_weight_g: totalFruitCount > 0 ? (totalFruitCountKg * 1000) / totalFruitCount : null,
        // Farm-wide: all qualifying kg over unique physical growing area (see farmKgPerM2.ts),
        // never a sum of variety area_m2, which double-counts renamed or split varieties.
        kg_per_m2: farmKgPerM2.kgPerM2,
        size_pct: averageSizePct
      };
    }

    return { sizes, rows, averageRow };
  }, [summary, selectedCrop, varietyMeta, filteredEntries, filteredWasteKgByVarietyId, farmKgPerM2]);

  // Piece counts per variety for the period: total pieces, and pieces/m² over
  // the variety's area (none without one). The total row's pieces/m² is
  // farm-wide over unique growing area, as kg/m² is.
  const farmPiecesPerM2 = useMemo(
    () =>
      computeFarmKgPerM2(
        filteredPieceEntries.map((entry) => ({ variety_id: entry.variety_id, total_kg: Number(entry.total_pieces ?? 0) })),
        areaFootprints
      ),
    [filteredPieceEntries, areaFootprints]
  );

  const pieceSummary = useMemo(() => {
    const areaById = new Map(varietyMeta.map((variety) => [variety.id, variety]));
    const byVariety = new Map<string, PieceRow>();
    for (const entry of filteredPieceEntries) {
      const pieces = Number(entry.total_pieces ?? 0);
      if (!Number.isFinite(pieces)) continue;
      const row = byVariety.get(entry.variety_id) ?? {
        variety_id: entry.variety_id,
        variety_name: areaById.get(entry.variety_id)?.name ?? entry.variety_name ?? "-",
        entries_count: 0,
        total_pieces: 0,
        pieces_per_m2: null
      };
      row.entries_count += 1;
      row.total_pieces += pieces;
      byVariety.set(entry.variety_id, row);
    }
    const rows = Array.from(byVariety.values())
      .map((row) => {
        const area = areaById.get(row.variety_id)?.area_m2 ?? 0;
        return { ...row, pieces_per_m2: area > 0 ? row.total_pieces / area : null };
      })
      .sort((a, b) => a.variety_name.localeCompare(b.variety_name));
    const total: PieceRow | null = rows.length
      ? {
          variety_id: "__average__",
          variety_name: "Average",
          entries_count: rows.reduce((sum, row) => sum + row.entries_count, 0),
          total_pieces: rows.reduce((sum, row) => sum + row.total_pieces, 0),
          pieces_per_m2: farmPiecesPerM2.kgPerM2
        }
      : null;
    return { rows, total };
  }, [filteredPieceEntries, varietyMeta, farmPiecesPerM2]);

  // With piece counts in the period, every Variety Summary view gets a Unit
  // column and pieces columns; a piece row leaves the weight-only columns
  // blank. Without them the table is exactly as before.
  const showPieces = pieceSummary.rows.length > 0;

  const summaryTable = useMemo(() => {
    const sizes = filteredVarietySummary.sizes;
    const kgCells = (row: AnalyticsRow, name: string): SummaryCell[] =>
      showPieces
        ? [
            name,
            "kg",
            row.entries_count,
            roundTo(row.total_kg, 2),
            "",
            formatWastePct(row.waste_pct),
            formatAvgFruitWeight(row.avg_fruit_weight_g),
            formatKgPerM2(row.kg_per_m2),
            "",
            ...sizes.map((size) => formatWholePercent(row.size_pct[size.id] ?? 0))
          ]
        : [
            name,
            row.entries_count,
            roundTo(row.total_kg, 2),
            formatWastePct(row.waste_pct),
            formatAvgFruitWeight(row.avg_fruit_weight_g),
            formatKgPerM2(row.kg_per_m2),
            ...sizes.map((size) => formatWholePercent(row.size_pct[size.id] ?? 0))
          ];
    const pieceCells = (row: PieceRow, name: string): SummaryCell[] => [
      name,
      "pieces",
      row.entries_count,
      "",
      Math.round(row.total_pieces),
      "",
      "",
      "",
      formatKgPerM2(row.pieces_per_m2),
      ...sizes.map(() => "")
    ];

    const body: Array<SummaryTableRow & { sortName: string; unitOrder: number }> = [
      ...filteredVarietySummary.rows.map((row) => ({
        key: `kg-${row.variety_id}`,
        cells: kgCells(row, row.variety_name),
        sortName: row.variety_name,
        unitOrder: 0
      })),
      ...pieceSummary.rows.map((row) => ({
        key: `pcs-${row.variety_id}`,
        cells: pieceCells(row, row.variety_name),
        sortName: row.variety_name,
        unitOrder: 1
      }))
    ].sort((a, b) => a.sortName.localeCompare(b.sortName) || a.unitOrder - b.unitOrder);

    const foot: SummaryTableRow[] = [];
    if (filteredVarietySummary.averageRow) {
      foot.push({ key: "average-kg", cells: kgCells(filteredVarietySummary.averageRow, "Average") });
    }
    if (showPieces && pieceSummary.total) {
      foot.push({ key: "average-pcs", cells: pieceCells(pieceSummary.total, "Average") });
    }

    const headers = (target: SummaryTarget) => {
      const perM2 = target === "csv" ? " / m2" : target === "pdf" ? "/m²" : " / m²";
      return [
        "Variety",
        ...(showPieces ? ["Unit"] : []),
        "Entries",
        "Total kg",
        ...(showPieces ? ["Total pieces"] : []),
        "Waste %",
        "Avg fw (g)",
        `kg${perM2}`,
        ...(showPieces ? [`Pieces${perM2}`] : []),
        ...sizes.map((size) => `${size.name} %`)
      ];
    };

    return { headers, body: body.map(({ key, cells }) => ({ key, cells })), foot };
  }, [filteredVarietySummary, pieceSummary, showPieces]);

  const varietySummaryWeekLabel = useMemo(
    () => getWeekFilterLabel(weekFilterMode, selectedWeek, fromWeek, toWeek),
    [weekFilterMode, selectedWeek, fromWeek, toWeek]
  );

  // Named for the crop only when there is more than one to choose from.
  const exportCropName = showCropSelector && selectedCrop ? selectedCrop.name : null;

  const varietySummaryExportBaseName = useMemo(
    () =>
      getExportFileBaseName(selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek, exportCropName ? cropSlugFor(exportCropName) : null),
    [selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek, exportCropName]
  );

  const exportTitle = exportCropName
    ? `Yield Analytics - Variety Summary - ${exportCropName}`
    : "Yield Analytics - Variety Summary";

  const previewFileName = useMemo(() => {
    if (exportPreviewType === "pdf") {
      return `${varietySummaryExportBaseName}.pdf`;
    }

    if (exportPreviewType === "csv") {
      return `${varietySummaryExportBaseName}.csv`;
    }

    return "";
  }, [exportPreviewType, varietySummaryExportBaseName]);

  const exportPreviewSummaryParts = useMemo(
    () => [
      exportPreviewType ? exportPreviewType.toUpperCase() : "",
      exportCropName ?? "",
      String(selectedYear),
      varietySummaryWeekLabel,
      previewFileName
    ].filter((part) => part.length > 0),
    [exportPreviewType, exportCropName, selectedYear, varietySummaryWeekLabel, previewFileName]
  );

  function openExportPreview(type: ExportPreviewType) {
    setIsExportMenuOpen(false);
    setExportPreviewType(type);
  }

  function closeExportPreview() {
    setExportPreviewType(null);
  }

  function confirmExportDownload() {
    if (exportPreviewType === "pdf") {
      exportPdf();
    }

    if (exportPreviewType === "csv") {
      downloadCsv();
    }

    setExportPreviewType(null);
  }

  function downloadCsv() {
    const lines = [summaryTable.headers("csv").map(toCsvCell).join(",")];

    for (const row of [...summaryTable.body, ...summaryTable.foot]) {
      lines.push(row.cells.map(toCsvCell).join(","));
    }

    const csvContent = `${lines.join("\n")}\n`;
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    downloadBlobFile(blob, `${varietySummaryExportBaseName}.csv`);
  }

  function exportPdf() {
    const headers = summaryTable.headers("pdf");

    const doc = new jsPDF({
      orientation: "landscape",
      unit: "pt",
      format: "a4"
    });

    doc.setFontSize(16);
    doc.text(exportTitle, 40, 36);

    doc.setFontSize(11);
    doc.setTextColor(75, 90, 85);
    doc.text(`Year: ${selectedYear} | Week selection: ${varietySummaryWeekLabel}`, 40, 56);

    const bodyRows = summaryTable.body.map((row) => row.cells.map(String));
    const footRows = summaryTable.foot.map((row) => row.cells.map(String));

    autoTable(doc, {
      head: [headers],
      body:
        bodyRows.length > 0
          ? bodyRows
          : [["No filtered rows to export.", ...new Array(Math.max(0, headers.length - 1)).fill("")]],
      foot: bodyRows.length > 0 ? footRows : [],
      startY: 72,
      styles: {
        fontSize: 9,
        cellPadding: 4,
        lineColor: [214, 223, 219],
        lineWidth: 0.5,
        textColor: [24, 35, 32]
      },
      headStyles: {
        fillColor: [240, 246, 244],
        textColor: [24, 35, 32],
        fontStyle: "bold"
      },
      footStyles: {
        fillColor: [231, 237, 233],
        textColor: [24, 35, 32],
        fontStyle: "bold",
        lineWidth: { top: 1.2 }
      },
      margin: { left: 40, right: 40, top: 72 }
    });

    const pdfBlob = doc.output("blob");
    downloadBlobFile(pdfBlob, `${varietySummaryExportBaseName}.pdf`);
  }

  // The analytics filter as an ISO week range for the shipped-yield calculation.
  const shippedRange = useMemo(() => {
    if (weekFilterMode === "single-week") return { fromYear: selectedYear, fromWeek: selectedWeek, toYear: selectedYear, toWeek: selectedWeek };
    if (weekFilterMode === "week-range") {
      return { fromYear: selectedYear, fromWeek: Math.min(fromWeek, toWeek), toYear: selectedYear, toWeek: Math.max(fromWeek, toWeek) };
    }
    return { fromYear: selectedYear, fromWeek: 1, toYear: selectedYear };
  }, [selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek]);

  useEffect(() => {
    let active = true;
    setShippedError(null);
    fetchShippedYield(shippedRange)
      .then((result) => {
        if (active) setShipped(result);
      })
      .catch((err: unknown) => {
        if (active) setShippedError(err instanceof Error ? err.message : "Failed to load shipped totals.");
      });
    return () => {
      active = false;
    };
  }, [shippedRange, reloadKey]);

  // Harvested kg by colour for the filtered weeks, against the same weeks' shipped cases and kg.
  const reconciliationRows = useMemo<ReconciliationRow[]>(() => {
    const harvestedByColor: Record<VarietyColor, number> = { red: 0, orange: 0, yellow: 0, green: 0 };
    const colorByVarietyId = new Map(varietyMeta.map((v) => [v.id, v.color]));

    for (const entry of filteredEntries) {
      const harvestedKg = Number(entry.total_kg);
      const color = colorByVarietyId.get(entry.variety_id);
      if (!color || !Number.isFinite(harvestedKg) || harvestedKg <= 0) continue;
      harvestedByColor[color] += harvestedKg;
    }

    return COLOR_ORDER.map((color) => {
      const harvestedKg = harvestedByColor[color];
      const shippedKg = shipped?.totals.colors[color].kg ?? 0;
      return {
        color,
        harvestedKg,
        shippedCases: shipped?.totals.colors[color].cases ?? 0,
        shippedKg,
        remainingKg: harvestedKg - shippedKg
      };
    });
  }, [filteredEntries, shipped, varietyMeta]);

  const averageRow = filteredVarietySummary.averageRow;
  const hasSummaryRows = summaryTable.body.length > 0;
  const summaryVarietyCount = new Set([...filteredVarietySummary.rows, ...pieceSummary.rows].map((row) => row.variety_id)).size;
  const activeFilterLabel = exportCropName
    ? `${exportCropName} · ${selectedYear} · ${varietySummaryWeekLabel}`
    : `${selectedYear} · ${varietySummaryWeekLabel}`;
  // With more than one crop the charts show the selected crop's varieties.
  const chartDescription = (chart: ChartDefinition) =>
    showCropSelector && selectedCrop
      ? chart.description.replace("Not affected by the filters.", `${selectedCrop.name} only; not affected by the year or week filters.`)
      : chart.description;
  // Harvest vs Shipped reconciles pepper colours; it isn't shown for a crop without colours.
  const showColourReconciliation = !selectedCrop || selectedCrop.tracksColour;
  const shippedIncomplete = shipped ? incompleteShippedText(shipped.totals) : null;
  const visibleCharts = cropPieceEntries.length > 0 ? [...CHARTS, PIECES_CHART] : CHARTS;
  const chartData = (id: ChartId) =>
    id === "kgm2"
      ? { points: chartPoints, ids: varietyIds }
      : id === "afw"
        ? { points: fruitWeightChartPoints, ids: fruitWeightVarietyIds }
        : { points: pieceChartPoints, ids: pieceVarietyIds };

  return (
    <section className="page-shell yield-analytics-page ya-page">
      <header className="ya-page-header">
        <h1>Yield Analytics</h1>
        <p>Per-variety yield totals, size mix and trends over time.</p>
      </header>

      {error ? (
        <div className="ya-alert" role="alert">
          <div>
            <p className="ya-alert-title">Yield analytics couldn&rsquo;t be loaded</p>
            <p className="ya-alert-body">{error}</p>
          </div>
          <button type="button" className="csv-tb-btn csv-tb-btn--outline" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? "Retrying\u2026" : "Retry"}
          </button>
        </div>
      ) : null}

      <section className="ya-card ya-filters" aria-labelledby="ya-filters-heading">
        <div className="ya-filters-head">
          <h2 id="ya-filters-heading" className="ya-filters-title">
            Filters
          </h2>
          <span className="ya-active-filter">
            <span className="ya-visually-hidden">Showing </span>
            {activeFilterLabel}
          </span>
          <p className="ya-filters-note">
            {showCropSelector
              ? "Applies to the summary metrics, Variety Summary, charts and exports."
              : "Applies to the summary metrics and Variety Summary."}
          </p>
        </div>

        <div className="ya-filters-row">
          <div className="ya-filter-fields">
            {showCropSelector ? (
              <label className="ya-field">
                <span className="ya-field-label">Crop</span>
                <select
                  className="ya-select"
                  value={cropCode ?? ""}
                  onChange={(event) => {
                    setSelectedCropCode(event.target.value);
                    setIsExportMenuOpen(false);
                  }}
                >
                  {crops.map((crop) => (
                    <option key={crop.code} value={crop.code}>
                      {crop.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="ya-field">
              <span className="ya-field-label">Year</span>
              <select
                className="ya-select"
                value={selectedYear}
                onChange={(event) => {
                  const nextYear = Number(event.target.value);
                  setSelectedYear(nextYear);
                  setSelectedWeek((current) => Math.min(Math.max(current, 1), 53));
                  setFromWeek((current) => Math.min(Math.max(current, 1), 53));
                  setToWeek((current) => Math.min(Math.max(current, 1), 53));
                  setIsExportMenuOpen(false);
                }}
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>

            <label className="ya-field">
              <span className="ya-field-label">Filter mode</span>
              <select
                className="ya-select"
                value={weekFilterMode}
                onChange={(event) => {
                  const mode = event.target.value as WeekFilterMode;
                  setWeekFilterMode(mode);
                  setIsExportMenuOpen(false);
                }}
              >
                <option value="full-year">Full Year</option>
                <option value="single-week">Single Week</option>
                <option value="week-range">Week Range</option>
              </select>
            </label>

            {weekFilterMode === "single-week" ? (
              <label className="ya-field ya-field--wide">
                <span className="ya-field-label">Week</span>
                <select
                  className="ya-select"
                  value={selectedWeek}
                  onChange={(event) => {
                    setSelectedWeek(Number(event.target.value));
                    setIsExportMenuOpen(false);
                  }}
                >
                  {weekOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {weekFilterMode === "week-range" ? (
              <>
                <label className="ya-field ya-field--wide">
                  <span className="ya-field-label">From Week</span>
                  <select
                    className="ya-select"
                    value={fromWeek}
                    onChange={(event) => {
                      setFromWeek(Number(event.target.value));
                      setIsExportMenuOpen(false);
                    }}
                  >
                    {weekOptions.map((option) => (
                      <option key={`from-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="ya-field ya-field--wide">
                  <span className="ya-field-label">To Week</span>
                  <select
                    className="ya-select"
                    value={toWeek}
                    onChange={(event) => {
                      setToWeek(Number(event.target.value));
                      setIsExportMenuOpen(false);
                    }}
                  >
                    {weekOptions.map((option) => (
                      <option key={`to-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>

          <div className="yield-analytics-export-menu ya-export">
            <button
              type="button"
              className="csv-tb-btn csv-tb-btn--outline ya-export-button"
              aria-expanded={isExportMenuOpen}
              onClick={() => setIsExportMenuOpen((open) => !open)}
            >
              <svg className="csv-tb-btn-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M10 3.5V13M6 9l4 4 4-4M4 13.5v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export
            </button>

            {isExportMenuOpen ? (
              <div className="ya-export-menu">
                <button type="button" className="ya-export-item" onClick={() => openExportPreview("pdf")}>
                  Export PDF
                </button>
                <button type="button" className="ya-export-item" onClick={() => openExportPreview("csv")}>
                  Export CSV
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {loading ? (
        <p className="ya-visually-hidden" role="status">
          Loading yield analytics&hellip;
        </p>
      ) : null}

      {loading ? (
        <div className="ya-kpi-grid" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="ya-kpi ya-kpi--skeleton">
              <span className="ya-skeleton ya-skeleton--label" />
              <span className="ya-skeleton ya-skeleton--value" />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && !error && (averageRow || pieceSummary.total) ? (
        <section className="ya-kpi-grid" aria-label="Summary metrics">
          {averageRow ? (
          <>
          <div className="ya-kpi ya-kpi--primary">
            <p className="ya-kpi-label">Total kg</p>
            <p className="ya-kpi-value">
              {roundTo(averageRow.total_kg, 2).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              <span className="ya-kpi-unit"> kg</span>
            </p>
            <p className="ya-kpi-context">
              {filteredVarietySummary.rows.length} variet{filteredVarietySummary.rows.length === 1 ? "y" : "ies"}
            </p>
          </div>
          <div className="ya-kpi">
            <p className="ya-kpi-label">Entries</p>
            <p className="ya-kpi-value">{averageRow.entries_count}</p>
            <p className="ya-kpi-context">{activeFilterLabel}</p>
          </div>
          <div className="ya-kpi">
            <p className="ya-kpi-label">Average fruit weight</p>
            <p className="ya-kpi-value">
              {formatAvgFruitWeight(averageRow.avg_fruit_weight_g)}
              {averageRow.avg_fruit_weight_g !== null ? <span className="ya-kpi-unit"> g</span> : null}
            </p>
            <p className="ya-kpi-context">Combined across varieties</p>
          </div>
          <div className="ya-kpi">
            <p className="ya-kpi-label">kg / m²</p>
            <p className="ya-kpi-value">{formatKgPerM2(averageRow.kg_per_m2)}</p>
            {farmKgPerM2.kgPerM2 !== null ? (
              <p className="ya-kpi-context">
                {formatKgFigure(farmKgPerM2.coveredKg)} kg ÷ {formatAreaFigure(farmKgPerM2.areaM2)} m² of unique growing area
              </p>
            ) : (
              <p className="ya-kpi-context">
                {areaFootprints ? "No measured growing area for this period" : "Growing areas couldn\u2019t be loaded"}
              </p>
            )}
            {farmKgPerM2.uncovered.length > 0 ? (
              <p className="ya-kpi-warning" role="note">
                <span className="ya-kpi-warning-label">Coverage: </span>
                {formatKgFigure(farmKgPerM2.uncoveredKg)} kg from{" "}
                {farmKgPerM2.uncovered.map((u) => varietyNameById[u.varietyId] ?? "an unknown variety").join(", ")} isn&rsquo;t linked to a
                growing area, so it&rsquo;s left out of kg/m².
              </p>
            ) : null}
            {farmKgPerM2.unmeasuredRowCount > 0 ? (
              <p className="ya-kpi-warning" role="note">
                <span className="ya-kpi-warning-label">Coverage: </span>
                {farmKgPerM2.unmeasuredRowCount} greenhouse row{farmKgPerM2.unmeasuredRowCount === 1 ? " has" : "s have"} no width/length, so
                {farmKgPerM2.unmeasuredRowCount === 1 ? " it adds" : " they add"} no area.
              </p>
            ) : null}
          </div>
          <div className="ya-kpi">
            <p className="ya-kpi-label">Waste</p>
            <p className="ya-kpi-value">{formatWastePct(averageRow.waste_pct)}</p>
            <p className="ya-kpi-context">Weighted by kg</p>
          </div>
          </>
          ) : null}
          {pieceSummary.total ? (
          <>
          <div className={averageRow ? "ya-kpi" : "ya-kpi ya-kpi--primary"}>
            <p className="ya-kpi-label">Total pieces</p>
            <p className="ya-kpi-value">
              {Math.round(pieceSummary.total.total_pieces).toLocaleString()}
              <span className="ya-kpi-unit"> pcs</span>
            </p>
            <p className="ya-kpi-context">
              {pieceSummary.total.entries_count} piece count{pieceSummary.total.entries_count === 1 ? "" : "s"} · counted, not weighed
            </p>
          </div>
          <div className="ya-kpi">
            <p className="ya-kpi-label">Pieces / m²</p>
            <p className="ya-kpi-value">{formatKgPerM2(pieceSummary.total.pieces_per_m2)}</p>
            <p className="ya-kpi-context">
              {farmPiecesPerM2.kgPerM2 !== null
                ? `${formatKgFigure(farmPiecesPerM2.coveredKg)} pieces ÷ ${formatAreaFigure(farmPiecesPerM2.areaM2)} m² of unique growing area`
                : areaFootprints
                  ? "No measured growing area for this period"
                  : "Growing areas couldn\u2019t be loaded"}
            </p>
          </div>
          </>
          ) : null}
        </section>
      ) : null}

      <section className="ya-card" aria-labelledby="ya-summary-heading">
        <div className="ya-card-head">
          <div>
            <h2 id="ya-summary-heading" className="ya-card-title">
              Variety Summary
            </h2>
            <p className="ya-card-description">
              {showPieces
                ? "Totals per variety for the selected period. Piece counts are listed in their own rows; weight-only columns are blank for them."
                : "Totals, waste, fruit weight and size mix per variety for the selected period."}
            </p>
          </div>
          {!loading && !error && hasSummaryRows ? (
            <span className="ya-card-meta">
              {summaryVarietyCount} variet{summaryVarietyCount === 1 ? "y" : "ies"}
            </span>
          ) : null}
        </div>

        {loading ? <TableSkeleton /> : null}

        {error ? <p className="ya-unavailable">Variety Summary is unavailable until the data loads.</p> : null}

        {!loading && !error && !hasSummaryRows ? (
          <div className="ya-empty" role="status">
            <p className="ya-empty-title">No analytics data for these filters</p>
            <p className="ya-empty-body">No yield entries found for {activeFilterLabel}. Try another week range or year.</p>
          </div>
        ) : null}

        {!loading && !error && hasSummaryRows ? (
          <div className="varieties-table-wrapper ya-table-scroll">
            <table className="varieties-table yield-analytics-table yield-analytics-summary-table ya-table">
              <thead>
                <tr>
                  {summaryTable.headers("screen").map((header) => (
                    <th key={header} scope="col">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summaryTable.body.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.cells[0]}</th>
                    {row.cells.slice(1).map((cell, index) => (
                      <td key={index}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {summaryTable.foot.length > 0 ? (
                <tfoot>
                  {summaryTable.foot.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.cells[0]}</th>
                      {row.cells.slice(1).map((cell, index) => (
                        <td key={index}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tfoot>
              ) : null}
            </table>
          </div>
        ) : null}
      </section>

      {showColourReconciliation ? (
      <section className="ya-card" aria-labelledby="ya-harvest-heading">
        <div className="ya-card-head">
          <div>
            <h2 id="ya-harvest-heading" className="ya-card-title">
              Harvest vs Shipped
            </h2>
            <p className="ya-card-description">Harvested kg by pepper colour against shipped cases and kg for the selected period ({activeFilterLabel}).</p>
          </div>
        </div>

        {loading ? <TableSkeleton rows={4} /> : null}

        {error ? <p className="ya-unavailable">Harvest vs Shipped is unavailable until the data loads.</p> : null}

        {!loading && !error ? (
          <>
            <div className="varieties-table-wrapper ya-table-scroll">
              <table className="varieties-table yield-analytics-table ya-table">
                <thead>
                  <tr>
                    <th scope="col">Color</th>
                    <th scope="col">Harvested kg</th>
                    <th scope="col">Shipped Cases</th>
                    <th scope="col">Shipped kg</th>
                    <th scope="col">Remaining kg</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliationRows.map((row) => (
                    <tr key={row.color}>
                      <th scope="row">
                        <span className={`ya-color-swatch ya-color-swatch--${row.color}`} aria-hidden="true" />
                        {row.color.charAt(0).toUpperCase() + row.color.slice(1)}
                      </th>
                      <td>{roundTo(row.harvestedKg, 1)}</td>
                      <td>{roundTo(row.shippedCases, 1)}</td>
                      <td>{roundTo(row.shippedKg, 1)}</td>
                      <td>{roundTo(row.remainingKg, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shippedError ? <p className="ya-unavailable">{shippedError}</p> : null}
            {shipped && shipped.totals.mixedCases > 0 ? (
              <p className="ya-footnote">
                Plus {roundTo(shipped.totals.mixedCases, 1)} mixed/rainbow cases, counted once — their kg is included in each colour above.
              </p>
            ) : null}
            {shippedIncomplete ? <p className="ya-footnote ya-footnote--warn">{shippedIncomplete}</p> : null}
          </>
        ) : null}
      </section>
      ) : null}

      <div className="ya-chart-grid">
        {visibleCharts.map((chart) => {
          const data = chartData(chart.id);
          const hasData = data.points.length > 0;
          return (
            <section key={chart.id} className="ya-card ya-chart-card" aria-labelledby={`ya-${chart.id}-heading`}>
              <div className="ya-card-head">
                <div>
                  <h2 id={`ya-${chart.id}-heading`} className="ya-card-title">
                    {chart.title}
                  </h2>
                  <p className="ya-card-description">{chartDescription(chart)}</p>
                </div>
                {!loading && !error && hasData ? (
                  <ExpandChartButton title={chart.title} onClick={() => fullscreen.open(chart.id)} buttonRef={fullscreen.buttonRef(chart.id)} />
                ) : null}
              </div>

              {loading ? <div className="ya-chart-placeholder ya-skeleton" aria-hidden="true" /> : null}

              {error ? <p className="ya-unavailable">Chart unavailable until the data loads.</p> : null}

              {!loading && !error && !hasData ? (
                <div className="ya-chart-placeholder ya-empty" role="status">
                  <p className="ya-empty-title">{chart.emptyTitle}</p>
                  <p className="ya-empty-body">{chart.emptyBody}</p>
                </div>
              ) : null}

              {!loading && !error && hasData ? (
                <div className="yield-analytics-chart-wrapper ya-chart">
                  <TrendChart chart={chart} points={data.points} varietyIds={data.ids} varietyNameById={varietyNameById} />
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      {fullscreen.expanded ? (() => {
        const chart = visibleCharts.find((c) => c.id === fullscreen.expanded) ?? CHARTS[0];
        const data = chartData(chart.id);
        return (
          <FullscreenChartOverlay title={chart.title} description={chartDescription(chart)} onClose={fullscreen.close}>
            <TrendChart chart={chart} points={data.points} varietyIds={data.ids} varietyNameById={varietyNameById} />
          </FullscreenChartOverlay>
        );
      })() : null}

      {exportPreviewType ? (
        <ModalOverlay
          onClose={closeExportPreview}
          contentClassName="variety-modal yield-analytics-export-modal"
          titleId="yield-analytics-export-title"
        >
            <div className="yield-analytics-export-modal-header">
              <h2 id="yield-analytics-export-title">Export Variety Summary</h2>
            </div>

            <div className="yield-analytics-export-summary-row" aria-label="Export summary">
              {exportPreviewSummaryParts.map((part, index) => (
                <span key={`export-summary-${index}`} className="yield-analytics-export-summary-pill">
                  {part}
                </span>
              ))}
            </div>

            <div className="yield-analytics-export-preview-shell">
              <p className="yield-analytics-export-preview-label">Page Preview</p>

              <div className="yield-analytics-export-paper">
                <div className="yield-analytics-export-paper-header">
                  <h3>{exportTitle}</h3>
                  <p>Year: {selectedYear} | Week selection: {varietySummaryWeekLabel}</p>
                </div>

                <div className="varieties-table-wrapper yield-analytics-export-preview-table-wrapper">
                  <table className="varieties-table yield-analytics-table yield-analytics-summary-table">
                    <thead>
                      <tr>
                        {summaryTable.headers("screen").map((header) => (
                          <th key={`preview-${header}`}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summaryTable.body.length > 0 ? (
                        summaryTable.body.map((row) => (
                          <tr key={`preview-row-${row.key}`}>
                            {row.cells.map((cell, index) => (
                              <td key={index}>{cell}</td>
                            ))}
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={summaryTable.headers("screen").length}>No filtered rows to export.</td>
                        </tr>
                      )}
                    </tbody>
                    {summaryTable.foot.length > 0 ? (
                      <tfoot>
                        {summaryTable.foot.map((row) => (
                          <tr key={`preview-${row.key}`}>
                            {row.cells.map((cell, index) => (
                              <td key={index}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tfoot>
                    ) : null}
                  </table>
                </div>
              </div>
            </div>

            <div className="form-actions yield-analytics-export-modal-actions">
              <button type="button" onClick={confirmExportDownload}>
                {exportPreviewType === "pdf" ? "Download PDF" : "Download CSV"}
              </button>
              <button type="button" className="secondary" onClick={closeExportPreview}>
                Cancel
              </button>
            </div>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
