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
};

type ChartPoint = {
  label: string;
  sortKey: number;
  [varietyId: string]: number | string;
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

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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

export function YieldAnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [entries, setEntries] = useState<YieldEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [summaryRes, entriesRes] = await Promise.all([
          apiFetch("/api/yield-analytics/summary"),
          apiFetch("/api/yield-entries")
        ]);

        if (!summaryRes.ok) {
          throw new Error(`Failed to load analytics (${summaryRes.status})`);
        }
        if (!entriesRes.ok) {
          throw new Error(`Failed to load entries (${entriesRes.status})`);
        }

        const summaryData = (await summaryRes.json()) as AnalyticsSummary;
        const entriesData = (await entriesRes.json()) as YieldEntry[];

        if (active) {
          setSummary(summaryData);
          setEntries(entriesData);
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

  const varietyNameById = useMemo(() => {
    const map: Record<string, string> = {};
    if (summary) {
      for (const row of summary.rows) {
        map[row.variety_id] = row.variety_name;
      }
    }
    return map;
  }, [summary]);

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
    </section>
  );
}
