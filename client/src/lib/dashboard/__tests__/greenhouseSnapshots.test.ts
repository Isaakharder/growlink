import { describe, expect, it } from "vitest";
import {
  formatSnapshotNumber,
  getAvgFeedMl,
  getDrainPercent,
  getLastReadingDate,
  pairGreenhouseSnapshots,
  resolveTrackingMode,
  selectGreenhouseSnapshotGroups,
  type IrrigationGroup,
  type IrrigationLogRecord
} from "../greenhouseSnapshots";

const g = (id: string, type: IrrigationGroup["type"], status: IrrigationGroup["status"] = "active"): IrrigationGroup => ({ id, type, name: id, status });
const r = (volume_ml: number | null, dripper_count?: number | null) => ({ id: "r", name: "r", volume_ml, dripper_count });
const log = (group_key: string, fields: Partial<IrrigationLogRecord> = {}) =>
  ({ id: group_key, log_date: "2026-08-11", group_key, feed_valve_readings: [], drain_bucket_readings: [], ...fields }) as IrrigationLogRecord;

describe("resolveTrackingMode", () => {
  it("picks the most common type, and the first-seen type on a tie", () => {
    expect(resolveTrackingMode([])).toBeNull();
    expect(resolveTrackingMode([g("a", "phase"), g("b", "zone"), g("c", "zone")])).toBe("zone");
    expect(resolveTrackingMode([g("a", "zone"), g("b", "phase"), g("c", "phase"), g("d", "zone")])).toBe("zone");
    expect(resolveTrackingMode([g("a", "color")])).toBe("color");
  });
});

describe("selectGreenhouseSnapshotGroups / pairGreenhouseSnapshots", () => {
  it("keeps active groups of the tracking mode in setup order, and the first log per group", () => {
    const groups = [g("p1", "phase"), g("z1", "zone"), g("z2", "zone"), g("z3", "zone", "inactive"), g("z4", "zone", "inactive"), g("z5", "zone", "inactive")];
    const logs = [log("z2", { log_date: "new" }), log("z2", { log_date: "old" }), log("", {}), log("z3")];
    const picked = selectGreenhouseSnapshotGroups(groups, logs);
    expect(picked.trackingMode).toBe("zone");
    expect(picked.groups.map((x) => x.id)).toEqual(["z1", "z2"]);
    expect([...picked.latestLogsByGroupId.keys()]).toEqual(["z2", "z3"]);
    expect(pairGreenhouseSnapshots(picked.groups, picked.latestLogsByGroupId).map((s) => [s.group.id, s.log?.log_date ?? null])).toEqual([
      ["z1", null],
      ["z2", "new"]
    ]);
  });

  it("handles missing setup groups and logs", () => {
    expect(selectGreenhouseSnapshotGroups(undefined, null)).toEqual({ trackingMode: null, groups: [], latestLogsByGroupId: new Map() });
  });
});

describe("snapshot card metrics", () => {
  it("formats numbers to 2 dp, with a dash for missing values", () => {
    expect([formatSnapshotNumber(2.456), formatSnapshotNumber(5.8), formatSnapshotNumber(null), formatSnapshotNumber(undefined), formatSnapshotNumber(NaN)]).toEqual(["2.46", "5.8", "—", "—", "—"]);
  });

  it("drain % averages each reading per dripper, skipping unusable readings", () => {
    const l = log("z", { feed_valve_readings: [r(100, 2), r(300, 1), r(null, 4)], drain_bucket_readings: [r(30, 2), r(-5), r(45, 3)] });
    expect(getDrainPercent(l)).toBe("8.57%");
    expect(getDrainPercent(null)).toBe("—");
    expect(getDrainPercent(log("z", { feed_valve_readings: [r(100)] }))).toBe("—");
    expect(getDrainPercent(log("z", { feed_valve_readings: [r(0)], drain_bucket_readings: [r(10)] }))).toBe("—");
    // A zero or missing dripper count counts as 1.
    expect(getDrainPercent(log("z", { feed_valve_readings: [r(200, 0)], drain_bucket_readings: [r(50, null)] }))).toBe("25%");
  });

  it("avg feed ml is the rounded mean of usable feed volumes", () => {
    expect(getAvgFeedMl(log("z", { feed_valve_readings: [r(100, 2), r(301), r(null), r(-1)] }))).toBe("201");
    expect(getAvgFeedMl(log("z"))).toBe("—");
    expect(getAvgFeedMl(null)).toBe("—");
  });

  it("last reading is the log date, a dash without one, or 'No readings yet'", () => {
    expect(getLastReadingDate(log("z"))).toBe("2026-08-11");
    expect(getLastReadingDate(log("z", { log_date: "" }))).toBe("—");
    expect(getLastReadingDate(null)).toBe("No readings yet");
  });
});
