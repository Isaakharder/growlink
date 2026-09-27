import { roundTo } from "../roundTo";

// Greenhouse Snapshot: which irrigation groups the Dashboard shows, the
// newest log for each, and the metrics on each card. Shared by the desktop
// Dashboard and the iOS workspace Overview so both show identical values.

export type IrrigationGroupType = "phase" | "zone" | "color";

export type IrrigationGroup = {
  id: string;
  type: IrrigationGroupType;
  name: string;
  status: "active" | "inactive";
  created_at?: string;
};

type IrrigationReading = { id: string; name: string; volume_ml: number | null; dripper_count?: number | null };

export type IrrigationLogRecord = {
  id: string;
  log_date: string;
  tracking_mode: IrrigationGroupType;
  group_id: string | null;
  group_key: string;
  group_name: string;
  feed_valve_ids: string[];
  drain_bucket_ids: string[];
  feed_ph: number | null;
  feed_ec: number | null;
  drain_ph: number | null;
  drain_ec: number | null;
  feed_valve_readings?: IrrigationReading[];
  drain_bucket_readings?: IrrigationReading[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type GreenhouseSnapshot = { group: IrrigationGroup; log: IrrigationLogRecord | null };

export const TRACKING_LABELS: Record<IrrigationGroupType, string> = {
  phase: "Phase",
  zone: "Zone",
  color: "Color"
};

/** The most common group type; a tie goes to the type seen first. */
export function resolveTrackingMode(groups: IrrigationGroup[]): IrrigationGroupType | null {
  if (groups.length === 0) {
    return null;
  }

  const counts = new Map<IrrigationGroupType, number>();
  const firstSeenOrder: IrrigationGroupType[] = [];

  for (const group of groups) {
    const current = counts.get(group.type) ?? 0;
    counts.set(group.type, current + 1);

    if (current === 0) {
      firstSeenOrder.push(group.type);
    }
  }

  let selectedType = firstSeenOrder[0];
  let selectedCount = counts.get(selectedType) ?? 0;

  for (const type of firstSeenOrder) {
    const count = counts.get(type) ?? 0;

    if (count > selectedCount) {
      selectedType = type;
      selectedCount = count;
    }
  }

  return selectedType;
}

/**
 * From /api/irrigation-setup's groups and /api/irrigation/logs (newest
 * first): the active groups of the tracking mode, in setup order, and the
 * first (newest) log per group.
 */
export function selectGreenhouseSnapshotGroups(
  groups: IrrigationGroup[] | undefined,
  logs: IrrigationLogRecord[] | null | undefined
): {
  trackingMode: IrrigationGroupType | null;
  groups: IrrigationGroup[];
  latestLogsByGroupId: Map<string, IrrigationLogRecord>;
} {
  const activeGroups = (groups ?? []).filter((group) => group.status === "active");
  const mode = resolveTrackingMode(activeGroups);
  const displayGroups = mode === null ? [] : activeGroups.filter((group) => group.type === mode);
  const latestLogsByGroupId = new Map<string, IrrigationLogRecord>();

  for (const log of logs ?? []) {
    const groupId = typeof log.group_key === "string" ? log.group_key : "";

    if (!groupId || latestLogsByGroupId.has(groupId)) {
      continue;
    }

    latestLogsByGroupId.set(groupId, log);
  }

  return { trackingMode: mode, groups: displayGroups, latestLogsByGroupId };
}

export function pairGreenhouseSnapshots(
  groups: IrrigationGroup[],
  latestLogsByGroupId: Map<string, IrrigationLogRecord>
): GreenhouseSnapshot[] {
  return groups.map((group) => ({
    group,
    log: latestLogsByGroupId.get(group.id) ?? null
  }));
}

export function formatSnapshotNumber(val: number | null | undefined, decimals = 2) {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  return String(roundTo(Number(val), decimals));
}

function formatSnapshotPercent(val: number | null | undefined, decimals = 2) {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  return `${roundTo(Number(val), decimals)}%`;
}

function usableReadings(readings: IrrigationReading[] | undefined) {
  return (readings ?? [])
    .map((reading) => ({
      volumeMl:
        typeof reading.volume_ml === "number" &&
        Number.isFinite(reading.volume_ml) &&
        reading.volume_ml >= 0
          ? reading.volume_ml
          : null,
      dripperCount:
        Number(reading.dripper_count) > 0 ? Number(reading.dripper_count) : 1
    }))
    .filter(
      (reading): reading is { volumeMl: number; dripperCount: number } =>
        reading.volumeMl !== null
    );
}

export function getDrainPercent(log: IrrigationLogRecord | null) {
  if (!log) return "—";

  const feed = usableReadings(log.feed_valve_readings);
  const drain = usableReadings(log.drain_bucket_readings);

  if (!feed.length || !drain.length) return "—";

  // Normalise each reading by its own dripper count, then average.
  // Averaging raw volumes and dripper counts separately gives a wrong result
  // when readings have different dripper counts.
  const avgFeedPerDripper =
    feed.reduce((sum, r) => sum + r.volumeMl / r.dripperCount, 0) / feed.length;
  const avgDrainPerDripper =
    drain.reduce((sum, r) => sum + r.volumeMl / r.dripperCount, 0) / drain.length;

  if (!Number.isFinite(avgFeedPerDripper) || avgFeedPerDripper <= 0) return "—";
  if (!Number.isFinite(avgDrainPerDripper) || avgDrainPerDripper < 0) return "—";

  return formatSnapshotPercent((avgDrainPerDripper / avgFeedPerDripper) * 100, 2);
}

export function getAvgFeedMl(log: IrrigationLogRecord | null) {
  if (!log) return "—";

  const values = (log.feed_valve_readings ?? [])
    .map((reading) =>
      typeof reading.volume_ml === "number" &&
      Number.isFinite(reading.volume_ml) &&
      reading.volume_ml >= 0
        ? reading.volume_ml
        : null
    )
    .filter((value): value is number => value !== null);

  if (!values.length) return "—";

  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return String(Math.round(avg));
}

export function getLastReadingDate(log: IrrigationLogRecord | null) {
  if (!log) return "No readings yet";
  return log.log_date || "—";
}
