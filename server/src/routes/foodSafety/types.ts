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
