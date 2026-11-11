import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Manual Entry once Cucumbers' default unit is Pieces (Setup → Products):
// a new cucumber harvest is a whole-number piece count, saved apart from
// weight. A week that already has a cucumber kg harvest keeps it; editing an
// old harvest opens it in the unit it was recorded in. Bell Peppers is kg.
type Call = { path: string; method: string; body: string | undefined };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ weekEntries: [] as unknown[], recent: [] as unknown[] }));

vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path, method) });
  }
}));

const PRODUCTS = [
  { code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active", defaultUnitCode: "kg" },
  { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active", defaultUnitCode: "pcs" }
];
const VARIETIES = [
  { id: "v-bon", name: "Bonbon", area_m2: 400, case_kg: 12, status: "active", color: null, product_code: "cucumber" },
  { id: "v-cad", name: "Cadalora", area_m2: 1000, case_kg: 5, status: "active", color: "red", product_code: "bell_pepper" }
];
const SIZES = [{ id: "s-sm", name: "Small", sort_order: 1, status: "active" }];
// Week 33 in kg, recorded before the switch to pieces.
const KG_ENTRY = {
  id: "e-kg", unit_code: "kg", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: 2026, week: 33,
  packed_date: "2026-08-10", size_kg: {}, total_kg: 1200, average_fruit_weight_g: null, kg_per_m2: 3, total_cases: 100,
  created_at: "2026-08-10T10:00:00Z", updated_at: "2026-08-10T10:00:00Z", daily_breakdowns: []
};
const PIECE_ENTRY = {
  id: "e-pcs", unit_code: "pcs", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: 2026, week: 32,
  packed_date: "2026-08-05", total_pieces: 5000, pieces_per_m2: 12.5, size_kg: {}, total_kg: null, average_fruit_weight_g: null,
  kg_per_m2: null, total_cases: null, created_at: "2026-08-05T10:00:00Z", updated_at: "2026-08-05T10:00:00Z", daily_breakdowns: []
};

function route(path: string, method: string) {
  if (method !== "GET") return { message: null };
  if (path === "/api/yield-entry-options") return { varieties: VARIETIES, yieldSizes: SIZES, products: PRODUCTS };
  if (path.startsWith("/api/yield-entries/recent")) return { entries: state.recent, nextCursor: null, hasMore: false };
  if (path.startsWith("/api/yield-entries?")) {
    // Like the server: piece counts only when asked for.
    const all = path.includes("units=all");
    return state.weekEntries.filter((e) => all || (e as { unit_code?: string }).unit_code !== "pcs");
  }
  if (path.startsWith("/api/agent-pending-imports")) return { weeks: [] };
  return [];
}

import { KgEntriesTab } from "../KgEntriesTab";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  calls.length = 0;
  state.weekEntries = [];
  state.recent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const writes = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/yield-entries"));

async function openForm() {
  const user = userEvent.setup();
  render(<KgEntriesTab />);
  const open = await screen.findByRole("button", { name: "Enter Kg Manually" });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  const dialog = await screen.findByRole("dialog", { name: "Enter Pieces" });
  return { user, dialog };
}

describe("Manual Entry — Cucumbers in pieces", () => {
  it("shows Total harvested pieces, no weight fields, and saves a whole-number count", async () => {
    const { user, dialog } = await openForm();
    expect(within(dialog).getByLabelText("Variety")).toHaveValue("v-bon");
    expect(within(dialog).queryByLabelText("Total harvested kg")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Average fruit weight (g)")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("kg/m²")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Total cases")).not.toBeInTheDocument();

    const pieces = within(dialog).getByLabelText("Total harvested pieces");
    expect(pieces).toHaveAttribute("step", "1");
    await user.type(pieces, "5000");
    expect(within(dialog).getByLabelText("Pieces/m²")).toHaveValue(12.5);

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: "/api/yield-entries",
      method: "POST",
      body: JSON.stringify({ variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-12", unit_code: "pcs", total_pieces: 5000 })
    });
  });

  it("accepts whole counts only", async () => {
    const { user, dialog } = await openForm();
    dialog.querySelector("form")!.noValidate = true;
    for (const bad of ["12.5", "-3"]) {
      await user.clear(within(dialog).getByLabelText("Total harvested pieces"));
      await user.type(within(dialog).getByLabelText("Total harvested pieces"), bad);
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(await within(dialog).findByText("Pieces must be a whole number of 0 or more.")).toBeInTheDocument();
    }
    await user.clear(within(dialog).getByLabelText("Total harvested pieces"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Total pieces is required.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("a week that already has a cucumber kg harvest gets a separate piece count, without the add-to prompt", async () => {
    state.weekEntries = [KG_ENTRY];
    const { user, dialog } = await openForm();
    await user.type(within(dialog).getByLabelText("Total harvested pieces"), "800");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Add to Existing Entry?" })).not.toBeInTheDocument();
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ unit_code: "pcs", total_pieces: 800 });
    // The duplicate check asked for piece counts, so it could tell them apart from the kg harvest.
    expect(calls.some((c) => c.path === "/api/yield-entries?year=2026&week=33&units=all")).toBe(true);
  });

  it("a second count in the same week asks to add these pieces to the existing count", async () => {
    state.weekEntries = [KG_ENTRY, { ...PIECE_ENTRY, week: 33 }];
    const { user, dialog } = await openForm();
    await user.type(within(dialog).getByLabelText("Total harvested pieces"), "250");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const confirm = await screen.findByRole("dialog", { name: "Add to Existing Entry?" });
    expect(confirm).toHaveTextContent("A piece count already exists for Bonbon Week 33, 2026. Add these pieces to the existing weekly count?");
    await user.click(within(confirm).getByRole("button", { name: "Add to Existing" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ unit_code: "pcs", total_pieces: 250 });
  });

  it("Recent Entries shows the count with blank kg columns; each harvest opens in its own unit", async () => {
    state.recent = [KG_ENTRY, PIECE_ENTRY];
    const user = userEvent.setup();
    render(<KgEntriesTab />);
    const table = (await screen.findByRole("columnheader", { name: "Total pieces" })).closest("table")!;
    const rows = within(table).getAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((cell) => cell.textContent));
    expect(rows[1].slice(0, 10)).toEqual(["Bonbon", "2026", "33", "2026-08-10", "1200", "", "3", "", "100", "-"]);
    expect(rows[2].slice(0, 10)).toEqual(["Bonbon", "2026", "32", "2026-08-05", "", "5,000 pcs", "", "12.5", "", ""]);

    // The kg harvest still opens in kg, though new cucumber harvests are pieces.
    await user.click(within(table).getAllByRole("button", { name: "Edit" })[0]);
    let edit = await screen.findByRole("dialog", { name: "Edit Yield Entry" });
    expect(within(edit).getByLabelText("Total harvested kg")).toHaveValue(1200);
    expect(within(edit).queryByLabelText("Total harvested pieces")).not.toBeInTheDocument();
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].path).toBe("/api/yield-entries/e-kg");
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-10", size_kg: {}, total_kg: 1200, average_fruit_weight_g: null
    });

    // The piece count opens in pieces.
    await user.click(within(table).getAllByRole("button", { name: "Edit" })[1]);
    edit = await screen.findByRole("dialog", { name: "Edit Yield Entry" });
    expect(within(edit).getByLabelText("Total harvested pieces")).toHaveValue(5000);
    expect(within(edit).getByText("This harvest was recorded in pieces, so it is edited in pieces.")).toBeInTheDocument();
    await user.clear(within(edit).getByLabelText("Total harvested pieces"));
    await user.type(within(edit).getByLabelText("Total harvested pieces"), "5100");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({
      path: "/api/yield-entries/e-pcs",
      method: "PUT",
      body: JSON.stringify({ variety_id: "v-bon", year: 2026, week: 32, packed_date: "2026-08-05", unit_code: "pcs", total_pieces: 5100 })
    });
    // Recent Entries always asks for piece counts.
    expect(calls.filter((c) => c.path.startsWith("/api/yield-entries/recent")).every((c) => c.path.endsWith("&units=all"))).toBe(true);
  });

  it("Bell Peppers stays kg by size, with the same request as before", async () => {
    const { user, dialog } = await openForm();
    await user.selectOptions(within(dialog).getByLabelText("Variety"), "v-cad");
    const kgDialog = await screen.findByRole("dialog", { name: "Enter Kg" });
    expect(within(kgDialog).queryByLabelText("Total harvested pieces")).not.toBeInTheDocument();
    await user.clear(within(kgDialog).getByLabelText("Small (kg)"));
    await user.type(within(kgDialog).getByLabelText("Small (kg)"), "30");
    await user.click(within(kgDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-cad", year: 2026, week: 33, packed_date: "2026-08-12", size_kg: { "s-sm": 30 }, average_fruit_weight_g: null
    });
  });
});
