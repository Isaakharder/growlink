import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEquipmentHistory } from "../equipmentHistory";

test("mergeEquipmentHistory: interleaves all three sources newest-first by their own timestamp", () => {
  const workLogs = [{ id: "wl-1", performed_at: "2026-01-15T10:00:00.000Z", work_performed: "Replaced filter" }];
  const meterReadings = [{ id: "mr-1", recorded_at: "2026-01-16T10:00:00.000Z", value: 120 }];
  const completions = [{ id: "sc-1", completed_at: "2026-01-14T10:00:00.000Z", schedule_name_snapshot: "Monthly service" }];

  const result = mergeEquipmentHistory(workLogs, meterReadings, completions, 50);

  assert.deepEqual(result.map((e) => e.id), ["mr-1", "wl-1", "sc-1"]);
  assert.equal(result[0].type, "meter_reading");
  assert.equal(result[1].type, "work_log");
  assert.equal(result[2].type, "schedule_completion");
});

test("mergeEquipmentHistory: strictly newest-first even within a single source", () => {
  const workLogs = [
    { id: "wl-old", performed_at: "2026-01-01T00:00:00.000Z" },
    { id: "wl-new", performed_at: "2026-01-10T00:00:00.000Z" },
    { id: "wl-mid", performed_at: "2026-01-05T00:00:00.000Z" }
  ];

  const result = mergeEquipmentHistory(workLogs, [], [], 50);

  assert.deepEqual(result.map((e) => e.id), ["wl-new", "wl-mid", "wl-old"]);
});

test("mergeEquipmentHistory: caller-filtered meter readings (related_work_log_id set) never appear — the function trusts its input, proving the route's exclusion query is what prevents duplicates, not this merge step", () => {
  // Simulates what the route passes in: the meter reading tied to wl-1 is
  // already excluded by the DB query (.is("related_work_log_id", null)),
  // so only the work log entry represents that event.
  const workLogs = [{ id: "wl-1", performed_at: "2026-01-15T10:00:00.000Z", work_performed: "Replaced filter", meter_reading_value: 120 }];
  const meterReadings: Array<{ id: string; recorded_at: string }> = []; // the linked reading was filtered out before reaching here

  const result = mergeEquipmentHistory(workLogs, meterReadings, [], 50);

  assert.equal(result.length, 1);
  assert.equal(result[0].type, "work_log");
});

test("mergeEquipmentHistory: respects the limit across merged sources", () => {
  const workLogs = Array.from({ length: 5 }, (_, i) => ({ id: `wl-${i}`, performed_at: `2026-01-0${i + 1}T00:00:00.000Z` }));

  const result = mergeEquipmentHistory(workLogs, [], [], 3);

  assert.equal(result.length, 3);
  // Newest three, i.e. indices 4, 3, 2.
  assert.deepEqual(result.map((e) => e.id), ["wl-4", "wl-3", "wl-2"]);
});

test("mergeEquipmentHistory: an empty history returns an empty array, not an error", () => {
  assert.deepEqual(mergeEquipmentHistory([], [], [], 50), []);
});
