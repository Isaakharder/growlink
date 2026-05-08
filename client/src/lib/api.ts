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
