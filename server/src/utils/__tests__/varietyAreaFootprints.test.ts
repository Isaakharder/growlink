// Physical footprints behind the farm-wide kg/m2: which measured greenhouse
// rows each variety's yield came from. Offline, pure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVarietyFootprints, rowKey, type FootprintRowInput } from "../varietyAreaFootprints";

const P2 = "group-phase-2";
const P3 = "group-phase-3";
const row = (group: string, n: number, width = 2, length = 50): FootprintRowInput => ({
  group_id: group,
  row_number: n,
  width_meters: width,
  length_meters: length,
  section_id: null
});
const rowsOf = (group: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(group, from + i));

// A legacy record (yield, no rows) split into one successor per phase.
const LEGACY = "variety-legacy";
const SUCCESSOR_P2 = "variety-successor-p2";
const SUCCESSOR_P3 = "variety-successor-p3";
const NEIGHBOUR_P2 = "variety-neighbour-p2";

function base() {
  return {
    groups: [
      { id: P2, name: "Phase 2" },
      { id: P3, name: "Phase 3" }
    ],
    rows: [...rowsOf(P2, 1, 10), ...rowsOf(P3, 101, 104)],
    sections: [],
    assignments: [
      { group_id: P2, variety_id: NEIGHBOUR_P2, start_row: 1, end_row: 6, assignment_pattern: "all" },
      { group_id: P2, variety_id: SUCCESSOR_P2, start_row: 7, end_row: 10, assignment_pattern: "all" },
      { group_id: P3, variety_id: SUCCESSOR_P3, start_row: 101, end_row: 104, assignment_pattern: "all" }
    ],
    links: [] as Array<{ variety_id: string; successor_variety_id: string | null; greenhouse_group_id: string | null }>
  };
}

test("a variety's footprint is its assigned rows; every_other steps by two like Greenhouse Setup", () => {
  const input = base();
  input.assignments.push({ group_id: P2, variety_id: "variety-trial", start_row: 1, end_row: 5, assignment_pattern: "every_other" });
  const result = resolveVarietyFootprints(input);
  assert.deepEqual(result.footprints["variety-trial"], [rowKey(P2, 1), rowKey(P2, 3), rowKey(P2, 5)]);
  assert.equal(result.footprints[SUCCESSOR_P2].length, 4);
});

test("row area is width x length, falling back to the row's section, else unknown", () => {
  const result = resolveVarietyFootprints({
    groups: [{ id: P2, name: "Phase 2" }],
    rows: [
      row(P2, 1, 1.6, 91.44),
      { group_id: P2, row_number: 2, width_meters: null, length_meters: null, section_id: "section-a" },
      { group_id: P2, row_number: 3, width_meters: null, length_meters: null, section_id: null }
    ],
    sections: [{ id: "section-a", width_meters: 1.6, length_meters: 100.58 }],
    assignments: [],
    links: []
  });
  assert.deepEqual(
    result.rows.map((r) => (r.areaM2 === null ? null : Math.round(r.areaM2 * 1000) / 1000)),
    [146.304, 160.928, null]
  );
});

test("a legacy variety with no rows has no footprint until it is linked", () => {
  assert.equal(resolveVarietyFootprints(base()).footprints[LEGACY], undefined);
});

test("a continuation link gives the legacy variety exactly its successors' rows in both phases", () => {
  const input = base();
  input.links.push(
    { variety_id: LEGACY, successor_variety_id: SUCCESSOR_P2, greenhouse_group_id: null },
    { variety_id: LEGACY, successor_variety_id: SUCCESSOR_P3, greenhouse_group_id: null }
  );
  const { footprints } = resolveVarietyFootprints(input);
  assert.deepEqual(footprints[LEGACY], [...footprints[SUCCESSOR_P2], ...footprints[SUCCESSOR_P3]].sort());
  // Not the neighbour's rows in the same phase.
  for (const key of footprints[NEIGHBOUR_P2]) assert.ok(!footprints[LEGACY].includes(key));
});

test("a group link covers every row of that greenhouse group (a shared reporting area)", () => {
  const input = base();
  input.links.push({ variety_id: "variety-trial", successor_variety_id: null, greenhouse_group_id: P2 });
  assert.equal(resolveVarietyFootprints(input).footprints["variety-trial"].length, 10);
});

test("continuation chains are followed and a cycle cannot loop", () => {
  const input = base();
  input.links.push(
    { variety_id: "variety-oldest", successor_variety_id: LEGACY, greenhouse_group_id: null },
    { variety_id: LEGACY, successor_variety_id: SUCCESSOR_P3, greenhouse_group_id: null },
    { variety_id: SUCCESSOR_P3, successor_variety_id: "variety-oldest", greenhouse_group_id: null }
  );
  const { footprints } = resolveVarietyFootprints(input);
  assert.deepEqual(footprints["variety-oldest"], footprints[SUCCESSOR_P3]);
  assert.deepEqual(footprints[LEGACY], footprints[SUCCESSOR_P3]);
});

test("assignments pointing at rows that don't exist add no footprint", () => {
  const input = base();
  input.assignments.push({ group_id: P3, variety_id: "variety-ghost", start_row: 900, end_row: 905, assignment_pattern: "all" });
  assert.equal(resolveVarietyFootprints(input).footprints["variety-ghost"], undefined);
});

test("no logic depends on variety names", () => {
  const source = readFileSync(join(__dirname, "..", "varietyAreaFootprints.ts"), "utf-8");
  assert.doesNotMatch(source, /levente|cadalora|silverstone|mathieu|lavreysen/i);
  // The resolver never even receives variety names.
  const result = resolveVarietyFootprints(base());
  assert.ok(!JSON.stringify(result).includes("name\":\"Levente"));
});
