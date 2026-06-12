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
  }, []);

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
      return { sizes: [] as YieldSize[], rows: [] as AnalyticsRow[] };
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

    return { sizes, rows };
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

    autoTable(doc, {
      head: [headers],
      body:
        bodyRows.length > 0
          ? bodyRows
          : [["No filtered rows to export.", ...new Array(Math.max(0, headers.length - 1)).fill("")]],
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

  return (
    <section className="page-shell yield-analytics-page">
      <header>
        <h1>Yield Analytics</h1>
        <p>Per-variety yield totals and size percentage breakdown.</p>
      </header>

      <div className="coming-soon-card">
        <div className="yield-analytics-summary-header">
          <h2>Variety Summary</h2>

          <div className="yield-analytics-summary-toolbar">
            <label className="yield-analytics-filter-label">
            Year
            <select
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

            <label className="yield-analytics-filter-label">
            Filter mode
            <select
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
              <label className="yield-analytics-filter-label">
              Week
              <select
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
                <label className="yield-analytics-filter-label">
                From Week
                <select
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

                <label className="yield-analytics-filter-label">
                To Week
                <select
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

            <div className="yield-analytics-export-menu">
              <button
                type="button"
                className="yield-analytics-export-button"
                onClick={() => setIsExportMenuOpen((open) => !open)}
              >
                Export
              </button>

              {isExportMenuOpen ? (
                <div className="yield-analytics-export-dropdown">
                  <button type="button" onClick={() => openExportPreview("pdf")}>
                    Export PDF
                  </button>
                  <button type="button" onClick={() => openExportPreview("csv")}>
                    Export CSV
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {loading ? <p>Loading...</p> : null}

        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && filteredVarietySummary.rows.length === 0 ? (
          <p>No yield entries found for the selected filters.</p>
        ) : null}

        {!loading && !error && filteredVarietySummary.rows.length > 0 ? (
          <div className="varieties-table-wrapper">
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
                    <th key={size.id}>{size.name} %</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredVarietySummary.rows.map((row) => (
                  <tr key={row.variety_id}>
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
                      <td key={size.id}>
                        {formatWholePercent(row.size_pct[size.id] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="coming-soon-card">
        <h2>Harvest vs Shipped</h2>

        {loading ? <p>Loading...</p> : null}

        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table yield-analytics-table">
              <thead>
                <tr>
                  <th>Color</th>
                  <th>Harvested kg</th>
                  <th>Shipped Cases</th>
                  <th>Est. kg / Case</th>
                  <th>Estimated Shipped kg</th>
                  <th>Remaining kg</th>
                </tr>
              </thead>
              <tbody>
                {reconciliationRows.map((row) => (
                  <tr key={row.color}>
                    <td>{row.color.charAt(0).toUpperCase() + row.color.slice(1)}</td>
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
        ) : null}
      </div>

      <div className="coming-soon-card">
        <h2>kg / m² Over Time</h2>

        {loading ? <p>Loading...</p> : null}

        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && chartPoints.length === 0 ? (
          <p>No yield entries found. Add entries in Yield Data Entry to see the chart here.</p>
        ) : null}

        {!loading && !error && chartPoints.length > 0 ? (
          <div className="yield-analytics-chart-wrapper">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartPoints} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
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
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 13
                  }}
                  formatter={(value, name) => [
                    typeof value === "number" ? `${roundTo(value, 3)} kg/m²` : String(value),
                    typeof name === "string" ? (varietyNameById[name] ?? name) : String(name)
                  ]}
                  labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
                />
                <Legend
                  formatter={(value: string) => varietyNameById[value] ?? value}
                  wrapperStyle={{ fontSize: 13, paddingTop: 8 }}
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
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </div>

      <div className="coming-soon-card">
        <h2>Average Fruit Weight Over Time</h2>
        <p>Average fruit weight (g) by week across all varieties.</p>

        {loading ? <p>Loading...</p> : null}

        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && fruitWeightChartPoints.length === 0 ? (
          <p>No average fruit weight data available yet.</p>
        ) : null}

        {!loading && !error && fruitWeightChartPoints.length > 0 ? (
          <div className="yield-analytics-chart-wrapper">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={fruitWeightChartPoints} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
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
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 13
                  }}
                  formatter={(value, name) => [
                    typeof value === "number" ? `${roundTo(value, 1)} g` : String(value),
                    typeof name === "string" ? (varietyNameById[name] ?? name) : String(name)
                  ]}
                  labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
                />
                <Legend
                  formatter={(value: string) => varietyNameById[value] ?? value}
                  wrapperStyle={{ fontSize: 13, paddingTop: 8 }}
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
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </div>

      {exportPreviewType ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Export Variety Summary">
          <div className="variety-modal yield-analytics-export-modal">
            <div className="yield-analytics-export-modal-header">
              <h2>Export Variety Summary</h2>
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
          </div>
        </div>
      ) : null}
    </section>
  );
}
