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
