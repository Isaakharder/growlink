import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Yield Analytics once Cucumbers is partly counted in pieces: kg and pieces
// stay apart in the KPIs, the Variety Summary, the charts and both exports.
// A piece row leaves the weight-only columns blank; pieces/m² is shown where
// there is an area. Bell Peppers is unchanged.
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
  { id: "e3", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 31, total_kg: 800, kg_per_m2: 2, average_fruit_weight_g: null, size_kg: {} },
  // Piece counts, after Cucumbers switched to Pieces: no kg at all.
  { id: "p1", unit_code: "pcs", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 31, total_pieces: 5000, pieces_per_m2: 12.5, total_kg: null, kg_per_m2: null, average_fruit_weight_g: null, size_kg: {} },
  { id: "p2", unit_code: "pcs", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 32, total_pieces: 3000, pieces_per_m2: 7.5, total_kg: null, kg_per_m2: null, average_fruit_weight_g: null, size_kg: {} }
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

describe("Yield Analytics — Cucumbers in kg and pieces", () => {
  it("Bell Peppers is exactly as before: no unit or pieces columns, the same CSV", async () => {
    const user = await renderLoaded();
    expect(within(summaryTable()).queryByRole("columnheader", { name: "Unit" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Summary metrics" })).queryByText("Total pieces")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pieces / m² Over Time" })).not.toBeInTheDocument();
    const pepper = await exportCsv(user);
    expect(pepper.text.trim().split("\n")).toEqual([
      "Variety,Entries,Total kg,Waste %,Avg fw (g),kg / m2,Large %",
      "Cadalora,1,1000,0.0%,200,1.0,100%",
      "Average,1,1000,0.0%,200,1.0,100%"
    ]);
  });

  it("Cucumbers: kg and pieces in separate KPIs and rows, weight-only cells blank for pieces", async () => {
    const user = await renderLoaded();
    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");

    // kg figures are the kg harvests only: the counts add nothing to them.
    expect(metric("Total kg")).toHaveTextContent("2,000 kg");
    expect(metric("kg / m²")).toHaveTextContent("2,000 kg ÷ 400 m² of unique growing area");
    expect(metric("Total pieces")).toHaveTextContent("8,000 pcs");
    expect(metric("Total pieces")).toHaveTextContent("2 piece counts · counted, not weighed");
    // 8,000 pieces over Bonbon's 400 m².
    expect(metric("Pieces / m²")).toHaveTextContent("20.0");
    expect(metric("Pieces / m²")).toHaveTextContent("8,000 pieces ÷ 400 m² of unique growing area");

    const table = summaryTable();
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Variety", "Unit", "Entries", "Total kg", "Total pieces", "Waste %", "Avg fw (g)", "kg / m²", "Pieces / m²"
    ]);
    const cells = Array.from(table.querySelectorAll("tr")).slice(1).map((row) => Array.from(row.children).map((c) => c.textContent));
    expect(cells).toEqual([
      ["Bonbon", "kg", "2", "2000", "", "0.0%", "0", "5.0", ""],
      ["Bonbon", "pieces", "2", "", "8000", "", "", "", "20.0"],
      ["Average", "kg", "2", "2000", "", "0.0%", "-", "5.0", ""],
      ["Average", "pieces", "2", "", "8000", "", "", "", "20.0"]
    ]);
    expect(screen.getByRole("region", { name: "Variety Summary" })).toHaveTextContent("1 variety");
    expect(screen.getByRole("heading", { name: "Pieces / m² Over Time" })).toBeInTheDocument();
  });

  it("the CSV and the export preview hold the same rows as the screen", async () => {
    const user = await renderLoaded();
    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");
    const screenRows = Array.from(summaryTable().querySelectorAll("tr")).map((row) => Array.from(row.children).map((c) => c.textContent));

    const csv = await exportCsv(user);
    expect(csv.name).toBe(`growlink-variety-summary-cucumbers-${YEAR}.csv`);
    expect(csv.text.trim().split("\n")).toEqual([
      "Variety,Unit,Entries,Total kg,Total pieces,Waste %,Avg fw (g),kg / m2,Pieces / m2",
      "Bonbon,kg,2,2000,,0.0%,0,5.0,",
      "Bonbon,pieces,2,,8000,,,,20.0",
      "Average,kg,2,2000,,0.0%,-,5.0,",
      "Average,pieces,2,,8000,,,,20.0"
    ]);
    // Same cells as on screen (the CSV writes "kg / m2" for the header only).
    expect(csv.text.trim().split("\n").slice(1).map((line) => line.split(","))).toEqual(screenRows.slice(1));

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    const preview = await screen.findByRole("dialog", { name: "Export Variety Summary" });
    const previewRows = Array.from(within(preview).getByRole("table").querySelectorAll("tr")).map((row) =>
      Array.from(row.children).map((c) => c.textContent)
    );
    expect(previewRows).toEqual(screenRows);
  });

  it("a period with piece counts only shows the pieces KPIs, and no kg ones", async () => {
    const user = await renderLoaded();
    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");
    await user.selectOptions(screen.getByLabelText("Filter mode"), "single-week");
    await user.selectOptions(screen.getByLabelText("Week"), "32");

    const metrics = screen.getByRole("region", { name: "Summary metrics" });
    expect(within(metrics).queryByText("Total kg")).not.toBeInTheDocument();
    expect(metric("Total pieces")).toHaveTextContent("3,000 pcs");
    expect(Array.from(summaryTable().querySelectorAll("tbody tr")).map((row) => row.children[1].textContent)).toEqual(["pieces"]);
  });
});
