import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Week-only X-axis ticks on the three weekly graphs, with data spanning a
// year boundary (2025 W51-W52, 2026 W1-W2). The tick drops the year; the
// point's label - and so the tooltip, sorting and grouping - keeps it.
// jsdom can't measure SVG text, so Recharts draws no tick text here: the
// real XAxis is wrapped to capture the tick formatter each graph passes,
// which is applied to the chart's own labels. The rendered tick text is
// checked in a real browser.
vi.mock("../../lib/api", () => ({
  getBackendHealth: () => Promise.resolve({ ok: true }),
  getForecastingStatus: () => Promise.resolve({ ok: true }),
  getOrganizationId: () => Promise.resolve("org-1"),
  apiFetch: (path: string) => Promise.resolve({ ok: true, status: 200, json: async () => route(path) })
}));
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: true, can: () => true, canAny: () => true })
}));
const xAxisProps: Array<{ dataKey?: unknown; tickFormatter?: (value: unknown) => string; minTickGap?: number }> = [];
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const RealXAxis = actual.XAxis as unknown as (props: Record<string, unknown>) => ReactElement;
  return {
    ...actual,
    XAxis: (props: Record<string, unknown>) => {
      xAxisProps.push(props as (typeof xAxisProps)[number]);
      return <RealXAxis {...props} />;
    },
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div data-testid="responsive-container">
        {isValidElement(children) ? cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 800, height: 400 }) : children}
      </div>
    )
  };
});

import { DashboardPage } from "../DashboardPage";
import { YieldAnalyticsPage } from "../YieldAnalyticsPage";

const WEEKS = [
  { year: 2025, week: 51 },
  { year: 2025, week: 52 },
  { year: 2026, week: 1 },
  { year: 2026, week: 2 }
];
const VARIETIES = [
  { id: "v-red", name: "Cadalora", color: "red", area_m2: 1000, case_kg: 5, status: "active" },
  { id: "v-green", name: "Green trial", color: "green", area_m2: 500, case_kg: 5, status: "active" }
];
// Listed out of order on purpose: the charts sort by year, then week.
const ENTRIES = [...WEEKS].reverse().flatMap(({ year, week }, i) => [
  { id: `r${year}${week}`, variety_id: "v-red", variety_name: "Cadalora", year, week, total_kg: 1000 * (i + 1), kg_per_m2: (i + 1) / 10, average_fruit_weight_g: 200 + i, size_kg: {} },
  { id: `g${year}${week}`, variety_id: "v-green", variety_name: "Green trial", year, week, total_kg: 0, kg_per_m2: 0, average_fruit_weight_g: 150 + i, size_kg: {} }
]);
const byWeek = (year: number, week: number) => ENTRIES.find((e) => e.variety_id === "v-red" && e.year === year && e.week === week)!;
function route(path: string) {
  if (path === "/api/yield-entries") return ENTRIES;
  if (path === "/api/varieties") return VARIETIES;
  if (path === "/api/yield-analytics/summary") return { sizes: [], rows: [] };
  if (path === "/api/yield-analytics/area-footprints") return { rows: [], footprints: {}, linksAvailable: true };
  return [];
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  xAxisProps.length = 0;
  vi.clearAllMocks();
  localStorage.clear();
});

/** The chart's own point labels, in drawing order, as the tooltip's week header shows them. */
const LABELS = ["W51 2025", "W52 2025", "W1 2026", "W2 2026"];
/** What the most recently rendered X axis shows for each point. */
const tickTexts = () => {
  const axis = xAxisProps.at(-1)!;
  expect(axis.dataKey).toBe("label");
  return LABELS.map((label) => (axis.tickFormatter ? axis.tickFormatter(label) : label));
};

/** Hovers near the left or right end of the plot and returns the tooltip text. */
async function hover(root: Element, end: "first" | "last") {
  const surface = root.querySelector(".recharts-wrapper")!;
  fireEvent.mouseLeave(surface);
  fireEvent.mouseMove(surface, { clientX: end === "first" ? 66 : 780, clientY: 200 });
  const header = end === "first" ? LABELS[0] : LABELS[LABELS.length - 1];
  return waitFor(() => {
    const text = root.querySelector(".recharts-tooltip-wrapper")?.textContent ?? "";
    expect(text).toContain(header);
    return text;
  });
}

const GRAPHS = [
  {
    name: "Dashboard: Weekly kg by Color",
    title: "Weekly kg by Color",
    render: () => render(<MemoryRouter><DashboardPage /></MemoryRouter>),
    card: (title: string) => screen.getByRole("heading", { name: title }).closest("section") as HTMLElement,
    series: 4, // the Dashboard draws all four colours
    // Red kg in the first (2025 W51) and last (2026 W2) weeks.
    firstValue: `${byWeek(2025, 51).total_kg} kg`,
    lastValue: `${byWeek(2026, 2).total_kg} kg`
  },
  {
    name: "Yield Analytics: kg / m² Over Time",
    title: "kg / m² Over Time",
    render: () => render(<YieldAnalyticsPage />),
    card: (title: string) => screen.getByRole("region", { name: title }),
    series: 2,
    firstValue: `${byWeek(2025, 51).kg_per_m2} kg/m²`,
    lastValue: `${byWeek(2026, 2).kg_per_m2} kg/m²`
  },
  {
    name: "Yield Analytics: Average Fruit Weight Over Time",
    title: "Average Fruit Weight Over Time",
    render: () => render(<YieldAnalyticsPage />),
    card: (title: string) => screen.getByRole("region", { name: title }),
    series: 2,
    firstValue: `${byWeek(2025, 51).average_fruit_weight_g} g`,
    lastValue: `${byWeek(2026, 2).average_fruit_weight_g} g`
  }
];

describe.each(GRAPHS)("$name", (graph) => {
  async function setup() {
    const user = userEvent.setup();
    graph.render();
    await screen.findByRole("button", { name: `Expand ${graph.title} graph` });
    return user;
  }

  it("shows W<number> ticks with no year, in chronological order across the year boundary", async () => {
    await setup();
    const labels = tickTexts();
    expect(labels).toEqual(["W51", "W52", "W1", "W2"]);
    for (const label of labels) {
      expect(label).toMatch(/^W\d{1,2}$/);
      expect(label).not.toMatch(/\d{4}/);
    }
  });

  it("uses exactly the same ticks and tick spacing full-screen", async () => {
    const user = await setup();
    const cardAxis = xAxisProps.at(-1)!;
    const cardTicks = tickTexts();
    await user.click(screen.getByRole("button", { name: `Expand ${graph.title} graph` }));
    await screen.findByRole("dialog", { name: graph.title });
    const fullAxis = xAxisProps.at(-1)!;
    expect(fullAxis.tickFormatter).toBe(cardAxis.tickFormatter);
    expect(fullAxis.minTickGap).toBe(cardAxis.minTickGap);
    expect(tickTexts()).toEqual(cardTicks);
  });

  it("the tooltip still names the week and year, with the unchanged value, at both ends", async () => {
    const user = await setup();
    const card = graph.card(graph.title);
    const first = await hover(card, "first");
    expect(first).toContain("W51 2025");
    expect(first).toContain(graph.firstValue);
    const last = await hover(card, "last");
    expect(last).toContain("W2 2026");
    expect(last).toContain(graph.lastValue);

    // Same in the full-screen view.
    await user.click(screen.getByRole("button", { name: `Expand ${graph.title} graph` }));
    const dialog = await screen.findByRole("dialog", { name: graph.title });
    expect(await hover(dialog, "first")).toContain("W51 2025");
    expect(await hover(dialog, "last")).toContain("W2 2026");
  });

  it("draws the same series and points: one line per series, one point per week", async () => {
    await setup();
    const card = graph.card(graph.title);
    const lines = card.querySelectorAll(".recharts-line-curve");
    expect(lines).toHaveLength(graph.series);
    for (const line of lines) {
      // Monotone path: M then one C segment per remaining point.
      const segments = line.getAttribute("d")!.match(/[MC]/g)!;
      expect(segments.length).toBe(WEEKS.length);
    }
  });
});
