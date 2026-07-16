export type FoodSafetyFormTemplateRow = {
  id: string;
  organization_id: string;
  department_id: string | null;
  name: string;
  description: string | null;
  form_code: string | null;
  canadagap_section: string | null;
  instructions: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type FoodSafetyFormTemplateVersionStatus = "draft" | "published" | "archived";

export type FoodSafetyFormTemplateVersionRow = {
  id: string;
  organization_id: string;
  template_id: string;
  version_number: number;
  status: FoodSafetyFormTemplateVersionStatus;
  schema_json: unknown;
  version_notes: string | null;
  created_by_user_id: string | null;
  published_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

// The list/history views never need the (potentially large) schema_json blob.
export type FoodSafetyFormTemplateVersionSummary = Omit<FoodSafetyFormTemplateVersionRow, "schema_json">;

// ── Phase 3: records, revisions, audit events, changes ──────────────────────

export type FoodSafetyRecordStatus = "draft" | "submitted" | "verified" | "rejected" | "amended";

export type FoodSafetyRecordRow = {
  id: string;
  organization_id: string;
  template_id: string;
  template_version_id: string;
  department_id: string | null;
  location_id: string | null;
  status: FoodSafetyRecordStatus;
  answers_json: Record<string, unknown>;
  record_date: string;
  started_at: string;
  submitted_at: string | null;
  verified_at: string | null;
  rejected_at: string | null;
  completed_by_employee_id: string | null;
  completed_by_user_id: string | null;
  verified_by_employee_id: string | null;
  verified_by_user_id: string | null;
  rejected_by_user_id: string | null;
  rejection_reason: string | null;
  current_revision_number: number;
  created_at: string;
  updated_at: string;
};

export type FoodSafetyRecordRevisionRow = {
  id: string;
  organization_id: string;
  record_id: string;
  revision_number: number;
  status_snapshot: string;
  answers_snapshot: Record<string, unknown>;
  template_schema_snapshot: unknown;
  metadata_snapshot: Record<string, unknown>;
  reason: string | null;
  created_by_user_id: string | null;
  created_by_employee_id: string | null;
  created_at: string;
};

export type FoodSafetyRecordAuditEventRow = {
  id: string;
  organization_id: string;
  record_id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_employee_id: string | null;
  event_metadata: Record<string, unknown>;
  created_at: string;
};

export type FoodSafetyRecordChangeRow = {
  id: string;
  organization_id: string;
  record_id: string;
  from_revision_number: number;
  to_revision_number: number;
  field_id: string | null;
  old_value: unknown;
  new_value: unknown;
  change_reason: string;
  changed_by_user_id: string | null;
  changed_by_employee_id: string | null;
  created_at: string;
};

export type EmployeeRow = {
  id: string;
  organization_id: string;
  employee_code: string | null;
  first_name: string;
  last_name: string;
  display_name: string;
  active: boolean;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};
