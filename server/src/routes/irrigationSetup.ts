import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";

type IrrigationGroupPayload = {
  type: GroupType;
  name: string;
  status: StatusType;
};

type LinkedItemPayload = {
  name: string;
  group_id: string;
  dripper_count: number;
  status: StatusType;
};

const GROUP_TYPES: GroupType[] = ["phase", "zone", "color"];
const STATUS_VALUES: StatusType[] = ["active", "inactive"];

function parseRequiredName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }

  return name;
}

function parseStatus(value: unknown): StatusType {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (!STATUS_VALUES.includes(status as StatusType)) {
    throw new Error("status must be active or inactive");
  }

  return status as StatusType;
}

function parseGroupType(value: unknown): GroupType {
  const type = typeof value === "string" ? value.toLowerCase() : "";
  if (!GROUP_TYPES.includes(type as GroupType)) {
    throw new Error("type must be phase, zone, or color");
  }

  return type as GroupType;
}

function parseDripperCount(value: unknown): number {
  const dripperCount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(dripperCount) || dripperCount < 1) {
    throw new Error("dripper_count must be 1 or greater");
  }

  return dripperCount;
}

function validateGroupPayload(input: unknown): IrrigationGroupPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  return {
    type: parseGroupType(body.type),
    name: parseRequiredName(body.name),
    status: parseStatus(body.status)
  };
}

function validateLinkedItemPayload(input: unknown): LinkedItemPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const group_id = typeof body.group_id === "string" ? body.group_id.trim() : "";

  if (!group_id) {
    throw new Error("group_id is required");
  }

  return {
    name: parseRequiredName(body.name),
    group_id,
    dripper_count: parseDripperCount(body.dripper_count),
    status: parseStatus(body.status)
  };
}

async function ensureGroupExists(groupId: string, organizationId: string) {
  const { data, error } = await supabase
    .from("irrigation_groups")
    .select("id")
    .eq("id", groupId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) {
    throw new Error("Selected group was not found");
  }
}

const irrigationSetupRouter = Router();

const canView = requireAnyPermission(["irrigation:view", "irrigation:edit"]);
const canEdit = requirePermission("irrigation:edit");

irrigationSetupRouter.get("/irrigation-setup", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const [groupsResult, feedValvesResult, drainBucketsResult] = await Promise.all([
    supabase
      .from("irrigation_groups")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("irrigation_feed_valves")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("irrigation_drain_buckets")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true })
  ]);

  if (groupsResult.error) {
    return sendSafeError(res, 500, "Failed to load irrigation setup.", "Irrigation setup - groups error:", groupsResult.error);
  }

  if (feedValvesResult.error) {
    return sendSafeError(res, 500, "Failed to load irrigation setup.", "Irrigation setup - feed valves error:", feedValvesResult.error);
  }

  if (drainBucketsResult.error) {
    return sendSafeError(res, 500, "Failed to load irrigation setup.", "Irrigation setup - drain buckets error:", drainBucketsResult.error);
  }

  return res.json({
    groups: groupsResult.data ?? [],
    feedValves: feedValvesResult.data ?? [],
    drainBuckets: drainBucketsResult.data ?? []
  });
});

irrigationSetupRouter.post("/irrigation-groups", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: IrrigationGroupPayload;

  try {
    payload = validateGroupPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("irrigation_groups")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create irrigation group.", "Irrigation group insert error:", error);
  }

  return res.status(201).json(data);
});

irrigationSetupRouter.put("/irrigation-groups/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: IrrigationGroupPayload;

  try {
    payload = validateGroupPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("irrigation_groups")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update irrigation group.", "Irrigation group update error:", error);
  }

  return res.json(data);
});

irrigationSetupRouter.delete("/irrigation-groups/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("irrigation_groups")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete irrigation group.", "Irrigation group delete error:", error);
  }

  return res.status(204).send();
});

irrigationSetupRouter.post("/irrigation-feed-valves", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: LinkedItemPayload;

  try {
    payload = validateLinkedItemPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("irrigation_feed_valves")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create feed valve.", "Irrigation feed valve insert error:", error);
  }

  return res.status(201).json(data);
});

irrigationSetupRouter.put("/irrigation-feed-valves/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: LinkedItemPayload;

  try {
    payload = validateLinkedItemPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("irrigation_feed_valves")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update feed valve.", "Irrigation feed valve update error:", error);
  }

  return res.json(data);
});

irrigationSetupRouter.delete("/irrigation-feed-valves/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("irrigation_feed_valves")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete feed valve.", "Irrigation feed valve delete error:", error);
  }

  return res.status(204).send();
});

irrigationSetupRouter.post("/irrigation-drain-buckets", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: LinkedItemPayload;

  try {
    payload = validateLinkedItemPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("irrigation_drain_buckets")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create drain bucket.", "Irrigation drain bucket insert error:", error);
  }

  return res.status(201).json(data);
});

irrigationSetupRouter.put("/irrigation-drain-buckets/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: LinkedItemPayload;

  try {
    payload = validateLinkedItemPayload(req.body);
    await ensureGroupExists(payload.group_id, organizationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("irrigation_drain_buckets")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update drain bucket.", "Irrigation drain bucket update error:", error);
  }

  return res.json(data);
});

irrigationSetupRouter.delete("/irrigation-drain-buckets/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("irrigation_drain_buckets")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete drain bucket.", "Irrigation drain bucket delete error:", error);
  }

  return res.status(204).send();
});

export { irrigationSetupRouter };
