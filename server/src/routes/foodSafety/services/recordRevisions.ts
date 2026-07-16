import { supabase } from "../../../config/supabase";
import type { FoodSafetyRecordRow } from "../types";

// See services/orgScopedTable.ts and services/templateVersioning.ts for the
// rationale — this project has no generated Database type, so postgrest-js's
// literal-select-string inference doesn't work; going through `any` here
// avoids fighting that rather than adding a schema type just for this.
function from(table: string) {
  return (supabase as any).from(table); // eslint-disable-line @typescript-eslint/no-explicit-any
}
function rpc(fn: string, params: Record<string, unknown>) {
  return (supabase as any).rpc(fn, params); // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class RecordApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Maps a Postgres function's raised exception to an HTTP-appropriate error.
// P0002 (custom, matching templateVersioning.ts's convention) = not found.
// 42501 (insufficient_privilege) = self-verification blocked — the only
// case any of the Phase 3 RPC functions raise it for, since they only ever
// INSERT into the append-only tables (never triggering the immutability
// guard's own 42501). Anything else defaults to P0001 (Postgres's default
// code for a plain `raise exception`), which in every Phase 3 function means
// "the record is not in the right status for this transition" — a conflict.
function mapRpcError(error: { code?: string; message?: string }): RecordApiError {
  if (error.code === "P0002") return new RecordApiError(404, "Record not found.");
  if (error.code === "42501") return new RecordApiError(403, error.message ?? "Not permitted.");
  if (error.message && /reason is required/i.test(error.message)) {
    return new RecordApiError(400, error.message);
  }
  return new RecordApiError(409, error.message ?? "This record cannot be changed right now.");
}

export async function getRecordRow(organizationId: string, recordId: string): Promise<FoodSafetyRecordRow | null> {
  const { data, error } = await from("food_safety_records")
    .select("*")
    .eq("id", recordId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new RecordApiError(500, "Failed to load record.");
  }
  return (data as FoodSafetyRecordRow | null) ?? null;
}

export async function getRecordOrThrow(organizationId: string, recordId: string): Promise<FoodSafetyRecordRow> {
  const record = await getRecordRow(organizationId, recordId);
  if (!record) {
    throw new RecordApiError(404, "Record not found.");
  }
  return record;
}

// ── metadata snapshot ────────────────────────────────────────────────────────
// Assembled once per lifecycle transition and stored verbatim in the
// resulting revision row, so historical audits never depend on joining back
// to department/location/employee rows that may since have been renamed,
// deactivated, or (for locations/departments) soft-removed.

export async function resolveMetadataSnapshot(
  organizationId: string,
  record: Pick<FoodSafetyRecordRow, "department_id" | "location_id" | "completed_by_employee_id" | "record_date">,
  templateInfo: { templateName: string; formCode: string | null; canadagapSection: string | null; versionNumber: number }
): Promise<Record<string, unknown>> {
  const [departmentResult, locationResult, employeeResult] = await Promise.all([
    record.department_id
      ? from("food_safety_departments").select("name").eq("id", record.department_id).eq("organization_id", organizationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    record.location_id
      ? from("food_safety_locations").select("name").eq("id", record.location_id).eq("organization_id", organizationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    record.completed_by_employee_id
      ? from("employees").select("display_name").eq("id", record.completed_by_employee_id).eq("organization_id", organizationId).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);

  return {
    templateName: templateInfo.templateName,
    formCode: templateInfo.formCode,
    canadagapSection: templateInfo.canadagapSection,
    versionNumber: templateInfo.versionNumber,
    departmentName: (departmentResult.data as { name: string } | null)?.name ?? null,
    locationName: (locationResult.data as { name: string } | null)?.name ?? null,
    employeeDisplayName: (employeeResult.data as { display_name: string } | null)?.display_name ?? null,
    recordDate: record.record_date
  };
}

// ── answer diffing (for resubmit / amend change rows) ───────────────────────

export type AnswerChange = { field_id: string; old_value: unknown; new_value: unknown };

export function computeAnswerChanges(
  oldAnswers: Record<string, unknown> | null | undefined,
  newAnswers: Record<string, unknown> | null | undefined
): AnswerChange[] {
  const keys = new Set([...Object.keys(oldAnswers ?? {}), ...Object.keys(newAnswers ?? {})]);
  const changes: AnswerChange[] = [];

  for (const key of keys) {
    const oldValue = (oldAnswers ?? {})[key] ?? null;
    const newValue = (newAnswers ?? {})[key] ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({ field_id: key, old_value: oldValue, new_value: newValue });
    }
  }

  return changes;
}

// ── lifecycle RPC wrappers ───────────────────────────────────────────────────

export async function submitRecord(params: {
  organizationId: string;
  recordId: string;
  answersJson: Record<string, unknown>;
  completedByEmployeeId: string | null;
  completedByUserId: string | null;
  requiresVerification: boolean;
  metadataSnapshot: Record<string, unknown>;
}): Promise<FoodSafetyRecordRow> {
  const { data, error } = await rpc("food_safety_submit_record", {
    p_organization_id: params.organizationId,
    p_record_id: params.recordId,
    p_answers_json: params.answersJson,
    p_completed_by_employee_id: params.completedByEmployeeId,
    p_completed_by_user_id: params.completedByUserId,
    p_requires_verification: params.requiresVerification,
    p_metadata_snapshot: params.metadataSnapshot
  });
  if (error) throw mapRpcError(error);
  return data as FoodSafetyRecordRow;
}

export async function verifyRecord(params: {
  organizationId: string;
  recordId: string;
  verifiedByUserId: string | null;
  verifiedByEmployeeId: string | null;
  metadataSnapshot: Record<string, unknown>;
}): Promise<FoodSafetyRecordRow> {
  const { data, error } = await rpc("food_safety_verify_record", {
    p_organization_id: params.organizationId,
    p_record_id: params.recordId,
    p_verified_by_user_id: params.verifiedByUserId,
    p_verified_by_employee_id: params.verifiedByEmployeeId,
    p_metadata_snapshot: params.metadataSnapshot
  });
  if (error) throw mapRpcError(error);
  return data as FoodSafetyRecordRow;
}

export async function rejectRecord(params: {
  organizationId: string;
  recordId: string;
  rejectedByUserId: string | null;
  rejectionReason: string;
  metadataSnapshot: Record<string, unknown>;
}): Promise<FoodSafetyRecordRow> {
  const { data, error } = await rpc("food_safety_reject_record", {
    p_organization_id: params.organizationId,
    p_record_id: params.recordId,
    p_rejected_by_user_id: params.rejectedByUserId,
    p_rejection_reason: params.rejectionReason,
    p_metadata_snapshot: params.metadataSnapshot
  });
  if (error) throw mapRpcError(error);
  return data as FoodSafetyRecordRow;
}

export async function resubmitRecord(params: {
  organizationId: string;
  recordId: string;
  answersJson: Record<string, unknown>;
  completedByEmployeeId: string | null;
  completedByUserId: string | null;
  requiresVerification: boolean;
  changeReason: string | null;
  changes: AnswerChange[];
  metadataSnapshot: Record<string, unknown>;
}): Promise<FoodSafetyRecordRow> {
  const { data, error } = await rpc("food_safety_resubmit_record", {
    p_organization_id: params.organizationId,
    p_record_id: params.recordId,
    p_answers_json: params.answersJson,
    p_completed_by_employee_id: params.completedByEmployeeId,
    p_completed_by_user_id: params.completedByUserId,
    p_requires_verification: params.requiresVerification,
    p_change_reason: params.changeReason,
    p_changes: params.changes,
    p_metadata_snapshot: params.metadataSnapshot
  });
  if (error) throw mapRpcError(error);
  return data as FoodSafetyRecordRow;
}

export async function amendRecord(params: {
  organizationId: string;
  recordId: string;
  answersJson: Record<string, unknown>;
  amendedByEmployeeId: string | null;
  amendedByUserId: string | null;
  reason: string;
  changes: AnswerChange[];
  metadataSnapshot: Record<string, unknown>;
}): Promise<FoodSafetyRecordRow> {
  const { data, error } = await rpc("food_safety_amend_record", {
    p_organization_id: params.organizationId,
    p_record_id: params.recordId,
    p_answers_json: params.answersJson,
    p_amended_by_employee_id: params.amendedByEmployeeId,
    p_amended_by_user_id: params.amendedByUserId,
    p_reason: params.reason,
    p_changes: params.changes,
    p_metadata_snapshot: params.metadataSnapshot
  });
  if (error) throw mapRpcError(error);
  return data as FoodSafetyRecordRow;
}

// ── history reads ────────────────────────────────────────────────────────────

export async function listRevisions(organizationId: string, recordId: string) {
  const { data, error } = await from("food_safety_record_revisions")
    .select(
      "id, organization_id, record_id, revision_number, status_snapshot, metadata_snapshot, reason, created_by_user_id, created_by_employee_id, created_at"
    )
    .eq("organization_id", organizationId)
    .eq("record_id", recordId)
    .order("revision_number", { ascending: false });

  if (error) throw new RecordApiError(500, "Failed to load revision history.");
  return data ?? [];
}

export async function getRevisionDetail(organizationId: string, recordId: string, revisionNumber: number) {
  const { data, error } = await from("food_safety_record_revisions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("record_id", recordId)
    .eq("revision_number", revisionNumber)
    .maybeSingle();

  if (error) throw new RecordApiError(500, "Failed to load revision.");
  if (!data) throw new RecordApiError(404, "Revision not found.");
  return data;
}

export async function listAuditEvents(organizationId: string, recordId: string) {
  const { data, error } = await from("food_safety_record_audit_events")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("record_id", recordId)
    .order("created_at", { ascending: false });

  if (error) throw new RecordApiError(500, "Failed to load audit events.");
  return data ?? [];
}

export async function listChanges(organizationId: string, recordId: string) {
  const { data, error } = await from("food_safety_record_changes")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("record_id", recordId)
    .order("created_at", { ascending: false });

  if (error) throw new RecordApiError(500, "Failed to load change history.");
  return data ?? [];
}

// record_created / draft_saved are logged as standalone inserts (not via an
// RPC) — see records.ts for why this is an acceptable, explicitly narrower
// atomicity bar than the five lifecycle transitions above.
export async function logAuditEvent(params: {
  organizationId: string;
  recordId: string;
  eventType: string;
  actorUserId: string | null;
  actorEmployeeId?: string | null;
  eventMetadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await from("food_safety_record_audit_events").insert({
    organization_id: params.organizationId,
    record_id: params.recordId,
    event_type: params.eventType,
    actor_user_id: params.actorUserId,
    actor_employee_id: params.actorEmployeeId ?? null,
    event_metadata: params.eventMetadata ?? {}
  });
  if (error) throw new RecordApiError(500, "Failed to log audit event.");
}
