import { Router, Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission } from "../../middleware/requirePermission";
import { resolveActor } from "./services/actorIdentity";
import { CHECKLIST_PERIOD_TYPES, computePeriodKey, type ChecklistPeriodType } from "./services/checklistPeriod";
import { maybeCreateReport } from "./services/reportGeneration";

type LocationRow = {
  id: string;
  name: string;
  area: string;
};

type TaskRow = {
  id: string;
  location_id: string;
  frequency: ChecklistPeriodType;
};

type ChecklistRow = {
  id: string;
  location_id: string;
  status: "incomplete" | "complete";
  completed_at: string | null;
  completed_by_name: string | null;
  completed_by_initials: string | null;
};

type ChecklistItemResponseType = "checkbox" | "number" | "short_text" | "long_text";

type ChecklistItemRow = {
  id: string;
  checklist_id: string;
  task_name_snapshot: string;
  frequency_snapshot: ChecklistPeriodType;
  response_type_snapshot: ChecklistItemResponseType;
  action_label_snapshot: string | null;
  is_required_snapshot: boolean;
  number_unit_snapshot: string | null;
  response_value: string | null;
  sort_order: number;
  is_complete: boolean;
  checked_at: string | null;
  checked_by_name: string | null;
  checked_by_initials: string | null;
};

type LocationCard = {
  id: string;
  name: string;
  area: string;
  isComplete: boolean;
  completedAt: string | null;
  completedByName: string | null;
  completedByInitials: string | null;
  items: {
    id: string;
    name: string;
    frequency: ChecklistPeriodType;
    responseType: ChecklistItemResponseType;
    actionLabel: string | null;
    isRequired: boolean;
    numberUnit: string | null;
    responseValue: string | null;
    isComplete: boolean;
    checkedAt: string | null;
    checkedByName: string | null;
    checkedByInitials: string | null;
  }[];
};

// Ensures every (location, frequency-currently-in-use) checklist for the
// given locations exists, creating any missing ones via the atomic RPC.
async function ensureChecklists(
  organizationId: string,
  locations: LocationRow[],
  tasksByLocation: Map<string, TaskRow[]>
): Promise<void> {
  const now = new Date();

  for (const location of locations) {
    const tasks = tasksByLocation.get(location.id) ?? [];
    const frequencies = new Set(tasks.map((t) => t.frequency));

    for (const periodType of CHECKLIST_PERIOD_TYPES) {
      if (!frequencies.has(periodType)) continue;

      const periodKey = computePeriodKey(periodType, now);
      const { error } = await supabase.rpc("food_safety_get_or_create_checklist", {
        p_organization_id: organizationId,
        p_location_id: location.id,
        p_period_type: periodType,
        p_period_key: periodKey
      });

      if (error) {
        throw new Error(`Failed to prepare checklist for location ${location.id} (${periodType}): ${error.message}`);
      }
    }
  }
}

async function loadLocationCards(organizationId: string, locationIds?: string[]): Promise<LocationCard[]> {
  let locationQuery = supabase
    .from("food_safety_cleaning_locations")
    .select("id, name, area")
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (locationIds) {
    locationQuery = locationQuery.in("id", locationIds);
  }

  const { data: locations, error: locationsError } = await locationQuery.order("name", { ascending: true });

  if (locationsError) {
    throw new Error(locationsError.message);
  }

  const activeLocations = (locations ?? []) as LocationRow[];
  if (activeLocations.length === 0) return [];

  const { data: tasks, error: tasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .select("id, location_id, frequency")
    .eq("organization_id", organizationId)
    .in("location_id", activeLocations.map((l) => l.id));

  if (tasksError) {
    throw new Error(tasksError.message);
  }

  const tasksByLocation = new Map<string, TaskRow[]>();
  for (const task of (tasks ?? []) as TaskRow[]) {
    const list = tasksByLocation.get(task.location_id) ?? [];
    list.push(task);
    tasksByLocation.set(task.location_id, list);
  }

  await ensureChecklists(organizationId, activeLocations, tasksByLocation);

  const now = new Date();
  const periodKeyByType: Record<ChecklistPeriodType, string> = {
    daily: computePeriodKey("daily", now),
    weekly: computePeriodKey("weekly", now),
    monthly: computePeriodKey("monthly", now),
    annually: computePeriodKey("annually", now)
  };

  const { data: checklists, error: checklistsError } = await supabase
    .from("food_safety_cleaning_checklists")
    .select("id, location_id, status, completed_at, completed_by_name, completed_by_initials, period_type, period_key")
    .eq("organization_id", organizationId)
    .in("location_id", activeLocations.map((l) => l.id))
    .in("period_key", Array.from(new Set(Object.values(periodKeyByType))));

  if (checklistsError) {
    throw new Error(checklistsError.message);
  }

  // Belt-and-suspenders: only keep checklists whose period_key matches the
  // *current* period for its own period_type (the broad period_key filter
  // above is just to keep the query cheap).
  const currentChecklists = ((checklists ?? []) as (ChecklistRow & { period_type: ChecklistPeriodType; period_key: string })[])
    .filter((c) => c.period_key === periodKeyByType[c.period_type]);

  const checklistIds = currentChecklists.map((c) => c.id);
  const itemsByChecklist = new Map<string, ChecklistItemRow[]>();

  if (checklistIds.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .from("food_safety_cleaning_checklist_items")
      .select(
        "id, checklist_id, task_name_snapshot, frequency_snapshot, response_type_snapshot, action_label_snapshot, is_required_snapshot, number_unit_snapshot, response_value, sort_order, is_complete, checked_at, checked_by_name, checked_by_initials"
      )
      .eq("organization_id", organizationId)
      .in("checklist_id", checklistIds);

    if (itemsError) {
      throw new Error(itemsError.message);
    }

    for (const item of (items ?? []) as ChecklistItemRow[]) {
      const list = itemsByChecklist.get(item.checklist_id) ?? [];
      list.push(item);
      itemsByChecklist.set(item.checklist_id, list);
    }
  }

  const checklistsByLocation = new Map<string, ChecklistRow[]>();
  for (const checklist of currentChecklists) {
    const list = checklistsByLocation.get(checklist.location_id) ?? [];
    list.push(checklist);
    checklistsByLocation.set(checklist.location_id, list);
  }

  return activeLocations.map((location) => {
    const locationChecklists = checklistsByLocation.get(location.id) ?? [];

    const items = locationChecklists
      .flatMap((checklist) => itemsByChecklist.get(checklist.id) ?? [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        id: item.id,
        name: item.task_name_snapshot,
        frequency: item.frequency_snapshot,
        responseType: item.response_type_snapshot,
        actionLabel: item.action_label_snapshot,
        isRequired: item.is_required_snapshot,
        numberUnit: item.number_unit_snapshot,
        responseValue: item.response_value,
        isComplete: item.is_complete,
        checkedAt: item.checked_at,
        checkedByName: item.checked_by_name,
        checkedByInitials: item.checked_by_initials
      }));

    const isComplete = locationChecklists.length > 0 && locationChecklists.every((c) => c.status === "complete");

    // Whichever checklist finished last is who "completed the location".
    const lastCompleted = locationChecklists
      .filter((c) => c.status === "complete" && c.completed_at)
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))[0];

    return {
      id: location.id,
      name: location.name,
      area: location.area,
      isComplete,
      completedAt: isComplete ? lastCompleted?.completed_at ?? null : null,
      completedByName: isComplete ? lastCompleted?.completed_by_name ?? null : null,
      completedByInitials: isComplete ? lastCompleted?.completed_by_initials ?? null : null,
      items
    };
  });
}

const mobileCleaningChecklistRouter = Router();

const canUseMobileFoodSafety = requirePermission("mobile:food_safety");

mobileCleaningChecklistRouter.get(
  "/food-safety/mobile/cleaning-checklist",
  canUseMobileFoodSafety,
  async (req, res) => {
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;

    try {
      const cards = await loadLocationCards(req.organizationId, locationId ? [locationId] : undefined);
      return res.json({ locations: cards });
    } catch (error) {
      return sendSafeError(res, 500, "Failed to load cleaning checklists.", "Cleaning checklist load error:", error);
    }
  }
);

async function handleSetItemResponse(req: Request, res: Response, responseValue: string | null) {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const { itemId } = req.params;

  if (!userId) {
    return res.status(401).json({ message: "Authentication is required." });
  }

  let actor;
  try {
    actor = await resolveActor(userId);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in employee.", "Actor resolution error:", error);
  }

  const { data: checklist, error: rpcError } = await supabase.rpc("food_safety_set_checklist_item_response", {
    p_organization_id: organizationId,
    p_item_id: itemId,
    p_response_value: responseValue,
    p_actor_user_id: actor.userId,
    p_actor_name: actor.name,
    p_actor_initials: actor.initials
  });

  if (rpcError) {
    if (rpcError.code === "P0002") {
      return res.status(404).json({ message: "Checklist item not found." });
    }
    if (rpcError.code === "42501") {
      return res.status(409).json({ message: "This cleaning checklist has already been finalized and cannot be changed." });
    }
    return sendSafeError(res, 500, "Failed to update the checklist item.", "Checklist item update error:", rpcError);
  }

  // The RPC returns the full updated checklist row (function return type is
  // `public.food_safety_cleaning_checklists`), so location_id is right there.
  const locationId = (checklist as { location_id?: string } | null)?.location_id ?? null;

  if (!locationId) {
    return sendSafeError(res, 500, "Failed to load the updated location.", "Checklist RPC result missing location_id:", checklist);
  }

  await maybeCreateReport(organizationId, locationId);

  try {
    const cards = await loadLocationCards(organizationId, [locationId]);
    return res.json({ location: cards[0] ?? null });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load the updated location.", "Cleaning checklist reload error:", error);
  }
}

mobileCleaningChecklistRouter.post(
  "/food-safety/mobile/cleaning-checklist/items/:itemId/check",
  canUseMobileFoodSafety,
  (req, res) => void handleSetItemResponse(req, res, "true")
);

mobileCleaningChecklistRouter.post(
  "/food-safety/mobile/cleaning-checklist/items/:itemId/uncheck",
  canUseMobileFoodSafety,
  (req, res) => void handleSetItemResponse(req, res, null)
);

// For number/short_text/long_text tasks — the raw entered value. Empty/blank
// values are stored as null (an intentionally cleared answer), consistent
// with how "unchecked" is null for checkbox tasks above.
mobileCleaningChecklistRouter.post(
  "/food-safety/mobile/cleaning-checklist/items/:itemId/respond",
  canUseMobileFoodSafety,
  (req, res) => {
    const rawValue = (req.body as Record<string, unknown> | undefined)?.value;
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    void handleSetItemResponse(req, res, value || null);
  }
);

export { mobileCleaningChecklistRouter };
