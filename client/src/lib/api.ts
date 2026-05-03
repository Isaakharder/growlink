const BACKEND_HEALTH_URL = "http://localhost:4001/api/health";
const FORECASTING_STATUS_URL = "http://localhost:8000/forecasting/status";

type ApiSuccess = {
  success: true;
  data: unknown;
};

type ApiFailure = {
  success: false;
  data: { message: string; status?: number };
};

export type ApiResult = ApiSuccess | ApiFailure;

async function fetchJson(url: string): Promise<ApiResult> {
  try {
    const response = await fetch(url);

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
