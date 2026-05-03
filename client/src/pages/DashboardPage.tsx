import { useEffect, useState } from "react";
import {
  getBackendHealth,
  getForecastingStatus,
  type ApiResult
} from "../lib/api";

type ServiceState = {
  loading: boolean;
  status: "connected" | "disconnected";
  response: ApiResult | null;
};

const INITIAL_SERVICE_STATE: ServiceState = {
  loading: true,
  status: "disconnected",
  response: null
};

function statusColor(status: ServiceState["status"]) {
  return status === "connected" ? "#0f7660" : "#b42318";
}

export function DashboardPage() {
  const [backend, setBackend] = useState<ServiceState>(INITIAL_SERVICE_STATE);
  const [forecasting, setForecasting] = useState<ServiceState>(
    INITIAL_SERVICE_STATE
  );

  useEffect(() => {
    let active = true;

    async function loadStatuses() {
      const [backendResult, forecastingResult] = await Promise.all([
        getBackendHealth(),
        getForecastingStatus()
      ]);

      if (!active) {
        return;
      }

      setBackend({
        loading: false,
        status: backendResult.success ? "connected" : "disconnected",
        response: backendResult
      });

      setForecasting({
        loading: false,
        status: forecastingResult.success ? "connected" : "disconnected",
        response: forecastingResult
      });
    }

    void loadStatuses();

    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="page-shell">
      <header>
        <h1>Dashboard</h1>
        <p>Live service connectivity snapshot for backend and forecasting systems.</p>
      </header>

      <div className="coming-soon-card">
        <h2>Backend Status</h2>
        <p>
          {backend.loading ? (
            "Loading..."
          ) : (
            <span style={{ color: statusColor(backend.status), fontWeight: 600 }}>
              {backend.status === "connected" ? "Connected" : "Disconnected"}
            </span>
          )}
        </p>
      </div>

      <div className="coming-soon-card">
        <h2>Forecasting Service</h2>
        <p>
          {forecasting.loading ? (
            "Loading..."
          ) : (
            <span
              style={{ color: statusColor(forecasting.status), fontWeight: 600 }}
            >
              {forecasting.status === "connected" ? "Connected" : "Disconnected"}
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
