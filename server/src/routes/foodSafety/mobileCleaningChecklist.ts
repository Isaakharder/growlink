import { Router, Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission } from "../../middleware/requirePermission";
import { resolveActor } from "./services/actorIdentity";
import { computePeriodKey, type ChecklistPeriodType } from "./services/checklistPeriod";
import { getCurrentChecklistsForLocation } from "./services/currentChecklists";
import { maybeCreateReport, reportAlreadyExistsForPeriod } from "./services/reportGeneration";
import { validateReportDate } from "./services/reportDate";

type LocationRow = {
  id: string;
  name: string;
  area: string;
  frequency: ChecklistPeriodType;
  mobile_instructions: string | null;
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
  mobileInstructions: string | null;
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

// Ensures the one checklist for each location's period (its own frequency)
// for `referenceDate` exists, creating any missing ones via the atomic RPC.
// Defaults to "now" (today); the mobile long-press date selector passes a
// backdated referenceDate so a worker can retroactively fill out a past day.
async function ensureChecklists(
  organizationId: string,
  locations: LocationRow[],
  referenceDate: Date = new Date()
): Promise<void> {
  const now = referenceDate;

  for (const location of locations) {
    const periodKey = computePeriodKey(location.frequency, now);
    const { error } = await supabase.rpc("food_safety_get_or_create_checklist", {
      p_organization_id: organizationId,
      p_location_id: location.id,
      p_period_type: location.frequency,
      p_period_key: periodKey
    });

    if (error) {
      throw new Error(`Failed to prepare checklist for location ${location.id} (${location.frequency}): ${error.message}`);
    }
  }
}

async function loadLocationCards(
  organizationId: string,
  locationIds?: string[],
  referenceDate: Date = new Date()
): Promise<LocationCard[]> {
  let locationQuery = supabase
    .from("food_safety_cleaning_locations")
    .select("id, name, area, frequency, mobile_instructions")
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

  await ensureChecklists(organizationId, activeLocations, referenceDate);

  const now = referenceDate;
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
      mobileInstructions: location.mobile_instructions,
      isComplete,
      completedAt: isComplete ? lastCompleted?.completed_at ?? null : null,
      completedByName: isComplete ? lastCompleted?.completed_by_name ?? null : null,
      completedByInitials: isComplete ? lastCompleted?.completed_by_initials ?? null : null,
      items
    };
  });
}

// Looks up the location's own frequency (needed to build the exact
// period_signature a report for this date would use), then checks whether a
// report already exists for that period — via either the live-completion
// path's own format or the unrelated admin backfill path's format. Used to
// reject entry into (GET) or completion of (complete) an already-reported
// backdated day before any checklist rows get created for it. Returns false
// (rather than throwing) if the location itself can't be found, since the
// normal load path already handles a missing/inactive location correctly.
async function reportAlreadyExistsForBackdatedDate(
  organizationId: string,
  locationId: string,
  referenceDate: Date,
  dailyDateKey: string
): Promise<boolean> {
  const { data: location, error } = await supabase
    .from("food_safety_cleaning_locations")
    .select("frequency")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!location) return false;

  const frequency = (location as { frequency: ChecklistPeriodType }).frequency;
  const periodKey = computePeriodKey(frequency, referenceDate);

  return reportAlreadyExistsForPeriod(organizationId, locationId, frequency, periodKey, dailyDateKey);
}

const mobileCleaningChecklistRouter = Router();

const canUseMobileFoodSafety = requirePermission("mobile:food_safety");

mobileCleaningChecklistRouter.get(
  "/food-safety/mobile/cleaning-checklist",
  canUseMobileFoodSafety,
  async (req, res) => {
    const locationId = typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    // reportDate only means anything for a single-location request (the
    // detail page's long-press date selector) — the multi-location list view
    // never sends it, and it's ignored if it somehow did.
    const rawReportDate = locationId && typeof req.query.reportDate === "string" ? req.query.reportDate : undefined;

    let referenceDate: Date | undefined;

    if (rawReportDate) {
      let validated;
      try {
        validated = validateReportDate(rawReportDate);
      } catch (error) {
        return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid report date." });
      }

      if (validated.isBackdated) {
        try {
          const exists = await reportAlreadyExistsForBackdatedDate(req.organizationId, locationId as string, validated.referenceDate, validated.dateStr);
          if (exists) {
            return res.status(409).json({ message: "A report already exists for this location and date." });
          }
        } catch (error) {
          return sendSafeError(res, 500, "Failed to check existing reports for this date.", "Backdate duplicate-check error:", error);
        }
      }

      referenceDate = validated.referenceDate;
    }

    try {
      const cards = await loadLocationCards(req.organizationId, locationId ? [locationId] : undefined, referenceDate);
      return res.json({ locations: cards });
    } catch (error) {
      return sendSafeError(res, 500, "Failed to load cleaning checklists.", "Cleaning checklist load error:", error);
    }
  }
);

async function resolveRequestActor(req: Request, res: Response) {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: "Authentication is required." });
    return null;
  }

  try {
    return await resolveActor(userId);
  } catch (error) {
    sendSafeError(res, 500, "Failed to resolve the logged-in employee.", "Actor resolution error:", error);
    return null;
  }
}

async function respondWithReloadedLocation(
  req: Request,
  res: Response,
  organizationId: string,
  locationId: string,
  referenceDate?: Date
) {
  try {
    const cards = await loadLocationCards(organizationId, [locationId], referenceDate);
    return res.json({ location: cards[0] ?? null });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load the updated location.", "Cleaning checklist reload error:", error);
  }
}

// Sets a task's response value / checked state. Never finalizes the
// checklist by itself — only the explicit "Complete Location" action does.
// Accepts an optional reportDate (re-validated here, never trusted as-is) so
// that after this edit, reloading the location shows the SAME backdated
// period the client is working on instead of silently snapping back to
// today's checklist.
async function handleSetItemResponse(req: Request, res: Response, responseValue: string | null) {
  const organizationId = req.organizationId;
  const { itemId } = req.params;
  const rawReportDate = (req.body as Record<string, unknown> | undefined)?.reportDate;

  let referenceDate: Date | undefined;
  if (typeof rawReportDate === "string") {
    try {
      referenceDate = validateReportDate(rawReportDate).referenceDate;
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid report date." });
    }
  }

  const actor = await resolveRequestActor(req, res);
  if (!actor) return;

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

  const locationId = (checklist as { location_id?: string } | null)?.location_id ?? null;
  if (!locationId) {
    return sendSafeError(res, 500, "Failed to load the updated location.", "Checklist RPC result missing location_id:", checklist);
  }

  return respondWithReloadedLocation(req, res, organizationId, locationId, referenceDate);
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

// "Complete Location" — the only way a checklist is ever finalized. No
// validation of checkbox state: whatever is currently checked/unchecked
// across every currently-due item (across every frequency in use at this
// location) is what gets locked in and reported. An optional reportDate
// (the mobile long-press date selector's choice) is re-validated here from
// scratch — the client's date is never trusted — and, when it names a past
// day, is re-checked for an already-existing report immediately before
// finalizing, closing the race where another device/admin reported that same
// day between this device's initial GET and this Complete tap.
mobileCleaningChecklistRouter.post(
  "/food-safety/mobile/cleaning-checklist/locations/:locationId/complete",
  canUseMobileFoodSafety,
  async (req, res) => {
    const organizationId = req.organizationId;
    const locationId = String(req.params.locationId);
    const rawReportDate = (req.body as Record<string, unknown> | undefined)?.reportDate;

    let referenceDate: Date | undefined;
    if (typeof rawReportDate === "string") {
      let validated;
      try {
        validated = validateReportDate(rawReportDate);
      } catch (error) {
        return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid report date." });
      }

      if (validated.isBackdated) {
        try {
          const exists = await reportAlreadyExistsForBackdatedDate(organizationId, locationId, validated.referenceDate, validated.dateStr);
          if (exists) {
            return res.status(409).json({ message: "A report already exists for this location and date." });
          }
        } catch (error) {
          return sendSafeError(res, 500, "Failed to check existing reports for this date.", "Backdate duplicate-check error:", error);
        }
      }

      referenceDate = validated.referenceDate;
    }

    const actor = await resolveRequestActor(req, res);
    if (!actor) return;

    let currentChecklists;
    try {
      currentChecklists = await getCurrentChecklistsForLocation(organizationId, locationId, referenceDate);
    } catch (error) {
      return sendSafeError(res, 500, "Failed to load this location's checklists.", "Complete-location checklist lookup error:", error);
    }

    if (currentChecklists.length === 0) {
      return res.status(400).json({ message: "There are no cleaning tasks due for this location right now." });
    }

    const { error: rpcError } = await supabase.rpc("food_safety_complete_location_checklists", {
      p_organization_id: organizationId,
      p_checklist_ids: currentChecklists.map((c) => c.id),
      p_actor_user_id: actor.userId,
      p_actor_name: actor.name,
      p_actor_initials: actor.initials
    });

    if (rpcError) {
      return sendSafeError(res, 500, "Failed to complete this location.", "Complete-location error:", rpcError);
    }

    await maybeCreateReport(organizationId, locationId, referenceDate);

    return respondWithReloadedLocation(req, res, organizationId, locationId, referenceDate);
  }
);

export { mobileCleaningChecklistRouter };
