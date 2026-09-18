import { useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { recordMeterReading } from "./api";
import { equipmentMeterUnit } from "./formatters";
import { EquipmentRow, MeterReadingRow } from "./types";

type Props = {
  equipment: EquipmentRow;
  onClose: () => void;
  onRecorded: (reading: MeterReadingRow) => void;
};

export function MeterReadingSheet({ equipment, onClose, onRecorded }: Props) {
  const { isOnline } = useOnlineStatus();
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [isReset, setIsReset] = useState(false);
  const [resetReason, setResetReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError(null);

    const numericValue = Number(value);
    if (value.trim() === "" || !Number.isFinite(numericValue) || numericValue < 0) {
      setError("Enter a valid reading value (0 or greater).");
      return;
    }
    if (isReset && !resetReason.trim()) {
      setError("A reason is required when resetting a meter.");
      return;
    }

    setSaving(true);
    try {
      const reading = await recordMeterReading(equipment.id, {
        value: numericValue,
        note: note.trim() || null,
        is_reset: isReset,
        reset_reason: isReset ? resetReason.trim() : null
      });
      onRecorded(reading);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record reading.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="meter-reading-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="meter-reading-title">Record Reading</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <form className="maintenance-sheet-body maintenance-form" onSubmit={(event) => void submit(event)}>
        <p>
          {equipment.name} — current: {equipment.current_meter_reading ?? "No reading yet"} {equipmentMeterUnit(equipment)}
        </p>

        <label>
          New reading ({equipmentMeterUnit(equipment)})
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        </label>

        <label>
          Note (optional)
          <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>

        <label className="maintenance-checkbox-row">
          <input type="checkbox" checked={isReset} onChange={(event) => setIsReset(event.target.checked)} />
          This is a meter reset (replaced or rolled over)
        </label>

        {isReset ? (
          <label>
            Reset reason (required)
            <input type="text" value={resetReason} onChange={(event) => setResetReason(event.target.value)} />
          </label>
        ) : null}

        {error ? <p className="form-error">{error}</p> : null}
        {!isOnline ? <p className="form-error">You're offline — reconnect to save this reading.</p> : null}

        <button type="submit" disabled={saving || !isOnline}>
          {saving ? "Saving…" : "Save Reading"}
        </button>
      </form>
    </ModalOverlay>
  );
}
