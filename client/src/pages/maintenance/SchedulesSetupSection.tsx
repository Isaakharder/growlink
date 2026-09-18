import { useEffect, useState } from "react";
import { archiveSchedule, createSchedule, getSchedule, listEquipment, listSchedules, reactivateSchedule, updateSchedule } from "./api";
import { formatDate, recurrenceLabel } from "./formatters";
import { EquipmentRow, RecurrenceType, RECURRENCE_TYPES, ScheduleChecklistItem, SchedulePayload, ScheduleRow } from "./types";

type Draft = {
  equipment_id: string; name: string; instructions: string; first_due_date: string; recurrence_type: RecurrenceType;
  recurrence_interval: string; warning_days_before_due: string; checklist_items: ScheduleChecklistItem[];
};

const EMPTY_DRAFT: Draft = {
  equipment_id: "", name: "", instructions: "", first_due_date: "", recurrence_type: "monthly",
  recurrence_interval: "1", warning_days_before_due: "0", checklist_items: []
};

function toPayload(draft: Draft): SchedulePayload {
  return {
    equipment_id: draft.equipment_id,
    name: draft.name.trim(),
    instructions: draft.instructions.trim() || null,
    first_due_date: draft.first_due_date,
    recurrence_type: draft.recurrence_type,
    recurrence_interval: draft.recurrence_type === "one_time" ? 1 : Number(draft.recurrence_interval) || 1,
    warning_days_before_due: Number(draft.warning_days_before_due) || 0,
    checklist_items: draft.checklist_items.filter((item) => item.label.trim()).map((item, index) => ({ ...item, label: item.label.trim(), sort_order: index }))
  };
}

export function SchedulesSetupSection({ canEdit }: { canEdit: boolean }) {
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setSchedules(await listSchedules({}));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules.");
    }
  }

  useEffect(() => {
    void load();
    void listEquipment({}).then(setEquipmentOptions).catch(() => setEquipmentOptions([]));
  }, []);

  function startCreate() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  async function startEdit(schedule: ScheduleRow) {
    setEditingId(schedule.id);
    setFormError(null);
    // The list endpoint doesn't include checklist_items — fetch the full
    // detail so editing doesn't silently wipe the existing checklist.
    setDraft({
      equipment_id: schedule.equipment_id, name: schedule.name, instructions: schedule.instructions ?? "",
      // PUT always resets next_due_date/next_occurrence_index to whatever's
      // submitted here (server behavior, by design) — defaulting to the
      // schedule's CURRENT next_due_date, not its original first_due_date,
      // so an edit that only touches e.g. instructions doesn't silently
      // rewind the cadence to the original anchor and make it overdue.
      first_due_date: schedule.next_due_date ?? schedule.first_due_date,
      recurrence_type: schedule.recurrence_type,
      recurrence_interval: String(schedule.recurrence_interval), warning_days_before_due: String(schedule.warning_days_before_due),
      checklist_items: []
    });
    try {
      const detail = await getSchedule(schedule.id);
      setDraft((current) => ({ ...current, checklist_items: detail.checklist_items }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to load checklist items.");
    }
  }

  function addChecklistItem() {
    setDraft((current) => ({ ...current, checklist_items: [...current.checklist_items, { label: "", sort_order: current.checklist_items.length }] }));
  }

  function updateChecklistItem(index: number, label: string) {
    setDraft((current) => ({ ...current, checklist_items: current.checklist_items.map((item, i) => (i === index ? { ...item, label } : item)) }));
  }

  function removeChecklistItem(index: number) {
    setDraft((current) => ({ ...current, checklist_items: current.checklist_items.filter((_, i) => i !== index) }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!draft.equipment_id || !draft.name.trim() || !draft.first_due_date) {
      setFormError("Equipment, name, and first due date are required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = toPayload(draft);
      if (editingId === "new") await createSchedule(payload);
      else if (editingId) await updateSchedule(editingId, payload);
      setEditingId(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save schedule.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(schedule: ScheduleRow) {
    if (togglingId) return;
    setTogglingId(schedule.id);
    try {
      if (schedule.is_active) await archiveSchedule(schedule.id);
      else await reactivateSchedule(schedule.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule.");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="maintenance-setup-section">
      <div className="maintenance-card-top-row">
        <h4>Maintenance Schedules</h4>
        {canEdit ? <button type="button" onClick={startCreate}>+ Add</button> : null}
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {schedules === null && !error ? <p>Loading…</p> : null}
      {schedules && schedules.length === 0 ? <p>No schedules yet.</p> : null}

      <div className="maintenance-setup-list">
        {schedules?.map((schedule) => (
          <div key={schedule.id} className={`maintenance-setup-row ${schedule.is_active ? "" : "maintenance-setup-row-inactive"}`}>
            <div>
              <strong>{schedule.name}</strong> {!schedule.is_active ? <span className="maintenance-inactive-badge">Inactive</span> : null}
              <p>{schedule.equipment?.name ?? "--"} · {recurrenceLabel(schedule.recurrence_type, schedule.recurrence_interval)} · Next: {formatDate(schedule.next_due_date)}</p>
            </div>
            {canEdit ? (
              <div className="maintenance-button-row">
                <button type="button" className="btn-secondary" onClick={() => void startEdit(schedule)}>Edit</button>
                <button type="button" className="btn-secondary" onClick={() => void toggleActive(schedule)} disabled={togglingId === schedule.id}>
                  {schedule.is_active ? "Archive" : "Reactivate"}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {editingId ? (
        <form className="maintenance-form maintenance-inline-form" onSubmit={(event) => void submit(event)}>
          <label>
            Equipment
            <select value={draft.equipment_id} onChange={(event) => setDraft((c) => ({ ...c, equipment_id: event.target.value }))}>
              <option value="">Select equipment</option>
              {equipmentOptions.map((eq) => <option key={eq.id} value={eq.id}>{eq.name} ({eq.asset_code})</option>)}
            </select>
          </label>
          <label>Name<input type="text" value={draft.name} onChange={(event) => setDraft((c) => ({ ...c, name: event.target.value }))} /></label>
          <label>Instructions (optional)<textarea rows={2} value={draft.instructions} onChange={(event) => setDraft((c) => ({ ...c, instructions: event.target.value }))} /></label>
          <label>
            {editingId === "new" ? "First due date" : "Restart cadence from"}
            <input type="date" value={draft.first_due_date} onChange={(event) => setDraft((c) => ({ ...c, first_due_date: event.target.value }))} />
          </label>
          <label>
            Recurrence
            <select value={draft.recurrence_type} onChange={(event) => setDraft((c) => ({ ...c, recurrence_type: event.target.value as RecurrenceType }))}>
              {RECURRENCE_TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
            </select>
          </label>
          {draft.recurrence_type !== "one_time" ? (
            <label>Every N {draft.recurrence_type.replace("ly", "")}(s)<input type="number" min="1" step="1" value={draft.recurrence_interval} onChange={(event) => setDraft((c) => ({ ...c, recurrence_interval: event.target.value }))} /></label>
          ) : null}
          <label>Warning days before due<input type="number" min="0" step="1" value={draft.warning_days_before_due} onChange={(event) => setDraft((c) => ({ ...c, warning_days_before_due: event.target.value }))} /></label>

          <div>
            <span>Checklist items</span>
            {draft.checklist_items.map((item, index) => (
              <div key={index} className="maintenance-button-row">
                <input type="text" value={item.label} onChange={(event) => updateChecklistItem(index, event.target.value)} placeholder={`Step ${index + 1}`} />
                <button type="button" className="btn-secondary" onClick={() => removeChecklistItem(index)}>Remove</button>
              </div>
            ))}
            <button type="button" className="maintenance-link-button" onClick={addChecklistItem}>+ Add checklist item</button>
          </div>

          {formError ? <p className="form-error">{formError}</p> : null}
          <div className="maintenance-button-row">
            <button type="button" className="btn-secondary" onClick={() => setEditingId(null)} disabled={saving}>Cancel</button>
            <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
