import { supabase } from "./supabase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const FORECASTING_BASE_URL =
  import.meta.env.VITE_FORECASTING_BASE_URL || "http://localhost:8000";

export const apiUrl = (path: string) =>
  `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

const BACKEND_HEALTH_URL = apiUrl("/api/health");
const FORECASTING_STATUS_URL = `${FORECASTING_BASE_URL}/forecasting/status`;

type ApiSuccess = {
  success: true;
  data: unknown;
};

type ApiFailure = {
  success: false;
  data: { message: string; status?: number };
};

export type ApiResult = ApiSuccess | ApiFailure;

export async function apiFetch(path: string, options: RequestInit = {}) {
  const {
    data: { session }
  } = await supabase.auth.getSession();

  const headers = new Headers(options.headers);

  if (!headers.has("Content-Type") && options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }

  const url = /^https?:\/\//i.test(path) ? path : apiUrl(path);

  return fetch(url, {
    ...options,
    headers
  });
}

async function fetchJson(url: string): Promise<ApiResult> {
  try {
    const response = await apiFetch(url);

    if (!response.ok) {
      return {
        success: false,
        data: {
          message: `Request failed with status ${response.status}`,
          status: response.status
        }
      };
    }

    const data = (await response.json()) as unknown;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      data: {
        message: error instanceof Error ? error.message : "Unexpected network error"
      }
    };
  }
}

export function getBackendHealth() {
  return fetchJson(BACKEND_HEALTH_URL);
}

export function getForecastingStatus() {
  return fetchJson(FORECASTING_STATUS_URL);
}

/**
 * Fetches the current user's organization ID from Supabase memberships.
 * Returns "unknown" as a safe fallback if the org ID cannot be determined.
 * This ensures dashboard settings are organization-scoped and never leak
 * between different companies/organizations.
 */
export async function getOrganizationId(): Promise<string> {
  try {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user?.id) {
      return "unknown";
    }

    const { data: membership, error } = await supabase
      .from("memberships")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !membership?.organization_id) {
      return "unknown";
    }

    return membership.organization_id;
  } catch {
    return "unknown";
  }
}

export type ClimateReading = {
  id: number;
  timestamp: string;
  zone_label: string | null;
  metric_name: string;
  metric_value: number;
  unit: string;
  source_file: string;
};

export type ClimateReadingsQuery = {
  metricName?: string;
  zoneLabel?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
};

/**
 * Fetches recent climate_readings (Climate Agent CSV imports) for the
 * caller's organization, newest first. Throws on a non-OK response so
 * callers can surface the error message from the body.
 */
export async function fetchClimateReadings(
  query: ClimateReadingsQuery = {}
): Promise<ClimateReading[]> {
  const params = new URLSearchParams();
  if (query.metricName) params.set("metric_name", query.metricName);
  if (query.zoneLabel) params.set("zone_label", query.zoneLabel);
  if (query.startDate) params.set("start_date", query.startDate);
  if (query.endDate) params.set("end_date", query.endDate);
  if (query.limit) params.set("limit", String(query.limit));

  const queryString = params.toString();
  const response = await apiFetch(`/api/climate/readings${queryString ? `?${queryString}` : ""}`);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Failed to load climate readings (${response.status})`);
  }

  return (await response.json()) as ClimateReading[];
}

export async function getOrganizationName(): Promise<string | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return null;

    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError || !membership?.organization_id) return null;

    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", membership.organization_id)
      .maybeSingle();

    if (orgError || !org) return null;
    return org.name ?? null;
  } catch {
    return null;
  }
}
