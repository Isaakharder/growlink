import type { Request } from "express";
import { supabase } from "../../../config/supabase";
import { userHasPermission } from "./permissionCheck";
import { RecordApiError } from "./recordRevisions";
import type { EmployeeRow, FoodSafetyRecordRow } from "../types";

function from(table: string) {
  return (supabase as any).from(table); // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Never trusts an employee_id from the client without checking it belongs
// to this organization — the same rule already applied to department_id
// (Phase 1's ensureDepartmentExists) and to filterDepartmentId inside form
// schemas (Phase 2's ensureReferencedDepartmentsExist).
export async function resolveEmployee(organizationId: string, employeeId: string): Promise<EmployeeRow> {
  const { data, error } = await from("employees")
    .select("*")
    .eq("id", employeeId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new RecordApiError(500, "Failed to verify employee.");
  }
  if (!data) {
    throw new RecordApiError(400, "Selected employee was not found in this organization.");
  }
  return data as EmployeeRow;
}

export async function resolveActiveEmployee(organizationId: string, employeeId: string): Promise<EmployeeRow> {
  const employee = await resolveEmployee(organizationId, employeeId);
  if (!employee.active) {
    throw new RecordApiError(400, "Selected employee is not active.");
  }
  return employee;
}

// Draft ownership is intentionally strict: the authenticated user who
// created the draft is the only one who may edit it via PUT .../draft — not
// even owner/admin bypass this, per the Phase 3 requirement that a manager
// may VIEW but never silently change another worker's in-progress draft.
export function isDraftOwner(record: FoodSafetyRecordRow, requestingUserId: string | null): boolean {
  return requestingUserId !== null && record.completed_by_user_id === requestingUserId;
}

// A record is only visible in full to non-owners once it has left the draft
// state (per food_safety:view's "view submitted/verified/rejected records").
// Callers combine this with isDraftOwner(): a draft is visible to its
// owner OR to someone with food_safety:verify (a supervisor may look, just
// never silently edit) OR owner/admin (checked by the caller via
// usePermissions-equivalent bypass before calling this at all).
export function isDraftVisibleToNonOwner(record: FoodSafetyRecordRow): boolean {
  return record.status !== "draft";
}

// Self-verification is blocked at the database layer (see migration 0077)
// as the authoritative guarantee; this mirrors the same check so the API
// can return a clear 403 without a round trip to the RPC when possible.
export function wouldBeSelfVerification(
  record: FoodSafetyRecordRow,
  verifierUserId: string | null,
  verifierEmployeeId: string | null
): boolean {
  if (verifierUserId !== null && record.completed_by_user_id === verifierUserId) return true;
  if (verifierEmployeeId !== null && record.completed_by_employee_id === verifierEmployeeId) return true;
  return false;
}

// Shared visibility rule for record detail, revisions, and audit events:
//   - a draft is visible to its owner, or to anyone with food_safety:verify
//     (which also covers owner/admin, since requirePermission bypasses for
//     those roles regardless of which key is checked);
//   - a non-draft record is visible to any food_safety:view or
//     food_safety:verify holder (org-wide), or to a food_safety:complete-only
//     caller if it is their own record.
export async function ensureRecordViewable(req: Request, record: FoodSafetyRecordRow): Promise<void> {
  if (record.status === "draft") {
    if (isDraftOwner(record, req.userId ?? null)) return;
    if (await userHasPermission(req, "food_safety:verify")) return;
    throw new RecordApiError(403, "You do not have permission to view this draft.");
  }

  if (await userHasPermission(req, "food_safety:view")) return;
  if (await userHasPermission(req, "food_safety:verify")) return;
  if (record.completed_by_user_id !== null && record.completed_by_user_id === req.userId) return;

  throw new RecordApiError(403, "You do not have permission to view this record.");
}
