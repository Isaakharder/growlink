import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Manual Entry with sizes per crop (migration 0152): the form offers only the
// selected variety's crop's active sizes, in kg (decimals) or pieces (whole
// counts) by the entry's unit, and totals them; a crop without sizes keeps
// the single total. Changing to a variety of another crop never carries size
// values across. Old harvests open as recorded: a total-only cucumber
// harvest as a total, a combined one with its unsized amount, and a retired
// size stays on the pepper harvest that carries it.
type Call = { path: string; method: string; body: string | undefined };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ cucumberUnit: "kg", cucumberSizes: true, recent: [] as unknown[] }));

vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path, method) });
  }
}));

const VARIETIES = [
  { id: "v-cad", name: "Cadalora", area_m2: 1000, case_kg: 5, status: "active", color: "red", product_code: "bell_pepper" },
  { id: "v-bon", name: "Bonbon", area_m2: 400, case_kg: 12, status: "active", color: null, product_code: "cucumber" }
];
// Bell Peppers: Large, XL, and MD (retired). Cucumbers: its own "Large" (same name), Straight, and Crooked (retired).
const PEPPER_SIZES = [
  { id: "p-lg", name: "Large", sort_order: 1, status: "active", product_code: "bell_pepper" },
  { id: "p-xl", name: "XL", sort_order: 2, status: "active", product_code: "bell_pepper" },
  { id: "p-md", name: "MD", sort_order: 3, status: "inactive", product_code: "bell_pepper" }
];
const CUCUMBER_SIZES = [
  { id: "c-st", name: "Straight", sort_order: 2, status: "active", product_code: "cucumber" },
  { id: "c-lg", name: "Large", sort_order: 1, status: "active", product_code: "cucumber" },
  { id: "c-cr", name: "Crooked", sort_order: 3, status: "inactive", product_code: "cucumber" }
];

const entry = (over: Record<string, unknown>) => ({
  unit_code: "kg", year: 2026, packed_date: "2026-08-10", average_fruit_weight_g: null, kg_per_m2: 1, total_cases: 1,
  created_at: "2026-08-10T10:00:00Z", updated_at: "2026-08-10T10:00:00Z", daily_breakdowns: [], ...over
});

function route(path: string, method: string) {
  if (method !== "GET") return { message: null };
  if (path === "/api/yield-entry-options") {
    return {
      varieties: VARIETIES,
      yieldSizes: PEPPER_SIZES.filter((s) => s.status === "active").map(({ product_code: _p, ...size }) => size),
      sizes: [...PEPPER_SIZES, ...(state.cucumberSizes ? CUCUMBER_SIZES : [])],
      products: [
        { code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active", defaultUnitCode: "kg" },
        { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active", defaultUnitCode: state.cucumberUnit }
      ]
    };
  }
  if (path.startsWith("/api/yield-entries/recent")) return { entries: state.recent, nextCursor: null, hasMore: false };
  if (path.startsWith("/api/yield-entries?")) return [];
  if (path.startsWith("/api/agent-pending-imports")) return { weeks: [] };
  return [];
}

import { KgEntriesTab } from "../KgEntriesTab";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  calls.length = 0;
  state.cucumberUnit = "kg";
  state.cucumberSizes = true;
  state.recent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const writes = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/yield-entries"));
const sizeLabels = (dialog: HTMLElement) =>
  Array.from(dialog.querySelectorAll(".yield-size-fields label")).map((label) => label.textContent?.trim() ?? "");

async function openForm(title = "Enter Kg") {
  const user = userEvent.setup();
  render(<KgEntriesTab />);
  const open = await screen.findByRole("button", { name: "Enter Kg Manually" });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  const dialog = await screen.findByRole("dialog", { name: title });
  return { user, dialog };
}

async function openEdit(index = 0) {
  const user = userEvent.setup();
  render(<KgEntriesTab />);
  const table = (await screen.findByRole("columnheader", { name: "Total cases" })).closest("table")!;
  await user.click(within(table).getAllByRole("button", { name: "Edit" })[index]);
  const dialog = await screen.findByRole("dialog", { name: "Edit Yield Entry" });
  return { user, dialog };
}

describe("Manual Entry — sizes by crop", () => {
  it("a pepper variety shows the active Bell Pepper sizes only; a cucumber variety its own, values never carried across", async () => {
    const { user, dialog } = await openForm();
    expect(within(dialog).getByLabelText("Variety")).toHaveValue("v-cad");
    expect(sizeLabels(dialog)).toEqual(["Large (kg)", "XL (kg)"]);
    await user.clear(within(dialog).getByLabelText("Large (kg)"));
    await user.type(within(dialog).getByLabelText("Large (kg)"), "40");

    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-bon");
    expect(sizeLabels(dialog)).toEqual(["Large (kg)", "Straight (kg)"]);
    // The pepper "Large" value did not follow to the cucumber "Large".
    expect(within(dialog).getByLabelText("Large (kg)")).toHaveValue(0);
    expect(within(dialog).queryByLabelText("Total harvested kg")).not.toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText("Large (kg)"));
    await user.type(within(dialog).getByLabelText("Large (kg)"), "12.5");
    await user.clear(within(dialog).getByLabelText("Straight (kg)"));
    await user.type(within(dialog).getByLabelText("Straight (kg)"), "7.25");
    expect(within(dialog).getByLabelText("Total kg")).toHaveValue(19.75);

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-12",
      size_kg: { "c-lg": 12.5, "c-st": 7.25 }, average_fruit_weight_g: null
    });
  });

  it("back to a pepper variety: its own sizes again, zeroed", async () => {
    const { user, dialog } = await openForm();
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-bon");
    await user.type(within(dialog).getByLabelText("Straight (kg)"), "9");
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-cad");
    expect(sizeLabels(dialog)).toEqual(["Large (kg)", "XL (kg)"]);
    expect(within(dialog).getByLabelText("Total kg")).toHaveValue(0);
  });

  it("a crop without sizes keeps the single total field", async () => {
    state.cucumberSizes = false;
    const { user, dialog } = await openForm();
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-bon");
    expect(sizeLabels(dialog)).toEqual([]);
    await user.type(within(dialog).getByLabelText("Total harvested kg"), "500");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ variety_id: "v-bon", size_kg: {}, total_kg: 500 });
  });

  it("pieces with sizes: whole counts per size, totalled", async () => {
    state.cucumberUnit = "pcs";
    const { user, dialog } = await openForm();
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-bon");
    expect(await screen.findByRole("heading", { name: "Enter Pieces" })).toBeInTheDocument();
    expect(sizeLabels(dialog)).toEqual(["Large (pcs)", "Straight (pcs)"]);
    expect(within(dialog).getByLabelText("Large (pcs)")).toHaveAttribute("step", "1");
    await user.clear(within(dialog).getByLabelText("Large (pcs)"));
    await user.type(within(dialog).getByLabelText("Large (pcs)"), "3000");
    await user.clear(within(dialog).getByLabelText("Straight (pcs)"));
    await user.type(within(dialog).getByLabelText("Straight (pcs)"), "2000");
    expect(within(dialog).getByLabelText("Total pieces")).toHaveValue(5000);
    expect(within(dialog).getByLabelText("Pieces/m²")).toHaveValue(12.5);
    expect(within(dialog).queryByLabelText("Average fruit weight (g)")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-12", unit_code: "pcs",
      size_pieces: { "c-lg": 3000, "c-st": 2000 }
    });
  });

  it("pieces with sizes refuse a part piece", async () => {
    state.cucumberUnit = "pcs";
    const { user, dialog } = await openForm();
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-bon");
    dialog.querySelector("form")!.noValidate = true;
    await user.clear(within(dialog).getByLabelText("Large (pcs)"));
    await user.type(within(dialog).getByLabelText("Large (pcs)"), "12.5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Pieces must be whole numbers of 0 or more.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("pieces without sizes keep Total harvested pieces", async () => {
    state.cucumberUnit = "pcs";
    state.cucumberSizes = false;
    const { user, dialog } = await openForm();
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-bon");
    expect(sizeLabels(dialog)).toEqual([]);
    await user.type(within(dialog).getByLabelText("Total harvested pieces"), "800");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-12", unit_code: "pcs", total_pieces: 800
    });
  });

  it("an old total-only cucumber harvest is edited as its total; no size breakdown is invented", async () => {
    state.recent = [entry({ id: "e-tot", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", week: 30, size_kg: {}, total_kg: 640 })];
    const { user, dialog } = await openEdit();
    expect(sizeLabels(dialog)).toEqual([]);
    expect(within(dialog).getByLabelText("Total harvested kg")).toHaveValue(640);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: "/api/yield-entries/e-tot", method: "PUT" });
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ size_kg: {}, total_kg: 640 });
  });

  it("a week combining a total-only and a sized harvest keeps its unsized kg, so the total stays", async () => {
    state.recent = [entry({ id: "e-mix", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", week: 31, size_kg: { "c-lg": 100, "c-st": 50 }, total_kg: 650 })];
    const { user, dialog } = await openEdit();
    expect(sizeLabels(dialog)).toEqual(["Large (kg)", "Straight (kg)", "Not sized (kg)"]);
    expect(within(dialog).getByLabelText("Not sized (kg)")).toHaveValue(500);
    expect(within(dialog).getByLabelText("Total kg")).toHaveValue(650);
    await user.clear(within(dialog).getByLabelText("Large (kg)"));
    await user.type(within(dialog).getByLabelText("Large (kg)"), "120");
    expect(within(dialog).getByLabelText("Total kg")).toHaveValue(670);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ size_kg: { "c-lg": 120, "c-st": 50 }, unsized_kg: 500 });
  });

  it("a sized piece count with unsized pieces opens per size with its unsized pieces", async () => {
    state.cucumberUnit = "pcs";
    state.recent = [
      entry({
        id: "e-pcs", unit_code: "pcs", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", week: 32,
        total_pieces: 860, size_pieces: { "c-lg": 40, "c-st": 20 }, pieces_per_m2: 2.15, size_kg: {}, total_kg: null, kg_per_m2: null, total_cases: null
      })
    ];
    const { user, dialog } = await openEdit();
    expect(sizeLabels(dialog)).toEqual(["Large (pcs)", "Straight (pcs)", "Not sized (pcs)"]);
    expect(within(dialog).getByLabelText("Not sized (pcs)")).toHaveValue(800);
    expect(within(dialog).getByLabelText("Total pieces")).toHaveValue(860);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ unit_code: "pcs", size_pieces: { "c-lg": 40, "c-st": 20 }, unsized_pieces: 800 });
  });

  it("a retired pepper size stays readable and is kept on the harvest that carries it", async () => {
    state.recent = [entry({ id: "e-pep", variety_id: "v-cad", variety_name: "Cadalora", product_code: "bell_pepper", week: 10, size_kg: { "p-lg": 60, "p-xl": 40, "p-md": 5 }, total_kg: 105 })];
    const { user, dialog } = await openEdit();
    expect(sizeLabels(dialog)).toEqual(["Large (kg)", "XL (kg)", "MD (kg) · retired"]);
    expect(within(dialog).getByLabelText("Total kg")).toHaveValue(105);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-cad", year: 2026, week: 10, packed_date: "2026-08-10",
      size_kg: { "p-lg": 60, "p-xl": 40, "p-md": 5 }, average_fruit_weight_g: null
    });
  });
});
