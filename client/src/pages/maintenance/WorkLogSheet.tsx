import { useRef, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { logEquipmentWork } from "./api";
import { equipmentMeterUnit } from "./formatters";
import { EquipmentRow, WorkLogRow } from "./types";

type Props = {
  equipment: EquipmentRow;
  onClose: () => void;
  onSaved: (log: WorkLogRow) => void;
};

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function WorkLogSheet({ equipment, onClose, onSaved }: Props) {
  const { isOnline } = useOnlineStatus();
  const [workPerformed, setWorkPerformed] = useState("");
  const [meterReading, setMeterReading] = useState("");
  const [notes, setNotes] = useState("");
  const [performedAt, setPerformedAt] = useState(() => toDatetimeLocalValue(new Date()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generated once per open attempt and reused across retries of the same
  // submission (including a genuine double tap) so it can never create a
  // second work log — matches the server's request_id idempotency contract.
  const requestIdRef = useRef(crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError(null);

    const trimmedWork = workPerformed.trim();
    if (!trimmedWork) {
      setError("Enter what work was performed.");
      return;
    }

    let numericReading: number | null = null;
    if (meterReading.trim() !== "") {
      numericReading = Number(meterReading);
      if (!Number.isFinite(numericReading) || numericReading < 0) {
        setError("Enter a valid reading value (0 or greater), or leave it blank.");
        return;
      }
    }

    let performedAtIso: string | null = null;
    if (performedAt) {
      const parsed = new Date(performedAt);
      if (Number.isNaN(parsed.getTime())) {
        setError("Enter a valid date and time.");
        return;
      }
      performedAtIso = parsed.toISOString();
    }

    setSaving(true);
    try {
      const log = await logEquipmentWork(equipment.id, {
        request_id: requestIdRef.current,
        work_performed: trimmedWork,
        meter_reading_value: numericReading,
        notes: notes.trim() || null,
        performed_at: performedAtIso
      });
      onSaved(log);
    } catch (err) {
      // Form fields are deliberately left exactly as entered — the user
      // shouldn't have to retype a paragraph of work notes because of a
      // transient network error.
      setError(err instanceof Error ? err.message : "Failed to save job.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="work-log-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="work-log-title">Log / Work</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {/* noValidate: native constraint validation (the min="0" below) would
          otherwise silently block the submit event before our own JS
          validation ever runs — same GrowLink-styled-error-over-native-
          popup convention as the rest of this module. */}
      <form className="maintenance-sheet-body maintenance-form" noValidate onSubmit={(event) => void submit(event)}>
        <p>
          {equipment.name} — current: {equipment.current_meter_reading ?? "No reading yet"} {equipmentMeterUnit(equipment)}
        </p>

        <label>
          Work Performed
          <textarea
            rows={3}
            value={workPerformed}
            autoFocus
            placeholder="e.g. Replaced hydraulic hose, adjusted limit switch, inspected lift controls"
            onChange={(event) => setWorkPerformed(event.target.value)}
          />
        </label>

        <label>
          New Reading ({equipmentMeterUnit(equipment)}) — optional
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={meterReading}
            onChange={(event) => setMeterReading(event.target.value)}
          />
        </label>

        <label>
          Notes (optional)
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>

        <label>
          Date and Time
          <input type="datetime-local" value={performedAt} onChange={(event) => setPerformedAt(event.target.value)} />
        </label>

        {error ? <p className="form-error">{error}</p> : null}
        {!isOnline ? <p className="form-error">You're offline — reconnect to save this job.</p> : null}

        <button type="submit" disabled={saving || !isOnline}>
          {saving ? "Saving…" : "Save Job"}
        </button>
      </form>
    </ModalOverlay>
  );
}
