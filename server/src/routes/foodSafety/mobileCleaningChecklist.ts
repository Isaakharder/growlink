import { Router, Request, Response } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission } from "../../middleware/requirePermission";
import { resolveActor } from "./services/actorIdentity";
import { computePeriodKey, type ChecklistPeriodType } from "./services/checklistPeriod";
import { getCurrentChecklistsForLocation, reduceToLatestAttempts } from "./services/currentChecklists";
import { maybeCreateReport } from "./services/reportGeneration";
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
  attempt_number: number;
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
  frequency: ChecklistPeriodType;
  mobileInstructions: string | null;
  isComplete: boolean;
  completedAt: string | null;
  completedByName: string | null;
  completedByInitials: string | null;
  // The most recent FINALIZED report for this location (from
  // food_safety_cleaning_reports, never the in-progress checklist) --
  // distinct from completedAt/completedByInitials above, which only ever
  // reflect the CURRENT period's cycle and are null while it's incomplete.
  // Powers the "Last: Jul 22, 3:41 PM" footer on the mobile location list.
  lastCompletedAt: string | null;
  lastCompletedByInitials: string | null;
  // True when a report already exists for this location's CURRENT period
  // (today's date for a daily location, this ISO week for weekly, etc.) --
  // regardless of whether that report came from the attempt currently being
  // displayed or an earlier, already-finalized one. Drives the mobile
  // client's "Report already logged today" confirmation dialog before a
  // second/third completion of the same period; stays true across a
  // "Complete Another Report" attempt so the dialog still fires when THAT
  // attempt is completed too.
  reportAlreadyLoggedForPeriod: boolean;
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

type LatestReportRow = {
  location_id: string;
  completed_at: string;
  completed_by_initials: string | null;
};

type LatestReportInfo = { completedAt: string; completedByInitials: string | null };

// One query for the whole list (via food_safety_latest_reports_for_locations,
// migration 0100) instead of one query per location -- returns the most
// recent FINALIZED report per location_id, reading only
// food_safety_cleaning_reports (immutable, completed reports), never the
// live/in-progress food_safety_cleaning_checklists.
async function loadLatestReportsByLocation(
  organizationId: string,
  locationIds: string[]
): Promise<Map<string, LatestReportInfo>> {
  const map = new Map<string, LatestReportInfo>();
  if (locationIds.length === 0) return map;

  const { data, error } = await supabase.rpc("food_safety_latest_reports_for_locations", {
    p_organization_id: organizationId,
    p_location_ids: locationIds
  });

  if (error) {
    throw new Error(error.message);
  }

  for (const row of (data ?? []) as LatestReportRow[]) {
    map.set(row.location_id, { completedAt: row.completed_at, completedByInitials: row.completed_by_initials });
  }

  return map;
}

// The set of `${frequency}:${periodKey}` signatures (see
// reportGeneration.ts's periodSignature) that already have at least one
// finalized report, restricted to the locations asked for. Reads only
// food_safety_cleaning_reports (immutable), so an in-progress "Complete
// Another Report" attempt never itself counts here -- only a PRIOR
// completed attempt does, which is exactly what should trigger the
// mobile client's duplicate-report confirmation dialog.
async function loadReportedPeriodSignaturesByLocation(
  organizationId: string,
  locationIds: string[],
  periodSignatures: string[]
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (locationIds.length === 0 || periodSignatures.length === 0) return map;

  const { data, error } = await supabase
    .from("food_safety_cleaning_reports")
    .select("location_id, period_signature")
    .eq("organization_id", organizationId)
    .in("location_id", locationIds)
    .in("period_signature", periodSignatures);

  if (error) {
    throw new Error(error.message);
  }

  for (const row of (data ?? []) as { location_id: string | null; period_signature: string }[]) {
    if (!row.location_id) continue;
    const set = map.get(row.location_id) ?? new Set<string>();
    set.add(row.period_signature);
    map.set(row.location_id, set);
  }

  return map;
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

  const locationIdList = activeLocations.map((l) => l.id);

  // Every possible frequency's signature for the current reference date --
  // used to detect "does this location already have a finalized report for
  // its own current period", regardless of which frequency that location
  // actually uses.
  const periodSignatures = (Object.entries(periodKeyByType) as [ChecklistPeriodType, string][]).map(
    ([periodType, periodKey]) => `${periodType}:${periodKey}`
  );

  const [{ data: checklists, error: checklistsError }, latestReportsByLocation, reportedPeriodsByLocation] = await Promise.all([
    supabase
      .from("food_safety_cleaning_checklists")
      .select(
        "id, location_id, attempt_number, status, completed_at, completed_by_name, completed_by_initials, period_type, period_key"
      )
      .eq("organization_id", organizationId)
      .in("location_id", locationIdList)
      .in("period_key", Array.from(new Set(Object.values(periodKeyByType)))),
    loadLatestReportsByLocation(organizationId, locationIdList),
    loadReportedPeriodSignaturesByLocation(organizationId, locationIdList, periodSignatures)
  ]);

  if (checklistsError) {
    throw new Error(checklistsError.message);
  }

  // Belt-and-suspenders: only keep checklists whose period_key matches the
  // *current* period for its own period_type (the broad period_key filter
  // above is just to keep the query cheap). A location can now have more
  // than one row per period_type/period_key (one per "attempt" -- see
  // migration 0101), so this is further reduced to the latest attempt of
  // each period_type per location below.
  const currentPeriodChecklists = ((checklists ?? []) as (ChecklistRow & { period_type: ChecklistPeriodType; period_key: string })[])
    .filter((c) => c.period_key === periodKeyByType[c.period_type]);

  const checklistsByLocationRaw = new Map<string, (ChecklistRow & { period_type: ChecklistPeriodType; period_key: string })[]>();
  for (const checklist of currentPeriodChecklists) {
    const list = checklistsByLocationRaw.get(checklist.location_id) ?? [];
    list.push(checklist);
    checklistsByLocationRaw.set(checklist.location_id, list);
  }

  const currentChecklists = Array.from(checklistsByLocationRaw.values()).flatMap((list) => reduceToLatestAttempts(list));

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

    const latestReport = latestReportsByLocation.get(location.id);

    const locationPeriodSignature = `${location.frequency}:${periodKeyByType[location.frequency]}`;
    const reportAlreadyLoggedForPeriod = reportedPeriodsByLocation.get(location.id)?.has(locationPeriodSignature) ?? false;

    return {
      id: location.id,
      name: location.name,
      area: location.area,
      frequency: location.frequency,
      mobileInstructions: location.mobile_instructions,
      isComplete,
      completedAt: isComplete ? lastCompleted?.completed_at ?? null : null,
      completedByName: isComplete ? lastCompleted?.completed_by_name ?? null : null,
      completedByInitials: isComplete ? lastCompleted?.completed_by_initials ?? null : null,
      lastCompletedAt: latestReport?.completedAt ?? null,
      lastCompletedByInitials: latestReport?.completedByInitials ?? null,
      reportAlreadyLoggedForPeriod,
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
    // reportDate only means anything for a single-location request (the
    // detail page's long-press date selector) — the multi-location list view
    // never sends it, and it's ignored if it somehow did.
    const rawReportDate = locationId && typeof req.query.reportDate === "string" ? req.query.reportDate : undefined;

    let referenceDate: Date | undefined;

    if (rawReportDate) {
      try {
        referenceDate = validateReportDate(rawReportDate).referenceDate;
      } catch (error) {
        return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid report date." });
      }
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

// "Complete Another Report" — starts a fresh checklist attempt for a
// location whose current (or backdated) period is already complete, so a
// second (or third) full report can be logged for the same location/date
// (e.g. a packline swab test that failed and needs a re-clean + re-test).
// Only callable once that period's latest attempt is actually complete; the
// underlying RPC enforces that itself (errcode GL002) even if two requests
// race. reportDate is re-validated from scratch here — the client's date is
// never trusted — and works identically whether it names today or a past
// period: there is no separate "already reported" hard block for backdated
// dates (that used to 409 here and in GET/`/complete`, which meant simply
// navigating the date picker into an already-completed week/month/year
// bounced you straight back with no way to view or add to it — see the
// weekly-frequency bug report this was fixed for). A location's period
// identity (period_type + period_key) is derived the same way regardless of
// how the date was reached, so this is exactly the same flow as "today".
mobileCleaningChecklistRouter.post(
  "/food-safety/mobile/cleaning-checklist/locations/:locationId/new-attempt",
  canUseMobileFoodSafety,
  async (req, res) => {
    const organizationId = req.organizationId;
    const locationId = String(req.params.locationId);
    const rawReportDate = (req.body as Record<string, unknown> | undefined)?.reportDate;

    let referenceDate: Date | undefined;
    if (typeof rawReportDate === "string") {
      try {
        referenceDate = validateReportDate(rawReportDate).referenceDate;
      } catch (error) {
        return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid report date." });
      }
    }

    const { data: location, error: locationError } = await supabase
      .from("food_safety_cleaning_locations")
      .select("frequency")
      .eq("id", locationId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (locationError) {
      return sendSafeError(res, 500, "Failed to load this location.", "New-attempt location lookup error:", locationError);
    }
    if (!location) {
      return res.status(404).json({ message: "This location could not be found." });
    }

    const frequency = (location as { frequency: ChecklistPeriodType }).frequency;
    const periodKey = computePeriodKey(frequency, referenceDate ?? new Date());

    const { error: rpcError } = await supabase.rpc("food_safety_start_new_checklist_attempt", {
      p_organization_id: organizationId,
      p_location_id: locationId,
      p_period_type: frequency,
      p_period_key: periodKey
    });

    if (rpcError) {
      if (rpcError.code === "GL002") {
        return res.status(409).json({ message: "A checklist is already in progress for this location." });
      }
      return sendSafeError(res, 500, "Failed to start a new report for this location.", "New-attempt error:", rpcError);
    }

    return respondWithReloadedLocation(req, res, organizationId, locationId, referenceDate);
  }
);

// "Complete Location" — the only way a checklist is ever finalized. No
// validation of checkbox state: whatever is currently checked/unchecked
// across every currently-due item (across every frequency in use at this
// location) is what gets locked in and reported. An optional reportDate
// (the mobile long-press date selector's choice) is re-validated here from
// scratch — the client's date is never trusted. Completing an already-
// complete period (same-day resubmission or reaching a past period whose
// latest attempt is already done) is a safe no-op here: both the RPC and
// maybeCreateReport are idempotent per checklist attempt, not per date — see
// /new-attempt above for how a genuinely new attempt gets created.
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
