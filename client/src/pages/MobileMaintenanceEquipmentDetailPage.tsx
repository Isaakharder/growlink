import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getEquipment, getScheduleHistory, listMeterReadings } from "./maintenance/api";
import { MeterReadingSheet } from "./maintenance/MeterReadingSheet";
import { QrCodeSheet } from "./maintenance/QrCodeSheet";
import { ScheduleCompleteSheet } from "./maintenance/ScheduleCompleteSheet";
import { usePermissions } from "../hooks/usePermissions";
import {
  dueStatusClassSuffix, dueStatusLabel, equipmentMeterUnit, equipmentStatusLabel, formatDate, formatDateTime, recurrenceLabel
} from "./maintenance/formatters";
import { EquipmentDetail, MeterReadingRow, ScheduleCompletion } from "./maintenance/types";

const MAINTENANCE_ACT_PERMISSIONS = ["mobile:maintenance", "maintenance:edit"];

type LoadState = { status: "loading" } | { status: "loaded"; equipment: EquipmentDetail } | { status: "error"; message: string };

export function MobileMaintenanceEquipmentDetailPage() {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const navigate = useNavigate();
  const { canAny } = usePermissions();
  const canAct = canAny(MAINTENANCE_ACT_PERMISSIONS);

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [meterSheetOpen, setMeterSheetOpen] = useState(false);
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const [completingScheduleId, setCompletingScheduleId] = useState<string | null>(null);

  const [meterHistoryOpen, setMeterHistoryOpen] = useState(false);
  const [meterHistory, setMeterHistory] = useState<MeterReadingRow[] | null>(null);
  const [meterHistoryError, setMeterHistoryError] = useState<string | null>(null);

  const [scheduleHistoryOpenId, setScheduleHistoryOpenId] = useState<string | null>(null);
  const [scheduleHistory, setScheduleHistory] = useState<ScheduleCompletion[] | null>(null);
  const [scheduleHistoryError, setScheduleHistoryError] = useState<string | null>(null);

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

  async function toggleMeterHistory() {
    const next = !meterHistoryOpen;
    setMeterHistoryOpen(next);
    if (next && meterHistory === null && equipmentId) {
      setMeterHistoryError(null);
      try {
        setMeterHistory(await listMeterReadings(equipmentId));
      } catch (err) {
        setMeterHistoryError(err instanceof Error ? err.message : "Failed to load meter history.");
      }
    }
  }

  async function toggleScheduleHistory(scheduleId: string) {
    if (scheduleHistoryOpenId === scheduleId) {
      setScheduleHistoryOpenId(null);
      return;
    }
    setScheduleHistoryOpenId(scheduleId);
    setScheduleHistory(null);
    setScheduleHistoryError(null);
    try {
      setScheduleHistory(await getScheduleHistory(scheduleId));
    } catch (err) {
      setScheduleHistoryError(err instanceof Error ? err.message : "Failed to load history.");
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
            <button type="button" onClick={() => setMeterSheetOpen(true)}>
              Record Reading
            </button>
          ) : null}
          <button type="button" className="btn-secondary" onClick={() => void toggleMeterHistory()}>
            {meterHistoryOpen ? "Hide History" : "View History"}
          </button>
        </div>

        {meterHistoryOpen ? (
          <div className="maintenance-history-list">
            {meterHistoryError ? <p className="form-error">{meterHistoryError}</p> : null}
            {meterHistory === null && !meterHistoryError ? <p>Loading…</p> : null}
            {meterHistory && meterHistory.length === 0 ? <p>No readings recorded yet.</p> : null}
            {meterHistory?.map((reading) => (
              <div key={reading.id} className="maintenance-history-row">
                <span>{reading.value} {reading.unit_snapshot}{reading.is_reset ? " (reset)" : ""}</span>
                <span>{formatDateTime(reading.recorded_at)}</span>
                <span>{reading.recorded_by_name_snapshot}</span>
                {reading.note ? <span className="maintenance-history-note">{reading.note}</span> : null}
              </div>
            ))}
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

            <div className="maintenance-button-row">
              {canAct && schedule.is_active ? (
                <button type="button" onClick={() => setCompletingScheduleId(schedule.id)}>
                  Mark Complete
                </button>
              ) : null}
              <button type="button" className="btn-secondary" onClick={() => void toggleScheduleHistory(schedule.id)}>
                {scheduleHistoryOpenId === schedule.id ? "Hide History" : "View History"}
              </button>
            </div>

            {scheduleHistoryOpenId === schedule.id ? (
              <div className="maintenance-history-list">
                {scheduleHistoryError ? <p className="form-error">{scheduleHistoryError}</p> : null}
                {scheduleHistory === null && !scheduleHistoryError ? <p>Loading…</p> : null}
                {scheduleHistory && scheduleHistory.length === 0 ? <p>No completions recorded yet.</p> : null}
                {scheduleHistory?.map((completion) => (
                  <div key={completion.id} className="maintenance-history-row">
                    <span>Completed {formatDateTime(completion.completed_at)}</span>
                    <span>{completion.completed_by_name_snapshot}</span>
                    {completion.notes ? <span className="maintenance-history-note">{completion.notes}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {meterSheetOpen ? (
        <MeterReadingSheet
          equipment={equipment}
          onClose={() => setMeterSheetOpen(false)}
          onRecorded={() => {
            setMeterSheetOpen(false);
            setMeterHistory(null);
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
            setScheduleHistory(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
