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
  avg_fruit_weight_g: number | null;
  kg_per_m2: number | null;
  size_pct: Record<string, number>;
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
};

type ChartPoint = {
  label: string;
  sortKey: number;
  [varietyId: string]: number | string;
};

type VarietyColor = "red" | "orange" | "yellow" | "green";

type VarietyMeta = {
  id: string;
  color: VarietyColor;
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
  estimatedShippedKg: number;
  remainingKg: number;
};

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

function normalizeColor(value: unknown): VarietyColor | null {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (color === "red" || color === "orange" || color === "yellow" || color === "green") {
    return color;
  }

  return null;
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
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [entries, setEntries] = useState<YieldEntry[]>([]);
  const [colorCaseEntries, setColorCaseEntries] = useState<ColorCaseEntry[]>([]);
  const [varietyMeta, setVarietyMeta] = useState<VarietyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [summaryRes, entriesRes, colorCaseRes, varietiesRes] = await Promise.all([
          apiFetch("/api/yield-analytics/summary"),
          apiFetch("/api/yield-entries"),
          apiFetch("/api/color-case-entries"),
          apiFetch("/api/varieties")
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
          const rawVarieties = (await varietiesRes.json()) as Array<{ id: string; color: unknown; case_kg: number }>;
          varietiesData = rawVarieties
            .map((item) => {
              const color = normalizeColor(item.color);
              const caseKg = Number(item.case_kg);
              if (!color || !Number.isFinite(caseKg)) {
                return null;
              }

              return {
                id: item.id,
                color,
                case_kg: caseKg
              };
            })
            .filter((item): item is VarietyMeta => item !== null);
        }

        if (active) {
          setSummary(summaryData);
          setEntries(entriesData);
          setColorCaseEntries(colorCaseData);
          setVarietyMeta(varietiesData);
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
    if (summary) {
      for (const row of summary.rows) {
        map[row.variety_id] = row.variety_name;
      }
    }
    return map;
  }, [summary]);

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
      const estimatedKgPerCase = denominator > 0
        ? weightedCaseKgNumerator[color] / denominator
        : DEFAULT_KG_PER_CASE;
      const estimatedShippedKg = shippedCases * estimatedKgPerCase;
      const remainingKg = harvestedKg - estimatedShippedKg;

      return {
        color,
        harvestedKg,
        shippedCases,
        estimatedKgPerCase,
        estimatedShippedKg,
        remainingKg
      };
    });
  }, [summary, colorCaseEntries, varietyMeta]);

  return (
    <section className="page-shell">
      <header>
        <h1>Yield Analytics</h1>
        <p>Per-variety yield totals and size percentage breakdown.</p>
      </header>

      <div className="coming-soon-card">
        <h2>Variety Summary</h2>

        {loading ? <p>Loading...</p> : null}

        {error ? <p className="form-error">{error}</p> : null}

        {!loading && !error && summary && summary.rows.length === 0 ? (
          <p>No yield entries found. Add entries in Yield Data Entry to see analytics here.</p>
        ) : null}

        {!loading && !error && summary && summary.rows.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table yield-analytics-table">
              <thead>
                <tr>
                  <th>Variety</th>
                  <th>Entries</th>
                  <th>Total kg</th>
                  <th>Avg fruit wt (g)</th>
                  <th>kg / m²</th>
                  {summary.sizes.map((size) => (
                    <th key={size.id}>{size.name} %</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row) => (
                  <tr key={row.variety_id}>
                    <td>{row.variety_name}</td>
                    <td>{row.entries_count}</td>
                    <td>{roundTo(row.total_kg, 2)}</td>
                    <td>
                      {row.avg_fruit_weight_g === null
                        ? "-"
                        : roundTo(row.avg_fruit_weight_g, 1)}
                    </td>
                    <td>
                      {row.kg_per_m2 === null ? "-" : roundTo(row.kg_per_m2, 3)}
                    </td>
                    {summary.sizes.map((size) => (
                      <td key={size.id}>
                        {roundTo(row.size_pct[size.id] ?? 0, 1)}%
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
                    <td>{roundTo(row.estimatedKgPerCase, 1)}</td>
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
    </section>
  );
}
