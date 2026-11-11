import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Yield Analytics for an organization growing Bell Peppers and Cucumbers:
// the Crop selector decides which harvests every figure, chart and export is
// built from, so cucumber kg never lands in a pepper total and the files
// match the screen.
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({ apiFetch: (path: string, options?: RequestInit) => apiFetch(path, options) }));

const downloads: Array<{ name: string; blob: Blob }> = [];
vi.mock("../../lib/downloadFile", () => ({
  downloadBlobFile: (blob: Blob, name: string) => downloads.push({ name, blob })
}));

import { YieldAnalyticsPage } from "../YieldAnalyticsPage";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const YEAR = new Date().getFullYear();
const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const PRODUCTS = [
  { code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active" },
  { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active" }
];
const SIZES = [{ id: "s1", name: "Large", sort_order: 1 }];
const VARIETIES = [
  { id: "v-cad", name: "Cadalora", area_m2: 1000, color: "red", case_kg: 5, product_code: "bell_pepper" },
  { id: "v-bon", name: "Bonbon", area_m2: 400, color: null, case_kg: 12, product_code: "cucumber" }
];
const ENTRIES = [
  { id: "e1", variety_id: "v-cad", variety_name: "Cadalora", product_code: "bell_pepper", year: YEAR, week: 30, total_kg: 1000, kg_per_m2: 1, average_fruit_weight_g: 200, size_kg: { s1: 1000 } },
  { id: "e2", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 30, total_kg: 1200, kg_per_m2: 3, average_fruit_weight_g: null, size_kg: {} },
  { id: "e3", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 31, total_kg: 800, kg_per_m2: 2, average_fruit_weight_g: null, size_kg: {} }
];
const SUMMARY = { sizes: SIZES, rows: [], products: PRODUCTS };
const colorTotals = Object.fromEntries(["red", "orange", "yellow", "green"].map((c) => [c, { kg: 0, cases: 0 }]));
const SHIPPED = {
  sync: null, weeks: [],
  totals: { colors: colorTotals, mixedCases: 0, shippedCases: 0, measuredCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 0, complete: true, nonPepper: [], weekCount: 0, packWeeks: 0, legacyWeeks: 0 }
};
// Cadalora: 10 rows × 100 m². Bonbon: 4 rows × 100 m² of its own.
const AREA_FOOTPRINTS = {
  rows: [
    ...Array.from({ length: 10 }, (_, i) => ({ key: `g1:${i + 1}`, groupId: "g1", areaM2: 100 })),
    ...Array.from({ length: 4 }, (_, i) => ({ key: `g2:${i + 1}`, groupId: "g2", areaM2: 100 }))
  ],
  footprints: {
    "v-cad": Array.from({ length: 10 }, (_, i) => `g1:${i + 1}`),
    "v-bon": Array.from({ length: 4 }, (_, i) => `g2:${i + 1}`)
  },
  linksAvailable: true
};

let summary: unknown = SUMMARY;

function route(path: string) {
  if (path === "/api/yield-analytics/summary") return jsonOk(summary);
  if (path === "/api/yield-entries?units=all") return jsonOk(ENTRIES);
  if (path.startsWith("/api/shipped-yield")) return jsonOk(SHIPPED);
  if (path === "/api/varieties") return jsonOk(VARIETIES);
  if (path === "/api/waste-imports") return jsonOk([]);
  if (path === "/api/yield-analytics/area-footprints") return jsonOk(AREA_FOOTPRINTS);
  return jsonOk([]);
}

beforeEach(() => {
  summary = SUMMARY;
  downloads.length = 0;
  apiFetch.mockImplementation((path: string) => Promise.resolve().then(() => route(path)));
});
afterEach(() => vi.clearAllMocks());

const metric = (label: string) =>
  within(screen.getByRole("region", { name: "Summary metrics" })).getByText(label).closest(".ya-kpi") as HTMLElement;
const summaryTable = () => within(screen.getByRole("region", { name: "Variety Summary" })).getByRole("table");

async function renderLoaded() {
  const user = userEvent.setup();
  render(<YieldAnalyticsPage />);
  await screen.findByRole("region", { name: "Summary metrics" });
  return user;
}

async function exportCsv(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Export" }));
  await user.click(screen.getByRole("button", { name: "Export CSV" }));
  await user.click(await screen.findByRole("button", { name: "Download CSV" }));
  const file = downloads[downloads.length - 1];
  return { name: file.name, text: await file.blob.text() };
}

describe("Yield Analytics — Crop selector", () => {
  it("starts on Bell Peppers: pepper totals, sizes and colours only, no cucumber kg", async () => {
    await renderLoaded();

    const crop = screen.getByRole("combobox", { name: "Crop" });
    expect(crop).toHaveValue("bell_pepper");
    expect(within(crop).getAllByRole("option").map((o) => o.textContent)).toEqual(["Bell Peppers", "Cucumbers"]);

    expect(metric("Total kg")).toHaveTextContent("1,000 kg");
    expect(metric("Total kg")).toHaveTextContent("1 variety");
    // 1,000 kg over Cadalora's own 1,000 m², not Bonbon's area too.
    expect(metric("kg / m²")).toHaveTextContent("1,000 kg ÷ 1,000 m² of unique growing area");
    expect(within(summaryTable()).getAllByRole("rowheader").map((r) => r.textContent)).toEqual(["Cadalora", "Average"]);
    expect(within(summaryTable()).getByRole("columnheader", { name: "Large %" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Harvest vs Shipped" })).toBeInTheDocument();
  });

  it("Cucumbers shows only cucumber kg, with no size or colour reports", async () => {
    const user = await renderLoaded();
    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");

    expect(metric("Total kg")).toHaveTextContent("2,000 kg");
    expect(metric("Entries")).toHaveTextContent("2");
    expect(metric("Entries")).toHaveTextContent(`Cucumbers · ${YEAR} · Full Year`);
    // 2,000 kg over Bonbon's 400 m².
    expect(metric("kg / m²")).toHaveTextContent("5");
    expect(metric("kg / m²")).toHaveTextContent("2,000 kg ÷ 400 m² of unique growing area");
    expect(within(summaryTable()).getAllByRole("rowheader").map((r) => r.textContent)).toEqual(["Bonbon", "Average"]);
    expect(within(summaryTable()).queryByRole("columnheader", { name: "Large %" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Harvest vs Shipped" })).not.toBeInTheDocument();
  });

  it("each crop's CSV holds exactly the figures on screen, in a file named for the crop", async () => {
    const user = await renderLoaded();

    const pepper = await exportCsv(user);
    expect(pepper.name).toBe(`growlink-variety-summary-bell-peppers-${YEAR}.csv`);
    expect(pepper.text.trim().split("\n")).toEqual([
      "Variety,Entries,Total kg,Waste %,Avg fw (g),kg / m2,Large %",
      "Cadalora,1,1000,0.0%,200,1.0,100%",
      "Average,1,1000,0.0%,200,1.0,100%"
    ]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");
    const cucumber = await exportCsv(user);
    expect(cucumber.name).toBe(`growlink-variety-summary-cucumbers-${YEAR}.csv`);
    expect(cucumber.text.trim().split("\n")).toEqual([
      "Variety,Entries,Total kg,Waste %,Avg fw (g),kg / m2",
      // Avg fw: the page reads a missing fruit weight as 0 g (existing behaviour, for peppers too).
      "Bonbon,2,2000,0.0%,0,5.0",
      "Average,2,2000,0.0%,-,5.0"
    ]);
  });

  it("an organization with one product sees no selector and keeps its file names", async () => {
    summary = { ...SUMMARY, products: [PRODUCTS[0]] };
    const user = await renderLoaded();
    expect(screen.queryByRole("combobox", { name: "Crop" })).not.toBeInTheDocument();
    expect((await exportCsv(user)).name).toBe(`growlink-variety-summary-${YEAR}.csv`);
  });
});
