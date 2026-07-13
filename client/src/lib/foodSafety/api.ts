import { apiFetch } from "../api";
import type {
  DepartmentInput,
  FoodSafetyDepartment,
  FoodSafetyFormTemplate,
  FoodSafetyFormTemplateListItem,
  FoodSafetyFormTemplateVersion,
  FoodSafetyFormTemplateVersionSummary,
  FoodSafetyLocation,
  LocationInput,
  TemplateInput
} from "./types";
import type { FoodSafetyFormSchema } from "./formSchema";

const DEPARTMENTS_URL = "/api/food-safety/departments";
const LOCATIONS_URL = "/api/food-safety/locations";
const TEMPLATES_URL = "/api/food-safety/templates";

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
