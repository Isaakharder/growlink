import { FormEvent, useState } from "react";
import { apiFetch } from "../../lib/api";
import { ModalOverlay } from "../../components/ModalOverlay";
import { CalibrationDevice, CustomIntervalUnit, DeviceDetail, FREQUENCY_OPTIONS, FrequencyType } from "./types";
import { EditableTask, TaskListEditor, tasksFromServer } from "./TaskListEditor";

// Mirrors FoodSafetyLocationsPage.tsx's single combined Add/Edit modal:
// device identity fields + notes + instructions + tasks, all saved from
// one form. Two requests happen under the hood (device row, then
// template/tasks/fields) rather than Food Safety's one — Calibration's
// tasks/fields use a diff-based upsert (to keep template_field_id stable
// on historical answers) rather than Food Safety's simpler
// delete-all-reinsert, so they stay on their own endpoint — but it reads
// as a single "Save" to the user.

type DeviceFormModalProps = {
  detail: DeviceDetail | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
};

type FormState = {
  name: string;
  area: string;
  identification_number: string;
  frequency_type: FrequencyType;
  custom_interval_value: string;
  custom_interval_unit: CustomIntervalUnit;
  notes: string;
  instructions: string;
};

function toFormState(device: CalibrationDevice | null): FormState {
  return {
    name: device?.name ?? "",
    area: device?.area ?? "",
    identification_number: device?.identification_number ?? "",
    frequency_type: device?.frequency_type ?? "weekly",
    custom_interval_value: device?.custom_interval_value ? String(device.custom_interval_value) : "",
    custom_interval_unit: device?.custom_interval_unit ?? "days",
    notes: device?.notes ?? "",
    instructions: device?.instructions ?? ""
  };
}

export function DeviceFormModal({ detail, onClose, onSaved }: DeviceFormModalProps) {
  const device = detail?.device ?? null;
  const [form, setForm] = useState<FormState>(toFormState(device));
  const [tasks, setTasks] = useState<EditableTask[]>(() => tasksFromServer(detail?.tasks ?? [], detail?.fields ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const name = form.name.trim();
    if (!name) return setError("Device name is required.");
    if (form.frequency_type === "custom") {
      const value = Number(form.custom_interval_value);
      if (!Number.isFinite(value) || value <= 0) {
        return setError("Custom interval requires a value greater than 0.");
      }
    }
    if (tasks.length === 0) return setError("Add at least one task.");
    for (const task of tasks) {
      if (!task.name.trim()) return setError("Every task needs a name.");
      if (task.fields.length === 0) return setError(`"${task.name}" needs at least one response field.`);
      for (const field of task.fields) {
        if (!field.label.trim()) return setError(`Every field in "${task.name}" needs a label.`);
      }
    }
    setSaving(true);
    try {
      const devicePayload = {
        name,
        area: form.area.trim() || null,
        identification_number: form.identification_number.trim() || null,
        frequency_type: form.frequency_type,
        custom_interval_value: form.frequency_type === "custom" ? Number(form.custom_interval_value) : null,
        custom_interval_unit: form.frequency_type === "custom" ? form.custom_interval_unit : null,
        notes: form.notes.trim() || null,
        instructions: form.instructions.trim() || null
      };

      const deviceRes = await apiFetch(
        device ? `/api/pest/calibration/devices/${device.id}` : "/api/pest/calibration/devices",
        { method: device ? "PUT" : "POST", body: JSON.stringify(devicePayload) }
      );
      if (!deviceRes.ok) {
        const body = (await deviceRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save device.");
      }
      const savedDevice = (await deviceRes.json()) as CalibrationDevice;

      const templatePayload = {
        tasks: tasks.map((t, taskIndex) => ({
          id: t._isNew ? null : t._key,
          client_key: t._isNew ? t._key : undefined,
          name: t.name.trim(),
          sort_order: taskIndex,
          is_repeating: t.is_repeating,
          min_rows: t.is_repeating && t.min_rows.trim() ? Number(t.min_rows) : null,
          max_rows: t.is_repeating && t.max_rows.trim() ? Number(t.max_rows) : null,
          fields: t.fields.map((f, fieldIndex) => ({
            id: f._isNew ? null : f._key,
            client_key: f._isNew ? f._key : undefined,
            field_type: f.field_type,
            label: f.label.trim(),
            help_text: f.help_text.trim() || null,
            is_required: f.is_required,
            placeholder: f.placeholder.trim() || null,
            unit: f.unit.trim() || null,
            min_value: f.min_value.trim() ? Number(f.min_value) : null,
            max_value: f.max_value.trim() ? Number(f.max_value) : null,
            decimal_precision: f.decimal_precision.trim() ? Number(f.decimal_precision) : null,
            choice_options: ["checkbox", "pass_fail", "multiple_choice"].includes(f.field_type)
              ? f.choice_options.map((c) => c.trim()).filter(Boolean)
              : null,
            sort_order: fieldIndex
          }))
        }))
      };

      const templateRes = await apiFetch(`/api/pest/calibration/devices/${savedDevice.id}/template`, {
        method: "PUT",
        body: JSON.stringify(templatePayload)
      });
      if (!templateRes.ok) {
        const body = (await templateRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Device saved, but tasks failed to save.");
      }

      onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save device.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="variety-modal cleaning-location-modal" titleId="calibration-device-form-title">
      <h2 id="calibration-device-form-title">{device ? "Edit Device" : "Add Device"}</h2>
      <form className="varieties-form cleaning-location-form" onSubmit={handleSubmit}>
        <label>
          Device name
          <input
            type="text"
            value={form.name}
            placeholder="e.g. Walking Spray Tree 1"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
        </label>

        <label>
          Area / Building
          <input
            type="text"
            value={form.area}
            placeholder="e.g. Packing Room"
            onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))}
          />
        </label>

        <label>
          Frequency
          <select
            value={form.frequency_type}
            onChange={(e) => setForm((f) => ({ ...f, frequency_type: e.target.value as FrequencyType }))}
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>

        {form.frequency_type === "custom" ? (
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <label style={{ flex: 1 }}>
              Every
              <input
                type="number" min="1" value={form.custom_interval_value}
                onChange={(e) => setForm((f) => ({ ...f, custom_interval_value: e.target.value }))}
                required
              />
            </label>
            <label style={{ flex: 1 }}>
              Unit
              <select
                value={form.custom_interval_unit}
                onChange={(e) => setForm((f) => ({ ...f, custom_interval_unit: e.target.value as CustomIntervalUnit }))}
              >
                <option value="days">Days</option>
                <option value="weeks">Weeks</option>
                <option value="months">Months</option>
              </select>
            </label>
          </div>
        ) : null}

        <label className="cleaning-location-notes-field">
          Notes
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Internal notes about this device — access information, quirks, or other details for admins…"
            rows={4}
          />
        </label>

        <label className="cleaning-location-mobile-instructions-field">
          Instructions
          <textarea
            value={form.instructions}
            onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
            placeholder="What the employee sees when starting this calibration…"
            rows={4}
          />
        </label>

        <details>
          <summary>Optional Details</summary>
          <label>
            Identification / Serial number
            <input
              type="text"
              value={form.identification_number}
              onChange={(e) => setForm((f) => ({ ...f, identification_number: e.target.value }))}
            />
          </label>
        </details>

        <TaskListEditor tasks={tasks} onChange={setTasks} />

        {error ? <p className="form-error">{error}</p> : null}

        <div className="form-actions">
          <button type="submit" disabled={saving}>{saving ? "Saving..." : device ? "Save changes" : "Add Device"}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </ModalOverlay>
  );
}
