import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression pin for the desktop Cases tab's "Weekly Case Totals" and
// "Sync DockLink Cases". Weekly totals come from the one shipped-yield
// calculation (GET /api/shipped-yield) — pack totals for weeks DockLink
// covers, colour totals otherwise — never from the colour rows directly.
// The sync runs the colour sync, then the pack sync, and shows the result
// beside the button (PR #28).
type Call = { path: string; method: string; body: string | undefined };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ syncFails: false, packSyncStatus: 200, afterSync: false }));

vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    if (method === "POST" && path === "/api/integrations/docklink/sync-color-cases") {
      if (state.syncFails) return Promise.resolve({ ok: false, status: 502, json: async () => ({ message: "DockLink is unreachable" }) });
      state.afterSync = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, message: "Synced DockLink cases: imported=1" }) });
    }
    if (method === "POST" && path === "/api/integrations/docklink/sync-packs") {
      const status = state.packSyncStatus;
      const message = status === 503 ? "DockLink's pack export (growlink_pack_export_v1) is not available yet." : "Synced DockLink packs for 2026-W33 to 2026-W34";
      return Promise.resolve({ ok: status < 400, status, json: async () => ({ message }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path) });
  }
}));

type Week = Record<string, unknown>;
const colors = (c: Partial<Record<"red" | "orange" | "yellow" | "green", [number, number]>>) =>
  Object.fromEntries((["red", "orange", "yellow", "green"] as const).map((k) => [k, { cases: c[k]?.[0] ?? 0, kg: c[k]?.[1] ?? 0 }]));
const week = (isoYear: number, isoWeek: number, source: "packs" | "legacy", o: Partial<Week> & { colors: Week["colors"] }): Week => ({
  isoYear, isoWeek, source, mixedCases: 0, shippedCases: 0, measuredCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 0,
  complete: true, nonPepper: [], supersededLegacyRows: 0, ...o
});
const response = (weeks: Week[]) => ({
  sync: { scopeStatus: "available", firstWeek: { isoYear: 2026, isoWeek: 33 }, lastWeek: { isoYear: 2026, isoWeek: 34 }, transitionWeek: { isoYear: 2026, isoWeek: 32 }, generatedAt: "", lastSyncedAt: "2026-08-12T09:00:00Z", captureActivatedAt: null, diagnostics: {} },
  weeks,
  totals: { colors: colors({}), mixedCases: 0, shippedCases: 0, measuredCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 0, complete: true, nonPepper: [], weekCount: weeks.length, packWeeks: 0, legacyWeeks: 0 }
});

const W33 = week(2026, 33, "packs", {
  colors: colors({ red: [10.3333, 52.1], orange: [12.5, 60] }),
  mixedCases: 4, attentionCases: 2, shippedCases: 28.8333, measuredCases: 22.8333, unmeasuredCases: 4, kg: 112.1, complete: false
});
const W32 = week(2026, 32, "legacy", { colors: colors({ yellow: [0.0004, 0] }), shippedCases: 0.0004, unmeasuredCases: 0.0004, complete: false });
const W31 = week(2026, 31, "legacy", { colors: colors({}), shippedCases: 0 }); // an all-zero week has no card
const W30 = week(2026, 30, "legacy", { colors: colors({ red: [3, 15] }), shippedCases: 3, measuredCases: 3, kg: 15 });
const W34 = week(2026, 34, "packs", { colors: colors({ green: [4, 20] }), shippedCases: 4, measuredCases: 4, kg: 20 });
const Y2025 = [week(2025, 52, "legacy", { colors: colors({ red: [7, 35] }), shippedCases: 7, measuredCases: 7, kg: 35 })];

let n = 0;
const entry = (color: string, year: number, week: number, total_cases: number, extra: Record<string, unknown> = {}) => ({
  id: `c${++n}`, color, year, week, total_cases, case_weight_kg: 5, total_kg: total_cases * 5, kg_per_m2: 0,
  color_area_m2: 1000, source: "docklink", synced_at: null, created_at: `2026-08-0${(n % 9) + 1}T10:00:00Z`,
  updated_at: `2026-08-0${(n % 9) + 1}T10:00:00Z`, ...extra
});
const ENTRIES = [entry("red", 2026, 33, 10), entry("red", 2026, 30, 3), entry("red", 2025, 52, 7)];

function route(path: string) {
  if (path === "/api/case-entry-options") return { colors: ["red", "orange", "yellow", "green"] };
  if (path === "/api/color-case-entries") return ENTRIES;
  if (path === "/api/shipped-yield?fromYear=2026&toYear=2026") return response(state.afterSync ? [W34, W33, W32, W31, W30] : [W33, W32, W31, W30]);
  if (path === "/api/shipped-yield?fromYear=2025&toYear=2025") return response(Y2025);
  if (path.startsWith("/api/pack-shipments/week")) {
    return { isoYear: 2026, isoWeek: 33, weekStart: "2026-08-10", weekEnd: "2026-08-16", sync: null, source: "legacy", packs: [], attention: [], nonPepper: [], legacyRows: [], totals: null, copySource: null };
  }
  return [];
}

import { CasesEntryTab } from "../CasesEntryTab";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  calls.length = 0;
  state.syncFails = false;
  state.packSyncStatus = 200;
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
    source: card.querySelector(".weekly-docklink-source")?.textContent ?? null,
    rows: Array.from(card.querySelectorAll(".weekly-docklink-row")).map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]),
    incomplete: card.querySelector(".weekly-docklink-incomplete")?.textContent ?? null
  }));

async function renderTab() {
  const user = userEvent.setup();
  render(<CasesEntryTab />);
  await waitFor(() => expect(section().querySelectorAll("article")).not.toHaveLength(0));
  return user;
}

describe("desktop Weekly Case Totals — from the shipped-yield calculation", () => {
  it("defaults to this year and lists the years with entries or pack coverage, newest first", async () => {
    await renderTab();
    const year = within(section()).getByLabelText("Year");
    expect(year).toHaveValue("2026");
    expect(within(year).getAllByRole("option").map((o) => o.textContent)).toEqual(["2026", "2025"]);
  });

  it("shows one card per week with shipped cases, newest first: colour cases, mixed cases once, needs-attention, total and kg", async () => {
    await renderTab();
    expect(cards()).toEqual([
      {
        title: "Week 33 · 2026",
        source: "Pack totals",
        rows: [["Red", "10.333"], ["Orange", "12.5"], ["Mixed / rainbow", "4"], ["Needs attention", "2"], ["Total", "28.833"], ["Shipped kg", "112.1 kg"]],
        incomplete: "Incomplete: 4 shipped cases have no usable measurement · 2 cases need attention. Shipped kg covers measured cases only."
      },
      {
        title: "Week 32 · 2026",
        source: "Colour totals",
        rows: [["Yellow", "0"], ["Total", "0"], ["Shipped kg", "0 kg"]],
        incomplete: "Incomplete: 0 shipped cases have no usable measurement. Shipped kg covers measured cases only."
      },
      { title: "Week 30 · 2026", source: "Colour totals", rows: [["Red", "3"], ["Total", "3"], ["Shipped kg", "15 kg"]], incomplete: null }
    ]);
  });

  it("switching the year loads that year's weeks", async () => {
    const user = await renderTab();
    await user.selectOptions(within(section()).getByLabelText("Year"), "2025");
    await waitFor(() => expect(cards()[0].title).toBe("Week 52 · 2025"));
    expect(cards()).toEqual([{ title: "Week 52 · 2025", source: "Colour totals", rows: [["Red", "7"], ["Total", "7"], ["Shipped kg", "35 kg"]], incomplete: null }]);
    expect(calls.some((c) => c.path === "/api/shipped-yield?fromYear=2025&toYear=2025")).toBe(true);
  });

  it("never computes totals from the colour rows itself", async () => {
    await renderTab();
    expect(calls.filter((c) => c.path.startsWith("/api/shipped-yield")).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.path === "/api/varieties")).toBe(false);
  });

  it("markup is pinned", async () => {
    await renderTab();
    expect(section().outerHTML).toMatchSnapshot();
  });
});

describe("desktop Recent Entries — stored values, superseded colour rows marked", () => {
  it("shows each colour row's stored case weight and kg, and marks rows in pack-covered weeks as superseded", async () => {
    const user = await renderTab();
    await user.click(screen.getByRole("button", { name: "Expand" }));
    const rows = Array.from(document.querySelectorAll(".yield-entry-table-cases tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).slice(0, 8).map((td) => td.textContent)
    );
    expect(rows).toContainEqual(["Red", "2026", "33", "10", "5", "50", "—", "DocklinkSuperseded by pack totals"]);
    expect(rows).toContainEqual(["Red", "2026", "30", "3", "5", "15", "—", "Docklink"]);
  });
});

describe("desktop Sync DockLink Cases — pinned behaviour", () => {
  it("POSTs the colour sync then the pack sync, with no body, then reloads the entries and the totals", async () => {
    const user = await renderTab();
    calls.length = 0;
    const sync = screen.getByRole("button", { name: "Sync DockLink Cases" });
    await user.click(sync);
    await waitFor(() => expect(cards()[0].title).toBe("Week 34 · 2026"));
    expect(calls.slice(0, 4)).toEqual([
      { path: "/api/integrations/docklink/sync-color-cases", method: "POST", body: undefined },
      { path: "/api/integrations/docklink/sync-packs", method: "POST", body: undefined },
      { path: "/api/color-case-entries", method: "GET", body: undefined },
      { path: "/api/shipped-yield?fromYear=2026&toYear=2026", method: "GET", body: undefined }
    ]);
    expect(cards()[0].rows).toEqual([["Green", "4"], ["Total", "4"], ["Shipped kg", "20 kg"]]);
    expect(sync).toBeEnabled();
    expect(sync).toHaveTextContent("Sync DockLink Cases");
  });

  it("on failure shows the server's message beside the button, and does not reload", async () => {
    state.syncFails = true;
    const user = await renderTab();
    calls.length = 0;
    const sync = screen.getByRole("button", { name: "Sync DockLink Cases" });
    await user.click(sync);
    await waitFor(() => expect(sync).toBeEnabled());
    expect(calls.map((c) => c.path)).toEqual(["/api/integrations/docklink/sync-color-cases"]);
    expect(cards()[0].title).toBe("Week 33 · 2026");
    expect(screen.getByRole("alert")).toHaveTextContent("DockLink is unreachable");
    // Opening the entry form no longer hides the sync result.
    await user.click(screen.getByRole("button", { name: "Add Case Entry" }));
    expect(screen.getByText("DockLink is unreachable")).toBeInTheDocument();
  });

  it("on success shows both summaries beside the button", async () => {
    const user = await renderTab();
    await user.click(screen.getByRole("button", { name: "Sync DockLink Cases" }));
    await waitFor(() => expect(cards()[0].title).toBe("Week 34 · 2026"));
    expect(screen.getByRole("status")).toHaveTextContent("Synced DockLink cases: imported=1 · Packs: Synced DockLink packs for 2026-W33 to 2026-W34");
  });

  it("a pack export DockLink hasn't deployed yet is reported, not shown as an error", async () => {
    state.packSyncStatus = 503;
    const user = await renderTab();
    await user.click(screen.getByRole("button", { name: "Sync DockLink Cases" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Packs: DockLink's pack export (growlink_pack_export_v1) is not available yet."));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a real pack sync failure is shown as an error after the colour sync's summary", async () => {
    state.packSyncStatus = 502;
    const user = await renderTab();
    await user.click(screen.getByRole("button", { name: "Sync DockLink Cases" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Synced DockLink cases: imported=1 · Pack sync failed:"));
  });
});
