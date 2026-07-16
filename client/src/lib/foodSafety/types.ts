import type { FoodSafetyFormSchema } from "./formSchema";

export type FoodSafetyDepartment = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type FoodSafetyLocationType = "location" | "asset";

export type FoodSafetyLocation = {
  id: string;
  organization_id: string;
  department_id: string | null;
  name: string;
  description: string | null;
  location_type: FoodSafetyLocationType;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type DepartmentInput = {
  name: string;
  description?: string | null;
  active?: boolean;
  sort_order?: number;
};

export type LocationInput = {
  name: string;
  description?: string | null;
  department_id?: string | null;
  location_type?: FoodSafetyLocationType;
  active?: boolean;
  sort_order?: number;
};

export type FoodSafetyFormTemplate = {
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

// Returned only by the list endpoint — cheap-to-compute summary fields
// merged in server-side from the versions table.
export type FoodSafetyFormTemplateListItem = FoodSafetyFormTemplate & {
  latest_published_version_number: number | null;
  has_draft: boolean;
  draft_version_number: number | null;
};

export type FoodSafetyFormTemplateVersionStatus = "draft" | "published" | "archived";

export type FoodSafetyFormTemplateVersionSummary = {
  id: string;
  organization_id: string;
  template_id: string;
  version_number: number;
  status: FoodSafetyFormTemplateVersionStatus;
  version_notes: string | null;
  created_by_user_id: string | null;
  published_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export type FoodSafetyFormTemplateVersion = FoodSafetyFormTemplateVersionSummary & {
  schema_json: FoodSafetyFormSchema;
};

export type TemplateInput = {
  name: string;
  description?: string | null;
  department_id?: string | null;
  form_code?: string | null;
  canadagap_section?: string | null;
  instructions?: string | null;
  active?: boolean;
  sort_order?: number;
};

// ── Phase 3: records, revisions, audit events ───────────────────────────────

export type FoodSafetyRecordStatus = "draft" | "submitted" | "verified" | "rejected" | "amended";

export type FoodSafetyEmployee = {
  id: string;
  employee_code: string | null;
  first_name: string;
  last_name: string;
  display_name: string;
  active: boolean;
  user_id: string | null;
};

export type FoodSafetyRecord = {
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

export type FoodSafetyRecordDetail = {
  record: FoodSafetyRecord;
  schema: FoodSafetyFormSchema | null;
  versionNumber: number | null;
};

export type FoodSafetyRecordRevisionChange = {
  id: string;
  field_id: string | null;
  old_value: unknown;
  new_value: unknown;
  change_reason: string;
  changed_by_user_id: string | null;
  changed_by_employee_id: string | null;
  created_at: string;
};

export type FoodSafetyRecordRevisionSummary = {
  id: string;
  record_id: string;
  revision_number: number;
  status_snapshot: string;
  metadata_snapshot: Record<string, unknown>;
  reason: string | null;
  created_by_user_id: string | null;
  created_by_employee_id: string | null;
  created_at: string;
  changes: FoodSafetyRecordRevisionChange[];
};

export type FoodSafetyRecordAuditEvent = {
  id: string;
  record_id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_employee_id: string | null;
  event_metadata: Record<string, unknown>;
  created_at: string;
};

export type MobileFormListItem = {
  id: string;
  name: string;
  description: string | null;
  hasInstructions: boolean;
  departmentId: string | null;
  departmentName: string | null;
  latestPublishedVersionNumber: number;
};

export type CreateRecordInput = {
  template_id: string;
  department_id?: string | null;
  location_id?: string | null;
  employee_id?: string | null;
  record_date?: string | null;
};

export type RecordListFilters = {
  status?: FoodSafetyRecordStatus;
  template_id?: string;
  department_id?: string;
  employee_id?: string;
  date_from?: string;
  date_to?: string;
};
