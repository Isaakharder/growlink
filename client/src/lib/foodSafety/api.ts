import { apiFetch } from "../api";
import type {
  DepartmentInput,
  FoodSafetyDepartment,
  FoodSafetyLocation,
  LocationInput
} from "./types";

const DEPARTMENTS_URL = "/api/food-safety/departments";
const LOCATIONS_URL = "/api/food-safety/locations";

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
