import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { CalibrationDevice, DueStatus } from "./pestCalibration/types";

function dueStatusLabel(status: DueStatus): string {
  switch (status) {
    case "overdue": return "Overdue";
    case "due_soon": return "Due Soon";
    case "on_demand": return "On Demand";
    default: return "OK";
  }
}

export function MobilePestCalibrationPage() {
  const [devices, setDevices] = useState<CalibrationDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch("/api/pest/calibration/devices");
        if (!res.ok) throw new Error("Failed to load calibration devices.");
        const data = (await res.json()) as CalibrationDevice[];
        setDevices(data.filter((d) => d.is_active));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load calibration devices.");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  return (
    <section className="mobile-page">
      <h2>Calibration</h2>
      <p>Choose a device to start a calibration.</p>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading…</p> : null}
      {!loading && devices.length === 0 ? <p>No active calibration devices configured yet.</p> : null}

      {!loading && devices.length > 0 ? (
        <div className="cleaning-checklist-list">
          {devices.map((device) => (
            <Link key={device.id} to={`/mobile/calibration/${device.id}`} className="cleaning-checklist-location-card">
              <div className="cleaning-checklist-card-name-row">
                <div className="cleaning-checklist-card-name">{device.name}</div>
                <span className="cleaning-checklist-frequency-badge">{device.frequency_type.toUpperCase()}</span>
              </div>
              {device.area ? <div className="cleaning-checklist-card-area">{device.area}</div> : null}
              <div className="cleaning-checklist-card-footer">
                <div className={`cleaning-checklist-status-badge status-${device.due_status === "overdue" ? "not-started" : "complete"}`}>
                  {dueStatusLabel(device.due_status)}
                </div>
                <span className="cleaning-checklist-last-completed">
                  {device.last_completed_at ? `Last: ${new Date(device.last_completed_at).toLocaleDateString()}` : "Never completed"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}
