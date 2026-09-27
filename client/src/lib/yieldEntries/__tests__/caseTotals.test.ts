import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ apiFetch }));

import {
  buildCaseEntryYearOptions,
  buildWeeklyCaseCards,
  formatCaseTotal,
  getVisibleColorRows,
  requestDocklinkCaseSync,
  weeklyCaseTotal,
  type WeeklyCaseEntry
} from "../caseTotals";

const e = (color: string, year: number, week: number, total_cases: number | string) => ({ color, year, week, total_cases }) as WeeklyCaseEntry;

afterEach(() => apiFetch.mockReset());

describe("weekly case totals", () => {
  it("lists this year and every entry year, newest first", () => {
    expect(buildCaseEntryYearOptions([{ year: 2024 }, { year: 2026 }, { year: 2024.5 }], 2025)).toEqual([2026, 2025, 2024]);
  });

  it("builds a card per week of the year with cases > 0, newest week first", () => {
    const cards = buildWeeklyCaseCards(
      [e("red", 2026, 3, 1), e("orange", 2026, 3, "2"), e("red", 2026, 5, 0), e("red", 2026, 54, 9), e("Red", 2026, 4, 9), e("green", 2026, 4, NaN as unknown as number), e("red", 2025, 3, 7), e("yellow", 2026, 1, 0.5)],
      2026
    );
    expect(cards).toEqual([
      { year: 2026, week: 3, totals: { red: 1, orange: 2, yellow: 0, green: 0 } },
      { year: 2026, week: 1, totals: { red: 0, orange: 0, yellow: 0.5, green: 0 } }
    ]);
    expect(buildWeeklyCaseCards([e("red", 2026, 3, 1)], NaN)).toEqual([]);
  });

  it("shows colours > 0 rounded to 3 dp, totals the shown rows, and formats without trailing zeros", () => {
    const rows = getVisibleColorRows({ red: 10.3333, orange: 12.5, yellow: 0, green: -2 });
    expect(rows).toEqual([{ color: "red", total: 10.333 }, { color: "orange", total: 12.5 }]);
    expect(formatCaseTotal(weeklyCaseTotal(rows))).toBe("22.833");
    expect([formatCaseTotal(3), formatCaseTotal(0.0004), formatCaseTotal(1.5), formatCaseTotal(2.1004)]).toEqual(["3", "0", "1.5", "2.1"]);
  });
});

describe("requestDocklinkCaseSync", () => {
  it("POSTs the sync with no body", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(requestDocklinkCaseSync()).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith("/api/integrations/docklink/sync-color-cases", { method: "POST" });
  });

  it("throws the server's message, or 'Sync failed'", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ message: "DockLink is unreachable" }) });
    await expect(requestDocklinkCaseSync()).rejects.toThrow("DockLink is unreachable");
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(requestDocklinkCaseSync()).rejects.toThrow("Sync failed");
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => { throw new Error("not json"); } });
    await expect(requestDocklinkCaseSync()).rejects.toThrow("Sync failed");
  });
});
