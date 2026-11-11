import { describe, expect, it } from "vitest";
import {
  buildWeeklyKgTable,
  displayMatrix,
  parseWeeklyKgSource,
  weeklyByVarietyUrl,
  weeklyKgCsv,
  weeklyKgFileBase,
  weeklyKgSourceForCrop,
  weeklyTableTitle,
  weeklyUnitsForCrop,
  type WeeklyKgByVarietySource
} from "../weeklyKgByVariety";
import {
  buildPieceEntryPayload,
  findExistingWeekEntry,
  newEntryUnit,
  piecesPerM2For,
  weekEntriesUrl,
  type ManualKgEntryForm
} from "../manualKgEntry";

// Weekly by Variety with piece counts: one crop and one unit per table, so
// pieces are never added to kg, and kg output stays exactly as before.
const SOURCE: WeeklyKgByVarietySource = {
  year: 2026,
  years: [2026],
  entryCount: 3,
  varieties: [
    { id: "v-cad", name: "Cadalora", status: "active", productCode: "bell_pepper" },
    { id: "v-bon", name: "Bonbon", status: "active", productCode: "cucumber" },
    { id: "v-may", name: "Mayu", status: "active", productCode: "cucumber" }
  ],
  entries: [
    { variety_id: "v-cad", week: 30, total_kg: 1000 },
    { variety_id: "v-bon", week: 30, total_kg: 1200.25 },
    { variety_id: "v-bon", week: 31, total_kg: 800 }
  ],
  pieceEntryCount: 3,
  pieceEntries: [
    { variety_id: "v-bon", week: 31, total_pieces: 5000 },
    { variety_id: "v-may", week: 31, total_pieces: 1200 },
    { variety_id: "v-bon", week: 33, total_pieces: 0 }
  ]
};

describe("Weekly by Variety — pieces", () => {
  it("asks the server for piece counts and validates them", () => {
    expect(weeklyByVarietyUrl(null)).toBe("/api/yield-entries/weekly-by-variety?units=all");
    expect(weeklyByVarietyUrl(2025)).toBe("/api/yield-entries/weekly-by-variety?year=2025&units=all");
    expect(parseWeeklyKgSource(SOURCE)).toBe(SOURCE);
    expect(() => parseWeeklyKgSource({ ...SOURCE, pieceEntryCount: 2 })).toThrow("incomplete");
    expect(() => parseWeeklyKgSource({ ...SOURCE, pieceEntries: [{ variety_id: "v-bon", week: 31, total_pieces: 1.5 }], pieceEntryCount: 1 })).toThrow();
    // An older server without piece counts is still read.
    const { pieceEntries: _p, pieceEntryCount: _c, ...kgOnly } = SOURCE;
    expect(parseWeeklyKgSource(kgOnly)).toBe(kgOnly);
  });

  it("lists the units each crop has entries in", () => {
    expect(weeklyUnitsForCrop(SOURCE, "bell_pepper")).toEqual(["kg"]);
    expect(weeklyUnitsForCrop(SOURCE, "cucumber")).toEqual(["kg", "pcs"]);
  });

  it("a pieces table holds counts only, as whole numbers, with its own title, CSV and file name", () => {
    const table = buildWeeklyKgTable(weeklyKgSourceForCrop(SOURCE, "cucumber", "pcs"))!;
    expect(table.unit).toBe("pcs");
    expect(table.columns.map((c) => c.label)).toEqual(["Bonbon", "Mayu"]);
    expect(displayMatrix(table)).toEqual({
      body: [
        ["Week 31", "5,000", "1,200", "6,200"],
        ["Week 32", "—", "—", "—"],
        ["Week 33", "0", "—", "0"]
      ],
      foot: ["Season total", "5,000", "1,200", "6,200"]
    });
    expect(weeklyKgCsv(table)).toBe(
      "﻿Week,Bonbon,Mayu,Weekly total\r\n31,5000,1200,6200\r\n32,,,\r\n33,0,,0\r\nSeason total,5000,1200,6200\r\n"
    );
    expect(weeklyTableTitle(table.unit)).toBe("Weekly pieces by Variety");
    expect(weeklyKgFileBase(2026, "cucumbers", "pcs")).toBe("weekly-pieces-by-variety-cucumbers-2026");
  });

  it("the cucumber kg table has the kg harvests only, unchanged; Bell Peppers is untouched by either", () => {
    const kg = buildWeeklyKgTable(weeklyKgSourceForCrop(SOURCE, "cucumber"))!;
    expect(kg.unit).toBe("kg");
    expect(displayMatrix(kg).foot).toEqual(["Season total", "2,000.3", "2,000.3"]);
    const pepper = buildWeeklyKgTable(weeklyKgSourceForCrop(SOURCE, "bell_pepper"))!;
    expect(displayMatrix(pepper)).toEqual({ body: [["Week 30", "1,000.0", "1,000.0"]], foot: ["Season total", "1,000.0", "1,000.0"] });
    expect(weeklyKgFileBase(2026, "bell-peppers")).toBe("weekly-kg-by-variety-bell-peppers-2026");
    expect(weeklyKgFileBase(2026)).toBe("weekly-kg-by-variety-2026");
  });
});

describe("Manual Entry — piece counts", () => {
  const form = (over: Partial<ManualKgEntryForm> = {}): ManualKgEntryForm => ({
    variety_id: "v-bon", year: "2026", week: "33", packed_date: "2026-08-12", average_fruit_weight_g: "250",
    size_kg: { s1: "4" }, total_kg: "9", total_pieces: " 5000 ", ...over
  });

  it("sends the whole count and nothing that weighs", () => {
    expect(buildPieceEntryPayload(form())).toEqual({
      ok: true,
      payload: { variety_id: "v-bon", year: 2026, week: 33, packed_date: "2026-08-12", unit_code: "pcs", total_pieces: 5000 }
    });
  });

  it.each([
    ["no variety", { variety_id: "" }, "Variety is required."],
    ["no count", { total_pieces: "" }, "Total pieces is required."],
    ["a fraction", { total_pieces: "12.5" }, "Pieces must be a whole number of 0 or more."],
    ["a negative", { total_pieces: "-1" }, "Pieces must be a whole number of 0 or more."],
    ["text", { total_pieces: "lots" }, "Pieces must be a whole number of 0 or more."],
    ["an exponent", { total_pieces: "1e3" }, "Pieces must be a whole number of 0 or more."],
    ["no week", { week: "x" }, "Week is required."]
  ])("rejects %s", (_label, over, error) => {
    expect(buildPieceEntryPayload(form(over))).toEqual({ ok: false, error });
  });

  it("uses the crop's default unit for a new harvest, kg unless it is pieces", () => {
    expect(newEntryUnit({ code: "cucumber", name: "Cucumbers", tracksSizes: false, defaultUnitCode: "pcs" })).toBe("pcs");
    expect(newEntryUnit({ code: "cucumber", name: "Cucumbers", tracksSizes: false, defaultUnitCode: "kg" })).toBe("kg");
    expect(newEntryUnit({ code: "bell_pepper", name: "Bell Peppers", tracksSizes: true })).toBe("kg");
    expect(newEntryUnit(undefined)).toBe("kg");
  });

  it("finds an existing entry in the same unit only, and asks for piece counts when they matter", () => {
    const week = [
      { id: "kg", variety_id: "v-bon", unit_code: "kg" },
      { id: "pcs", variety_id: "v-bon", unit_code: "pcs" },
      { id: "old", variety_id: "v-cad" }
    ];
    expect(findExistingWeekEntry(week, "v-bon")?.id).toBe("kg");
    expect(findExistingWeekEntry(week, "v-bon", "pcs")?.id).toBe("pcs");
    expect(findExistingWeekEntry(week, "v-cad")?.id).toBe("old");
    expect(findExistingWeekEntry(week, "v-cad", "pcs")).toBeNull();
    expect(weekEntriesUrl(2026, 33)).toBe("/api/yield-entries?year=2026&week=33");
    expect(weekEntriesUrl(2026, 33, { withPieces: true })).toBe("/api/yield-entries?year=2026&week=33&units=all");
    expect(piecesPerM2For(5000, { area_m2: 400, case_kg: 12 })).toBe(12.5);
    expect(piecesPerM2For(5000, { area_m2: 0, case_kg: 12 })).toBeNull();
  });
});
