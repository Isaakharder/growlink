import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression pin for the desktop Cases tab's "Weekly Case Totals" and
// "Sync DockLink Cases": the cards, their rounding, the year filter and the
// sync request. Written against the code before any logic moved into shared
// modules, and required to pass unchanged afterwards.
type Call = { path: string; method: string; body: string | undefined };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ syncFails: false, afterSync: false }));

vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    if (method === "POST" && path === "/api/integrations/docklink/sync-color-cases") {
      if (state.syncFails) return Promise.resolve({ ok: false, status: 502, json: async () => ({ message: "DockLink is unreachable" }) });
      state.afterSync = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ synced: 1 }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path) });
  }
}));

let n = 0;
const entry = (color: string, year: number, week: number, total_cases: number | string, extra: Record<string, unknown> = {}) => ({
  id: `c${++n}`, color, year, week, total_cases, case_weight_kg: 5, total_kg: Number(total_cases) * 5, kg_per_m2: 0,
  color_area_m2: 1000, source: "docklink", synced_at: null, created_at: `2026-08-0${(n % 9) + 1}T10:00:00Z`,
  updated_at: `2026-08-0${(n % 9) + 1}T10:00:00Z`, ...extra
});
const ENTRIES = [
  entry("red", 2026, 33, 10),
  entry("orange", 2026, 33, "12.5"), // string from the API: still summed numerically
  entry("red", 2026, 33, 0.3333), // red week 33 = 10.3333 → shown 10.333
  entry("yellow", 2026, 32, 0.0004), // > 0 keeps the card, but rounds to 0 on it
  entry("green", 2026, 31, 0), // an all-zero week has no card
  entry("red", 2026, 54, 5), // out-of-range week: ignored
  entry("purple", 2026, 30, 5), // unknown colour: ignored
  entry("Red", 2026, 30, 5), // colour must already be lower-case: ignored
  entry("orange", 2026, 30, -2), // negative: summed, but a row only shows when > 0
  entry("red", 2026, 30, 3),
  entry("red", 2025, 52, 7)
];
const SYNCED = [...ENTRIES, entry("green", 2026, 34, 4, { id: "synced" })];
function route(path: string) {
  if (path === "/api/case-entry-options") return { colors: ["red", "orange", "yellow", "green"] };
  if (path === "/api/color-case-entries") return state.afterSync ? SYNCED : ENTRIES;
  if (path === "/api/varieties") return [];
  return [];
}

import { CasesEntryTab } from "../CasesEntryTab";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  calls.length = 0;
  state.syncFails = false;
  state.afterSync = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const section = () => screen.getByRole("heading", { name: "Weekly Case Totals" }).closest(".yield-entry-weekly-cases") as HTMLElement;
const cards = () =>
  Array.from(section().querySelectorAll("article.weekly-docklink-card")).map((card) => ({
    title: card.querySelector("h3")!.textContent,
    rows: Array.from(card.querySelectorAll(".weekly-docklink-row")).map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]),
    dots: Array.from(card.querySelectorAll(".weekly-docklink-dot")).map((d) => d.className)
  }));

async function renderTab() {
  const user = userEvent.setup();
  render(<CasesEntryTab />);
  await waitFor(() => expect(section().querySelectorAll("article")).not.toHaveLength(0));
  return user;
}

describe("desktop Weekly Case Totals — pinned behaviour", () => {
  it("defaults to this year and lists the years with entries, newest first", async () => {
    await renderTab();
    const year = within(section()).getByLabelText("Year");
    expect(year).toHaveValue("2026");
    expect(within(year).getAllByRole("option").map((o) => o.textContent)).toEqual(["2026", "2025"]);
  });

  it("shows one card per week, newest first, with rounded colour rows > 0 and a total of the shown rows", async () => {
    await renderTab();
    expect(cards()).toEqual([
      {
        title: "Week 33 · 2026",
        rows: [["Red", "10.333"], ["Orange", "12.5"], ["Total", "22.833"]],
        dots: ["weekly-docklink-dot weekly-docklink-dot-red", "weekly-docklink-dot weekly-docklink-dot-orange"]
      },
      { title: "Week 32 · 2026", rows: [["Yellow", "0"], ["Total", "0"]], dots: ["weekly-docklink-dot weekly-docklink-dot-yellow"] },
      { title: "Week 30 · 2026", rows: [["Red", "3"], ["Total", "3"]], dots: ["weekly-docklink-dot weekly-docklink-dot-red"] }
    ]);
  });

  it("switching the year shows that year's weeks", async () => {
    const user = await renderTab();
    await user.selectOptions(within(section()).getByLabelText("Year"), "2025");
    expect(cards()).toEqual([{ title: "Week 52 · 2025", rows: [["Red", "7"], ["Total", "7"]], dots: ["weekly-docklink-dot weekly-docklink-dot-red"] }]);
  });

  it("markup is unchanged, byte for byte", async () => {
    await renderTab();
    expect(section().outerHTML).toMatchSnapshot();
  });
});

describe("desktop Sync DockLink Cases — pinned behaviour", () => {
  it("POSTs the sync with no body, then reloads the entries and the totals", async () => {
    const user = await renderTab();
    calls.length = 0;
    const sync = screen.getByRole("button", { name: "Sync DockLink Cases" });
    await user.click(sync);
    await waitFor(() => expect(cards()[0].title).toBe("Week 34 · 2026"));
    expect(calls).toEqual([
      { path: "/api/integrations/docklink/sync-color-cases", method: "POST", body: undefined },
      { path: "/api/color-case-entries", method: "GET", body: undefined }
    ]);
    expect(cards()[0].rows).toEqual([["Green", "4"], ["Total", "4"]]);
    expect(sync).toBeEnabled();
    expect(sync).toHaveTextContent("Sync DockLink Cases");
  });

  it("on failure keeps the server's message, does not reload, and (as today) only shows it inside the Add Case Entry form", async () => {
    state.syncFails = true;
    const user = await renderTab();
    calls.length = 0;
    const sync = screen.getByRole("button", { name: "Sync DockLink Cases" });
    await user.click(sync);
    await waitFor(() => expect(sync).toBeEnabled());
    expect(calls.map((c) => c.path)).toEqual(["/api/integrations/docklink/sync-color-cases"]);
    expect(cards()[0].title).toBe("Week 33 · 2026");
    // Pre-existing desktop behaviour, pinned rather than changed here: the
    // tab's error is rendered only in the entry modal.
    expect(screen.queryByText("DockLink is unreachable")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add Case Entry" }));
    // Opening the form clears the error (openEntryModal → setError(null)).
    expect(screen.queryByText("DockLink is unreachable")).toBeNull();
  });
});
