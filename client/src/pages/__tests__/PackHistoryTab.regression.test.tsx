import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 0 regression coverage: pins the kg Pack History shows per day and
// per week (the week total adds every variety), rounded as displayed today.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));

import { PackHistoryTab } from "../PackHistoryTab";

const breakdown = (id: string, packed_date: string | null, total_kg: number, average_fruit_weight_g: number | null) => ({
  id,
  packed_date,
  size_kg: {},
  total_kg,
  average_fruit_weight_g
});

const ENTRIES = [
  {
    id: "e1",
    variety_id: "red",
    variety_name: "Alpha Red",
    daily_breakdowns: [
      breakdown("b1", "2026-10-26", 100, 180),
      breakdown("b2", "2026-10-27", 50.06, null),
      breakdown("b3", "2026-09-01", 12.34, 190)
    ]
  },
  { id: "e2", variety_id: "red", variety_name: "Alpha Red", daily_breakdowns: [breakdown("b4", "2026-10-20", 30, 200)] },
  {
    id: "e3",
    variety_id: "yellow",
    variety_name: "Charlie Yellow",
    daily_breakdowns: [
      breakdown("b5", "2026-10-26", 20, 150),
      breakdown("b6", "2026-10-26", 10, 210),
      breakdown("b7", "2026-10-26", 0, 999),
      breakdown("b8", null, 99, 100)
    ]
  }
];

const weekTotals = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".pack-history-week-total")).map((el) => el.textContent);

const dayEntries = (weekCard: Element, dayName: string) => {
  const column = Array.from(weekCard.querySelectorAll(".week-day-col")).find(
    (col) => col.querySelector(".week-day-name")?.textContent === dayName
  )!;
  return Array.from(column.querySelectorAll(".week-day-entry")).map((entry) =>
    [".week-day-variety", ".week-day-kg", ".week-day-afw"].map((selector) => entry.querySelector(selector)?.textContent)
  );
};

describe("Pack History kg totals", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 29, 12)); // Thursday 29 October 2026, local time
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify(ENTRIES), { status: 200 }));
  });
  afterEach(() => {
    vi.useRealTimers();
    apiFetchMock.mockReset();
  });

  it("shows each day's kg per variety and each week's total across varieties", async () => {
    const { container } = render(<PackHistoryTab />);
    await screen.findByText("Load Earlier Weeks");

    expect(weekTotals(container)).toEqual(["180.1 kg", "30 kg", "0 kg", "0 kg"]);

    const [thisWeek, lastWeek] = Array.from(container.querySelectorAll(".pack-history-week-card"));
    expect(dayEntries(thisWeek, "Monday")).toEqual([
      ["Alpha Red", "100 kg", "180 g"],
      ["Charlie Yellow", "30 kg", "170 g"]
    ]);
    expect(dayEntries(thisWeek, "Tuesday")).toEqual([["Alpha Red", "50.1 kg", "—"]]);
    expect(within(thisWeek as HTMLElement).getAllByText("No entries")).toHaveLength(5);
    expect(dayEntries(lastWeek, "Tuesday")).toEqual([["Alpha Red", "30 kg", "200 g"]]);

    fireEvent.click(screen.getByText("Load Earlier Weeks"));
    expect(weekTotals(container)).toEqual(["180.1 kg", "30 kg", "0 kg", "0 kg", "12.3 kg"]);
  });
});
