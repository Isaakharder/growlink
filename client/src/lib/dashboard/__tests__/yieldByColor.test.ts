import { describe, expect, it } from "vitest";
import {
  buildColorYieldSummary,
  buildYieldPieSlices,
  buildYieldTrendPoints,
  formatColorKgPerM2,
  normalizeColor,
  normalizeColorCaseEntries,
  normalizeYieldEntries,
  type ColorYieldVariety
} from "../yieldByColor";

const v = (id: string, color: string | null, area_m2: number | string, status: "active" | "inactive" = "active") =>
  ({ id, color, area_m2, status }) as ColorYieldVariety;

describe("normalizers", () => {
  it("normalizeColor trims and lower-cases the four colours only", () => {
    expect(["Red", " green ", "ORANGE", "yellow", "purple", "", null, 3].map(normalizeColor)).toEqual(["red", "green", "orange", "yellow", null, null, null, null]);
  });

  it("normalizeYieldEntries accepts snake or camel case, truncates, and drops invalid rows", () => {
    expect(normalizeYieldEntries("nope")).toEqual([]);
    expect(
      normalizeYieldEntries([
        { variety_id: " va ", year: "2026", week: 31.9, total_kg: "12.5" },
        { varietyId: "vb", iso_year: 2026, iso_week: 1, totalKg: 0 },
        { variety_id: "vc", year: 2026, week: 54, total_kg: 1 },
        { variety_id: "vc", year: 2026, week: 0, total_kg: 1 },
        { variety_id: "vc", year: 2026, week: 5, total_kg: -1 },
        { variety_id: "", year: 2026, week: 5, total_kg: 1 },
        null,
        "x"
      ])
    ).toEqual([
      { variety_id: "va", year: 2026, week: 31, total_kg: 12.5 },
      { variety_id: "vb", year: 2026, week: 1, total_kg: 0 }
    ]);
  });

  it("normalizeColorCaseEntries drops negative or missing cases/weights; a missing total kg is 0", () => {
    expect(
      normalizeColorCaseEntries([
        { color: "RED", total_cases: 2, case_weight_kg: 5, total_kg: 10 },
        { color: "green", totalCases: "3", caseWeightKg: 4 },
        { color: "red", total_cases: -1, case_weight_kg: 5 },
        { color: "red", total_cases: 1 },
        { color: "red", total_cases: 1, case_weight_kg: null, total_kg: 7 }
      ])
    ).toEqual([
      { color: "RED", total_cases: 2, case_weight_kg: 5, total_kg: 10 },
      { color: "green", total_cases: 3, case_weight_kg: 4, total_kg: 0 },
      // Number(null) is 0, so a null weight is kept (as the Dashboard always has).
      { color: "red", total_cases: 1, case_weight_kg: 0, total_kg: 7 }
    ]);
  });
});

describe("buildColorYieldSummary", () => {
  it("sums active varieties' kg and positive area by colour, and shipped kg from cases", () => {
    const varieties = [v("a", "red", 1000), v("b", "red", "500"), v("c", "orange", 0), v("d", "yellow", 800, "inactive"), v("e", "Green ", -3)];
    const entries = [
      { variety_id: "a", year: 2026, week: 1, total_kg: 1000 },
      { variety_id: "b", year: 2026, week: 1, total_kg: 500 },
      { variety_id: "c", year: 2026, week: 1, total_kg: 200 },
      { variety_id: "d", year: 2026, week: 1, total_kg: 300 },
      { variety_id: "e", year: 2026, week: 1, total_kg: 50 }
    ];
    const cases = [{ color: "Red", total_cases: 1, case_weight_kg: 5, total_kg: 150 }];
    expect(buildColorYieldSummary(entries, varieties, cases)).toEqual([
      { color: "red", totalKg: 1500, totalAreaM2: 1500, harvestedKgPerM2: 1, exportedKg: 150, exportedKgPerM2: 0.1 },
      { color: "orange", totalKg: 200, totalAreaM2: 0, harvestedKgPerM2: null, exportedKg: 0, exportedKgPerM2: null },
      { color: "yellow", totalKg: 0, totalAreaM2: 0, harvestedKgPerM2: null, exportedKg: 0, exportedKgPerM2: null },
      { color: "green", totalKg: 50, totalAreaM2: 0, harvestedKgPerM2: null, exportedKg: 0, exportedKgPerM2: null }
    ]);
  });

  it("formats kg/m² to 2 dp", () => {
    expect([formatColorKgPerM2(2.1667), formatColorKgPerM2(0), formatColorKgPerM2(null)]).toEqual(["2.17 kg/m2", "0 kg/m2", "—"]);
  });
});

describe("buildYieldTrendPoints / buildYieldPieSlices", () => {
  it("groups kg by week and colour across all varieties, oldest first, rounded to 2 dp", () => {
    const varieties = [v("a", "red", 1), v("d", "yellow", 1, "inactive"), v("x", null, 1)];
    const entries = [
      { variety_id: "a", year: 2026, week: 2, total_kg: 1.005 },
      { variety_id: "a", year: 2025, week: 52, total_kg: 3 },
      { variety_id: "d", year: 2026, week: 2, total_kg: 4 },
      { variety_id: "x", year: 2026, week: 2, total_kg: 9 }
    ];
    expect(buildYieldTrendPoints(entries, varieties)).toEqual([
      { label: "W52 2025", sortKey: 202552, red: 3, orange: 0, yellow: 0, green: 0 },
      { label: "W2 2026", sortKey: 202602, red: 1, orange: 0, yellow: 4, green: 0 }
    ]);
  });

  it("gives each colour's kg and share to 1 dp, all zero when nothing is picked", () => {
    const summary = (kg: number[]) =>
      (["red", "orange", "yellow", "green"] as const).map((color, i) => ({ color, totalKg: kg[i], totalAreaM2: 0, harvestedKgPerM2: null, exportedKg: 0, exportedKgPerM2: null }));
    expect(buildYieldPieSlices(summary([2, 1, 0, 0]))).toEqual([
      { color: "red", kg: 2, percent: 66.7 },
      { color: "orange", kg: 1, percent: 33.3 },
      { color: "yellow", kg: 0, percent: 0 },
      { color: "green", kg: 0, percent: 0 }
    ]);
    expect(buildYieldPieSlices(summary([0, 0, 0, 0])).map((s) => s.percent)).toEqual([0, 0, 0, 0]);
  });
});
