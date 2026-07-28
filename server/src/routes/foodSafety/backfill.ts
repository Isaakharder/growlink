import { randomUUID } from "node:crypto";
import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission } from "../../middleware/requirePermission";
import { resolveActor } from "./services/actorIdentity";
import { todayInOrgTimezone } from "./services/checklistPeriod";
import { DEFAULT_ORG_TIMEZONE } from "../../config/orgTimezone";
import {
  buildColumns,
  buildManualGeneratedDays,
  columnKeyFor,
  datesFromCompletedAt,
  daysBetweenIsoInclusive,
  dateToDayIndex,
  parseTimeToMinutes,
  responseValueFor,
  type BackfillFrequency,
  type BackfillTaskInput
} from "./services/backfillGeneration";

const MAX_RANGE_DAYS = 400;
const MAX_UNIQUE_DATES = 1000;
const MAX_TASK_SELECTIONS = 5000;

type LocationRow = {
  id: string;
  name: string;
  area: string;
  frequency: BackfillFrequency;
  is_active: boolean;
};

type TaskRow = {
  id: string;
  name: string;
  response_type: BackfillTaskInput["responseType"];
  action_labels: string[] | null;
  sort_order: number;
};

type BackfillRequestBody = {
  locationId: string;
  startDate: string;
  endDate: string;
  earliestTime: string;
  latestTime: string;
  taskDates: Record<string, string[]>;
};

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateBody(input: unknown): BackfillRequestBody {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }
  const body = input as Record<string, unknown>;

  const locationId = typeof body.locationId === "string" ? body.locationId.trim() : "";
  if (!locationId) throw new Error("Location is required");

  if (!isIsoDate(body.startDate)) throw new Error("Start date is required");
  if (!isIsoDate(body.endDate)) throw new Error("End date is required");
  const startDate = body.startDate;
  const endDate = body.endDate;

  const rangeDays = daysBetweenIsoInclusive(startDate, endDate);
  if (rangeDays <= 0) throw new Error("End date must be on or after the start date.");
  if (rangeDays > MAX_RANGE_DAYS) throw new Error(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`);

  if (typeof body.earliestTime !== "string") throw new Error("Earliest completion time is required");
  if (typeof body.latestTime !== "string") throw new Error("Latest completion time is required");
  const earliestMinutes = parseTimeToMinutes(body.earliestTime);
  const latestMinutes = parseTimeToMinutes(body.latestTime);
  if (latestMinutes < earliestMinutes) {
    throw new Error("Latest completion time must be on or after the earliest completion time.");
  }

  const rawTaskDates = body.taskDates && typeof body.taskDates === "object" ? (body.taskDates as Record<string, unknown>) : {};
  const today = todayInOrgTimezone();
  const startIdx = dateToDayIndex(startDate);
  const endIdx = dateToDayIndex(endDate);
  const todayIdx = dateToDayIndex(today);

  const taskDates: Record<string, string[]> = {};
  let totalSelections = 0;
  const uniqueDates = new Set<string>();

  for (const [columnKey, rawDates] of Object.entries(rawTaskDates)) {
    if (!Array.isArray(rawDates)) continue;
    const dates: string[] = [];
    for (const rawDate of rawDates) {
      if (!isIsoDate(rawDate)) throw new Error(`Invalid date: ${String(rawDate)}`);
      const idx = dateToDayIndex(rawDate);
      if (idx > todayIdx) throw new Error(`${rawDate} is a future date and cannot be used for a historical backfill.`);
      if (idx < startIdx || idx > endIdx) throw new Error(`${rawDate} is outside the selected date range.`);
      dates.push(rawDate);
      uniqueDates.add(rawDate);
    }
    if (dates.length > 0) {
      taskDates[columnKey] = dates;
      totalSelections += dates.length;
    }
  }

  if (totalSelections === 0) {
    throw new Error("Select at least one date for at least one task.");
  }
  if (totalSelections > MAX_TASK_SELECTIONS) {
    throw new Error(`Too many task/date selections (max ${MAX_TASK_SELECTIONS}).`);
  }
  if (uniqueDates.size > MAX_UNIQUE_DATES) {
    throw new Error(`Too many unique dates selected (max ${MAX_UNIQUE_DATES}).`);
  }

  return { locationId, startDate, endDate, earliestTime: body.earliestTime, latestTime: body.latestTime, taskDates };
}

async function loadLocationWithTasks(organizationId: string, locationId: string) {
  const { data: location, error: locationError } = await supabase
    .from("food_safety_cleaning_locations")
    .select("id, name, area, frequency, is_active")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (locationError) throw new Error(locationError.message);
  if (!location || !(location as LocationRow).is_active) {
    throw new Error("Selected location was not found or is not active.");
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .select("id, name, response_type, action_labels, sort_order")
    .eq("organization_id", organizationId)
    .eq("location_id", locationId)
    .order("sort_order", { ascending: true });

  if (tasksError) throw new Error(tasksError.message);

  const taskInputs: BackfillTaskInput[] = ((tasks ?? []) as TaskRow[]).map((t) => ({
    id: t.id,
    name: t.name,
    responseType: t.response_type,
    actionLabels: t.action_labels,
    sortOrder: t.sort_order
  }));

  return { location: location as LocationRow, tasks: taskInputs };
}

async function loadExistingDates(organizationId: string, locationId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("food_safety_cleaning_reports")
    .select("completed_at")
    .eq("organization_id", organizationId)
    .eq("location_id", locationId);

  if (error) throw new Error(error.message);

  return datesFromCompletedAt((data ?? []).map((r) => r.completed_at as string), DEFAULT_ORG_TIMEZONE);
}

const backfillRouter = Router();

// Backfilling creates real historical records — write-level access only,
// same gate cleaningLocations.ts uses for editing (not the view-only gate).
const canEdit = requirePermission("food_safety:edit");

backfillRouter.get("/food-safety/backfill/members", canEdit, async (req, res) => {
  const organizationId = req.organizationId;

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load organization members.", "Backfill members fetch error:", error);
  }

  try {
    const members = await Promise.all(
      (memberships ?? []).map(async (m) => {
        try {
          const actor = await resolveActor(m.user_id as string);
          return { userId: actor.userId, name: actor.name, initials: actor.initials };
        } catch {
          return null;
        }
      })
    );

    return res.json(members.filter((m): m is { userId: string; name: string; initials: string } => m !== null));
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load organization members.", "Backfill members resolve error:", error);
  }
});

// Every date this location already has a completed report for (any source),
// in the organization timezone — used by the calendar to disable/mark
// existing dates the instant a location is picked, before any preview is run.
backfillRouter.get("/food-safety/backfill/existing-dates", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const locationId = typeof req.query.locationId === "string" ? req.query.locationId.trim() : "";

  if (!locationId) {
    return res.status(400).json({ message: "locationId is required." });
  }

  try {
    const existingDates = await loadExistingDates(organizationId, locationId);
    return res.json({ dates: Array.from(existingDates).sort() });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load existing report dates.", "Backfill existing-dates error:", error);
  }
});

backfillRouter.post("/food-safety/backfill/preview", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let body: BackfillRequestBody;

  try {
    body = validateBody(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  try {
    const { location, tasks } = await loadLocationWithTasks(organizationId, body.locationId);
    if (tasks.length === 0) {
      return res.status(400).json({ message: "This location has no cleaning tasks configured." });
    }

    const columns = buildColumns(tasks, location.frequency);
    const columnKeys = new Set(columns.map((c) => columnKeyFor(c)));

    const existingDates = await loadExistingDates(organizationId, body.locationId);

    const taskDatesByColumnKey = new Map<string, Set<string>>();
    const allSelectedDates = new Set<string>();
    let taskSelectionCount = 0;

    for (const [columnKey, dates] of Object.entries(body.taskDates)) {
      if (!columnKeys.has(columnKey)) continue; // stale/unknown column — ignore defensively
      const filtered = dates.filter((d) => !existingDates.has(d));
      if (filtered.length === 0) continue;
      taskDatesByColumnKey.set(columnKey, new Set(filtered));
      taskSelectionCount += filtered.length;
      for (const d of filtered) allSelectedDates.add(d);
    }

    const totalRequestedDates = new Set(Object.values(body.taskDates).flat());
    const skippedExisting = Array.from(totalRequestedDates).filter((d) => existingDates.has(d)).length;

    if (allSelectedDates.size === 0) {
      return res.json({
        summary: {
          locationName: location.name,
          dateRange: { start: body.startDate, end: body.endDate },
          dailyReportCount: 0,
          taskSelectionCount: 0,
          skippedExisting,
          timeWindow: { earliest: body.earliestTime, latest: body.latestTime }
        },
        taskColumns: columns.map((c) => ({ key: columnKeyFor(c), taskId: c.taskId, name: c.name, actionLabel: c.actionLabel })),
        days: []
      });
    }

    const earliestMinutes = parseTimeToMinutes(body.earliestTime);
    const latestMinutes = parseTimeToMinutes(body.latestTime);

    const uniqueDates = Array.from(allSelectedDates).sort();

    const days = buildManualGeneratedDays({
      uniqueDates,
      columns,
      taskDatesByColumnKey,
      earliestMinutes,
      latestMinutes,
      timeZone: DEFAULT_ORG_TIMEZONE
    });

    return res.json({
      summary: {
        locationName: location.name,
        dateRange: { start: body.startDate, end: body.endDate },
        dailyReportCount: days.length,
        taskSelectionCount,
        skippedExisting,
        timeWindow: { earliest: body.earliestTime, latest: body.latestTime }
      },
      taskColumns: columns.map((c) => ({ key: columnKeyFor(c), taskId: c.taskId, name: c.name, actionLabel: c.actionLabel })),
      days: days.map((day) => ({
        date: day.date,
        completedAtIso: day.completedAtIso,
        checks: Object.fromEntries(day.results.map((r) => [columnKeyFor(r), r.checked]))
      }))
    });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to generate backfill preview.", "Backfill preview error:", error);
  }
});

backfillRouter.post("/food-safety/backfill/create", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let body: BackfillRequestBody;

  try {
    body = validateBody(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const completedByUserId =
    typeof (req.body as Record<string, unknown>).completedByUserId === "string"
      ? ((req.body as Record<string, unknown>).completedByUserId as string).trim()
      : "";
  if (!completedByUserId) {
    return res.status(400).json({ message: "Completed By employee is required." });
  }

  try {
    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("user_id", completedByUserId)
      .maybeSingle();

    if (membershipError) throw new Error(membershipError.message);
    if (!membership) {
      return res.status(400).json({ message: "Selected employee is not a member of this organization." });
    }

    const actor = await resolveActor(completedByUserId);

    const { location, tasks } = await loadLocationWithTasks(organizationId, body.locationId);
    if (tasks.length === 0) {
      return res.status(400).json({ message: "This location has no cleaning tasks configured." });
    }

    const columns = buildColumns(tasks, location.frequency);
    const columnKeys = new Set(columns.map((c) => columnKeyFor(c)));

    // Re-checked fresh against the database — a date that was available when
    // last previewed could have been completed for real in the meantime.
    const existingDates = await loadExistingDates(organizationId, body.locationId);

    const taskDatesByColumnKey = new Map<string, Set<string>>();
    const allSelectedDates = new Set<string>();

    for (const [columnKey, dates] of Object.entries(body.taskDates)) {
      if (!columnKeys.has(columnKey)) continue;
      const filtered = dates.filter((d) => !existingDates.has(d));
      if (filtered.length === 0) continue;
      taskDatesByColumnKey.set(columnKey, new Set(filtered));
      for (const d of filtered) allSelectedDates.add(d);
    }

    const totalRequestedDates = new Set(Object.values(body.taskDates).flat());
    const skippedExisting = Array.from(totalRequestedDates).filter((d) => existingDates.has(d)).length;

    if (allSelectedDates.size === 0) {
      return res.json({ batchId: null, created: 0, skipped: skippedExisting });
    }

    const earliestMinutes = parseTimeToMinutes(body.earliestTime);
    const latestMinutes = parseTimeToMinutes(body.latestTime);
    const uniqueDates = Array.from(allSelectedDates).sort();

    const days = buildManualGeneratedDays({
      uniqueDates,
      columns,
      taskDatesByColumnKey,
      earliestMinutes,
      latestMinutes,
      timeZone: DEFAULT_ORG_TIMEZONE
    });

    const batchId = randomUUID();
    const generatedAt = new Date().toISOString();

    const reportRows = days.map((day) => ({
      organization_id: organizationId,
      location_id: body.locationId,
      location_name_snapshot: location.name,
      location_area_snapshot: location.area,
      period_signature: `backfill:${day.date}`,
      // Backfilled reports have no real checklist to derive an id-based
      // signature from (see reportGeneration.ts's buildChecklistSignature),
      // so they reuse their own already-unique period_signature value as
      // their checklist_signature -- this is what the upsert below is keyed
      // on since migration 0101 replaced the reports table's uniqueness
      // constraint from (location_id, period_signature) to
      // (location_id, checklist_signature).
      checklist_signature: `backfill:${day.date}`,
      task_count: day.results.length,
      completed_at: day.completedAtIso,
      completed_by_user_id: completedByUserId,
      completed_by_name: actor.name,
      completed_by_initials: actor.initials,
      source: "backfill",
      generated_by_user_id: req.userId ?? null,
      generated_at: generatedAt,
      backfill_batch_id: batchId
    }));

    const { data: insertedReports, error: reportsError } = await supabase
      .from("food_safety_cleaning_reports")
      .upsert(reportRows, { onConflict: "location_id,checklist_signature", ignoreDuplicates: true })
      .select("id, period_signature");

    if (reportsError) {
      return sendSafeError(res, 500, "Failed to create backfill records.", "Backfill reports insert error:", reportsError);
    }

    const insertedByDate = new Map((insertedReports ?? []).map((r) => [r.period_signature.replace("backfill:", ""), r.id]));

    const reportItemRows = days.flatMap((day) => {
      const reportId = insertedByDate.get(day.date);
      if (!reportId) return [];
      return day.results.map((result) => ({
        organization_id: organizationId,
        report_id: reportId,
        task_name_snapshot: result.name,
        frequency_snapshot: result.frequency,
        response_type_snapshot: result.responseType,
        action_label_snapshot: result.actionLabel,
        response_value: responseValueFor(result.responseType, result.checked),
        sort_order: result.sortOrder,
        checked_at: result.checked ? day.completedAtIso : null,
        checked_by_user_id: result.checked ? completedByUserId : null,
        checked_by_name: result.checked ? actor.name : null,
        checked_by_initials: result.checked ? actor.initials : null
      }));
    });

    if (reportItemRows.length > 0) {
      const { error: itemsError } = await supabase.from("food_safety_cleaning_report_items").insert(reportItemRows);
      if (itemsError) {
        return sendSafeError(res, 500, "Failed to save backfill task records.", "Backfill report items insert error:", itemsError);
      }
    }

    const createdCount = insertedReports?.length ?? 0;
    return res.status(201).json({
      batchId,
      created: createdCount,
      skipped: skippedExisting + (days.length - createdCount)
    });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to create backfill records.", "Backfill create error:", error);
  }
});

export { backfillRouter };
