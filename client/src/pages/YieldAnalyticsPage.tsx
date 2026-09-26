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
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

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

type AnalyticsSummary = {
  sizes: YieldSize[];
  rows: AnalyticsRow[];
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
};

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

type ColorCaseEntry = {
  color: VarietyColor;
  total_cases: number;
};

type ReconciliationRow = {
  color: VarietyColor;
  harvestedKg: number;
  shippedCases: number;
  estimatedKgPerCase: number;
  isKgPerCaseEstimated: boolean;
  estimatedShippedKg: number;
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

const COLOR_ORDER: VarietyColor[] = ["red", "orange", "yellow", "green"];
const DEFAULT_KG_PER_CASE = 11;

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

function getExportFileBaseName(year: number, mode: WeekFilterMode, singleWeek: number, fromWeek: number, toWeek: number) {
  if (mode === "single-week") {
    return `growlink-variety-summary-${year}-week-${singleWeek}`;
  }

  if (mode === "week-range") {
    const start = Math.min(fromWeek, toWeek);
    const end = Math.max(fromWeek, toWeek);
    return `growlink-variety-summary-${year}-weeks-${start}-${end}`;
  }

  return `growlink-variety-summary-${year}`;
}

function toCsvCell(value: string | number) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function downloadBlobFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function buildChartData(
  entries: YieldEntry[]
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
    point[entry.variety_id] = roundTo(entry.kg_per_m2, 3);
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
  const [colorCaseEntries, setColorCaseEntries] = useState<ColorCaseEntry[]>([]);
  const [varietyMeta, setVarietyMeta] = useState<VarietyMeta[]>([]);
  const [wasteImports, setWasteImports] = useState<WasteImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [weekFilterMode, setWeekFilterMode] = useState<WeekFilterMode>("full-year");
  const [selectedWeek, setSelectedWeek] = useState<number>(getCurrentWeek(currentYear));
  const [fromWeek, setFromWeek] = useState<number>(1);
  const [toWeek, setToWeek] = useState<number>(getCurrentWeek(currentYear));
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [exportPreviewType, setExportPreviewType] = useState<ExportPreviewType | null>(null);
  /** Bumped by the error panel's Retry to re-run the same load. */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [summaryRes, entriesRes, colorCaseRes, varietiesRes, wasteRes] = await Promise.all([
          apiFetch("/api/yield-analytics/summary"),
          apiFetch("/api/yield-entries"),
          apiFetch("/api/color-case-entries"),
          apiFetch("/api/varieties"),
          apiFetch("/api/waste-imports")
        ]);

        if (!summaryRes.ok) {
          throw new Error(`Failed to load analytics (${summaryRes.status})`);
        }
        if (!entriesRes.ok) {
          throw new Error(`Failed to load entries (${entriesRes.status})`);
        }

        const summaryData = (await summaryRes.json()) as AnalyticsSummary;
        const entriesData = (await entriesRes.json()) as YieldEntry[];

        let colorCaseData: ColorCaseEntry[] = [];
        if (colorCaseRes.ok) {
          colorCaseData = (await colorCaseRes.json()) as ColorCaseEntry[];
        }

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

        if (active) {
          setSummary(summaryData);
          setEntries(entriesData);
          setColorCaseEntries(colorCaseData);
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

  const { points: chartPoints, varietyIds } = useMemo(
    () => buildChartData(entries),
    [entries]
  );

  const { points: fruitWeightChartPoints, varietyIds: fruitWeightVarietyIds } = useMemo(
    () => buildAverageFruitWeightChartData(entries),
    [entries]
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

    for (const entry of entries) {
      const year = Number(entry.year);
      if (Number.isInteger(year)) {
        years.add(year);
      }
    }

    return Array.from(years).sort((a, b) => b - a);
  }, [entries, currentYear]);

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
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
  }, [entries, selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek]);

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

  const filteredVarietySummary = useMemo(() => {
    if (!summary) {
      return { sizes: [] as YieldSize[], rows: [] as AnalyticsRow[], averageRow: null as AnalyticsRow | null };
    }

    const sizes = summary.sizes ?? [];
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
      let kgPerM2Numerator = 0;
      let kgPerM2Denominator = 0;
      const sizeKgTotals: Record<string, number> = {};

      for (const item of byVariety.values()) {
        totalEntriesCount += item.entries_count;
        totalKg += item.total_kg;
        totalWasteKg += filteredWasteKgByVarietyId.get(item.variety_id) ?? 0;
        totalFruitCount += item.fruit_count_sum;
        totalFruitCountKg += item.fruit_count_kg;

        // Only varieties with a known area contribute to the combined kg/m2 figure,
        // so a missing area on one variety doesn't distort the others' density.
        if (item.area_m2 > 0) {
          kgPerM2Numerator += item.total_kg;
          kgPerM2Denominator += item.area_m2;
        }

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
        kg_per_m2: kgPerM2Denominator > 0 ? kgPerM2Numerator / kgPerM2Denominator : null,
        size_pct: averageSizePct
      };
    }

    return { sizes, rows, averageRow };
  }, [summary, varietyMeta, filteredEntries, filteredWasteKgByVarietyId]);

  const varietySummaryWeekLabel = useMemo(
    () => getWeekFilterLabel(weekFilterMode, selectedWeek, fromWeek, toWeek),
    [weekFilterMode, selectedWeek, fromWeek, toWeek]
  );

  const varietySummaryExportBaseName = useMemo(
    () => getExportFileBaseName(selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek),
    [selectedYear, weekFilterMode, selectedWeek, fromWeek, toWeek]
  );

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
      String(selectedYear),
      varietySummaryWeekLabel,
      previewFileName
    ].filter((part) => part.length > 0),
    [exportPreviewType, selectedYear, varietySummaryWeekLabel, previewFileName]
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
    const headers = [
      "Variety",
      "Entries",
      "Total kg",
      "Waste %",
      "Avg fw (g)",
      "kg / m2",
      ...filteredVarietySummary.sizes.map((size) => `${size.name} %`)
    ];

    const lines = [headers.map(toCsvCell).join(",")];

    for (const row of filteredVarietySummary.rows) {
      const values: Array<string | number> = [
        row.variety_name,
        row.entries_count,
        roundTo(row.total_kg, 2),
        formatWastePct(row.waste_pct),
        formatAvgFruitWeight(row.avg_fruit_weight_g),
        formatKgPerM2(row.kg_per_m2),
        ...filteredVarietySummary.sizes.map((size) => formatWholePercent(row.size_pct[size.id] ?? 0))
      ];

      lines.push(values.map(toCsvCell).join(","));
    }

    if (filteredVarietySummary.averageRow) {
      const averageValues: Array<string | number> = [
        filteredVarietySummary.averageRow.variety_name,
        filteredVarietySummary.averageRow.entries_count,
        roundTo(filteredVarietySummary.averageRow.total_kg, 2),
        formatWastePct(filteredVarietySummary.averageRow.waste_pct),
        formatAvgFruitWeight(filteredVarietySummary.averageRow.avg_fruit_weight_g),
        formatKgPerM2(filteredVarietySummary.averageRow.kg_per_m2),
        ...filteredVarietySummary.sizes.map((size) =>
          formatWholePercent(filteredVarietySummary.averageRow!.size_pct[size.id] ?? 0)
        )
      ];

      lines.push(averageValues.map(toCsvCell).join(","));
    }

    const csvContent = `${lines.join("\n")}\n`;
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    downloadBlobFile(blob, `${varietySummaryExportBaseName}.csv`);
  }

  function exportPdf() {
    const headers = [
      "Variety",
      "Entries",
      "Total kg",
      "Waste %",
      "Avg fw (g)",
      "kg/m²",
      ...filteredVarietySummary.sizes.map((size) => `${size.name} %`)
    ];

    const doc = new jsPDF({
      orientation: "landscape",
      unit: "pt",
      format: "a4"
    });

    doc.setFontSize(16);
    doc.text("Yield Analytics - Variety Summary", 40, 36);

    doc.setFontSize(11);
    doc.setTextColor(75, 90, 85);
    doc.text(`Year: ${selectedYear} | Week selection: ${varietySummaryWeekLabel}`, 40, 56);

    const bodyRows = filteredVarietySummary.rows.map((row) => [
      row.variety_name,
      String(row.entries_count),
      String(roundTo(row.total_kg, 2)),
      formatWastePct(row.waste_pct),
      formatAvgFruitWeight(row.avg_fruit_weight_g),
      formatKgPerM2(row.kg_per_m2),
      ...filteredVarietySummary.sizes.map((size) => formatWholePercent(row.size_pct[size.id] ?? 0))
    ]);

    const averageRow = filteredVarietySummary.averageRow;
    const footRows = averageRow
      ? [[
          averageRow.variety_name,
          String(averageRow.entries_count),
          String(roundTo(averageRow.total_kg, 2)),
          formatWastePct(averageRow.waste_pct),
          formatAvgFruitWeight(averageRow.avg_fruit_weight_g),
          formatKgPerM2(averageRow.kg_per_m2),
          ...filteredVarietySummary.sizes.map((size) => formatWholePercent(averageRow.size_pct[size.id] ?? 0))
        ]]
      : [];

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

  const reconciliationRows = useMemo<ReconciliationRow[]>(() => {
    const harvestedByColor: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };

    const shippedCasesByColor: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };

    const weightedCaseKgNumerator: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };

    const weightedCaseKgDenominator: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };

    const varietyById = new Map<string, VarietyMeta>();
    for (const variety of varietyMeta) {
      varietyById.set(variety.id, variety);
    }

    for (const row of summary?.rows ?? []) {
      const harvestedKg = Number(row.total_kg);
      if (!Number.isFinite(harvestedKg) || harvestedKg <= 0) {
        continue;
      }

      const variety = varietyById.get(row.variety_id);
      const color = variety?.color;
      if (!color) {
        continue;
      }

      harvestedByColor[color] += harvestedKg;

      if (variety.case_kg > 0) {
        weightedCaseKgNumerator[color] += harvestedKg * variety.case_kg;
        weightedCaseKgDenominator[color] += harvestedKg;
      }
    }

    for (const entry of colorCaseEntries) {
      const color = normalizeColor(entry.color);
      if (!color) {
        continue;
      }

      const shippedCases = Number(entry.total_cases);
      if (!Number.isFinite(shippedCases) || shippedCases < 0) {
        continue;
      }

      shippedCasesByColor[color] += shippedCases;
    }

    return COLOR_ORDER.map((color) => {
      const harvestedKg = harvestedByColor[color] ?? 0;
      const shippedCases = shippedCasesByColor[color] ?? 0;
      const denominator = weightedCaseKgDenominator[color] ?? 0;
      const isKgPerCaseEstimated = denominator <= 0;
      const estimatedKgPerCase = isKgPerCaseEstimated
        ? DEFAULT_KG_PER_CASE
        : weightedCaseKgNumerator[color] / denominator;
      const estimatedShippedKg = shippedCases * estimatedKgPerCase;
      const remainingKg = harvestedKg - estimatedShippedKg;

      return {
        color,
        harvestedKg,
        shippedCases,
        estimatedKgPerCase,
        isKgPerCaseEstimated,
        estimatedShippedKg,
        remainingKg
      };
    });
  }, [summary, colorCaseEntries, varietyMeta]);

  const averageRow = filteredVarietySummary.averageRow;
  const hasSummaryRows = filteredVarietySummary.rows.length > 0;
  const activeFilterLabel = `${selectedYear} · ${varietySummaryWeekLabel}`;
  const hasEstimatedKgPerCase = reconciliationRows.some((row) => row.isKgPerCaseEstimated);

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
          <p className="ya-filters-note">Applies to the summary metrics and Variety Summary.</p>
        </div>

        <div className="ya-filters-row">
          <div className="ya-filter-fields">
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

      {!loading && !error && averageRow ? (
        <section className="ya-kpi-grid" aria-label="Summary metrics">
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
            <p className="ya-kpi-context">Varieties with a valid area</p>
          </div>
          <div className="ya-kpi">
            <p className="ya-kpi-label">Waste</p>
            <p className="ya-kpi-value">{formatWastePct(averageRow.waste_pct)}</p>
            <p className="ya-kpi-context">Weighted by kg</p>
          </div>
        </section>
      ) : null}

      <section className="ya-card" aria-labelledby="ya-summary-heading">
        <div className="ya-card-head">
          <div>
            <h2 id="ya-summary-heading" className="ya-card-title">
              Variety Summary
            </h2>
            <p className="ya-card-description">Totals, waste, fruit weight and size mix per variety for the selected period.</p>
          </div>
          {!loading && !error && hasSummaryRows ? (
            <span className="ya-card-meta">
              {filteredVarietySummary.rows.length} variet{filteredVarietySummary.rows.length === 1 ? "y" : "ies"}
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
                  <th scope="col">Variety</th>
                  <th scope="col">Entries</th>
                  <th scope="col">Total kg</th>
                  <th scope="col">Waste %</th>
                  <th scope="col">Avg fw (g)</th>
                  <th scope="col">kg / m²</th>
                  {filteredVarietySummary.sizes.map((size) => (
                    <th key={size.id} scope="col">{size.name} %</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredVarietySummary.rows.map((row) => (
                  <tr key={row.variety_id}>
                    <th scope="row">{row.variety_name}</th>
                    <td>{row.entries_count}</td>
                    <td>{roundTo(row.total_kg, 2)}</td>
                    <td>{formatWastePct(row.waste_pct)}</td>
                    <td>
                      {formatAvgFruitWeight(row.avg_fruit_weight_g)}
                    </td>
                    <td>
                      {formatKgPerM2(row.kg_per_m2)}
                    </td>
                    {filteredVarietySummary.sizes.map((size) => (
                      <td key={size.id}>
                        {formatWholePercent(row.size_pct[size.id] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {averageRow ? (
                <tfoot>
                  <tr>
                    <th scope="row">Average</th>
                    <td>{averageRow.entries_count}</td>
                    <td>{roundTo(averageRow.total_kg, 2)}</td>
                    <td>{formatWastePct(averageRow.waste_pct)}</td>
                    <td>{formatAvgFruitWeight(averageRow.avg_fruit_weight_g)}</td>
                    <td>{formatKgPerM2(averageRow.kg_per_m2)}</td>
                    {filteredVarietySummary.sizes.map((size) => (
                      <td key={`average-${size.id}`}>
                        {formatWholePercent(averageRow.size_pct[size.id] ?? 0)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        ) : null}
      </section>

      <section className="ya-card" aria-labelledby="ya-harvest-heading">
        <div className="ya-card-head">
          <div>
            <h2 id="ya-harvest-heading" className="ya-card-title">
              Harvest vs Shipped
            </h2>
            <p className="ya-card-description">Harvested kg by pepper colour against shipped cases, across all recorded data. Not affected by the filters.</p>
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
                    <th scope="col">Est. kg / Case</th>
                    <th scope="col">Estimated Shipped kg</th>
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
                      <td>{row.isKgPerCaseEstimated ? `~${roundTo(row.estimatedKgPerCase, 1)}` : roundTo(row.estimatedKgPerCase, 1)}</td>
                      <td>{roundTo(row.estimatedShippedKg, 1)}</td>
                      <td>{roundTo(row.remainingKg, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasEstimatedKgPerCase ? (
              <p className="ya-footnote">~ Estimated with the default {DEFAULT_KG_PER_CASE} kg per case where no variety case weight is set.</p>
            ) : null}
          </>
        ) : null}
      </section>

      <div className="ya-chart-grid">
        <section className="ya-card" aria-labelledby="ya-kgm2-heading">
          <div className="ya-card-head">
            <div>
              <h2 id="ya-kgm2-heading" className="ya-card-title">
                kg / m² Over Time
              </h2>
              <p className="ya-card-description">Weekly kg/m² per variety across all recorded weeks. Not affected by the filters.</p>
            </div>
          </div>

          {loading ? <div className="ya-chart-placeholder ya-skeleton" aria-hidden="true" /> : null}

          {error ? <p className="ya-unavailable">Chart unavailable until the data loads.</p> : null}

          {!loading && !error && chartPoints.length === 0 ? (
            <div className="ya-chart-placeholder ya-empty" role="status">
              <p className="ya-empty-title">No kg/m² data yet</p>
              <p className="ya-empty-body">Add entries in Yield Data Entry to see this chart.</p>
            </div>
          ) : null}

          {!loading && !error && chartPoints.length > 0 ? (
            <div className="yield-analytics-chart-wrapper ya-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartPoints} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => String(roundTo(v, 2))}
                    label={{
                      value: "kg / m²",
                      angle: -90,
                      position: "insideLeft",
                      offset: 12,
                      style: { fill: "var(--text-muted)", fontSize: 12 }
                    }}
                    width={64}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value, name) => [
                      typeof value === "number" ? `${roundTo(value, 3)} kg/m²` : String(value),
                      typeof name === "string" ? (varietyNameById[name] ?? name) : String(name)
                    ]}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  />
                  <Legend
                    formatter={(value: string) => varietyNameById[value] ?? value}
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={CHART_LEGEND_STYLE}
                  />
                  {varietyIds.map((varietyId, index) => (
                    <Line
                      key={varietyId}
                      type="monotone"
                      dataKey={varietyId}
                      name={varietyId}
                      stroke={LINE_COLORS[index % LINE_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                      isAnimationActive={!prefersReducedMotion}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </section>

        <section className="ya-card" aria-labelledby="ya-afw-heading">
          <div className="ya-card-head">
            <div>
              <h2 id="ya-afw-heading" className="ya-card-title">
                Average Fruit Weight Over Time
              </h2>
              <p className="ya-card-description">Average fruit weight (g) by week across all varieties. Not affected by the filters.</p>
            </div>
          </div>

          {loading ? <div className="ya-chart-placeholder ya-skeleton" aria-hidden="true" /> : null}

          {error ? <p className="ya-unavailable">Chart unavailable until the data loads.</p> : null}

          {!loading && !error && fruitWeightChartPoints.length === 0 ? (
            <div className="ya-chart-placeholder ya-empty" role="status">
              <p className="ya-empty-title">No average fruit weight data yet</p>
              <p className="ya-empty-body">It appears once entries include an average fruit weight.</p>
            </div>
          ) : null}

          {!loading && !error && fruitWeightChartPoints.length > 0 ? (
            <div className="yield-analytics-chart-wrapper ya-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={fruitWeightChartPoints} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => String(roundTo(v, 1))}
                    label={{
                      value: "Avg fruit weight (g)",
                      angle: -90,
                      position: "insideLeft",
                      offset: 12,
                      style: { fill: "var(--text-muted)", fontSize: 12 }
                    }}
                    width={64}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value, name) => [
                      typeof value === "number" ? `${roundTo(value, 1)} g` : String(value),
                      typeof name === "string" ? (varietyNameById[name] ?? name) : String(name)
                    ]}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  />
                  <Legend
                    formatter={(value: string) => varietyNameById[value] ?? value}
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={CHART_LEGEND_STYLE}
                  />
                  {fruitWeightVarietyIds.map((varietyId, index) => (
                    <Line
                      key={varietyId}
                      type="monotone"
                      dataKey={varietyId}
                      name={varietyId}
                      stroke={LINE_COLORS[index % LINE_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                      isAnimationActive={!prefersReducedMotion}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </section>
      </div>

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
                  <h3>Yield Analytics - Variety Summary</h3>
                  <p>Year: {selectedYear} | Week selection: {varietySummaryWeekLabel}</p>
                </div>

                <div className="varieties-table-wrapper yield-analytics-export-preview-table-wrapper">
                  <table className="varieties-table yield-analytics-table yield-analytics-summary-table">
                    <thead>
                      <tr>
                        <th>Variety</th>
                        <th>Entries</th>
                        <th>Total kg</th>
                        <th>Waste %</th>
                        <th>Avg fw (g)</th>
                        <th>kg / m²</th>
                        {filteredVarietySummary.sizes.map((size) => (
                          <th key={`preview-${size.id}`}>{size.name} %</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVarietySummary.rows.length > 0 ? (
                        filteredVarietySummary.rows.map((row) => (
                          <tr key={`preview-row-${row.variety_id}`}>
                            <td>{row.variety_name}</td>
                            <td>{row.entries_count}</td>
                            <td>{roundTo(row.total_kg, 2)}</td>
                            <td>{formatWastePct(row.waste_pct)}</td>
                            <td>
                              {formatAvgFruitWeight(row.avg_fruit_weight_g)}
                            </td>
                            <td>
                              {formatKgPerM2(row.kg_per_m2)}
                            </td>
                            {filteredVarietySummary.sizes.map((size) => (
                              <td key={`preview-size-${row.variety_id}-${size.id}`}>
                                {formatWholePercent(row.size_pct[size.id] ?? 0)}
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6 + filteredVarietySummary.sizes.length}>No filtered rows to export.</td>
                        </tr>
                      )}
                    </tbody>
                    {filteredVarietySummary.averageRow ? (
                      <tfoot>
                        <tr>
                          <td>Average</td>
                          <td>{filteredVarietySummary.averageRow.entries_count}</td>
                          <td>{roundTo(filteredVarietySummary.averageRow.total_kg, 2)}</td>
                          <td>{formatWastePct(filteredVarietySummary.averageRow.waste_pct)}</td>
                          <td>{formatAvgFruitWeight(filteredVarietySummary.averageRow.avg_fruit_weight_g)}</td>
                          <td>{formatKgPerM2(filteredVarietySummary.averageRow.kg_per_m2)}</td>
                          {filteredVarietySummary.sizes.map((size) => (
                            <td key={`preview-average-${size.id}`}>
                              {formatWholePercent(filteredVarietySummary.averageRow!.size_pct[size.id] ?? 0)}
                            </td>
                          ))}
                        </tr>
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
