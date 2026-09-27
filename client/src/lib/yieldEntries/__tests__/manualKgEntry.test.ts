import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildManualKgEntryPayload,
  findExistingWeekEntry,
  kgPerM2For,
  manualKgEntrySaveTarget,
  sortYieldSizes,
  sumSizeKg,
  totalCasesFor,
  weekEntriesUrl,
  zeroSizeKgFields,
  type ManualKgEntryForm,
  type YieldSizeOption
} from "../manualKgEntry";
import { createWeekOptions, getCurrentWeek, localIsoDate } from "../weekOptions";

const SIZES: YieldSizeOption[] = [
  { id: "lg", name: "Large", sort_order: 2, status: "active" },
  { id: "sm", name: "Small", sort_order: 1, status: "active" }
];
const form = (over: Partial<ManualKgEntryForm> = {}): ManualKgEntryForm => ({
  variety_id: "v1", year: "2026", week: "33", packed_date: "2026-08-12", average_fruit_weight_g: "", size_kg: { sm: "1", lg: "2" }, ...over
});

describe("buildManualKgEntryPayload", () => {
  it("sends every size in the given order, blanks and junk as 0, and blank AFW / packed date as null", () => {
    const built = buildManualKgEntryPayload(form({ size_kg: { lg: "abc" }, packed_date: "" }), sortYieldSizes(SIZES));
    expect(built).toEqual({ ok: true, payload: { variety_id: "v1", year: 2026, week: 33, packed_date: null, size_kg: { sm: 0, lg: 0 }, average_fruit_weight_g: null } });
    expect(JSON.stringify(built.ok && built.payload)).toBe('{"variety_id":"v1","year":2026,"week":33,"packed_date":null,"size_kg":{"sm":0,"lg":0},"average_fruit_weight_g":null}');
    expect(buildManualKgEntryPayload(form({ average_fruit_weight_g: " 182.5 " }), SIZES)).toMatchObject({ ok: true, payload: { average_fruit_weight_g: 182.5 } });
  });

  it.each([
    ["no variety", { variety_id: "" }, "Variety is required."],
    ["a negative size", { size_kg: { sm: "-0.01" } }, "Kg values must be 0 or greater."],
    ["a non-integer year", { year: "2026.5" }, "Year is required."],
    ["a blank-looking year", { year: "x" }, "Year is required."],
    ["a fractional week", { week: "33.5" }, "Week is required."],
    ["a non-numeric week", { week: "w" }, "Week is required."],
    ["a negative AFW", { average_fruit_weight_g: "-1" }, "Average fruit weight must be 0 or greater."],
    ["a non-numeric AFW", { average_fruit_weight_g: "abc" }, "Average fruit weight must be 0 or greater."],
    // Checked in order: the variety first, then sizes, year, week, AFW.
    ["several problems", { variety_id: "", size_kg: { sm: "-1" }, average_fruit_weight_g: "-1" }, "Variety is required."]
  ])("rejects %s", (_label, over, error) => {
    expect(buildManualKgEntryPayload(form(over), SIZES)).toEqual({ ok: false, error });
  });

  it("like the desktop form, lets a blank week through as week 0 (Number(\"\") is 0); the server rejects it", () => {
    expect(buildManualKgEntryPayload(form({ week: "" }), SIZES)).toMatchObject({ ok: true, payload: { week: 0 } });
  });
});

describe("totals and helpers", () => {
  it("sums sizes and derives kg/m² and cases from the variety", () => {
    expect(sumSizeKg({ a: "12.5", b: "7.25", c: "", d: "x" })).toBe(19.75);
    expect(kgPerM2For(19.75, { area_m2: 1000, case_kg: 5 })).toBe(0.01975);
    expect(kgPerM2For(19.75, { area_m2: 0, case_kg: 5 })).toBeNull();
    expect(kgPerM2For(19.75, undefined)).toBeNull();
    expect(totalCasesFor(19.75, { area_m2: 1000, case_kg: 5 })).toBe(3.95);
    expect(totalCasesFor(19.75, { area_m2: 1000, case_kg: 0 })).toBe(0);
    expect(totalCasesFor(19.75, undefined)).toBe(0);
  });

  it("sorts sizes without mutating, zeroes fields, and builds the request targets", () => {
    const sorted = sortYieldSizes(SIZES);
    expect(sorted.map((s) => s.id)).toEqual(["sm", "lg"]);
    expect(SIZES.map((s) => s.id)).toEqual(["lg", "sm"]);
    expect(zeroSizeKgFields(sorted)).toEqual({ sm: "0", lg: "0" });
    expect(manualKgEntrySaveTarget(null)).toEqual({ method: "POST", url: "/api/yield-entries" });
    expect(manualKgEntrySaveTarget("e1")).toEqual({ method: "PUT", url: "/api/yield-entries/e1" });
    expect(weekEntriesUrl(2026, 33)).toBe("/api/yield-entries?year=2026&week=33");
    const week = [{ id: "a", variety_id: "v2" }, { id: "b", variety_id: "v1" }];
    expect(findExistingWeekEntry(week, "v1")).toEqual({ id: "b", variety_id: "v1" });
    expect(findExistingWeekEntry(week, "v9")).toBeNull();
  });
});

describe("week options", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  });
  afterEach(() => vi.useRealTimers());

  it("labels 53 Sunday-start weeks and finds today's week", () => {
    const weeks = createWeekOptions(2026);
    expect(weeks).toHaveLength(53);
    expect(weeks[32]).toEqual({ value: 33, label: "Week 33 - Aug 09 to Aug 15" });
    expect(getCurrentWeek(2026)).toBe(33);
    expect(getCurrentWeek(2030)).toBe(1);
    expect(getCurrentWeek(2020)).toBe(53);
    expect(localIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
