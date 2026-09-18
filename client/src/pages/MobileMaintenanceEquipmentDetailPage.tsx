import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getEquipment, getEquipmentHistory } from "./maintenance/api";
import { QrCodeSheet } from "./maintenance/QrCodeSheet";
import { ScheduleCompleteSheet } from "./maintenance/ScheduleCompleteSheet";
import { WorkLogSheet } from "./maintenance/WorkLogSheet";
import { usePermissions } from "../hooks/usePermissions";
import {
  dueStatusClassSuffix, dueStatusLabel, equipmentMeterUnit, equipmentStatusLabel, formatDate, formatDateTime, recurrenceLabel
} from "./maintenance/formatters";
import { EquipmentDetail, EquipmentHistoryEntry } from "./maintenance/types";

const MAINTENANCE_ACT_PERMISSIONS = ["mobile:maintenance", "maintenance:edit"];

type LoadState = { status: "loading" } | { status: "loaded"; equipment: EquipmentDetail } | { status: "error"; message: string };

function HistoryEntryRow({ entry }: { entry: EquipmentHistoryEntry }) {
  if (entry.type === "work_log") {
    return (
      <div className="maintenance-history-row">
        <span className="maintenance-history-primary">{entry.work_performed}</span>
        <span>{formatDateTime(entry.at)}</span>
        <span>{entry.performed_by_name_snapshot}</span>
        {entry.meter_reading_value !== null ? <span>Reading: {entry.meter_reading_value} {entry.meter_reading_unit_snapshot}</span> : null}
        {entry.notes ? <span className="maintenance-history-note">{entry.notes}</span> : null}
      </div>
    );
  }

  if (entry.type === "meter_reading") {
    return (
      <div className="maintenance-history-row">
        <span className="maintenance-history-primary">
          Meter reading: {entry.value} {entry.unit_snapshot}{entry.is_reset ? " (reset)" : ""}
        </span>
        <span>{formatDateTime(entry.at)}</span>
        <span>{entry.recorded_by_name_snapshot}</span>
        {entry.note ? <span className="maintenance-history-note">{entry.note}</span> : null}
      </div>
    );
  }

  return (
    <div className="maintenance-history-row">
      <span className="maintenance-history-primary">Scheduled maintenance completed: {entry.schedule_name_snapshot}</span>
      <span>{formatDateTime(entry.at)}</span>
      <span>{entry.completed_by_name_snapshot}</span>
      {entry.notes ? <span className="maintenance-history-note">{entry.notes}</span> : null}
    </div>
  );
}

export function MobileMaintenanceEquipmentDetailPage() {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const navigate = useNavigate();
  const { canAny } = usePermissions();
  const canAct = canAny(MAINTENANCE_ACT_PERMISSIONS);

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [workLogSheetOpen, setWorkLogSheetOpen] = useState(false);
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const [completingScheduleId, setCompletingScheduleId] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<EquipmentHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  async function load() {
    if (!equipmentId) return;
    setState({ status: "loading" });
    try {
      const equipment = await getEquipment(equipmentId);
      setState({ status: "loaded", equipment });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load equipment." });
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipmentId]);

  async function loadHistory() {
    if (!equipmentId) return;
    setHistoryError(null);
    try {
      setHistory(await getEquipmentHistory(equipmentId));
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Failed to load history.");
    }
  }

  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) {
      await loadHistory();
    }
  }

  if (state.status === "loading") {
    return (
      <section className="mobile-page maintenance-page">
        <p>Loading equipment…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mobile-page maintenance-page">
        <div className="maintenance-card">
          <p className="form-error">{state.message}</p>
          <button type="button" onClick={() => void load()}>Retry</button>
          <Link to="/mobile/maintenance" className="maintenance-link-button">Back to Maintenance</Link>
        </div>
      </section>
    );
  }

  const { equipment } = state;

  return (
    <section className="mobile-page maintenance-page maintenance-detail-page">
      <button type="button" className="maintenance-back-link" onClick={() => navigate("/mobile/maintenance")}>
        ← Equipment
      </button>

      <div className="maintenance-detail-header">
        <h2>{equipment.name}</h2>
        <span className={`maintenance-status-badge ${dueStatusClassSuffix(equipment.due_status)}`}>
          {dueStatusLabel(equipment.due_status)}
        </span>
      </div>

      <div className="maintenance-card">
        <div className="maintenance-detail-grid">
          <div><span>Asset Code</span><strong>{equipment.asset_code}</strong></div>
          <div><span>Category</span><strong>{equipment.category?.name ?? "--"}</strong></div>
          <div><span>Location</span><strong>{equipment.location?.name ?? "--"}</strong></div>
          <div><span>Status</span><strong>{equipmentStatusLabel(equipment.status)}</strong></div>
          <div><span>Make</span><strong>{equipment.make ?? "--"}</strong></div>
          <div><span>Model</span><strong>{equipment.model ?? "--"}</strong></div>
          <div><span>Serial #</span><strong>{equipment.serial_number ?? "--"}</strong></div>
        </div>
        {equipment.description ? <p className="maintenance-instructions">{equipment.description}</p> : null}
        <button type="button" className="btn-secondary" onClick={() => setQrSheetOpen(true)}>
          View QR Code
        </button>
      </div>

      <div className="maintenance-card">
        <div className="maintenance-card-top-row">
          <span className="maintenance-card-title">Meter Reading</span>
        </div>
        <p className="maintenance-meter-value">
          {equipment.current_meter_reading !== null ? `${equipment.current_meter_reading} ${equipmentMeterUnit(equipment)}` : "No reading recorded yet"}
        </p>
        {equipment.current_meter_reading_at ? <p>Last recorded {formatDateTime(equipment.current_meter_reading_at)}</p> : null}

        <div className="maintenance-button-row">
          {canAct ? (
            <button type="button" onClick={() => setWorkLogSheetOpen(true)}>
              Log / Work
            </button>
          ) : null}
          <button type="button" className="btn-secondary" onClick={() => void toggleHistory()}>
            {historyOpen ? "Hide History" : "View History"}
          </button>
        </div>

        {historyOpen ? (
          <div className="maintenance-history-list">
            {historyError ? <p className="form-error">{historyError}</p> : null}
            {history === null && !historyError ? <p>Loading…</p> : null}
            {history && history.length === 0 ? <p>No history recorded yet.</p> : null}
            {history?.map((entry) => <HistoryEntryRow key={`${entry.type}-${entry.id}`} entry={entry} />)}
          </div>
        ) : null}
      </div>

      <div className="maintenance-card">
        <div className="maintenance-card-top-row">
          <span className="maintenance-card-title">Scheduled Maintenance</span>
        </div>

        {equipment.schedules.length === 0 ? <p>No maintenance schedules configured for this equipment.</p> : null}

        {equipment.schedules.map((schedule) => (
          <div key={schedule.id} className="maintenance-schedule-row">
            <div className="maintenance-card-top-row">
              <strong>{schedule.name}</strong>
              {schedule.is_active ? null : <span className="maintenance-inactive-badge">Inactive</span>}
            </div>
            <p>{recurrenceLabel(schedule.recurrence_type, schedule.recurrence_interval)}</p>
            <p>Next due: {formatDate(schedule.next_due_date)}</p>
            {schedule.last_completed_at ? <p>Last completed {formatDateTime(schedule.last_completed_at)}</p> : null}

            {canAct && schedule.is_active ? (
              <div className="maintenance-button-row">
                <button type="button" onClick={() => setCompletingScheduleId(schedule.id)}>
                  Mark Complete
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {workLogSheetOpen ? (
        <WorkLogSheet
          equipment={equipment}
          onClose={() => setWorkLogSheetOpen(false)}
          onSaved={() => {
            setWorkLogSheetOpen(false);
            setHistory(null);
            setHistoryOpen(false);
            void load();
          }}
        />
      ) : null}

      {qrSheetOpen ? <QrCodeSheet equipment={equipment} onClose={() => setQrSheetOpen(false)} /> : null}

      {completingScheduleId ? (
        <ScheduleCompleteSheet
          scheduleId={completingScheduleId}
          onClose={() => setCompletingScheduleId(null)}
          onCompleted={() => {
            setCompletingScheduleId(null);
            setHistory(null);
            setHistoryOpen(false);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
