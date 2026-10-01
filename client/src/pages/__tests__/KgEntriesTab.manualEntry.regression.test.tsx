import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression pin for the desktop "Enter Kg Manually" form: the defaults,
// live totals, validation messages and the exact bytes of every request it
// sends. Written against the code before any logic moved into shared
// modules, and required to pass unchanged afterwards.
type Call = { path: string; method: string; body: string | undefined };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ existingForWeek: false, saveFails: false }));

vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    const json = route(path, method);
    const ok = !(method !== "GET" && state.saveFails);
    return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => (ok ? json : { message: "Week is locked" }) });
  }
}));

const VARIETIES = [
  { id: "v1", name: "Cadalora", area_m2: 1000, case_kg: 5, status: "active", color: "red" },
  { id: "v2", name: "Zero Area", area_m2: 0, case_kg: 0, status: "active", color: "orange" }
];
// Deliberately out of sort order: the form lists and sends them by sort_order.
const SIZES = [
  { id: "s-lg", name: "Large", sort_order: 2, status: "active" },
  { id: "s-sm", name: "Small", sort_order: 1, status: "active" },
  { id: "s-xl", name: "XL", sort_order: 3, status: "active" }
];
const RECENT = {
  entries: [
    {
      id: "e1", variety_id: "v1", variety_name: "Cadalora", year: 2026, week: 31, packed_date: "2026-07-29",
      size_kg: { "s-sm": 40, "s-lg": 2.5 }, total_kg: 42.5, average_fruit_weight_g: null, kg_per_m2: 0.0425,
      total_cases: 8.5, created_at: "2026-07-29T10:00:00Z", updated_at: "2026-07-29T10:00:00Z", daily_breakdowns: []
    }
  ],
  nextCursor: null,
  hasMore: false
};
function route(path: string, method: string) {
  if (method !== "GET") return { message: null };
  if (path === "/api/yield-entry-options") return { varieties: VARIETIES, yieldSizes: SIZES };
  if (path.startsWith("/api/yield-entries/recent")) return RECENT;
  if (path.startsWith("/api/yield-entries?")) {
    return state.existingForWeek ? [{ ...RECENT.entries[0], id: "e-week", week: 33 }] : [];
  }
  if (path.startsWith("/api/agent-pending-imports")) return { weeks: [] };
  return [];
}

import { KgEntriesTab } from "../KgEntriesTab";

beforeEach(() => {
  // Wed 12 Aug 2026, local time: form week 33 (Sunday-start weeks), packed date 2026-08-12.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  calls.length = 0;
  state.existingForWeek = false;
  state.saveFails = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const writes = () => calls.filter((c) => c.method !== "GET");
const dialog = () => screen.getByRole("dialog", { name: "Enter Kg" });
const field = (label: RegExp | string) => within(dialog()).getByLabelText(label) as HTMLInputElement | HTMLSelectElement;

async function openForm() {
  const user = userEvent.setup();
  render(<KgEntriesTab />);
  const open = await screen.findByRole("button", { name: "Enter Kg Manually" });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  await screen.findByRole("dialog", { name: "Enter Kg" });
  return user;
}
async function typeInto(user: ReturnType<typeof userEvent.setup>, label: RegExp | string, value: string) {
  const input = field(label);
  await user.clear(input);
  if (value) await user.type(input, value);
}

describe("desktop manual kg entry — pinned behaviour", () => {
  it("opens with the first variety, this year and Sunday-start week, today's packed date, and zeroed sizes in sort order", async () => {
    await openForm();
    expect(field("Variety")).toHaveValue("v1");
    expect(field("Year")).toHaveValue("2026");
    expect(within(field("Year") as HTMLElement).getAllByRole("option").map((o) => o.textContent)).toEqual(["2025", "2026", "2027"]);
    expect(field("Week")).toHaveValue("33");
    const weeks = within(field("Week") as HTMLElement).getAllByRole("option");
    expect(weeks).toHaveLength(53);
    expect(weeks[0]).toHaveTextContent("Week 1 - Dec 28 to Jan 03");
    expect(weeks[32]).toHaveTextContent("Week 33 - Aug 09 to Aug 15");
    expect(weeks[52]).toHaveTextContent("Week 53 - Dec 27 to Jan 02");
    expect(field("Packed Date")).toHaveValue("2026-08-12");
    const sizeLabels = Array.from(dialog().querySelectorAll(".yield-size-fields label")).map((l) => l.textContent);
    expect(sizeLabels).toEqual(["Small (kg)", "Large (kg)", "XL (kg)"]);
    for (const l of ["Small (kg)", "Large (kg)", "XL (kg)"]) expect(field(l)).toHaveValue(0);
    expect(field("Total kg")).toHaveValue(0);
    expect(field("kg/m²")).toHaveValue(0);
    expect(field("Total cases")).toHaveValue(0);
  });

  it("computes total kg, kg/m² and cases live from the sizes and the variety's area and case weight", async () => {
    const user = await openForm();
    await typeInto(user, "Small (kg)", "12.5");
    await typeInto(user, "Large (kg)", "7.25");
    await typeInto(user, "XL (kg)", "");
    expect(field("Total kg")).toHaveValue(19.75);
    expect(field("kg/m²")).toHaveValue(0.02); // 19.75 / 1000, rounded to 3 dp
    expect(field("Total cases")).toHaveValue(3.95); // 19.75 / 5
    // A variety with no area or case weight: kg/m² blank, cases 0.
    await user.selectOptions(field("Variety"), "v2");
    expect(field("kg/m²")).toHaveValue(null);
    expect(field("Total cases")).toHaveValue(0);
  });

  it("checks the week for an existing entry, then POSTs exactly this payload", async () => {
    const user = await openForm();
    await typeInto(user, "Small (kg)", "12.5");
    await typeInto(user, "Large (kg)", "7.25");
    await typeInto(user, "XL (kg)", "");
    await typeInto(user, "Average fruit weight (g)", "182.5");
    calls.length = 0;
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Enter Kg" })).toBeNull());
    expect(calls[0]).toEqual({ path: "/api/yield-entries?year=2026&week=33", method: "GET", body: undefined });
    expect(writes()).toEqual([
      {
        path: "/api/yield-entries",
        method: "POST",
        body: '{"variety_id":"v1","year":2026,"week":33,"packed_date":"2026-08-12","size_kg":{"s-sm":12.5,"s-lg":7.25,"s-xl":0},"average_fruit_weight_g":182.5}'
      }
    ]);
    // Then refreshes the week and the recent entries.
    // The Weekly kg by Variety card's read-only reload is the only addition;
    // the kg entry's own requests are unchanged and in the same order.
    const weekly = (c: Call) => c.path.startsWith("/api/yield-entries/weekly-by-variety");
    await waitFor(() => expect(calls.filter((c) => !weekly(c)).map((c) => c.path)).toEqual([
      "/api/yield-entries?year=2026&week=33",
      "/api/yield-entries",
      "/api/yield-entries?year=2026&week=33",
      "/api/yield-entries/recent?limit=7"
    ]));
    await waitFor(() => expect(calls.filter(weekly).map((c) => [c.method, c.path])).toEqual([["GET", "/api/yield-entries/weekly-by-variety"]]));
  });

  it("sends null for a blank average fruit weight and a cleared packed date", async () => {
    const user = await openForm();
    await typeInto(user, "Small (kg)", "3");
    fireEvent.change(field("Packed Date"), { target: { value: "" } });
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toBe(
      '{"variety_id":"v1","year":2026,"week":33,"packed_date":null,"size_kg":{"s-sm":3,"s-lg":0,"s-xl":0},"average_fruit_weight_g":null}'
    );
  });

  it("changing the year resets the week to 1", async () => {
    const user = await openForm();
    await user.selectOptions(field("Year"), "2025");
    expect(field("Week")).toHaveValue("1");
    expect(within(field("Week") as HTMLElement).getAllByRole("option")[0]).toHaveTextContent("Week 1 - Dec 29 to Jan 04");
  });

  it.each([
    ["a negative size kg", { "Small (kg)": "-1" }, "Kg values must be 0 or greater."],
    ["a negative average fruit weight", { "Average fruit weight (g)": "-5" }, "Average fruit weight must be 0 or greater."],
    ["both (sizes are checked first)", { "Small (kg)": "-1", "Average fruit weight (g)": "-5" }, "Kg values must be 0 or greater."]
  ])("rejects %s with the same message and sends nothing", async (_label, values, message) => {
    const user = await openForm();
    for (const [label, value] of Object.entries(values)) await typeInto(user, label, value);
    calls.length = 0;
    fireEvent.submit(dialog().querySelector("form")!);
    expect(await within(dialog()).findByText(message)).toHaveClass("form-error");
    expect(calls).toEqual([]);
  });

  it("asks before adding to an existing weekly entry; Add to Existing POSTs the same payload, Cancel sends nothing", async () => {
    state.existingForWeek = true;
    const user = await openForm();
    await typeInto(user, "Small (kg)", "5");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    const confirm = await screen.findByRole("dialog", { name: "Add to Existing Entry?" });
    expect(confirm).toHaveTextContent(
      "An entry already exists for Cadalora Week 33, 2026. Add these kg to the existing weekly total?"
    );
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(writes()).toEqual([]);

    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Add to Existing Entry?" })).getByRole("button", { name: "Add to Existing" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: "/api/yield-entries",
      method: "POST",
      body: '{"variety_id":"v1","year":2026,"week":33,"packed_date":"2026-08-12","size_kg":{"s-sm":5,"s-lg":0,"s-xl":0},"average_fruit_weight_g":null}'
    });
  });

  it("Edit fills the form from the entry and PUTs to that entry without the duplicate check", async () => {
    const user = userEvent.setup();
    render(<KgEntriesTab />);
    const row = (await screen.findByText("Cadalora", { selector: "td" })).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Yield Entry" });
    const f = (l: string) => within(edit).getByLabelText(l);
    expect(f("Week")).toHaveValue("31");
    expect(f("Packed Date")).toHaveValue("2026-07-29");
    expect(f("Small (kg)")).toHaveValue(40);
    expect(f("Large (kg)")).toHaveValue(2.5);
    expect(f("XL (kg)")).toHaveValue(0);
    expect(f("Average fruit weight (g)")).toHaveValue(null);
    calls.length = 0;
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(calls[0]).toEqual({
      path: "/api/yield-entries/e1",
      method: "PUT",
      body: '{"variety_id":"v1","year":2026,"week":31,"packed_date":"2026-07-29","size_kg":{"s-sm":40,"s-lg":2.5,"s-xl":0},"average_fruit_weight_g":null}'
    });
  });

  it("shows the server's message when a save is rejected, and keeps the form open", async () => {
    state.saveFails = true;
    const user = await openForm();
    await typeInto(user, "Small (kg)", "1");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await within(dialog()).findByText("Week is locked")).toHaveClass("form-error");
  });
});
