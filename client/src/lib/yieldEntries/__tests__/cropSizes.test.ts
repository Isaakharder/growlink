import { describe, expect, it } from "vitest";
import {
  buildManualKgEntryPayload,
  buildPieceEntryPayload,
  entrySizeFields,
  formTotalKg,
  formTotalPieces,
  newHarvestBySize,
  sizeFieldValues,
  sizesForCrop,
  unsizedAmount,
  type ManualKgEntryForm,
  type YieldSizeOption
} from "../manualKgEntry";

const SIZES: YieldSizeOption[] = [
  { id: "p-xl", name: "XL", sort_order: 2, status: "active", product_code: "bell_pepper" },
  { id: "p-lg", name: "Large", sort_order: 1, status: "active", product_code: "bell_pepper" },
  { id: "p-md", name: "MD", sort_order: 3, status: "inactive", product_code: "bell_pepper" },
  { id: "c-lg", name: "Large", sort_order: 1, status: "active", product_code: "cucumber" },
  { id: "c-cr", name: "Crooked", sort_order: 2, status: "inactive", product_code: "cucumber" }
];
const PEPPERS = { code: "bell_pepper", name: "Bell Peppers", tracksSizes: true };
const CUCUMBERS = { code: "cucumber", name: "Cucumbers", tracksSizes: false };

const form = (over: Partial<ManualKgEntryForm> = {}): ManualKgEntryForm => ({
  variety_id: "v1", year: "2026", week: "33", packed_date: "2026-08-12", average_fruit_weight_g: "", size_kg: {}, ...over
});

describe("sizes per crop", () => {
  it("lists a crop's own active sizes in sort order; a size or variety without a crop is Bell Peppers", () => {
    expect(sizesForCrop(SIZES, "bell_pepper").map((s) => s.id)).toEqual(["p-lg", "p-xl"]);
    expect(sizesForCrop(SIZES, "cucumber").map((s) => s.id)).toEqual(["c-lg"]);
    expect(sizesForCrop(SIZES, "cucumber", { activeOnly: false }).map((s) => s.id)).toEqual(["c-lg", "c-cr"]);
    expect(sizesForCrop([{ id: "old", name: "Old", sort_order: 1, status: "active" }], undefined).map((s) => s.id)).toEqual(["old"]);
  });

  it("enters a new harvest per size for Bell Peppers always, and for another crop once it has sizes", () => {
    expect(newHarvestBySize(PEPPERS, [])).toBe(true);
    expect(newHarvestBySize(CUCUMBERS, [])).toBe(false);
    expect(newHarvestBySize(CUCUMBERS, sizesForCrop(SIZES, "cucumber"))).toBe(true);
  });

  it("an edit keeps the retired or removed sizes the harvest carries, after the active ones", () => {
    const fields = entrySizeFields(SIZES, "bell_pepper", { "p-lg": 60, "p-md": 5, "gone": 2, "p-xl": 0 });
    expect(fields).toEqual([
      { id: "p-lg", name: "Large", retired: false },
      { id: "p-xl", name: "XL", retired: false },
      { id: "p-md", name: "MD", retired: true },
      { id: "gone", name: "Removed size", retired: true }
    ]);
    expect(sizeFieldValues(fields, { "p-lg": 60, "p-md": 5, "gone": 2 })).toEqual({ "p-lg": "60", "p-xl": "0", "p-md": "5", "gone": "2" });
    // Another crop's sizes never appear, even with the same name.
    expect(entrySizeFields(SIZES, "cucumber").map((f) => f.id)).toEqual(["c-lg"]);
  });

  it("the unsized amount is what a sized harvest's total holds beyond its sizes; none for a total-only harvest", () => {
    expect(unsizedAmount(650, { a: 100, b: 50 })).toBe(500);
    expect(unsizedAmount(150, { a: 100, b: 50 })).toBe(0);
    expect(unsizedAmount(640, {})).toBe(0);
  });

  it("a sized cucumber kg harvest totals its sizes plus unsized kg and sends both", () => {
    const sized = form({ by_size: true, size_kg: { "c-lg": "120", "c-st": "50" }, unsized: "500" });
    expect(formTotalKg(sized, CUCUMBERS)).toBe(670);
    const built = buildManualKgEntryPayload(sized, [{ id: "c-lg" }, { id: "c-st" }], CUCUMBERS);
    expect(built).toEqual({
      ok: true,
      payload: { variety_id: "v1", year: 2026, week: 33, packed_date: "2026-08-12", size_kg: { "c-lg": 120, "c-st": 50 }, unsized_kg: 500, average_fruit_weight_g: null }
    });
    // A total-only cucumber harvest still sends its total.
    expect(buildManualKgEntryPayload(form({ by_size: false, total_kg: "640" }), [], CUCUMBERS)).toMatchObject({ ok: true, payload: { size_kg: {}, total_kg: 640 } });
  });

  it("Bell Peppers never send unsized kg: the total is their sizes", () => {
    const built = buildManualKgEntryPayload(form({ size_kg: { "p-lg": "10" }, unsized: "3" }), [{ id: "p-lg" }], PEPPERS);
    expect(built.ok && built.payload).toEqual({ variety_id: "v1", year: 2026, week: 33, packed_date: "2026-08-12", size_kg: { "p-lg": 10 }, average_fruit_weight_g: null });
  });

  it("pieces per size are whole counts, totalled with any unsized pieces", () => {
    const sized = form({ by_size: true, size_pieces: { "c-lg": "300", "c-st": "" }, unsized: "800" });
    expect(formTotalPieces(sized)).toBe(1100);
    expect(buildPieceEntryPayload(sized, [{ id: "c-lg" }, { id: "c-st" }])).toEqual({
      ok: true,
      payload: { variety_id: "v1", year: 2026, week: 33, packed_date: "2026-08-12", unit_code: "pcs", size_pieces: { "c-lg": 300, "c-st": 0 }, unsized_pieces: 800 }
    });
    expect(formTotalPieces(form({ by_size: true, size_pieces: { "c-lg": "2.5" } }))).toBeNull();
    expect(buildPieceEntryPayload(form({ by_size: true, size_pieces: { "c-lg": "2.5" } }), [{ id: "c-lg" }])).toEqual({
      ok: false, error: "Pieces must be whole numbers of 0 or more."
    });
  });
});
