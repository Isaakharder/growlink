// Pure contract logic for the CropLink v2 integration — no database.
// Run: npm run test:croplink-v2
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeCursor, decodeCursor, parseListParams, pageOf, buildKeysetFilter, computeSettlement, isoWeekEndUtc,
  toYieldWeekItem, manifestChecksum, physicalAreasByVariety, YieldWeekRow, V2_MAX_LIMIT
} from "../croplinkV2";
import { resolveVarietyFootprints } from "../../utils/varietyAreaFootprints";

const TZ = "America/Toronto";
const ID = "0b0b66b0-1111-4222-8333-444455556666";

test("cursor round-trips with the raw microsecond timestamp intact", () => {
  const c = { at: "2026-09-22T21:30:21.123456+00:00", id: ID };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
});

test("tampered or malformed cursors are rejected", () => {
  assert.equal(decodeCursor("not-base64-json"), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ at: "yesterday", id: ID })).toString("base64url")), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ at: "2026-09-22T21:30:21Z", id: "1 or 1=1" })).toString("base64url")), null);
});

test("keyset filter quotes the timestamp and breaks ties on id", () => {
  assert.equal(
    buildKeysetFilter("updated_at", { at: "2026-09-22T21:30:21.123456+00:00", id: ID }),
    `updated_at.gt."2026-09-22T21:30:21.123456+00:00",and(updated_at.eq."2026-09-22T21:30:21.123456+00:00",id.gt.${ID})`
  );
  assert.throws(() => buildKeysetFilter("updated_at", { at: "x\",id.gt.0", id: ID }));
});

test("list params: limits, timestamps and year are validated", () => {
  assert.equal(parseListParams({}, "updatedAfter").ok, true);
  assert.equal(parseListParams({ limit: String(V2_MAX_LIMIT + 1) }, "updatedAfter").ok, false);
  assert.equal(parseListParams({ limit: "0" }, "updatedAfter").ok, false);
  assert.equal(parseListParams({ updatedAfter: "soon" }, "updatedAfter").ok, false);
  assert.equal(parseListParams({ year: "26" }, "updatedAfter").ok, false);
  assert.equal(parseListParams({ cursor: "garbage" }, "updatedAfter").ok, false);
  const ok = parseListParams({ limit: "10", updatedAfter: "2026-10-01T00:00:00Z", year: "2026" }, "updatedAfter");
  assert.deepEqual(ok, { ok: true, value: { limit: 10, cursor: null, after: "2026-10-01T00:00:00.000Z", year: 2026 } });
});

test("pageOf: limit+1 rows means more pages; exactly limit rows means last page", () => {
  const rows = [1, 2, 3].map(i => ({ at: `2026-01-01T00:00:0${i}Z`, id: ID }));
  const more = pageOf(rows, 2, r => r);
  assert.equal(more.items.length, 2);
  assert.equal(more.hasMore, true);
  assert.deepEqual(decodeCursor(more.nextCursor!), rows[1]);
  const last = pageOf(rows.slice(0, 2), 2, r => r);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(decodeCursor(last.resumeCursor!), rows[1]);
  assert.equal(pageOf([], 2, r => r, rows[0]).resumeCursor, encodeCursor(rows[0]));
});

test("week end is local midnight in Toronto, DST-aware", () => {
  // W40 2026 ends Mon 2026-10-05 00:00 EDT (UTC-4); W48 ends Mon 2026-11-30 00:00 EST (UTC-5).
  assert.equal(new Date(isoWeekEndUtc(2026, 40, TZ)).toISOString(), "2026-10-05T04:00:00.000Z");
  assert.equal(new Date(isoWeekEndUtc(2026, 48, TZ)).toISOString(), "2026-11-30T05:00:00.000Z");
  assert.equal(new Date(isoWeekEndUtc(2026, 53, TZ)).toISOString(), "2027-01-04T05:00:00.000Z");
});

test("settlement: provisional until 10 days after week end AND 3 quiet days", () => {
  const updated = "2026-09-22T21:30:21Z"; // W38 entry, last changed Tue after the week
  assert.equal(computeSettlement(2026, 38, updated, new Date("2026-09-30T03:59:00Z"), TZ).status, "provisional");
  const s = computeSettlement(2026, 38, updated, new Date("2026-10-04T12:00:00Z"), TZ);
  assert.equal(s.status, "settled");
  assert.equal(s.settledAt, "2026-10-01T04:00:00.000Z");
});

test("settlement reverts to provisional when the source data changes again", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  assert.equal(computeSettlement(2026, 36, "2026-09-08T16:58:10Z", now, TZ).status, "settled");
  const late = computeSettlement(2026, 36, "2026-10-03T09:00:00Z", now, TZ);
  assert.equal(late.status, "provisional");
  assert.match(late.reason, /changed within/);
  assert.equal(computeSettlement(2026, 36, "2026-10-03T09:00:00Z", new Date("2026-10-06T09:00:01Z"), TZ).status, "settled");
});

function row(overrides: Partial<YieldWeekRow> = {}): YieldWeekRow {
  return {
    id: ID, variety_id: "f25660ec-0000-4000-8000-000000000001", year: 2026, week: 38, packed_date: "2026-09-18",
    size_kg: { "size-xl": 812, "size-l": 1965 }, total_kg: "2777", average_fruit_weight_g: "210.5", kg_per_m2: "0.2388", total_cases: "544",
    last_write_source: "import_pdf", created_at: "2026-09-18T20:11:02Z", updated_at: "2026-09-22T21:30:21.123456+00:00",
    varieties: { name: "Mathieu", area_m2: "11627", updated_at: "2026-05-25T19:40:39Z" },
    yield_entry_daily_breakdown: [
      { id: "b2", packed_date: "2026-09-18", size_kg: {}, total_kg: "1477", average_fruit_weight_g: "209.2", created_at: "x", updated_at: "2026-09-18T20:11:02Z" },
      { id: "b1", packed_date: "2026-09-16", size_kg: {}, total_kg: "1300", average_fruit_weight_g: "212", created_at: "x", updated_at: "2026-09-16T20:11:02Z" }
    ],
    ...overrides
  };
}

test("item contract: raw values preserved, packing week named as such, daily rows sorted", () => {
  const item = toYieldWeekItem(row(), new Date("2026-10-04T12:00:00Z"), TZ);
  assert.deepEqual(Object.keys(item).sort(), [
    "averageFruitWeightG", "createdAt", "daily", "dailyBreakdownComplete", "kgPerM2", "lastWriteSource", "packedDate", "packingWeek", "packingYear",
    "physicalAreaM2", "physicalAreaRowCount", "physicalAreaRowsMissingDimensions",
    "settlement", "sizeKg", "totalCases", "totalKg", "updatedAt", "varietyAreaM2", "varietyId", "varietyName", "varietyUpdatedAt", "yieldEntryId"
  ]);
  assert.equal(item.packingWeek, 38);
  assert.equal(item.averageFruitWeightG, 210.5);
  assert.equal(item.totalCases, 544);
  assert.equal(item.varietyAreaM2, 11627);
  assert.equal(item.updatedAt, "2026-09-22T21:30:21.123456+00:00");
  assert.deepEqual(item.daily.map(d => d.packedDate), ["2026-09-16", "2026-09-18"]);
  assert.deepEqual(item.sizeKg, { "size-xl": 812, "size-l": 1965 });
});

test("dailyBreakdownComplete: false after a manual edit, null when provenance is unknown", () => {
  const at = new Date("2026-10-04T12:00:00Z");
  assert.equal(toYieldWeekItem(row({ last_write_source: "import_pdf" }), at, TZ).dailyBreakdownComplete, true);
  assert.equal(toYieldWeekItem(row({ last_write_source: "manual_edit" }), at, TZ).dailyBreakdownComplete, false);
  assert.equal(toYieldWeekItem(row({ last_write_source: null }), at, TZ).dailyBreakdownComplete, null);
});

test("manifest checksum is order- and case-independent but content-sensitive", () => {
  const a = ["B0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000001"];
  assert.equal(manifestChecksum(a), manifestChecksum([...a].reverse().map(s => s.toLowerCase())));
  assert.notEqual(manifestChecksum(a), manifestChecksum(a.slice(0, 1)));
});

test("physical area: sum of measured footprint rows; shared rows count for each variety; undimensioned rows reported", () => {
  const f = resolveVarietyFootprints({
    groups: [{ id: "g1", name: "Phase 1" }],
    rows: [
      { group_id: "g1", row_number: 1, width_meters: 8, length_meters: 100, section_id: null },
      { group_id: "g1", row_number: 2, width_meters: 8, length_meters: 100, section_id: null },
      { group_id: "g1", row_number: 3, width_meters: null, length_meters: null, section_id: null }
    ],
    sections: [],
    assignments: [
      { group_id: "g1", variety_id: "A", start_row: 1, end_row: 3, assignment_pattern: null },
      { group_id: "g1", variety_id: "B", start_row: 2, end_row: 2, assignment_pattern: null }
    ],
    links: []
  });
  const areas = physicalAreasByVariety(f);
  assert.deepEqual(areas.get("A"), { areaM2: 1600, rowCount: 3, rowsMissingDimensions: 1 });
  assert.deepEqual(areas.get("B"), { areaM2: 800, rowCount: 1, rowsMissingDimensions: 0 });
  assert.equal(areas.get("C"), undefined);
});
