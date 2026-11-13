import { describe, expect, it } from "vitest";
import {
  formatRowRanges,
  layoutIndex,
  orderCsv,
  rowLayout,
  rowsInRange,
  seedOrder,
  seedsWithOversow,
  selectionSummary,
  slabOrder,
  unassignedRows,
  type PlanGreenhouseRow,
  type RowLayoutInput
} from "../planCalc";

const P1 = "phase-1";
const P2 = "phase-2";
const GROUPS = [
  { id: P1, type: "phase", name: "Phase 1" },
  { id: P2, type: "phase", name: "Phase 2" }
];
// Phase 1: 106 slabs x 3 plants (2 stems per plant). Phase 2: rows 1-8 90 x 4; rows 9-10 have no layout in Setup.
const ROWS: PlanGreenhouseRow[] = [
  ...Array.from({ length: 30 }, (_, i) => ({ group_id: P1, row_number: i + 1, slab_count: 106, plants_per_slab: 3, stems_per_plant: 2 })),
  ...Array.from({ length: 10 }, (_, i) => ({ group_id: P2, row_number: i + 1, slab_count: i < 8 ? 90 : 0, plants_per_slab: i < 8 ? 4 : 0 }))
];
const range = (group: string, from: number, to: number) => rowsInRange(ROWS, group, from, to);

describe("row layout", () => {
  it("uses the row's Setup layout, and stems per plant never counts as plants", () => {
    expect(rowLayout(ROWS[0], undefined)).toMatchObject({ slabsPerRow: 106, plantsPerSlab: 3, plants: 318, slabsSource: "setup", missing: [] });
  });

  it("takes plan inputs over Setup: 53 slabs per trough x 2 troughs x 3 plants = 318", () => {
    const input: RowLayoutInput = { group_id: P2, row_number: 9, slabs_per_trough: 53, troughs_per_row: 2, plants_per_slab: 3 };
    expect(rowLayout(ROWS[38], input)).toMatchObject({ slabsPerRow: 106, plantsPerSlab: 3, plants: 318, slabsSource: "plan", plantsSource: "plan", formula: "53 × 2 × 3", missing: [] });
  });

  it("flags missing inputs instead of guessing", () => {
    expect(rowLayout(ROWS[38], undefined)).toMatchObject({ plants: null, missing: ["slabs per row", "plants per slab"] });
    // Only plants per slab given: slabs per row still missing.
    expect(rowLayout(ROWS[38], { group_id: P2, row_number: 9, slabs_per_trough: null, troughs_per_row: null, plants_per_slab: 3 }))
      .toMatchObject({ plantsPerSlab: 3, plants: null, missing: ["slabs per row"] });
    expect(rowLayout(undefined, undefined).missing).toEqual(["row not in Greenhouse Setup", "slabs per row", "plants per slab"]);
  });
});

describe("seed order", () => {
  it("adds the oversow to the variety's total and rounds up once", () => {
    expect(seedsWithOversow(1000, 30)).toBe(1300);
    expect(seedsWithOversow(1001, 12.5)).toBe(1127); // 1,126.125 -> 1,127
    expect(seedsWithOversow(318, 0)).toBe(318);
    expect(seedsWithOversow(3, 33.33)).toBe(4); // 3.9999 -> 4
  });

  it("combines a variety across two phases into one order, with the phase breakdown", () => {
    const layoutOf = layoutIndex(ROWS, []);
    const plantings = [
      ...range(P1, 1, 20).map((r) => ({ ...r, variety_id: "cad" })),
      ...range(P2, 1, 8).map((r) => ({ ...r, variety_id: "cad" })),
      ...range(P1, 21, 30).map((r) => ({ ...r, variety_id: "sun" }))
    ];
    const [cad, sun] = seedOrder({
      plantings,
      groups: GROUPS,
      varieties: [{ id: "cad", name: "Cadalora" }, { id: "sun", name: "Sunny" }],
      oversow: [{ variety_id: "cad", oversow_pct: 30 }],
      layoutOf
    });
    // Phase 1: 20 x 318 = 6,360; Phase 2: 8 x 360 = 2,880; together 9,240; + 30% = 12,012.
    expect(cad.phases.map((p) => [p.group_name, p.rows, p.quantity])).toEqual([["Phase 1", 20, 6360], ["Phase 2", 8, 2880]]);
    expect([cad.targetPlants, cad.baseSeeds, cad.extraSeeds, cad.totalSeeds, cad.incomplete]).toEqual([9240, 9240, 2772, 12012, false]);
    expect([sun.targetPlants, sun.oversowPct, sun.totalSeeds]).toEqual([3180, 0, 3180]);
  });

  it("marks the order incomplete while a row is missing inputs, and completes once they're entered", () => {
    const plantings = range(P2, 7, 10).map((r) => ({ ...r, variety_id: "cad" }));
    const params = { plantings, groups: GROUPS, varieties: [{ id: "cad", name: "Cadalora" }], oversow: [] };
    const [before] = seedOrder({ ...params, layoutOf: layoutIndex(ROWS, []) });
    expect([before.targetPlants, before.incomplete, before.missingRows.map((r) => r.row_number)]).toEqual([720, true, [9, 10]]);
    const inputs = range(P2, 9, 10).map((r) => ({ ...r, slabs_per_trough: 53, troughs_per_row: 2, plants_per_slab: 3 }));
    const [after] = seedOrder({ ...params, layoutOf: layoutIndex(ROWS, inputs) });
    expect([after.targetPlants, after.incomplete]).toEqual([720 + 636, false]);
  });
});

describe("slab order", () => {
  it("totals mixed slab types in one phase from row layouts, not from the oversow", () => {
    const slabs = [
      ...range(P1, 1, 20).map((r) => ({ ...r, slab_type_id: "a" })),
      ...range(P1, 21, 30).map((r) => ({ ...r, slab_type_id: "b" })),
      ...range(P2, 1, 10).map((r) => ({ ...r, slab_type_id: "b" }))
    ];
    const [a, b] = slabOrder({ slabs, groups: GROUPS, slabTypes: [{ id: "a", name: "Expert" }, { id: "b", name: "Vital" }], layoutOf: layoutIndex(ROWS, []) });
    expect([a.slabs, a.incomplete]).toEqual([2120, false]);
    expect(b.phases.map((p) => [p.group_name, p.rows, p.quantity, p.missingRows.length])).toEqual([["Phase 1", 10, 1060, 0], ["Phase 2", 10, 720, 2]]);
    expect([b.slabs, b.incomplete]).toEqual([1780, true]);
  });
});

describe("selection and unassigned rows", () => {
  it("previews a selection's row, plant and slab counts with its missing rows", () => {
    const summary = selectionSummary([...range(P1, 1, 2), ...range(P2, 8, 9)], layoutIndex(ROWS, []));
    expect([summary.rows, summary.plants, summary.slabs, summary.missingPlants.map((r) => r.row_number)]).toEqual([4, 318 * 2 + 360, 106 * 2 + 90, [9]]);
  });

  it("lists rows with no assignment, and formats row ranges", () => {
    const left = unassignedRows(ROWS, [...range(P1, 1, 30), ...range(P2, 1, 5)]);
    expect(formatRowRanges(left.map((r) => r.row_number))).toBe("6–10");
    expect(formatRowRanges([1, 2, 3, 7, 9, 10])).toBe("1–3, 7, 9–10");
    expect(rowsInRange(ROWS, P1, 5, 3).map((r) => r.row_number)).toEqual([3, 4, 5]);
  });
});

describe("order CSV", () => {
  it("has the season, separate seed and slab lists, phase lines and final quantities", () => {
    const layoutOf = layoutIndex(ROWS, []);
    const seeds = seedOrder({
      plantings: [...range(P1, 1, 2), ...range(P2, 1, 1)].map((r) => ({ ...r, variety_id: "cad" })),
      groups: GROUPS, varieties: [{ id: "cad", name: "Cadalora, red" }], oversow: [{ variety_id: "cad", oversow_pct: 30 }], layoutOf
    });
    const slabs = slabOrder({ slabs: range(P2, 9, 10).map((r) => ({ ...r, slab_type_id: "a" })), groups: GROUPS, slabTypes: [{ id: "a", name: "Expert" }], layoutOf });
    expect(orderCsv({ season: "2027", planName: "Main", seeds, slabs }).trim().split("\n")).toEqual([
      "Season,2027",
      "Plan,Main",
      "",
      "Seed order",
      "Variety,Phase,Rows,Target plants,Oversow %,Base seeds,Extra seeds,Total seeds to order,Status",
      '"Cadalora, red",Phase 1,2,636,,,,,',
      '"Cadalora, red",Phase 2,1,360,,,,,',
      '"Cadalora, red",All phases,3,996,30,996,299,1295,Complete',
      "",
      "Slab order",
      "Slab type,Phase,Rows,Slabs to order,Status",
      "Expert,Phase 2,2,0,Missing inputs: rows 9–10",
      "Expert,All phases,2,0,Incomplete"
    ]);
  });
});
