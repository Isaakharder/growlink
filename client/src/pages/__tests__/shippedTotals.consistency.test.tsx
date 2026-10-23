import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Every screen reads shipped cases and kg from the one shipped-yield
// calculation (GET /api/shipped-yield). Given the same response, the Cases
// tab, Yield Analytics and the Dashboard / iOS Yield by Color helper show the
// same shipped kg, and none of them derives it from colour rows or case weights.
const calls: string[] = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options?: RequestInit) => {
    calls.push(path);
    return apiFetch(path, options);
  }
}));

import { CasesEntryTab } from "../CasesEntryTab";
import { YieldAnalyticsPage } from "../YieldAnalyticsPage";
import { buildColorYieldSummary } from "../../lib/dashboard/yieldByColor";
import { shippedKgByColor } from "../../lib/shippedYield";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const YEAR = new Date().getFullYear();
const colors = { red: { kg: 520.4, cases: 100 }, orange: { kg: 0, cases: 0 }, yellow: { kg: 99.6, cases: 20 }, green: { kg: 0, cases: 0 } };
const week = {
  isoYear: YEAR, isoWeek: 30, source: "packs", colors, mixedCases: 0, shippedCases: 120, measuredCases: 120, unmeasuredCases: 0,
  attentionCases: 0, kg: 620, complete: true, nonPepper: [], supersededLegacyRows: 0
};
const SHIPPED = {
  sync: null,
  weeks: [week],
  totals: { ...week, weekCount: 1, packWeeks: 1, legacyWeeks: 0 }
};
const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  calls.length = 0;
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/api/shipped-yield")) return Promise.resolve(jsonOk(SHIPPED));
    if (path === "/api/case-entry-options") return Promise.resolve(jsonOk({ colors: ["red", "yellow"] }));
    if (path === "/api/yield-analytics/summary") return Promise.resolve(jsonOk({ sizes: [], rows: [] }));
    if (path === "/api/yield-analytics/area-footprints") return Promise.resolve(jsonOk({ groups: [], rows: [], footprints: {}, linksAvailable: false }));
    if (path.startsWith("/api/pack-shipments/week")) {
      return Promise.resolve(jsonOk({ isoYear: YEAR, isoWeek: 30, weekStart: "", weekEnd: "", sync: null, source: "legacy", packs: [], attention: [], nonPepper: [], legacyRows: [], totals: null, copySource: null }));
    }
    return Promise.resolve(jsonOk([]));
  });
});
afterEach(() => vi.clearAllMocks());

describe("shipped totals are the same on every screen", () => {
  it("Cases, Yield Analytics and the Dashboard/iOS helper show the same shipped kg from the same response", async () => {
    const { unmount } = render(<CasesEntryTab />);
    const casesCard = await screen.findByText(`Week 30 · ${YEAR}`);
    expect(within(casesCard.closest("article")!).getByText("620 kg")).toBeInTheDocument();
    // The Cases tab no longer loads varieties to average their case weights.
    expect(calls).not.toContain("/api/varieties");
    unmount();

    render(<YieldAnalyticsPage />);
    const harvest = await screen.findByRole("region", { name: "Harvest vs Shipped" });
    const shippedKgCell = (color: string) => within(within(harvest).getByRole("rowheader", { name: color }).closest("tr")!).getAllByRole("cell")[2].textContent;
    await waitFor(() => expect(shippedKgCell("Red")).toBe("520.4"));
    expect(shippedKgCell("Yellow")).toBe("99.6");
    expect(Number(shippedKgCell("Red")) + Number(shippedKgCell("Yellow"))).toBe(620);

    const dashboard = buildColorYieldSummary([], [], shippedKgByColor(SHIPPED));
    expect(dashboard.map((c) => c.exportedKg)).toEqual([520.4, 0, 99.6, 0]);

    // Shipped kg is read from the calculation, never rebuilt from colour rows or case weights.
    expect(calls.filter((c) => c.startsWith("/api/shipped-yield")).length).toBeGreaterThanOrEqual(2);
  });
});
