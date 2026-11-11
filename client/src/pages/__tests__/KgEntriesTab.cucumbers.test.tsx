import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Manual Entry for an organization growing Bell Peppers and Cucumbers: a
// cucumber harvest is one total kg with no size buckets, saved, edited and
// deleted through the same form; Bell Pepper entry is unchanged.
type Call = { path: string; method: string; body: string | undefined };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ weekEntries: [] as unknown[] }));

vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path, method) });
  }
}));

const PRODUCTS = [
  { code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active" },
  { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active" }
];
const VARIETIES = [
  { id: "v-bon", name: "Bonbon", area_m2: 400, case_kg: 12, status: "active", color: null, product_code: "cucumber" },
  { id: "v-cad", name: "Cadalora", area_m2: 1000, case_kg: 5, status: "active", color: "red", product_code: "bell_pepper" }
];
const SIZES = [
  { id: "s-sm", name: "Small", sort_order: 1, status: "active" },
  { id: "s-lg", name: "Large", sort_order: 2, status: "active" }
];
const CUCUMBER_ENTRY = {
  id: "e-bon", variety_id: "v-bon", variety_name: "Bonbon", product_code: "cucumber", year: 2026, week: 33, packed_date: "2026-08-12",
  size_kg: {}, total_kg: 2000, average_fruit_weight_g: null, kg_per_m2: 5, total_cases: 166.67,
  created_at: "2026-08-12T10:00:00Z", updated_at: "2026-08-12T10:00:00Z", daily_breakdowns: []
};
const PEPPER_ENTRY = {
  ...CUCUMBER_ENTRY, id: "e-cad", variety_id: "v-cad", variety_name: "Cadalora", product_code: "bell_pepper",
  size_kg: { "s-sm": 300 }, total_kg: 300, kg_per_m2: 0.3, total_cases: 60
};

function route(path: string, method: string) {
  if (method !== "GET") return { message: null };
  if (path === "/api/yield-entry-options") return { varieties: VARIETIES, yieldSizes: SIZES, products: PRODUCTS };
  if (path.startsWith("/api/yield-entries/recent")) return { entries: [CUCUMBER_ENTRY], nextCursor: null, hasMore: false };
  if (path.startsWith("/api/yield-entries?")) return state.weekEntries;
  if (path.startsWith("/api/agent-pending-imports")) return { weeks: [] };
  return [];
}

import { KgEntriesTab } from "../KgEntriesTab";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  calls.length = 0;
  state.weekEntries = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const writes = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/yield-entries"));
const dialog = (name = "Enter Kg") => screen.getByRole("dialog", { name });
const field = (label: string, name?: string) => within(dialog(name)).getByLabelText(label) as HTMLInputElement | HTMLSelectElement;

async function openForm() {
  const user = userEvent.setup();
  render(<KgEntriesTab />);
  const open = await screen.findByRole("button", { name: "Enter Kg Manually" });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await screen.findByRole("dialog", { name: "Enter Kg" });
  return user;
}

describe("Manual Entry — Cucumbers", () => {
  it("a cucumber variety takes the total harvested kg, with no size buckets, and saves just that", async () => {
    const user = await openForm();
    expect(field("Variety")).toHaveValue("v-bon");

    expect(dialog().querySelector(".yield-size-fields")).toBeNull();
    expect(within(dialog()).queryByLabelText("Small (kg)")).not.toBeInTheDocument();
    await user.type(field("Total harvested kg"), "1200");
    expect(field("kg/m²")).toHaveValue(3);
    expect(field("Total cases")).toHaveValue(100);

    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: "/api/yield-entries",
      method: "POST",
      body: JSON.stringify({
        variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-12", size_kg: {}, total_kg: 1200, average_fruit_weight_g: null
      })
    });
  });

  it("requires the total for a cucumber harvest", async () => {
    const user = await openForm();
    // The input is required; submitting the form directly still reports it.
    const form = dialog().querySelector("form")!;
    form.noValidate = true;
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText("Total kg is required.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("switching to a Bell Pepper variety brings back the size buckets and the same request as before", async () => {
    const user = await openForm();
    await user.selectOptions(field("Variety"), "v-cad");
    expect(within(dialog()).queryByLabelText("Total harvested kg")).not.toBeInTheDocument();
    await user.clear(field("Small (kg)"));
    await user.type(field("Small (kg)"), "30");
    expect(field("Total kg")).toHaveValue(30);

    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      variety_id: "v-cad", year: 2026, week: 33, packed_date: "2026-08-12", size_kg: { "s-sm": 30, "s-lg": 0 }, average_fruit_weight_g: null
    });
  });

  it("edits and deletes a cucumber entry through the existing Recent Entries actions", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<KgEntriesTab />);
    const row = (await screen.findByRole("cell", { name: "Bonbon" })).closest("tr")!;

    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Yield Entry" });
    expect(within(edit).getByLabelText("Total harvested kg")).toHaveValue(2000);
    await user.clear(within(edit).getByLabelText("Total harvested kg"));
    await user.type(within(edit).getByLabelText("Total harvested kg"), "2100");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].method).toBe("PUT");
    expect(writes()[0].path).toBe("/api/yield-entries/e-bon");
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ variety_id: "v-bon", size_kg: {}, total_kg: 2100 });

    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ path: "/api/yield-entries/e-bon", method: "DELETE" });
  });

  it("Weekly Color Share shows pepper colours only — a cucumber in the same week neither breaks it nor joins a colour", async () => {
    state.weekEntries = [CUCUMBER_ENTRY, PEPPER_ENTRY];
    render(<KgEntriesTab />);
    const card = (await screen.findByRole("heading", { name: "Weekly Color Share" })).closest(".color-share-card") as HTMLElement;
    const groups = Array.from(card.querySelectorAll(".color-group")).map((g) => g.getAttribute("data-color"));
    expect(groups).toEqual(["red"]);
    expect(within(card).getByText("Cadalora")).toBeInTheDocument();
    expect(within(card).queryByText("Bonbon")).not.toBeInTheDocument();
  });
});
