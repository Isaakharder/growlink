import { describe, expect, it } from "vitest";
import { assignmentRows, buildPlantingBoard, compressRows, statusOn, type PlantingsData } from "../plantingCards";

const P1 = "g1";
const P2 = "g2";
const row = (group_id: string, row_number: number, over: Partial<PlantingsData["rows"][number]> = {}) => ({
  group_id,
  row_number,
  slab_count: 106,
  plants_per_slab: 3,
  stems_per_plant: 2,
  area_m2: 100,
  ...over
});
const variety = (id: string, name: string, planting_date: string | null, pull_out_date: string | null = null) => ({
  id,
  name,
  color: "red",
  status: "active",
  product_code: "bell_pepper",
  planting_date,
  pull_out_date
});
const assign = (variety_id: string, group_id: string, start_row: number, end_row: number, assignment_pattern: "all" | "every_other" = "all") => ({
  id: `${variety_id}-${group_id}-${start_row}`,
  group_id,
  variety_id,
  start_row,
  end_row,
  assignment_pattern
});

function data(over: Partial<PlantingsData> = {}): PlantingsData {
  return {
    today: "2026-11-13",
    timeZone: "America/Toronto",
    groups: [
      { id: P1, type: "phase", name: "Phase 1", status: "active" },
      { id: P2, type: "phase", name: "Phase 2", status: "active" }
    ],
    rows: [...Array.from({ length: 10 }, (_, i) => row(P1, i + 1)), ...Array.from({ length: 6 }, (_, i) => row(P2, i + 1, { slab_count: 90, plants_per_slab: 4, stems_per_plant: 1 }))],
    assignments: [],
    varieties: [],
    products: [{ code: "bell_pepper", name: "Bell Peppers", status: "active" }],
    ...over
  };
}

describe("statusOn: the organization's local date decides", () => {
  it("is Active from the planting date through the pull-out date, Past the day after, Upcoming before", () => {
    expect(statusOn("2026-11-13", "2026-11-13", null)).toBe("active");
    expect(statusOn("2026-11-13", "2026-11-14", null)).toBe("upcoming");
    expect(statusOn("2026-11-13", "2025-12-15", "2026-11-13")).toBe("active");
    expect(statusOn("2026-11-14", "2025-12-15", "2026-11-13")).toBe("past");
    expect(statusOn("2026-11-13", null, null)).toBe("active");
  });
});

describe("rows", () => {
  it("expands every-other assignments from the start row, and compresses row lists", () => {
    expect(assignmentRows({ start_row: 3, end_row: 9, assignment_pattern: "every_other" })).toEqual([3, 5, 7, 9]);
    expect(compressRows([5, 1, 2, 3, 7, 3])).toBe("1–3, 5, 7");
  });
});

describe("buildPlantingBoard", () => {
  it("sorts cards into Active, Upcoming and Past and totals rows, m², plants and heads", () => {
    const board = buildPlantingBoard(
      data({
        varieties: [variety("cad", "Cadalora", "2025-12-15", "2026-11-20"), variety("sun", "Sunny", "2026-12-10"), variety("old", "Old", "2024-12-01", "2025-11-01")],
        assignments: [assign("cad", P1, 1, 4), assign("sun", P1, 1, 4), assign("old", P1, 5, 6)]
      })
    );
    expect(board.active.map((c) => c.varietyName)).toEqual(["Cadalora"]);
    expect(board.upcoming.map((c) => c.varietyName)).toEqual(["Sunny"]);
    expect(board.past.map((c) => c.varietyName)).toEqual(["Old"]);
    const cad = board.active[0];
    expect(cad.cropName).toBe("Bell Peppers");
    expect(cad.rowCount).toBe(4);
    expect(cad.m2).toEqual({ value: 400, missingRows: 0 });
    expect(cad.plants).toEqual({ value: 4 * 318, missingRows: 0 });
    expect(cad.heads).toEqual({ value: 4 * 636, missingRows: 0 });
    // Next year's crop on the same rows is Upcoming, not a clash with today's.
    expect(cad.issues).toEqual([]);
  });

  it("splits a planting across phases, with counts per phase", () => {
    const [card] = buildPlantingBoard(
      data({ varieties: [variety("cad", "Cadalora", "2025-12-15")], assignments: [assign("cad", P2, 1, 2), assign("cad", P1, 1, 9, "every_other")] })
    ).active;
    expect(card.phases.map((p) => [p.groupName, p.rowsLabel, p.m2.value, p.plants.value, p.heads.value])).toEqual([
      ["Phase 1", "1, 3, 5, 7, 9", 500, 5 * 318, 5 * 636],
      ["Phase 2", "1–2", 200, 2 * 360, 2 * 360]
    ]);
    expect(card.rowCount).toBe(7);
    expect(card.plants.value).toBe(5 * 318 + 2 * 360);
  });

  it("flags missing inputs instead of counting them as zero", () => {
    const rows = data().rows.map((r) =>
      r.group_id === P1 && r.row_number === 2 ? { ...r, area_m2: null } : r.group_id === P1 && r.row_number === 3 ? { ...r, slab_count: 0 } : r
    );
    const [card] = buildPlantingBoard(
      data({ rows, varieties: [variety("cad", "Cadalora", null)], assignments: [assign("cad", P1, 1, 3), assign("cad", P1, 11, 12)] })
    ).active;
    // rows 1-3 exist; 11-12 aren't in Greenhouse Setup
    expect(card.m2).toEqual({ value: 200, missingRows: 3 });
    expect(card.plants).toEqual({ value: 2 * 318, missingRows: 3 });
    expect(card.heads).toEqual({ value: 2 * 636, missingRows: 3 });
    expect(card.issues).toEqual([
      "No planting date. Add one in Crop Planner → Varieties.",
      "Phase 1: 2 rows not in Greenhouse Setup (11–12).",
      "1 row without a width or length: m² is incomplete.",
      "1 row without slabs or plants per slab: plants and heads are incomplete."
    ]);
  });

  it("flags a row assigned to two varieties that are both in the ground today, and counts a repeated row once", () => {
    const board = buildPlantingBoard(
      data({
        varieties: [variety("cad", "Cadalora", "2025-12-15"), variety("sun", "Sunny", "2025-12-20")],
        assignments: [assign("cad", P1, 1, 5), assign("cad", P1, 4, 6), assign("sun", P1, 5, 8)]
      })
    );
    const cad = board.active.find((c) => c.varietyName === "Cadalora")!;
    expect(cad.rowCount).toBe(6);
    expect(cad.issues).toEqual(["Phase 1 rows 5–6 are also assigned to Sunny today."]);
  });
});

describe("partial pull-out on cards", () => {
  it("lists rows pulled out early, and a row ended before today doesn't clash with today's planting", async () => {
    const { buildBoard } = await import("../plantingCards");
    const base = data({ varieties: [variety("cad", "Cadalora", null), variety("sun", "Sunny", null)] });
    const board = buildBoard(base, [
      {
        id: "a",
        variety_id: "cad",
        planting_date: "2025-12-15",
        pull_out_date: null,
        rows: [
          { group_id: P1, row_number: 1, pull_out_date: "2026-10-01" },
          { group_id: P1, row_number: 2, pull_out_date: "2026-10-01" },
          { group_id: P2, row_number: 1, pull_out_date: "2026-11-01" },
          { group_id: P1, row_number: 3, pull_out_date: null }
        ]
      },
      // Sunny went onto row 1 after Cadalora's row 1 was pulled out.
      { id: "b", variety_id: "sun", planting_date: "2026-10-15", pull_out_date: null, rows: [{ group_id: P1, row_number: 1 }] }
    ]);
    const cad = board.active.find((c) => c.varietyName === "Cadalora")!;
    expect(cad.endedEarly).toEqual([
      { date: "2026-10-01", rows: "Phase 1 rows 1–2" },
      { date: "2026-11-01", rows: "Phase 2 row 1" }
    ]);
    expect(cad.rowCount).toBe(4);
    expect([...cad.issues, ...board.active.find((c) => c.varietyName === "Sunny")!.issues].some((i) => i.includes("also assigned"))).toBe(false);
  });
});
