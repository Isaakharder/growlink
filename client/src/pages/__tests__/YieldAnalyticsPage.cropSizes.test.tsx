import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Yield Analytics with sizes per crop (migration 0152): the Variety Summary's
// size mix uses the selected crop's own sizes, in the table and both exports.
// Cucumbers, whose sizes are optional, gets a "Not sized" share so kg (or
// pieces) recorded without a size is accounted for; kg rows show the kg mix
// and piece rows the piece mix, never combined. Bell Peppers is unchanged.
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
// Both crops have a "Large"; each is its own size.
const SIZES = [
  { id: "p-lg", name: "Large", sort_order: 1, product_code: "bell_pepper" },
  { id: "p-xl", name: "XL", sort_order: 2, product_code: "bell_pepper" },
  { id: "c-lg", name: "Large", sort_order: 1, product_code: "cucumber" },
  { id: "c-st", name: "Straight", sort_order: 2, product_code: "cucumber" }
];
const VARIETIES = [
  { id: "v-cad", name: "Cadalora", area_m2: 1000, color: "red", case_kg: 5, product_code: "bell_pepper" },
  { id: "v-bon", name: "Bonbon", area_m2: 400, color: null, case_kg: 12, product_code: "cucumber" }
];
const ENTRIES = [
  { id: "e1", variety_id: "v-cad", variety_name: "Cadalora", product_code: "bell_pepper", year: YEAR, week: 30, total_kg: 1000, kg_per_m2: 1, average_fruit_weight_g: 200, size_kg: { "p-lg": 600, "p-xl": 400 } },
  // Cucumbers in kg: one week sized, one recorded as a total only (200 kg).
  { id: "e2", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 30, total_kg: 200, kg_per_m2: 0.5, average_fruit_weight_g: 300, size_kg: { "c-lg": 120, "c-st": 80 } },
  { id: "e3", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 31, total_kg: 200, kg_per_m2: 0.5, average_fruit_weight_g: 300, size_kg: {} },
  // Cucumbers in pieces: sized 500, and 500 counted without sizes.
  { id: "p1", unit_code: "pcs", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 32, total_pieces: 500, size_pieces: { "c-lg": 300, "c-st": 200 }, pieces_per_m2: 1.25, total_kg: null, kg_per_m2: null, average_fruit_weight_g: null, size_kg: {} },
  { id: "p2", unit_code: "pcs", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: YEAR, week: 33, total_pieces: 500, size_pieces: {}, pieces_per_m2: 1.25, total_kg: null, kg_per_m2: null, average_fruit_weight_g: null, size_kg: {} }
];
const colorTotals = Object.fromEntries(["red", "orange", "yellow", "green"].map((c) => [c, { kg: 0, cases: 0 }]));
const SHIPPED = {
  sync: null, weeks: [],
  totals: { colors: colorTotals, mixedCases: 0, shippedCases: 0, measuredCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 0, complete: true, nonPepper: [], weekCount: 0, packWeeks: 0, legacyWeeks: 0 }
};
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

let entries: unknown[] = ENTRIES;
let summarySizes: unknown[] = SIZES;

function route(path: string) {
  if (path === "/api/yield-analytics/summary") return jsonOk({ sizes: summarySizes, rows: [], products: PRODUCTS });
  if (path === "/api/yield-entries?units=all") return jsonOk(entries);
  if (path.startsWith("/api/shipped-yield")) return jsonOk(SHIPPED);
  if (path === "/api/varieties") return jsonOk(VARIETIES);
  if (path === "/api/waste-imports") return jsonOk([]);
  if (path === "/api/yield-analytics/area-footprints") return jsonOk(AREA_FOOTPRINTS);
  return jsonOk([]);
}

beforeEach(() => {
  entries = ENTRIES;
  summarySizes = SIZES;
  downloads.length = 0;
  apiFetch.mockImplementation((path: string) => Promise.resolve().then(() => route(path)));
});
afterEach(() => vi.clearAllMocks());

const summaryTable = () => within(screen.getByRole("region", { name: "Variety Summary" })).getByRole("table");
const headers = () => within(summaryTable()).getAllByRole("columnheader").map((th) => th.textContent);

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
  return file.blob.text().then((text) => text.trim().split("\n").map((line) => line.split(",")));
}

describe("Yield Analytics — sizes by crop", () => {
  it("Bell Peppers: its own sizes only, no Not sized column, as before", async () => {
    const user = await renderLoaded();
    expect(headers()).toEqual(["Variety", "Entries", "Total kg", "Waste %", "Avg fw (g)", "kg / m²", "Large %", "XL %"]);
    const csv = await exportCsv(user);
    expect(csv[0]).toEqual(["Variety", "Entries", "Total kg", "Waste %", "Avg fw (g)", "kg / m2", "Large %", "XL %"]);
    expect(csv[1]).toEqual(["Cadalora", "1", "1000", "0.0%", "200", "1.0", "60%", "40%"]);
  });

  it("Cucumbers: its own sizes plus Not sized; kg rows show the kg mix, piece rows the piece mix", async () => {
    const user = await renderLoaded();
    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");
    const head = headers();
    expect(head.slice(-3)).toEqual(["Large %", "Straight %", "Not sized %"]);
    expect(head).not.toContain("XL %");

    const csv = await exportCsv(user);
    const column = (name: string) => csv[0].indexOf(name);
    const pick = (row: string[]) => [row[0], row[column("Unit")], row[column("Large %")], row[column("Straight %")], row[column("Not sized %")]];
    // kg: 120 + 80 of 400 kg sized, 200 kg not. Pieces: 300 + 200 of 1000, 500 not.
    expect(csv.slice(1).map(pick)).toEqual([
      ["Bonbon", "kg", "30%", "20%", "50%"],
      ["Bonbon", "pieces", "30%", "20%", "50%"],
      ["Average", "kg", "30%", "20%", "50%"],
      ["Average", "pieces", "30%", "20%", "50%"]
    ]);
  });

  it("a crop with no sizes has no size or Not sized columns", async () => {
    entries = ENTRIES.filter((entry) => entry.id !== "e2" && entry.id !== "p1");
    summarySizes = SIZES.filter((size) => size.product_code === "bell_pepper");
    const user = await renderLoaded();
    await user.selectOptions(screen.getByRole("combobox", { name: "Crop" }), "cucumber");
    expect(headers().filter((header) => header?.endsWith("%"))).toEqual(["Waste %"]);
  });
});
