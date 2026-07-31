import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";
import { CalibrationDevice, DeviceDetail, DueStatus } from "./pestCalibration/types";
import { DeviceFormModal } from "./pestCalibration/DeviceFormModal";
import { StartCalibrationModal } from "./pestCalibration/StartCalibrationModal";
import { DeviceHistoryModal } from "./pestCalibration/DeviceHistoryModal";

function dueStatusLabel(status: DueStatus): string {
  switch (status) {
    case "overdue": return "Overdue";
    case "due_soon": return "Due Soon";
    case "on_demand": return "On Demand";
    default: return "OK";
  }
}

function dueStatusClass(status: DueStatus): string {
  return status === "overdue" ? "inactive" : "active";
}

// Device-centric, like Food Safety's Locations page — there is no separate
// "Calibration Records" list anymore; each device's history is reached only
// via its own "View History" button (see DeviceHistoryModal.tsx).
export function PestControlCalibrationPage() {
  const { can } = usePermissions();
  const canEdit = can("calibration:edit");

  const [devices, setDevices] = useState<CalibrationDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<DeviceDetail | null>(null);
  const [startingDevice, setStartingDevice] = useState<CalibrationDevice | null>(null);
  const [historyDevice, setHistoryDevice] = useState<CalibrationDevice | null>(null);

  async function fetchDevices() {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const res = await apiFetch("/api/pest/calibration/devices");
      if (!res.ok) throw new Error("Failed to load devices.");
      setDevices((await res.json()) as CalibrationDevice[]);
    } catch (error) {
      setDevicesError(error instanceof Error ? error.message : "Failed to load devices.");
    } finally {
      setDevicesLoading(false);
    }
  }

  useEffect(() => { void fetchDevices(); }, []);

  function openAdd() {
    setEditingDetail(null);
    setFormOpen(true);
  }

  async function openEdit(device: CalibrationDevice) {
    const res = await apiFetch(`/api/pest/calibration/devices/${device.id}`);
    if (res.ok) {
      setEditingDetail((await res.json()) as DeviceDetail);
      setFormOpen(true);
    }
  }

  function closeForm() {
    setFormOpen(false);
    setEditingDetail(null);
  }

  async function archiveDevice(device: CalibrationDevice) {
    if (!window.confirm(`Deactivate "${device.name}"? Its calibration history stays fully intact and searchable — you can reactivate it later.`)) return;
    const res = await apiFetch(`/api/pest/calibration/devices/${device.id}/archive`, { method: "POST" });
    if (res.ok) void fetchDevices();
  }

  async function reactivateDevice(device: CalibrationDevice) {
    const res = await apiFetch(`/api/pest/calibration/devices/${device.id}/reactivate`, { method: "POST" });
    if (res.ok) void fetchDevices();
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Calibration</h1>
        <p>Record and review pest-control equipment calibrations.</p>
      </header>

      {canEdit ? (
        <div className="cleaning-locations-toolbar">
          <button type="button" onClick={openAdd}>+ Add Device</button>
        </div>
      ) : null}

      {devicesError ? <p className="form-error">{devicesError}</p> : null}
      {devicesLoading ? <p>Loading...</p> : null}
      {!devicesLoading && devices.length === 0 ? <p>Calibration devices will appear here.</p> : null}

      {!devicesLoading && devices.length > 0 ? (
        <div className="cleaning-locations-list">
          {devices.map((device) => (
            <div className="cleaning-location-card" key={device.id}>
              <div className="cleaning-location-card-info">
                <div className="cleaning-location-card-name">
                  {device.name}
                  {!device.is_active ? <span className="status-badge inactive" style={{ marginLeft: "0.4rem" }}>Inactive</span> : null}
                </div>
                {device.area ? <div className="cleaning-location-card-area">{device.area}</div> : null}
                {/* Same stat-line shape as Food Safety's location cards
                    ("N cleaning tasks" + frequency) — extended with the
                    due-date info a calibration device needs and Food
                    Safety locations don't track. */}
                <div className="cleaning-location-card-stats">
                  <span>{device.task_count} task{device.task_count === 1 ? "" : "s"}</span>
                  <span>{device.frequency_type === "custom" ? `Every ${device.custom_interval_value} ${device.custom_interval_unit}` : device.frequency_type}</span>
                  <span className={`status-badge ${dueStatusClass(device.due_status)}`}>{dueStatusLabel(device.due_status)}</span>
                  <span>
                    {device.last_completed_at ? `Last: ${new Date(device.last_completed_at).toLocaleDateString()}` : "Never completed"}
                  </span>
                  {device.next_due_at ? <span>Next due: {new Date(device.next_due_at).toLocaleDateString()}</span> : null}
                </div>
              </div>

              <div className="row-actions cleaning-location-card-actions">
                <button type="button" disabled={!device.is_active} onClick={() => setStartingDevice(device)}>Start Calibration</button>
                <button type="button" onClick={() => setHistoryDevice(device)}>View History</button>
                {canEdit ? <button type="button" onClick={() => void openEdit(device)}>Edit</button> : null}
                {canEdit ? (
                  device.is_active ? (
                    <button type="button" className="danger" onClick={() => void archiveDevice(device)}>Deactivate</button>
                  ) : (
                    <button type="button" onClick={() => void reactivateDevice(device)}>Reactivate</button>
                  )
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {formOpen ? (
        <DeviceFormModal
          detail={editingDetail}
          onClose={closeForm}
          onSaved={() => { closeForm(); void fetchDevices(); }}
        />
      ) : null}

      {startingDevice ? (
        <StartCalibrationModal
          device={startingDevice}
          onClose={() => setStartingDevice(null)}
          onCompleted={() => void fetchDevices()}
        />
      ) : null}

      {historyDevice ? (
        <DeviceHistoryModal device={historyDevice} onClose={() => setHistoryDevice(null)} />
      ) : null}
    </section>
  );
}
