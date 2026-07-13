import { supabase } from "../../../config/supabase";
import { collectReferencedDepartmentIds, validateFormSchema, type FoodSafetyFormSchema } from "./templateSchema";
import type {
  FoodSafetyFormTemplateRow,
  FoodSafetyFormTemplateVersionRow,
  FoodSafetyFormTemplateVersionSummary
} from "../types";

// postgrest-js's literal-select-string type inference doesn't work without a
// generated Database type (this project has none — see config/supabase.ts
// and services/orgScopedTable.ts for the same rationale). Kept local to this
// file rather than exported, since callers only ever see the typed rows
// returned by the functions below.
function from(table: string) {
  return (supabase as any).from(table); // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class TemplateApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const VERSION_SUMMARY_COLUMNS =
  "id, organization_id, template_id, version_number, status, version_notes, created_by_user_id, published_by_user_id, created_at, updated_at, published_at";

export async function ensureTemplateExists(
  organizationId: string,
  templateId: string
): Promise<FoodSafetyFormTemplateRow> {
  const { data, error } = await from("food_safety_form_templates")
    .select("*")
    .eq("id", templateId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new TemplateApiError(500, "Failed to load template.");
  }
  if (!data) {
    throw new TemplateApiError(404, "Template not found.");
  }
  return data as FoodSafetyFormTemplateRow;
}

export async function listVersionSummaries(
  organizationId: string,
  templateId: string
): Promise<FoodSafetyFormTemplateVersionSummary[]> {
  const { data, error } = await from("food_safety_form_template_versions")
    .select(VERSION_SUMMARY_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("template_id", templateId)
    .order("version_number", { ascending: false });

  if (error) {
    throw new TemplateApiError(500, "Failed to load versions.");
  }
  return (data ?? []) as FoodSafetyFormTemplateVersionSummary[];
}

// Scoping by BOTH organization_id and template_id means a version id from a
// different template (even within the same org) resolves to null here,
// which routes turn into a clean 404 — this is what prevents "a version
// from another template accessed through a mismatched template URL".
export async function getVersionRow(
  organizationId: string,
  templateId: string,
  versionId: string
): Promise<FoodSafetyFormTemplateVersionRow | null> {
  const { data, error } = await from("food_safety_form_template_versions")
    .select("*")
    .eq("id", versionId)
    .eq("organization_id", organizationId)
    .eq("template_id", templateId)
    .maybeSingle();

  if (error) {
    throw new TemplateApiError(500, "Failed to load version.");
  }
  return (data as FoodSafetyFormTemplateVersionRow | null) ?? null;
}

async function getVersionOrThrow(
  organizationId: string,
  templateId: string,
  versionId: string
): Promise<FoodSafetyFormTemplateVersionRow> {
  const row = await getVersionRow(organizationId, templateId, versionId);
  if (!row) {
    throw new TemplateApiError(404, "Version not found.");
  }
  return row;
}

// Maps the food_safety_create_draft_version() Postgres function's custom
// error codes (see migration 0076) to HTTP-appropriate TemplateApiErrors.
async function callCreateDraftVersion(
  organizationId: string,
  templateId: string,
  schemaJson: unknown,
  versionNotes: string | null,
  createdByUserId: string | null
): Promise<FoodSafetyFormTemplateVersionRow> {
  const { data, error } = await (supabase as any).rpc("food_safety_create_draft_version", {
    p_organization_id: organizationId,
    p_template_id: templateId,
    p_schema_json: schemaJson,
    p_version_notes: versionNotes,
    p_created_by_user_id: createdByUserId
  });

  if (error) {
    if (error.code === "P0002") {
      throw new TemplateApiError(404, "Template not found.");
    }
    if (error.code === "23505") {
      throw new TemplateApiError(409, "A draft version already exists for this template. Edit or publish it before creating a new one.");
    }
    throw new TemplateApiError(500, "Failed to create version.");
  }

  return data as FoodSafetyFormTemplateVersionRow;
}

// Any location_asset_selector field's filterDepartmentId is a plain UUID
// stored inside schema_json, not a real foreign key — so it can't be
// enforced by a DB constraint. Checked here at save time (draft create and
// draft update) so a cross-org department can never be assigned into a
// form, matching the same rule already enforced for
// food_safety_form_templates.department_id and food_safety_locations.
async function ensureReferencedDepartmentsExist(organizationId: string, schema: FoodSafetyFormSchema): Promise<void> {
  const departmentIds = collectReferencedDepartmentIds(schema);
  if (departmentIds.length === 0) return;

  const { data, error } = await from("food_safety_departments")
    .select("id")
    .eq("organization_id", organizationId)
    .in("id", departmentIds);

  if (error) {
    throw new TemplateApiError(500, "Failed to verify referenced departments.");
  }

  const foundIds = new Set(((data ?? []) as Array<{ id: string }>).map((row) => row.id));
  const missing = departmentIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new TemplateApiError(
      400,
      "One or more location/asset selector fields reference a department that was not found in this organization."
    );
  }
}

export async function createFirstVersion(
  organizationId: string,
  templateId: string,
  schemaJsonInput: unknown,
  versionNotes: string | null,
  createdByUserId: string | null
): Promise<FoodSafetyFormTemplateVersionRow> {
  const existing = await listVersionSummaries(organizationId, templateId);
  if (existing.length > 0) {
    throw new TemplateApiError(
      409,
      "This template already has a version. Use 'create new version' to start a new draft from an existing one."
    );
  }

  const validation = validateFormSchema(schemaJsonInput);
  if (!validation.valid) {
    throw new TemplateApiError(400, validation.errors.join(" "));
  }
  await ensureReferencedDepartmentsExist(organizationId, validation.schema);

  return callCreateDraftVersion(organizationId, templateId, validation.schema, versionNotes, createdByUserId);
}

export async function updateDraftVersion(
  organizationId: string,
  templateId: string,
  versionId: string,
  schemaJsonInput: unknown,
  versionNotes: string | null | undefined
): Promise<FoodSafetyFormTemplateVersionRow> {
  const existing = await getVersionOrThrow(organizationId, templateId, versionId);

  if (existing.status !== "draft") {
    throw new TemplateApiError(409, "Published versions are immutable. Create a new version to make changes.");
  }

  const validation = validateFormSchema(schemaJsonInput);
  if (!validation.valid) {
    throw new TemplateApiError(400, validation.errors.join(" "));
  }
  await ensureReferencedDepartmentsExist(organizationId, validation.schema);

  const updates: Record<string, unknown> = { schema_json: validation.schema, updated_at: new Date().toISOString() };
  if (versionNotes !== undefined) {
    updates.version_notes = versionNotes;
  }

  const { data, error } = await from("food_safety_form_template_versions")
    .update(updates)
    .eq("id", versionId)
    .eq("organization_id", organizationId)
    .eq("template_id", templateId)
    .eq("status", "draft") // guards against a race with a concurrent publish
    .select("*")
    .maybeSingle();

  if (error) {
    throw new TemplateApiError(500, "Failed to update version.");
  }
  if (!data) {
    throw new TemplateApiError(409, "Published versions are immutable. Create a new version to make changes.");
  }

  return data as FoodSafetyFormTemplateVersionRow;
}

export async function publishVersion(
  organizationId: string,
  templateId: string,
  versionId: string,
  publishedByUserId: string | null
): Promise<FoodSafetyFormTemplateVersionRow> {
  const existing = await getVersionOrThrow(organizationId, templateId, versionId);

  if (existing.status !== "draft") {
    throw new TemplateApiError(409, "This version is not a draft and cannot be published again.");
  }

  // Re-validate defensively: the draft was validated when last saved, but
  // publishing is the point where the form becomes permanent, so we never
  // rely solely on validation performed at an earlier save.
  const validation = validateFormSchema(existing.schema_json);
  if (!validation.valid) {
    throw new TemplateApiError(400, `Cannot publish an invalid schema: ${validation.errors.join(" ")}`);
  }

  const { data, error } = await from("food_safety_form_template_versions")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      published_by_user_id: publishedByUserId,
      updated_at: new Date().toISOString()
    })
    .eq("id", versionId)
    .eq("organization_id", organizationId)
    .eq("template_id", templateId)
    .eq("status", "draft") // optimistic-concurrency guard: only one publish can ever win the race
    .select("*")
    .maybeSingle();

  if (error) {
    throw new TemplateApiError(500, "Failed to publish version.");
  }
  if (!data) {
    throw new TemplateApiError(409, "This version was already published by someone else.");
  }

  return data as FoodSafetyFormTemplateVersionRow;
}

export async function cloneVersion(
  organizationId: string,
  templateId: string,
  sourceVersionId: string,
  createdByUserId: string | null
): Promise<FoodSafetyFormTemplateVersionRow> {
  const source = await getVersionOrThrow(organizationId, templateId, sourceVersionId);

  return callCreateDraftVersion(
    organizationId,
    templateId,
    source.schema_json,
    `Cloned from version ${source.version_number}`,
    createdByUserId
  );
}
