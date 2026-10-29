import { describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({ apiFetch: vi.fn() }));

import { buildDailyPackMap, getWeekStartsWithData, type YieldEntryForHistory } from "../packHistory";

// Phase 0 regression coverage: pins how Pack History groups daily breakdowns
// into kg per variety per packed day, and which weeks count as having data.
const breakdown = (id: string, packed_date: string | null, total_kg: number, average_fruit_weight_g: number | null) => ({
  id,
  packed_date,
  size_kg: {},
  total_kg,
  average_fruit_weight_g
});

const ENTRIES: YieldEntryForHistory[] = [
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
  {
    id: "e2",
    variety_id: "red",
    variety_name: "Alpha Red",
    daily_breakdowns: [breakdown("b4", "2026-10-20", 30, 200)]
  },
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

describe("Pack History daily totals", () => {
  it("sums kg per variety per packed day, kg-weights fruit weight, sorts by kg, and skips undated rows", () => {
    const map = buildDailyPackMap(ENTRIES);
    expect(Object.fromEntries(map)).toEqual({
      "2026-10-26": [
        { varietyId: "red", name: "Alpha Red", kg: 100, averageFruitWeightG: 180 },
        { varietyId: "yellow", name: "Charlie Yellow", kg: 30, averageFruitWeightG: 170 }
      ],
      "2026-10-27": [{ varietyId: "red", name: "Alpha Red", kg: 50.06, averageFruitWeightG: null }],
      "2026-09-01": [{ varietyId: "red", name: "Alpha Red", kg: 12.34, averageFruitWeightG: 190 }],
      "2026-10-20": [{ varietyId: "red", name: "Alpha Red", kg: 30, averageFruitWeightG: 200 }]
    });
  });

  it("lists the Sunday that starts every week with packed entries", () => {
    expect(Array.from(getWeekStartsWithData(buildDailyPackMap(ENTRIES))).sort()).toEqual(["2026-08-30", "2026-10-18", "2026-10-25"]);
  });
});
