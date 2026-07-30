import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { resolveActor } from "../foodSafety/services/actorIdentity";
import { todayInOrgTimezone } from "../foodSafety/services/checklistPeriod";
import { loadDeviceDetail } from "./devices";
import { addCalibrationInterval } from "./services/dueScheduling";
import { validateEffectiveDate } from "./services/effectiveDate";
import { buildFlatAnswerSnapshots, buildRepeatingRows, CalibrationValidationError } from "./services/validation";
import { AnswerSnapshot, FieldAnswerInput, RepeatingRowInput, Task, TaskStampedAnswerSnapshot, TemplateField } from "./services/types";

const recordsRouter = Router();

const canView = requireAnyPermission(["calibration:view", "calibration:edit"]);
const canComplete = requireAnyPermission(["calibration:edit", "mobile:calibration"]);

function toAnswerSnapshotRow(a: AnswerSnapshot) {
  return {
    template_field_id: a.template_field_id,
    field_label_snapshot: a.field_label_snapshot,
    field_type_snapshot: a.field_type_snapshot,
    help_text_snapshot: a.help_text_snapshot,
    placeholder_snapshot: a.placeholder_snapshot,
    unit_snapshot: a.unit_snapshot,
    min_value_snapshot: a.min_value_snapshot,
    max_value_snapshot: a.max_value_snapshot,
    decimal_precision_snapshot: a.decimal_precision_snapshot,
    choice_options_snapshot: a.choice_options_snapshot,
    is_required_snapshot: a.is_required_snapshot,
    sort_order: a.sort_order,
    value_text: a.value_text,
    value_number: a.value_number,
    value_boolean: a.value_boolean,
    value_date: a.value_date,
    value_choices: a.value_choices,
    is_within_range: a.is_within_range
  };
}

// Non-repeating tasks' flat answers additionally carry task context so the
// record detail view can group them back under their task card.
function toTaskAnswerSnapshotRow(a: TaskStampedAnswerSnapshot) {
  return {
    ...toAnswerSnapshotRow(a),
    task_id: a.task_id,
    task_name_snapshot: a.task_name_snapshot,
    task_sort_order: a.task_sort_order
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

recordsRouter.post("/pest/calibration/devices/:id/complete", canComplete, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const deviceId = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!userId) {
    return res.status(401).json({ message: "Authentication is required." });
  }

  // Client-generated once per completion attempt and resent unchanged on
  // any retry of that same attempt — see 0104's migration comment. Required:
  // there is no server-side fallback, since a server-generated id would be
  // different on every retry and defeat the whole point.
  const completionRequestId = typeof body.completion_request_id === "string" ? body.completion_request_id : "";
  if (!UUID_PATTERN.test(completionRequestId)) {
    return res.status(400).json({ message: "A valid completion_request_id is required." });
  }

  let detail;
  try {
    detail = await loadDeviceDetail(organizationId, deviceId);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load device.", "Calibration complete device-load error:", error);
  }
  if (!detail) return res.status(404).json({ message: "Device not found." });
  if (!detail.device.is_active) {
    return res.status(400).json({ message: "This device is archived and cannot be calibrated." });
  }
  if (!detail.template || detail.tasks.length === 0) {
    return res.status(400).json({ message: "This device has no calibration form configured yet." });
  }

  // effectiveDate is the (possibly backdated) date the calibration was
  // actually performed, chosen via the mobile long-press date selector —
  // never trusted as-is. Omitted entirely (older/desktop clients) defaults
  // to today; present-but-invalid is a hard 400, not a silent fallback.
  const rawEffectiveDate = typeof body.effectiveDate === "string" ? body.effectiveDate : undefined;
  let effectiveDate;
  try {
    effectiveDate = validateEffectiveDate(rawEffectiveDate ?? todayInOrgTimezone());
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid calibration date." });
  }

  const answersInput: FieldAnswerInput[] = Array.isArray(body.answers) ? (body.answers as FieldAnswerInput[]) : [];
  const rowsInput: RepeatingRowInput[] = Array.isArray(body.repeating_rows) ? (body.repeating_rows as RepeatingRowInput[]) : [];

  let flatAnswers: TaskStampedAnswerSnapshot[];
  let repeatingRows;
  try {
    flatAnswers = buildFlatAnswerSnapshots(detail.tasks as Task[], detail.fields as TemplateField[], answersInput);
    repeatingRows = buildRepeatingRows(detail.tasks as Task[], detail.fields as TemplateField[], rowsInput);
  } catch (error) {
    if (error instanceof CalibrationValidationError) {
      return res.status(400).json({ message: error.message });
    }
    return sendSafeError(res, 500, "Failed to validate calibration answers.", "Calibration validation error:", error);
  }

  let actorName: string;
  try {
    actorName = (await resolveActor(userId)).name;
  } catch (error) {
    return sendSafeError(res, 500, "Failed to resolve the logged-in user.", "Calibration actor resolution error:", error);
  }

  // The submission instant — stored as-is on the record's completed_at
  // (never backdated, so the audit trail always shows real entry time).
  const completedAt = new Date();

  // The next-due calculation must be anchored to the performed date, not
  // the entry timestamp — a quarterly device performed July 15 but entered
  // July 30 is next due October 15, not October 30 (effectiveDate.referenceDate
  // is noon on the performed date in the org timezone).
  const nextDueAt = addCalibrationInterval(
    effectiveDate.referenceDate,
    detail.device.frequency_type,
    detail.device.custom_interval_value,
    detail.device.custom_interval_unit
  );

  const { data: recordId, error: rpcError } = await supabase.rpc("pest_calibration_complete_record", {
    p_organization_id: organizationId,
    p_device_id: detail.device.id,
    p_template_id: detail.template.id,
    p_completion_request_id: completionRequestId,
    p_device_name_snapshot: detail.device.name,
    p_device_identification_number_snapshot: detail.device.identification_number,
    p_device_area_snapshot: detail.device.area,
    p_device_frequency_snapshot: {
      frequency_type: detail.device.frequency_type,
      custom_interval_value: detail.device.custom_interval_value,
      custom_interval_unit: detail.device.custom_interval_unit
    },
    p_instructions_snapshot: detail.device.instructions ?? null,
    p_effective_date: effectiveDate.dateStr,
    p_completed_by_user_id: userId,
    p_completed_by_name: actorName,
    p_completed_at: completedAt.toISOString(),
    p_next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
    p_answers: flatAnswers.map(toTaskAnswerSnapshotRow),
    p_repeating_rows: repeatingRows.map((row) => ({
      row: {
        task_id: row.task_id,
        task_name_snapshot: row.task_name_snapshot,
        task_sort_order: row.task_sort_order,
        row_index: row.row_index
      },
      answers: row.answers.map(toAnswerSnapshotRow)
    }))
  });

  if (rpcError) {
    return sendSafeError(res, 500, "Failed to save calibration record.", "Calibration complete RPC error:", rpcError);
  }

  // Re-fetch the actual stored row rather than trusting the locally
  // computed `nextDueAt` above — on a retry/double-submit, the RPC
  // short-circuits to the ORIGINAL record (see 0104), which may have been
  // computed from different device data if something changed between the
  // original attempt and this retry. The response must always reflect
  // what's actually in the database, not a fresh recomputation.
  const { data: savedRecord, error: fetchError } = await supabase
    .from("pest_calibration_records")
    .select("next_due_at, effective_date")
    .eq("id", recordId)
    .single();

  if (fetchError || !savedRecord) {
    return sendSafeError(res, 500, "Calibration saved, but failed to load the confirmation.", "Calibration complete re-fetch error:", fetchError);
  }

  return res.status(201).json({
    record_id: recordId,
    next_due_at: savedRecord.next_due_at,
    effective_date: savedRecord.effective_date
  });
});

// Lets the mobile long-press date picker warn "a record already exists for
// this date" before submitting, per the same UX as Food Safety's
// reportAlreadyLoggedForPeriod check — but computed on demand here rather
// than preloaded, since the employee can pick any of the last 300 days,
// not just "today"/"this period". Deliberately does NOT block submission —
// the server still allows a second record for the same device+date (each
// completion is its own immutable row; there is no uniqueness rule here).
recordsRouter.get("/pest/calibration/devices/:id/effective-date-check", canComplete, async (req, res) => {
  const organizationId = req.organizationId;
  const deviceId = String(req.params.id);
  const rawDate = req.query.date;

  let effectiveDate;
  try {
    effectiveDate = validateEffectiveDate(rawDate);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid calibration date." });
  }

  const { data, error } = await supabase
    .from("pest_calibration_records")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("device_id", deviceId)
    .eq("effective_date", effectiveDate.dateStr)
    .limit(1);

  if (error) {
    return sendSafeError(res, 500, "Failed to check existing calibration records.", "Calibration date-check error:", error);
  }

  return res.json({ existing_record: (data ?? []).length > 0 });
});

const DEFAULT_RECORDS_LIMIT = 50;
const MAX_RECORDS_LIMIT = 200;

recordsRouter.get("/pest/calibration/records", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const { device_id, employee, date_from, date_to, limit, offset } = req.query;

  const parsedLimit = typeof limit === "string" ? Number(limit) : NaN;
  const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), MAX_RECORDS_LIMIT)
    : DEFAULT_RECORDS_LIMIT;

  const parsedOffset = typeof offset === "string" ? Number(offset) : NaN;
  const boundedOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;

  let query = supabase
    .from("pest_calibration_records")
    .select(
      "id, device_id, device_name_snapshot, device_area_snapshot, completed_by_user_id, completed_by_name, completed_at, created_at, effective_date, next_due_at"
    )
    .eq("organization_id", organizationId)
    // effective_date (the performed date) is the primary ordering key now —
    // completed_at/created_at/id are deterministic tiebreakers for rows
    // sharing the same effective_date (e.g. two backdated entries for the
    // same day), without which page boundaries under .range() aren't
    // stable across requests.
    .order("effective_date", { ascending: false })
    .order("completed_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(boundedOffset, boundedOffset + boundedLimit - 1);

  if (typeof device_id === "string" && device_id) query = query.eq("device_id", device_id);
  if (typeof employee === "string" && employee) query = query.eq("completed_by_user_id", employee);
  if (typeof date_from === "string" && date_from) query = query.gte("effective_date", date_from);
  if (typeof date_to === "string" && date_to) query = query.lte("effective_date", date_to);

  const { data, error } = await query;

  if (error) {
    return sendSafeError(res, 500, "Failed to load calibration records.", "Calibration records fetch error:", error);
  }

  return res.json(data ?? []);
});

recordsRouter.get("/pest/calibration/records/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data: record, error: recordError } = await supabase
    .from("pest_calibration_records")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (recordError) {
    return sendSafeError(res, 500, "Failed to load record.", "Calibration record detail error:", recordError);
  }
  if (!record) return res.status(404).json({ message: "Record not found." });

  const [{ data: answers, error: answersError }, { data: rows, error: rowsError }] = await Promise.all([
    supabase
      .from("pest_calibration_record_answers")
      .select("*")
      .eq("record_id", id)
      .order("task_sort_order", { ascending: true })
      .order("sort_order", { ascending: true }),
    supabase
      .from("pest_calibration_record_repeating_rows")
      .select("*, pest_calibration_record_repeating_answers(*)")
      .eq("record_id", id)
      .order("task_sort_order", { ascending: true })
      .order("row_index", { ascending: true })
  ]);

  if (answersError) {
    return sendSafeError(res, 500, "Failed to load record answers.", "Calibration record answers error:", answersError);
  }
  if (rowsError) {
    return sendSafeError(res, 500, "Failed to load record repeating rows.", "Calibration record rows error:", rowsError);
  }

  const repeatingRows = (rows ?? []).map((row) => {
    const { pest_calibration_record_repeating_answers, ...rest } = row as typeof row & {
      pest_calibration_record_repeating_answers: unknown[];
    };
    return {
      ...rest,
      answers: [...pest_calibration_record_repeating_answers].sort(
        (a: any, b: any) => a.sort_order - b.sort_order
      )
    };
  });

  return res.json({ ...record, answers: answers ?? [], repeating_rows: repeatingRows });
});

export { recordsRouter };
