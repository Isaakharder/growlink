import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { summarizeMixes, type MixInput, type PlanInput, type RowInput } from "../pestMixSummary";

const CHEM = "chem-1";
const line = (amount: number) => [{ chemical_id: CHEM, name: "Kontos", amount, unit: "ml" }];
const plan = (water: number, chem: number, mixes: number): PlanInput => ({
  water_l: water,
  mixes,
  chemicals: [{ chemical_id: CHEM, name: "Kontos", amount: chem, unit: "ml" }]
});
const mix = (n: number, water: number, chem: number, leftover: number | null = 0, status: MixInput["status"] = "completed"): MixInput => ({
  mix_number: n, status, water_l: water, leftover_l: leftover, chemicals: line(chem)
});
const rows = (spec: number[][]): RowInput[] => spec.map((m) => ({ completed: true, mixNumbers: m }));

describe("pestMixSummary", () => {
  it("is the same code as the server copy (the record and the progress card agree)", () => {
    const body = (file: string) => {
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      return text.slice(text.indexOf("// Definitions"));
    };
    const client = body(path.resolve(__dirname, "../pestMixSummary.ts"));
    const server = body(path.resolve(__dirname, "../../../../server/src/utils/pestMixSummary.ts"));
    expect(client).toBe(server);
  });

  it("fewer mixes than planned: 12 of 16, under plan by amount and percentage", () => {
    const mixes = Array.from({ length: 12 }, (_, i) => mix(i + 1, 600, 264));
    const s = summarizeMixes(plan(9300, 4092, 16), mixes, rows(Array.from({ length: 24 }, (_, i) => [Math.floor(i / 2) + 1])));
    expect(s.mixes_made).toBe(12);
    expect(s.extra_mixes).toBe(0);
    expect(s.water.applied_vs_plan.diff).toBe(-2100);
    expect(s.water.applied_vs_plan.pct).toBeCloseTo(-22.58, 2);
    expect(s.chemicals[0].applied_vs_plan.diff).toBe(-924);
    expect(s.water.per_row).toBe(300);
  });

  it("more mixes than planned: 18 of 16 are counted, 2 extra, over plan", () => {
    const mixes = Array.from({ length: 18 }, (_, i) => mix(i + 1, 600, 264));
    const s = summarizeMixes(plan(9300, 4092, 16), mixes, []);
    expect(s.mixes_made).toBe(18);
    expect(s.extra_mixes).toBe(2);
    expect(s.water.mixed).toBe(10800);
    expect(s.water.applied_vs_plan.pct).toBeCloseTo(16.13, 2);
  });

  it("partial final tank and leftovers keep mixed and applied apart", () => {
    const s = summarizeMixes(plan(1500, 660, 3), [mix(1, 600, 264, 40), mix(2, 600, 264), mix(3, 250, 110, 25)], rows([[1], [1], [2], [3]]));
    expect(s.water.mixed).toBe(1450);
    expect(s.water.leftover).toBe(65);
    expect(s.water.applied).toBe(1385);
    expect(s.chemicals[0].mixed).toBe(638);
    expect(s.chemicals[0].applied).toBeCloseTo(264 * (560 / 600) + 264 + 110 * 0.9, 9);
    expect(s.chemicals[0].leftover).toBeCloseTo(638 - s.chemicals[0].applied, 9);
    expect(s.water.mixed_vs_plan.diff).toBe(-50);
  });

  it("a tank still in use counts as mixed; per-row averages use closed tanks only", () => {
    const s = summarizeMixes(plan(1200, 528, 2), [mix(1, 600, 264), mix(2, 600, 264, 0, "active")], rows([[1], [1], [2]]));
    expect(s.applied_pending).toBe(true);
    expect(s.applied_complete).toBe(false);
    expect(s.active_mix_number).toBe(2);
    expect(s.water.mixed).toBe(1200);
    // Not reported as an exact total while a tank is in use.
    expect(s.water.applied).toBeNull();
    expect(s.water.applied_known).toBe(600);
    expect(s.water.applied_max).toBe(1200);
    expect(s.water.applied_vs_plan.diff).toBeNull();
    expect(s.per_row_basis_rows).toBe(2);
    expect(s.water.per_row).toBe(300);
  });

  it("a row across two tanks counts once and half to each", () => {
    const s = summarizeMixes(plan(1200, 528, 2), [mix(1, 600, 264), mix(2, 600, 264)], rows([[1], [1, 2], [2]]));
    expect(s.completed_rows).toBe(3);
    expect(s.mixes.map((m) => m.rows)).toEqual([1.5, 1.5]);
    expect(s.water.per_row).toBe(400);
    expect(s.chemicals[0].per_row).toBe(176);
    expect(s.split_rows).toBe(1);
    expect(s.mixes.map((m) => m.split_rows)).toEqual([0.5, 0.5]);
    expect(s.per_row_estimated).toBe(true);
  });

  it("a leftover that wasn't recorded is unknown, never 0", () => {
    const s = summarizeMixes(plan(1200, 528, 2), [mix(1, 600, 264, null), mix(2, 600, 264, 50)], rows([[1], [2]]));
    expect(s.unknown_leftover_mixes).toEqual([1]);
    expect(s.applied_complete).toBe(false);
    expect(s.water.applied).toBeNull();
    expect(s.water.leftover).toBe(50);
    expect(s.water.applied_known).toBe(550);
    expect(s.water.applied_max).toBe(1150);
    expect(s.chemicals[0].applied).toBeNull();
    expect(s.chemicals[0].applied_vs_plan).toEqual({ planned: 528, actual: null, diff: null, pct: null });
    expect(s.chemicals[0].mixed_vs_plan.diff).toBe(0);
    // Per-row averages come from the tank whose applied amount is known.
    expect(s.per_row_basis_rows).toBe(1);
    expect(s.water.per_row).toBe(550);
  });

  it("carried-over planned estimates are flagged", () => {
    const s = summarizeMixes(plan(1200, 528, 2), [{ ...mix(1, 600, 264, null), estimated: true }, mix(2, 600, 264, 0)], rows([[1], [2]]));
    expect(s.estimated_mixes).toEqual([1]);
    expect(s.mixes[0].estimated).toBe(true);
  });

  it("rows without a linked tank are reported, not averaged", () => {
    const s = summarizeMixes(plan(600, 264, 1), [mix(1, 600, 264)], [{ completed: true, completedByMixNumber: 1 }, { completed: true }]);
    expect(s.completed_rows).toBe(2);
    expect(s.rows_without_mix).toBe(1);
    expect(s.water.per_row).toBe(600);
  });
});
