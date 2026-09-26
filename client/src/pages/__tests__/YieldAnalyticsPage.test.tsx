import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Yield Analytics layout: filter panel, summary metrics, tables, and the
// loading / empty / error states. The figures are the page's own
// calculations, unchanged by the restyle; the fixture is small enough that
// every expected value below is worked out by hand.
const calls: string[] = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options?: RequestInit) => {
    calls.push(path);
    return apiFetch(path, options);
  }
}));

import { YieldAnalyticsPage } from "../YieldAnalyticsPage";

beforeAll(() => {
  // Recharts' ResponsiveContainer observes its size; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const YEAR = new Date().getFullYear();
const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failed = (status: number) => ({ ok: false, status, json: async () => ({}) });

const SIZES = [
  { id: "s1", name: "Large", sort_order: 1 },
  { id: "s2", name: "XL", sort_order: 2 }
];
const VARIETIES = [
  { id: "v-cad", name: "Cadalora", area_m2: 1000, color: "red", case_kg: 5 },
  { id: "v-mat", name: "Mathieu", area_m2: 0, color: "yellow", case_kg: 0 }
];
const ENTRIES = [
  { id: "e1", variety_id: "v-cad", variety_name: "Cadalora", year: YEAR, week: 30, total_kg: 1000, kg_per_m2: 1, average_fruit_weight_g: 200, size_kg: { s1: 600, s2: 400 } },
  { id: "e2", variety_id: "v-cad", variety_name: "Cadalora", year: YEAR, week: 31, total_kg: 500, kg_per_m2: 0.5, average_fruit_weight_g: 250, size_kg: { s1: 200, s2: 300 } },
  { id: "e3", variety_id: "v-mat", variety_name: "Mathieu", year: YEAR, week: 30, total_kg: 300, kg_per_m2: 0, average_fruit_weight_g: 150, size_kg: { s1: 300 } },
  // Another year — never part of this year's summary.
  { id: "e4", variety_id: "v-cad", variety_name: "Cadalora", year: YEAR - 1, week: 30, total_kg: 9999, kg_per_m2: 9.999, average_fruit_weight_g: 100, size_kg: { s1: 9999 } }
];
const SUMMARY = {
  sizes: SIZES,
  rows: [
    { variety_id: "v-cad", variety_name: "Cadalora", entries_count: 2, total_kg: 1500, waste_pct: 0, avg_fruit_weight_g: null, kg_per_m2: null, size_pct: {} },
    { variety_id: "v-mat", variety_name: "Mathieu", entries_count: 1, total_kg: 300, waste_pct: 0, avg_fruit_weight_g: null, kg_per_m2: null, size_pct: {} }
  ]
};
const CASES = [
  { color: "red", total_cases: 100 },
  { color: "yellow", total_cases: 10 }
];
const WASTE = [{ id: "w1", variety_id: "v-cad", year: YEAR, week: 30, waste_kg: 30 }];

type Override = (path: string) => unknown;
let override: Override | null = null;

function route(path: string) {
  const custom = override?.(path);
  if (custom !== undefined) return custom;
  if (path === "/api/yield-analytics/summary") return jsonOk(SUMMARY);
  if (path === "/api/yield-entries") return jsonOk(ENTRIES);
  if (path === "/api/color-case-entries") return jsonOk(CASES);
  if (path === "/api/varieties") return jsonOk(VARIETIES);
  if (path === "/api/waste-imports") return jsonOk(WASTE);
  return jsonOk([]);
}

beforeEach(() => {
  calls.length = 0;
  override = null;
  apiFetch.mockImplementation((path: string) => Promise.resolve().then(() => route(path)));
});

afterEach(() => vi.clearAllMocks());

const metrics = () => screen.getByRole("region", { name: "Summary metrics" });
const summaryCard = () => screen.getByRole("region", { name: "Variety Summary" });
const metric = (label: string) => within(metrics()).getByText(label).closest(".ya-kpi") as HTMLElement;

async function renderLoaded() {
  const user = userEvent.setup();
  render(<YieldAnalyticsPage />);
  await screen.findByRole("region", { name: "Summary metrics" });
  return user;
}

describe("Yield Analytics — summary metrics and Variety Summary", () => {
  it("shows the Average row's own figures as metric cards, matching the table footer", async () => {
    await renderLoaded();

    // 1,000 + 500 + 300 kg across 2 varieties; last year's 9,999 kg is excluded.
    expect(metric("Total kg")).toHaveTextContent("1,800 kg");
    expect(metric("Total kg")).toHaveTextContent("2 varieties");
    expect(metric("Entries")).toHaveTextContent("3");
    expect(metric("Entries")).toHaveTextContent(`${YEAR} · Full Year`);
    // Combined AFW = 1,800 kg / (5,000 + 2,000 + 2,000 fruit) = 200 g.
    expect(metric("Average fruit weight")).toHaveTextContent("200 g");
    // Only Cadalora has a valid area: 1,500 kg / 1,000 m².
    expect(metric("kg / m²")).toHaveTextContent("1.5");
    // 30 kg waste / 1,800 kg.
    expect(metric("Waste")).toHaveTextContent("1.7%");

    const footer = within(summaryCard()).getByRole("rowheader", { name: "Average" }).closest("tr")!;
    const footerCells = within(footer).getAllByRole("cell").map((c) => c.textContent);
    expect(footerCells.slice(0, 5)).toEqual(["3", "1800", "1.7%", "200", "1.5"]);
  });

  it("keeps every Variety Summary column and per-variety figure, with variety names as row headers", async () => {
    await renderLoaded();
    const table = within(summaryCard()).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Variety",
      "Entries",
      "Total kg",
      "Waste %",
      "Avg fw (g)",
      "kg / m²",
      "Large %",
      "XL %"
    ]);

    const cadalora = within(table).getByRole("rowheader", { name: "Cadalora" }).closest("tr")!;
    // kg-weighted AFW (200×1,000 + 250×500) / 1,500 = 216.7; 800 of 1,500 kg Large, 700 XL.
    expect(within(cadalora).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2", "1500", "2.0%", "217", "1.5", "53%", "47%"]);
    const mathieu = within(table).getByRole("rowheader", { name: "Mathieu" }).closest("tr")!;
    // No valid area, so no kg/m².
    expect(within(mathieu).getAllByRole("cell").map((c) => c.textContent)).toEqual(["1", "300", "0.0%", "150", "-", "100%", "0%"]);
  });

  it("filters apply exactly as before, and the active-filter pill says what is selected", async () => {
    const user = await renderLoaded();
    const filters = screen.getByRole("region", { name: "Filters" });
    expect(within(filters).getByText(`${YEAR} · Full Year`)).toBeInTheDocument();

    await user.selectOptions(within(filters).getByLabelText("Filter mode"), "week-range");
    await user.selectOptions(within(filters).getByLabelText("From Week"), "31");
    await user.selectOptions(within(filters).getByLabelText("To Week"), "31");

    expect(within(filters).getByText(`${YEAR} · Weeks 31-31`)).toBeInTheDocument();
    // Week 31 holds only Cadalora's 500 kg entry.
    expect(metric("Entries")).toHaveTextContent("1");
    expect(metric("Total kg")).toHaveTextContent("500 kg");
    expect(within(summaryCard()).queryByRole("rowheader", { name: "Mathieu" })).not.toBeInTheDocument();
  });

  it("shows the empty state, and no metric cards, when nothing matches the filters", async () => {
    const user = await renderLoaded();
    const filters = screen.getByRole("region", { name: "Filters" });
    await user.selectOptions(within(filters).getByLabelText("Filter mode"), "single-week");
    await user.selectOptions(within(filters).getByLabelText("Week"), "10");

    expect(within(summaryCard()).getByText("No analytics data for these filters")).toBeInTheDocument();
    expect(within(summaryCard()).getByText(`No yield entries found for ${YEAR} · Week 10. Try another week range or year.`)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Summary metrics" })).not.toBeInTheDocument();
    // The charts are not filtered, so they don't switch to their empty states.
    expect(screen.queryByText("No kg/m² data yet")).not.toBeInTheDocument();
  });
});

describe("Yield Analytics — Harvest vs Shipped and export", () => {
  it("labels each colour in text next to its swatch and explains estimated kg per case", async () => {
    await renderLoaded();
    const card = screen.getByRole("region", { name: "Harvest vs Shipped" });
    const red = within(card).getByRole("rowheader", { name: "Red" }).closest("tr")!;
    // 1,500 kg harvested; 100 cases × 5 kg = 500 kg shipped; 1,000 kg remaining.
    expect(within(red).getAllByRole("cell").map((c) => c.textContent)).toEqual(["1500", "100", "5", "500", "1000"]);
    const yellow = within(card).getByRole("rowheader", { name: "Yellow" }).closest("tr")!;
    expect(within(yellow).getAllByRole("cell")[2]).toHaveTextContent("~11");
    expect(within(card).getByText(/~ Estimated with the default 11 kg per case/)).toBeInTheDocument();
  });

  it("Export opens the same PDF/CSV choice, and the CSV option opens the existing preview", async () => {
    const user = await renderLoaded();
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton).toHaveAttribute("aria-expanded", "false");

    await user.click(exportButton);
    expect(exportButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export PDF" })).not.toBeInTheDocument();
  });
});

describe("Yield Analytics — loading and error states", () => {
  it("shows a loading status and placeholders instead of figures while loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    apiFetch.mockImplementation((path: string) => gate.then(() => route(path)));
    render(<YieldAnalyticsPage />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading yield analytics…");
    expect(screen.queryByRole("region", { name: "Summary metrics" })).not.toBeInTheDocument();
    expect(within(summaryCard()).queryByRole("table")).not.toBeInTheDocument();

    release();
    expect(await screen.findByRole("region", { name: "Summary metrics" })).toBeInTheDocument();
    expect(screen.queryByText("Loading yield analytics…")).not.toBeInTheDocument();
  });

  it("shows one error panel with the server message, and Retry reloads the same data", async () => {
    let failures = 1;
    override = (path) => (path === "/api/yield-analytics/summary" && failures-- > 0 ? failed(500) : undefined);
    const user = userEvent.setup();
    render(<YieldAnalyticsPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Yield analytics couldn’t be loaded");
    expect(alert).toHaveTextContent("Failed to load analytics (500)");
    expect(within(summaryCard()).getByText("Variety Summary is unavailable until the data loads.")).toBeInTheDocument();
    expect(calls.filter((c) => c === "/api/yield-analytics/summary")).toHaveLength(1);

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "Summary metrics" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Retry re-ran the same five requests, once.
    expect(calls.filter((c) => c === "/api/yield-analytics/summary")).toHaveLength(2);
    expect(calls.filter((c) => c === "/api/yield-entries")).toHaveLength(2);
  });
});
