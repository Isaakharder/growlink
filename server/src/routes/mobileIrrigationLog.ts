import { Router } from "express";
import { supabase } from "../config/supabase";

type GroupType = "phase" | "zone" | "color";

type IrrigationGroup = {
  id: string;
  type: GroupType;
  name: string;
  status: "active" | "inactive";
  created_at: string;
};

type IrrigationEquipment = {
  id: string;
  name: string;
  group_id: string;
  dripper_count: number;
  status: "active" | "inactive";
};

type EquipmentReading = {
  id: string;
  name: string;
  volume_ml: number | null;
};

const GROUP_TYPES: GroupType[] = ["phase", "zone", "color"];

function isValidDateString(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLogDate(value: unknown): string {
  const parsed = typeof value === "string" ? value.trim() : "";

  if (!isValidDateString(parsed)) {
    throw new Error("log_date must be YYYY-MM-DD");
  }

  return parsed;
}

function parseGroupType(value: unknown): GroupType {
  const parsed = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!GROUP_TYPES.includes(parsed as GroupType)) {
    throw new Error("tracking_mode must be phase, zone, or color");
  }

  return parsed as GroupType;
}

function parseOptionalNumber(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

function parseOptionalNotes(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalIdArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  const parsed = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(parsed));
}

function parseOptionalEquipmentReadings(
  value: unknown,
  fieldName: string
): EquipmentReading[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${fieldName}[${index}] must be an object`);
    }

    const reading = entry as Record<string, unknown>;
    const id = typeof reading.id === "string" ? reading.id.trim() : "";

    if (!id) {
      throw new Error(`${fieldName}[${index}].id is required`);
    }

    const name = typeof reading.name === "string" ? reading.name.trim() : "";

    const rawVolume = reading.volume_ml;
    let volume_ml: number | null = null;

    if (rawVolume !== undefined && rawVolume !== null && rawVolume !== "") {
      const parsedVolume = typeof rawVolume === "number" ? rawVolume : Number(rawVolume);
      if (!Number.isFinite(parsedVolume) || parsedVolume < 0) {
        throw new Error(`${fieldName}[${index}].volume_ml must be 0 or greater`);
      }

      volume_ml = parsedVolume;
    }

    return {
      id,
      name,
      volume_ml
    };
  });
}

function parseDaysQuery(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 30;
  }

  return Math.min(parsed, 365);
}

function resolveTrackingMode(groups: IrrigationGroup[]): GroupType | null {
  if (groups.length === 0) {
    return null;
  }

  const counts = new Map<GroupType, number>();
  const firstSeenOrder: GroupType[] = [];

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

const mobileIrrigationLogRouter = Router();

mobileIrrigationLogRouter.get("/irrigation/logs", async (req, res) => {
  const days = parseDaysQuery(req.query.days);
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - (days - 1));

  const fromDateString = toDateString(fromDate);

  const { data, error } = await supabase
    .from("mobile_irrigation_logs")
    .select("*")
    .gte("log_date", fromDateString)
    .order("log_date", { ascending: false })
    .order("group_name", { ascending: true });

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.json(data ?? []);
});

mobileIrrigationLogRouter.get("/mobile/irrigation-log", async (req, res) => {
  const requestedDate = req.query.log_date;
  const logDate =
    typeof requestedDate === "string" && requestedDate.trim().length > 0
      ? requestedDate.trim()
      : toDateString(new Date());

  if (!isValidDateString(logDate)) {
    return res.status(400).json({ message: "log_date must be YYYY-MM-DD" });
  }

  const { data: groupsData, error: groupsError } = await supabase
    .from("irrigation_groups")
    .select("id, type, name, status, created_at")
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (groupsError) {
    return res.status(500).json({ message: groupsError.message });
  }

  const allActiveGroups = (groupsData ?? []) as IrrigationGroup[];
  const trackingMode = resolveTrackingMode(allActiveGroups);

  if (!trackingMode) {
    return res.json({
      log_date: logDate,
      tracking_mode: null,
      groups: []
    });
  }

  const groups = allActiveGroups.filter((group) => group.type === trackingMode);
  const groupIds = groups.map((group) => group.id);

  if (groupIds.length === 0) {
    return res.json({
      log_date: logDate,
      tracking_mode: trackingMode,
      groups: []
    });
  }

  const [feedResult, drainResult, logsResult] = await Promise.all([
    supabase
      .from("irrigation_feed_valves")
      .select("id, name, group_id, dripper_count, status")
      .eq("status", "active")
      .in("group_id", groupIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("irrigation_drain_buckets")
      .select("id, name, group_id, dripper_count, status")
      .eq("status", "active")
      .in("group_id", groupIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("mobile_irrigation_logs")
      .select("*")
      .eq("log_date", logDate)
      .in("group_key", groupIds)
  ]);

  if (feedResult.error) {
    return res.status(500).json({ message: feedResult.error.message });
  }

  if (drainResult.error) {
    return res.status(500).json({ message: drainResult.error.message });
  }

  if (logsResult.error) {
    return res.status(500).json({ message: logsResult.error.message });
  }

  const feedValves = (feedResult.data ?? []) as IrrigationEquipment[];
  const drainBuckets = (drainResult.data ?? []) as IrrigationEquipment[];
  const logByGroupKey = new Map(
    (logsResult.data ?? []).map((entry) => [String(entry.group_key), entry])
  );

  const grouped = groups.map((group) => {
    const linkedFeedValves = feedValves.filter((valve) => valve.group_id === group.id);
    const linkedDrainBuckets = drainBuckets.filter((bucket) => bucket.group_id === group.id);

    return {
      id: group.id,
      type: group.type,
      name: group.name,
      feedValves: linkedFeedValves,
      drainBuckets: linkedDrainBuckets,
      existingLog: logByGroupKey.get(group.id) ?? null
    };
  });

  return res.json({
    log_date: logDate,
    tracking_mode: trackingMode,
    groups: grouped
  });
});

mobileIrrigationLogRouter.put("/mobile/irrigation-log/:groupId", async (req, res) => {
  const groupId = typeof req.params.groupId === "string" ? req.params.groupId.trim() : "";

  if (!groupId) {
    return res.status(400).json({ message: "groupId is required" });
  }

  let logDate: string;
  let trackingMode: GroupType;
  let feedPh: number | null;
  let feedEc: number | null;
  let drainPh: number | null;
  let drainEc: number | null;
  let notes: string | null;
  let requestedFeedValveIds: string[];
  let requestedDrainBucketIds: string[];
  let requestedFeedValveReadings: EquipmentReading[];
  let requestedDrainBucketReadings: EquipmentReading[];

  try {
    const body = req.body as Record<string, unknown>;

    logDate = parseLogDate(body.log_date);
    trackingMode = parseGroupType(body.tracking_mode);
    feedPh = parseOptionalNumber(body.feed_ph, "feed_ph");
    feedEc = parseOptionalNumber(body.feed_ec, "feed_ec");
    drainPh = parseOptionalNumber(body.drain_ph, "drain_ph");
    drainEc = parseOptionalNumber(body.drain_ec, "drain_ec");
    notes = parseOptionalNotes(body.notes);
    requestedFeedValveIds = parseOptionalIdArray(body.feed_valve_ids, "feed_valve_ids");
    requestedDrainBucketIds = parseOptionalIdArray(
      body.drain_bucket_ids,
      "drain_bucket_ids"
    );
    requestedFeedValveReadings = parseOptionalEquipmentReadings(
      body.feed_valve_readings,
      "feed_valve_readings"
    );
    requestedDrainBucketReadings = parseOptionalEquipmentReadings(
      body.drain_bucket_readings,
      "drain_bucket_readings"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data: groupData, error: groupError } = await supabase
    .from("irrigation_groups")
    .select("id, type, name")
    .eq("id", groupId)
    .single();

  if (groupError || !groupData) {
    return res.status(404).json({ message: "Irrigation group was not found" });
  }

  if (groupData.type !== trackingMode) {
    return res.status(400).json({ message: "tracking_mode does not match group type" });
  }

  const [feedResult, drainResult] = await Promise.all([
    supabase
      .from("irrigation_feed_valves")
      .select("id, name")
      .eq("group_id", groupId)
      .eq("status", "active"),
    supabase
      .from("irrigation_drain_buckets")
      .select("id, name")
      .eq("group_id", groupId)
      .eq("status", "active")
  ]);

  if (feedResult.error) {
    return res.status(500).json({ message: feedResult.error.message });
  }

  if (drainResult.error) {
    return res.status(500).json({ message: drainResult.error.message });
  }

  const allowedFeedValves = new Map((feedResult.data ?? []).map((entry) => [entry.id, entry.name]));
  const allowedDrainBuckets = new Map(
    (drainResult.data ?? []).map((entry) => [entry.id, entry.name])
  );

  const allowedFeedValveIds = new Set(allowedFeedValves.keys());
  const allowedDrainBucketIds = new Set(allowedDrainBuckets.keys());

  const feedValveIds = requestedFeedValveIds.filter((id) => allowedFeedValveIds.has(id));
  const drainBucketIds = requestedDrainBucketIds.filter((id) => allowedDrainBucketIds.has(id));

  const feedValveReadings = requestedFeedValveReadings
    .filter((reading) => allowedFeedValveIds.has(reading.id))
    .map((reading) => ({
      id: reading.id,
      name: reading.name || String(allowedFeedValves.get(reading.id) ?? ""),
      volume_ml: reading.volume_ml
    }));

  const drainBucketReadings = requestedDrainBucketReadings
    .filter((reading) => allowedDrainBucketIds.has(reading.id))
    .map((reading) => ({
      id: reading.id,
      name: reading.name || String(allowedDrainBuckets.get(reading.id) ?? ""),
      volume_ml: reading.volume_ml
    }));

  const now = new Date().toISOString();

  const upsertPayload = {
    log_date: logDate,
    tracking_mode: trackingMode,
    group_id: groupData.id,
    group_key: groupData.id,
    group_name: groupData.name,
    feed_valve_ids: feedValveIds,
    drain_bucket_ids: drainBucketIds,
    feed_ph: feedPh,
    feed_ec: feedEc,
    drain_ph: drainPh,
    drain_ec: drainEc,
    feed_valve_readings: feedValveReadings,
    drain_bucket_readings: drainBucketReadings,
    notes,
    updated_at: now
  };

  const { data, error } = await supabase
    .from("mobile_irrigation_logs")
    .upsert(upsertPayload, {
      onConflict: "log_date,group_key"
    })
    .select("*")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.json(data);
});

export { mobileIrrigationLogRouter };
