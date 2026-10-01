import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Regression pin for the desktop Dashboard's Greenhouse Snapshot, Yield by
// Color, weekly kg by colour and Total Picked by Color: every rendered value,
// the exact data handed to each chart, and the markup byte for byte. Written
// against the code before any logic moved into shared modules, and required
// to pass unchanged afterwards. Fixtures deliberately include the inputs the
// calculations filter, coerce or tie-break on.
const state = vi.hoisted(() => ({ groups: null as unknown, projection: null as unknown }));
vi.mock("../../lib/api", () => ({
  getBackendHealth: () => Promise.resolve({ success: true }),
  getForecastingStatus: () => Promise.resolve({ success: true }),
  getOrganizationId: () => Promise.resolve("org-1"),
  apiFetch: (path: string) => Promise.resolve({ ok: true, status: 200, json: async () => route(path) })
}));
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: true, can: () => true, canAny: () => false })
}));
// Records the data each chart receives, and gives it a fixed size (jsdom does no layout).
const chartData: Array<{ chart: string; data: unknown }> = [];
function findData(node: ReactNode): unknown {
  let found: unknown;
  Children.forEach(node, (child) => {
    if (found === undefined && isValidElement<{ data?: unknown; children?: ReactNode }>(child)) {
      found = child.props.data ?? findData(child.props.children);
    }
  });
  return found;
}
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children, width, height }: { children: ReactNode; width: string | number; height: string | number }) => {
      if (isValidElement<{ data?: unknown; children?: ReactNode }>(children)) {
        chartData.push({ chart: children.type === actual.PieChart ? "pie" : "line", data: children.props.data ?? findData(children.props.children) });
      }
      return (
        <div data-testid="responsive-container" data-width={String(width)} data-height={String(height)}>
          {isValidElement(children) ? cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 800, height: 400 }) : children}
        </div>
      );
    }
  };
});

const reading = (id: string, volume_ml: number | null, dripper_count?: number | null) => ({ id, name: id, volume_ml, dripper_count });
const log = (id: string, group_key: string, log_date: string, fields: Record<string, unknown>) => ({
  id, log_date, tracking_mode: "zone", group_id: group_key, group_key, group_name: group_key, feed_valve_ids: [], drain_bucket_ids: [],
  feed_ph: null, feed_ec: null, drain_ph: null, drain_ec: null, feed_valve_readings: [], drain_bucket_readings: [], notes: null,
  created_at: "2026-08-11T08:00:00Z", updated_at: "2026-08-11T08:00:00Z", ...fields
});
const group = (id: string, type: string, name: string, status = "active") => ({ id, type, name, status });
// Phase is seen first, but Zone has more active groups, so Zone is shown.
const GROUPS = [
  group("p1", "phase", "Phase 1"),
  group("z1", "zone", "Zone A"),
  group("p2", "phase", "Phase 2"),
  group("z2", "zone", "Zone B"),
  group("z3", "zone", "Zone C"),
  group("z4", "zone", "Zone D", "inactive"),
  group("z5", "zone", "Zone E", "inactive")
];
// Newest first, as the logs endpoint returns them: the first log per group wins.
const LOGS = [
  log("l1", "z1", "2026-08-11", {
    feed_ec: 2.456, feed_ph: 5.8, drain_ec: 3.14159, drain_ph: null,
    feed_valve_readings: [reading("f1", 100, 2), reading("f2", 300, 1), reading("f3", null, 4)],
    drain_bucket_readings: [reading("d1", 30, 2), reading("d2", -5, 1), reading("d3", 45, 3)]
  }),
  log("l2", "z1", "2026-08-04", { feed_ec: 9, feed_ph: 9 }),
  log("l3", "z2", "", { feed_ec: 1, feed_valve_readings: [reading("f4", 250, 0)], drain_bucket_readings: [] }),
  log("l4", "p1", "2026-08-10", { feed_ec: 7 })
];
const VARIETIES = [
  { id: "va", name: "Red A", color: "red", area_m2: 1000, status: "active" },
  { id: "vb", name: "Red B", color: "red", area_m2: "500", status: "active" },
  { id: "vc", name: "Orange", color: "orange", area_m2: 0, status: "active" },
  { id: "vd", name: "Old Yellow", color: "yellow", area_m2: 800, status: "inactive" },
  { id: "ve", name: "Green", color: "Green ", area_m2: 400, status: "active" },
  { id: "vf", name: "Uncoloured", color: null, area_m2: 300, status: "active" }
];
const ENTRIES = [
  { variety_id: "va", year: 2026, week: 30, total_kg: 1000 },
  { variety_id: "va", year: 2026, week: 31, total_kg: "1500.5" },
  { variety_id: "vb", year: 2026, week: 31, total_kg: 500 },
  { variety_id: "vc", year: 2026, week: 31, total_kg: 200 },
  { variety_id: "vd", year: 2026, week: 30, total_kg: 300 }, // inactive: in the trend, not the totals
  { variety_id: "ve", year: 2026, week: 31, total_kg: 100 },
  { variety_id: "va", year: 2026, week: 32, total_kg: -10 }, // negative: dropped
  { variety_id: "va", year: 2026, week: 54, total_kg: 10 }, // no week 54: dropped
  { variety_id: "vz", year: 2026, week: 31, total_kg: 50 }, // unknown variety
  { varietyId: "vb", totalKg: 250, week: 32, year: 2026 }, // camelCase fields are accepted
  { variety_id: "vf", year: 2026, week: 31, total_kg: 99 } // variety without a colour
];
const CASE_ENTRIES = [
  { color: "RED", total_cases: 100, case_weight_kg: 5, total_kg: 500 },
  { color: "green", total_cases: 10, case_weight_kg: 5 }, // no total_kg: counts as 0
  { color: "orange", total_cases: -1, case_weight_kg: 5, total_kg: 40 }, // negative: dropped
  { color: "red", total_cases: 5, case_weight_kg: null, total_kg: 25 } // null weight reads as 0, so it counts
];
function route(path: string) {
  if (path === "/api/irrigation-setup") return { groups: state.groups ?? GROUPS };
  if (path === "/api/irrigation/logs?days=365") return LOGS;
  if (path === "/api/yield-entries") return ENTRIES;
  if (path === "/api/varieties") return VARIETIES;
  if (path === "/api/color-case-entries") return CASE_ENTRIES;
  if (path === "/api/mobile/daily-yield/today-projection") return state.projection ?? { status: "no_data" };
  return [];
}

import { DashboardPage } from "../DashboardPage";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  localStorage.clear();
  chartData.length = 0;
  state.groups = null;
  state.projection = null;
});
afterEach(() => vi.clearAllMocks());

async function renderDashboard() {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
  await screen.findByText("Zone A");
  await waitFor(() => expect(document.querySelectorAll(".dashboard-yield-color-pill")).toHaveLength(4));
  await waitFor(() => expect(document.querySelector(".dashboard-pie-legend-value")).not.toBeNull());
}
// Recharts' clip-path ids come from a global counter and line ids from
// React's useId: both depend on how many renders happened earlier in the
// file, not on the data, so they're normalised before comparing markup.
const markup = (el: Element) => el.outerHTML.replace(/recharts\d+-clip/g, "recharts#-clip").replace(/:r[0-9a-z]+:/g, ":r#:");
const card = (heading: string) => screen.getByRole("heading", { name: heading, level: 2 }).closest(".coming-soon-card") as HTMLElement;
const snapshotCards = () =>
  Array.from(card("Greenhouse Snapshot").querySelectorAll("article.dashboard-snapshot-card")).map((a) => ({
    name: a.querySelector("h3")!.textContent,
    badge: a.querySelector(".dashboard-snapshot-type-badge")!.textContent,
    metrics: Object.fromEntries(
      Array.from(a.querySelectorAll(".dashboard-snapshot-metric, .dashboard-snapshot-footer")).map((m) => [
        m.querySelector(".dashboard-snapshot-label")!.textContent,
        m.querySelector(".dashboard-snapshot-value")!.textContent
      ])
    )
  }));

describe("desktop Greenhouse Snapshot — pinned values", () => {
  it("shows the most common active group type, in setup order, each with its newest log's metrics", async () => {
    await renderDashboard();
    expect(card("Greenhouse Snapshot")).toHaveTextContent("Latest irrigation readings by zone.");
    expect(snapshotCards()).toEqual([
      {
        name: "Zone A",
        badge: "Zone",
        metrics: {
          "Feed EC": "2.46", "Feed pH": "5.8", "Drain EC": "3.14", "Drain pH": "—",
          // Feed per dripper 50 and 300 (null skipped) → 175; drain 15 and 15 (negative skipped) → 15.
          "Avg Feed ml": "200", "Drain %": "8.57%", "Last Reading": "2026-08-11"
        }
      },
      {
        name: "Zone B",
        badge: "Zone",
        metrics: { "Feed EC": "1", "Feed pH": "—", "Drain EC": "—", "Drain pH": "—", "Avg Feed ml": "250", "Drain %": "—", "Last Reading": "—" }
      },
      {
        name: "Zone C",
        badge: "Zone",
        metrics: { "Feed EC": "—", "Feed pH": "—", "Drain EC": "—", "Drain pH": "—", "Avg Feed ml": "—", "Drain %": "—", "Last Reading": "No readings yet" }
      }
    ]);
  });

  it("breaks a tie between group types by the type seen first", async () => {
    state.groups = [group("p1", "phase", "Phase 1"), group("z1", "zone", "Zone A"), group("z2", "zone", "Zone B"), group("p2", "phase", "Phase 2")];
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    await screen.findByText("Phase 1");
    expect(card("Greenhouse Snapshot")).toHaveTextContent("Latest irrigation readings by phase.");
    expect(snapshotCards().map((c) => [c.name, c.badge, c.metrics["Feed EC"]])).toEqual([
      ["Phase 1", "Phase", "7"],
      ["Phase 2", "Phase", "—"]
    ]);
  });

  it("markup is unchanged, byte for byte", async () => {
    await renderDashboard();
    expect(markup(card("Greenhouse Snapshot"))).toMatchSnapshot();
  });
});

describe("desktop Yield by Color — pinned values", () => {
  it("totals active varieties' kg and area by colour, with shipped kg from case entries", async () => {
    await renderDashboard();
    const pills = Array.from(card("Yield by Color").querySelectorAll(".dashboard-yield-color-pill")).map((p) => [
      p.querySelector(".color-badge")!.textContent,
      ...Array.from(p.querySelectorAll(".dashboard-yield-color-metric")).map(
        (m) => `${m.querySelector(".dashboard-yield-color-metric-label")!.textContent}: ${m.querySelector(".dashboard-yield-color-metric-value")!.textContent}`
      )
    ]);
    expect(pills).toEqual([
      // Red: 3,250.5 kg over 1,500 m²; shipped 525 kg.
      ["Red", "Harvested: 2.17 kg/m2", "Shipped (kg/m²): 0.35 kg/m2"],
      // Orange's only variety has no area; Yellow's is inactive.
      ["Orange", "Harvested: —", "Shipped (kg/m²): —"],
      ["Yellow", "Harvested: —", "Shipped (kg/m²): —"],
      ["Green", "Harvested: 0.25 kg/m2", "Shipped (kg/m²): 0 kg/m2"]
    ]);
  });

  it("the doughnut gets each colour's kg and share of the total, and lists them", async () => {
    await renderDashboard();
    expect(chartData.find((c) => c.chart === "pie")!.data).toEqual([
      { color: "red", kg: 3250.5, percent: 91.6 },
      { color: "orange", kg: 200, percent: 5.6 },
      { color: "yellow", kg: 0, percent: 0 },
      { color: "green", kg: 100, percent: 2.8 }
    ]);
    expect(Array.from(document.querySelectorAll(".dashboard-pie-legend-value")).map((e) => e.textContent)).toEqual([
      "3250.5 kg | 91.6%",
      "200 kg | 5.6%",
      "0 kg | 0%",
      "100 kg | 2.8%"
    ]);
  });

  it("the weekly kg by colour chart gets one point per week, oldest first, including inactive varieties", async () => {
    await renderDashboard();
    expect(chartData.find((c) => c.chart === "line")!.data).toEqual([
      { label: "W30 2026", sortKey: 202630, red: 1000, orange: 0, yellow: 300, green: 0 },
      { label: "W31 2026", sortKey: 202631, red: 2000.5, orange: 200, yellow: 0, green: 100 },
      { label: "W32 2026", sortKey: 202632, red: 250, orange: 0, yellow: 0, green: 0 }
    ]);
  });

  it("markup is unchanged, byte for byte", async () => {
    await renderDashboard();
    expect(markup(card("Yield by Color"))).toMatchSnapshot();
    expect(markup(card("Yield Trends"))).toMatchSnapshot();
  });
});

describe("desktop Daily Yield Projection placement", () => {
  it("renders after all other dashboard cards and preserves the projection details and samples link", async () => {
    state.projection = {
      hasProjection: true,
      sessionYear: 2026,
      sessionWeek: 38,
      sampledRowCount: 14,
      byVariety: [
        {
          varietyId: "variety-a",
          varietyName: "Ruby Crown",
          color: "red",
          projectedKg: 1240,
          projectedCases: 82,
          sampledRowCount: 14,
          lastSampleDate: "2026-09-21",
          lastUpdatedAt: "2026-09-21T14:30:00Z",
          lastEnteredByName: "Alex Green",
          lastEnteredByInitials: "AG"
        }
      ],
      byColor: [{ color: "red", totalCases: 82 }],
      grandTotal: 82
    };

    await renderDashboard();

    const projectionCard = card("Daily Yield Projection");
    const allDashboardCards = Array.from(document.querySelectorAll(".coming-soon-card"));
    expect(allDashboardCards.at(-1)).toBe(projectionCard);
    expect(projectionCard).toHaveTextContent("Week 38, 2026");
    expect(projectionCard).toHaveTextContent("Not recorded/actual yield.");
    expect(projectionCard).toHaveTextContent("Ruby Crown");
    expect(projectionCard).toHaveTextContent("1,240 kg");
    expect(projectionCard).toHaveTextContent("82 cases");
    expect(projectionCard).toHaveTextContent("14 sampled rows");
    expect(projectionCard).toHaveTextContent("Projection Ready");
    expect(within(projectionCard).getByRole("link", { name: /View Samples/ })).toHaveAttribute(
      "href",
      "/yield/daily-yield-samples"
    );
  });
});
