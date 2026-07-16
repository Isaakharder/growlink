import { apiFetch } from "../api";
import type {
  CreateRecordInput,
  DepartmentInput,
  FoodSafetyDepartment,
  FoodSafetyEmployee,
  FoodSafetyFormTemplate,
  FoodSafetyFormTemplateListItem,
  FoodSafetyFormTemplateVersion,
  FoodSafetyFormTemplateVersionSummary,
  FoodSafetyLocation,
  FoodSafetyRecord,
  FoodSafetyRecordAuditEvent,
  FoodSafetyRecordDetail,
  FoodSafetyRecordRevisionSummary,
  LocationInput,
  MobileFormListItem,
  RecordListFilters,
  TemplateInput
} from "./types";
import type { FoodSafetyFormSchema } from "./formSchema";

const DEPARTMENTS_URL = "/api/food-safety/departments";
const LOCATIONS_URL = "/api/food-safety/locations";
const TEMPLATES_URL = "/api/food-safety/templates";
const RECORDS_URL = "/api/food-safety/records";
const EMPLOYEES_URL = "/api/food-safety/employees";
const MOBILE_URL = "/api/food-safety/mobile";

async function parseJsonOrThrow<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : fallbackMessage;
    throw new Error(message);
  }

  return body as T;
}

export async function listDepartments(): Promise<FoodSafetyDepartment[]> {
  const response = await apiFetch(DEPARTMENTS_URL);
  return parseJsonOrThrow<FoodSafetyDepartment[]>(response, "Failed to load departments.");
}

export async function createDepartment(input: DepartmentInput): Promise<FoodSafetyDepartment> {
  const response = await apiFetch(DEPARTMENTS_URL, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyDepartment>(response, "Failed to create department.");
}

export async function updateDepartment(id: string, input: DepartmentInput): Promise<FoodSafetyDepartment> {
  const response = await apiFetch(`${DEPARTMENTS_URL}/${id}`, { method: "PUT", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyDepartment>(response, "Failed to update department.");
}

export async function reorderDepartments(orderedIds: string[]): Promise<void> {
  const response = await apiFetch(`${DEPARTMENTS_URL}/reorder`, {
    method: "POST",
    body: JSON.stringify({ orderedIds })
  });
  await parseJsonOrThrow<{ success: boolean }>(response, "Failed to reorder departments.");
}

export async function listLocations(): Promise<FoodSafetyLocation[]> {
  const response = await apiFetch(LOCATIONS_URL);
  return parseJsonOrThrow<FoodSafetyLocation[]>(response, "Failed to load locations.");
}

export async function createLocation(input: LocationInput): Promise<FoodSafetyLocation> {
  const response = await apiFetch(LOCATIONS_URL, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyLocation>(response, "Failed to create location.");
}

export async function updateLocation(id: string, input: LocationInput): Promise<FoodSafetyLocation> {
  const response = await apiFetch(`${LOCATIONS_URL}/${id}`, { method: "PUT", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyLocation>(response, "Failed to update location.");
}

export async function reorderLocations(orderedIds: string[]): Promise<void> {
  const response = await apiFetch(`${LOCATIONS_URL}/reorder`, {
    method: "POST",
    body: JSON.stringify({ orderedIds })
  });
  await parseJsonOrThrow<{ success: boolean }>(response, "Failed to reorder locations.");
}

// ── form templates ────────────────────────────────────────────────────────

export async function listTemplates(): Promise<FoodSafetyFormTemplateListItem[]> {
  const response = await apiFetch(TEMPLATES_URL);
  return parseJsonOrThrow<FoodSafetyFormTemplateListItem[]>(response, "Failed to load form templates.");
}

export async function getTemplate(id: string): Promise<FoodSafetyFormTemplate> {
  const response = await apiFetch(`${TEMPLATES_URL}/${id}`);
  return parseJsonOrThrow<FoodSafetyFormTemplate>(response, "Failed to load form template.");
}

export async function createTemplate(input: TemplateInput): Promise<FoodSafetyFormTemplate> {
  const response = await apiFetch(TEMPLATES_URL, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyFormTemplate>(response, "Failed to create form template.");
}

export async function updateTemplate(id: string, input: TemplateInput): Promise<FoodSafetyFormTemplate> {
  const response = await apiFetch(`${TEMPLATES_URL}/${id}`, { method: "PUT", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyFormTemplate>(response, "Failed to update form template.");
}

// ── template versions ──────────────────────────────────────────────────────

export async function listTemplateVersions(templateId: string): Promise<FoodSafetyFormTemplateVersionSummary[]> {
  const response = await apiFetch(`${TEMPLATES_URL}/${templateId}/versions`);
  return parseJsonOrThrow<FoodSafetyFormTemplateVersionSummary[]>(response, "Failed to load version history.");
}

export async function getTemplateVersion(
  templateId: string,
  versionId: string
): Promise<FoodSafetyFormTemplateVersion> {
  const response = await apiFetch(`${TEMPLATES_URL}/${templateId}/versions/${versionId}`);
  return parseJsonOrThrow<FoodSafetyFormTemplateVersion>(response, "Failed to load version.");
}

export async function createFirstTemplateVersion(
  templateId: string,
  schemaJson: FoodSafetyFormSchema,
  versionNotes?: string | null
): Promise<FoodSafetyFormTemplateVersion> {
  const response = await apiFetch(`${TEMPLATES_URL}/${templateId}/versions`, {
    method: "POST",
    body: JSON.stringify({ schema_json: schemaJson, version_notes: versionNotes ?? null })
  });
  return parseJsonOrThrow<FoodSafetyFormTemplateVersion>(response, "Failed to create the first version.");
}

export async function updateTemplateVersionDraft(
  templateId: string,
  versionId: string,
  schemaJson: FoodSafetyFormSchema,
  versionNotes?: string | null
): Promise<FoodSafetyFormTemplateVersion> {
  const response = await apiFetch(`${TEMPLATES_URL}/${templateId}/versions/${versionId}`, {
    method: "PUT",
    body: JSON.stringify({ schema_json: schemaJson, version_notes: versionNotes ?? null })
  });
  return parseJsonOrThrow<FoodSafetyFormTemplateVersion>(response, "Failed to save draft.");
}

export async function publishTemplateVersion(
  templateId: string,
  versionId: string
): Promise<FoodSafetyFormTemplateVersion> {
  const response = await apiFetch(`${TEMPLATES_URL}/${templateId}/versions/${versionId}/publish`, {
    method: "POST"
  });
  return parseJsonOrThrow<FoodSafetyFormTemplateVersion>(response, "Failed to publish version.");
}

export async function cloneTemplateVersion(
  templateId: string,
  versionId: string
): Promise<FoodSafetyFormTemplateVersion> {
  const response = await apiFetch(`${TEMPLATES_URL}/${templateId}/versions/${versionId}/clone`, {
    method: "POST"
  });
  return parseJsonOrThrow<FoodSafetyFormTemplateVersion>(response, "Failed to create a new version.");
}

// ── Phase 3: employees, mobile browsing, records lifecycle ──────────────────

export async function listEmployees(): Promise<FoodSafetyEmployee[]> {
  const response = await apiFetch(EMPLOYEES_URL);
  return parseJsonOrThrow<FoodSafetyEmployee[]>(response, "Failed to load employees.");
}

export async function listMobileForms(departmentId?: string): Promise<MobileFormListItem[]> {
  const query = departmentId ? `?department_id=${encodeURIComponent(departmentId)}` : "";
  const response = await apiFetch(`${MOBILE_URL}/forms${query}`);
  return parseJsonOrThrow<MobileFormListItem[]>(response, "Failed to load available forms.");
}

export async function getMobileForm(
  templateId: string
): Promise<{ template: FoodSafetyFormTemplate; version: { id: string; version_number: number; schema_json: FoodSafetyFormSchema } }> {
  const response = await apiFetch(`${MOBILE_URL}/forms/${templateId}`);
  return parseJsonOrThrow(response, "Failed to load form.");
}

export async function createRecord(input: CreateRecordInput): Promise<FoodSafetyRecord> {
  const response = await apiFetch(RECORDS_URL, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to start record.");
}

export async function getRecord(id: string): Promise<FoodSafetyRecordDetail> {
  const response = await apiFetch(`${RECORDS_URL}/${id}`);
  return parseJsonOrThrow<FoodSafetyRecordDetail>(response, "Failed to load record.");
}

export async function updateRecordDraft(
  id: string,
  input: { answers_json: Record<string, unknown>; employee_id?: string | null }
): Promise<FoodSafetyRecord> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/draft`, { method: "PUT", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to save draft.");
}

export async function submitRecord(
  id: string,
  input: { answers_json: Record<string, unknown>; employee_id: string }
): Promise<FoodSafetyRecord> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/submit`, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to submit record.");
}

export async function verifyRecord(id: string, employeeId?: string | null): Promise<FoodSafetyRecord> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/verify`, {
    method: "POST",
    body: JSON.stringify({ employee_id: employeeId ?? null })
  });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to verify record.");
}

export async function rejectRecord(id: string, reason: string): Promise<FoodSafetyRecord> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to reject record.");
}

export async function resubmitRecord(
  id: string,
  input: { answers_json: Record<string, unknown>; employee_id: string; change_reason?: string | null }
): Promise<FoodSafetyRecord> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/resubmit`, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to resubmit record.");
}

export async function amendRecord(
  id: string,
  input: { answers_json: Record<string, unknown>; reason: string; employee_id?: string | null }
): Promise<FoodSafetyRecord> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/amend`, { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<FoodSafetyRecord>(response, "Failed to amend record.");
}

export async function listRecordRevisions(id: string): Promise<FoodSafetyRecordRevisionSummary[]> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/revisions`);
  return parseJsonOrThrow<FoodSafetyRecordRevisionSummary[]>(response, "Failed to load revision history.");
}

export async function listRecordAuditEvents(id: string): Promise<FoodSafetyRecordAuditEvent[]> {
  const response = await apiFetch(`${RECORDS_URL}/${id}/audit-events`);
  return parseJsonOrThrow<FoodSafetyRecordAuditEvent[]>(response, "Failed to load audit events.");
}

export async function listRecords(filters: RecordListFilters = {}): Promise<FoodSafetyRecord[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.template_id) params.set("template_id", filters.template_id);
  if (filters.department_id) params.set("department_id", filters.department_id);
  if (filters.employee_id) params.set("employee_id", filters.employee_id);
  if (filters.date_from) params.set("date_from", filters.date_from);
  if (filters.date_to) params.set("date_to", filters.date_to);
  const query = params.toString();
  const response = await apiFetch(`${RECORDS_URL}${query ? `?${query}` : ""}`);
  return parseJsonOrThrow<FoodSafetyRecord[]>(response, "Failed to load records.");
}

export async function listAwaitingVerification(): Promise<FoodSafetyRecord[]> {
  const response = await apiFetch(`${RECORDS_URL}/awaiting-verification`);
  return parseJsonOrThrow<FoodSafetyRecord[]>(response, "Failed to load records awaiting verification.");
}

export async function listMobileRecent(employeeId?: string): Promise<FoodSafetyRecord[]> {
  const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : "";
  const response = await apiFetch(`${MOBILE_URL}/recent${query}`);
  return parseJsonOrThrow<FoodSafetyRecord[]>(response, "Failed to load recent records.");
}
