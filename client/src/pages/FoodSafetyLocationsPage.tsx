import { FormEvent, useEffect, useState } from "react";
import { apiFetch, apiUrl } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";
import { ModalOverlay } from "../components/ModalOverlay";

type CleaningLocationFrequency = "daily" | "weekly" | "monthly" | "annually";
type CleaningTaskResponseType = "checkbox" | "number" | "short_text" | "long_text";

type CleaningTask = {
  id: string;
  name: string;
  response_type: CleaningTaskResponseType;
  action_labels: string[] | null;
  sort_order: number;
};

type CleaningLocation = {
  id: string;
  name: string;
  area: string;
  frequency: CleaningLocationFrequency;
  notes: string | null;
  mobile_instructions: string | null;
  tasks: CleaningTask[];
};

type ActionLabelRow = {
  key: string;
  value: string;
};

type TaskFormRow = {
  key: string;
  name: string;
  responseType: CleaningTaskResponseType;
  actionLabels: ActionLabelRow[];
};

function newActionLabelRow(value = ""): ActionLabelRow {
  return { key: crypto.randomUUID(), value };
}

const RESPONSE_TYPE_LABELS: Record<CleaningTaskResponseType, string> = {
  checkbox: "Checkbox",
  number: "Number",
  short_text: "Short text",
  long_text: "Long text"
};

const MAX_NOTES_LENGTH = 2000;
const MAX_MOBILE_INSTRUCTIONS_LENGTH = 1000;

type LocationFormState = {
  name: string;
  area: string;
  frequency: CleaningLocationFrequency;
  notes: string;
  mobileInstructions: string;
  tasks: TaskFormRow[];
};

const API_BASE = apiUrl("/api/food-safety/cleaning-locations");

const FREQUENCY_LABELS: Record<CleaningLocationFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  annually: "Annually"
};

function newTaskRow(): TaskFormRow {
  return {
    key: crypto.randomUUID(),
    name: "",
    responseType: "checkbox",
    actionLabels: [newActionLabelRow()]
  };
}

function emptyForm(): LocationFormState {
  return { name: "", area: "", frequency: "daily", notes: "", mobileInstructions: "", tasks: [newTaskRow()] };
}

function toFormState(location: CleaningLocation): LocationFormState {
  return {
    name: location.name,
    area: location.area,
    frequency: location.frequency,
    notes: location.notes ?? "",
    mobileInstructions: location.mobile_instructions ?? "",
    tasks: location.tasks.map((task) => ({
      key: crypto.randomUUID(),
      name: task.name,
      responseType: task.response_type,
      actionLabels:
        task.action_labels && task.action_labels.length > 0
          ? task.action_labels.map((label) => newActionLabelRow(label))
          : [newActionLabelRow()]
    }))
  };
}

export function FoodSafetyLocationsPage() {
  const { can } = usePermissions();
  const canEdit = can("food_safety:edit");

  const [locations, setLocations] = useState<CleaningLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LocationFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CleaningLocation | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchLocations() {
    setLoading(true);
    setListError(null);

    try {
      const res = await apiFetch(API_BASE);
      if (!res.ok) {
        throw new Error("Failed to load cleaning locations");
      }

      const data = (await res.json()) as CleaningLocation[];
      setLocations(data);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Failed to load cleaning locations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchLocations();
  }, []);

  function openAddModal() {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
    setIsModalOpen(true);
  }

  function beginEdit(location: CleaningLocation) {
    setEditingId(location.id);
    setForm(toFormState(location));
    setFormError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
  }

  function addTaskRow() {
    setForm((current) => ({ ...current, tasks: [...current.tasks, newTaskRow()] }));
  }

  function removeTaskRow(key: string) {
    setForm((current) => ({ ...current, tasks: current.tasks.filter((task) => task.key !== key) }));
  }

  function updateTaskName(key: string, name: string) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.key === key ? { ...task, name } : task))
    }));
  }

  function updateTaskResponseType(key: string, responseType: CleaningTaskResponseType) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.key === key
          ? {
              ...task,
              responseType,
              // Switching to checkbox with no labels configured yet gets one
              // empty slot to fill in, same as a brand-new task.
              actionLabels:
                responseType === "checkbox" && task.actionLabels.length === 0
                  ? [newActionLabelRow()]
                  : task.actionLabels
            }
          : task
      )
    }));
  }

  function addActionLabel(taskKey: string) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.key === taskKey ? { ...task, actionLabels: [...task.actionLabels, newActionLabelRow()] } : task
      )
    }));
  }

  function removeActionLabel(taskKey: string, labelKey: string) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.key === taskKey
          ? { ...task, actionLabels: task.actionLabels.filter((label) => label.key !== labelKey) }
          : task
      )
    }));
  }

  function updateActionLabel(taskKey: string, labelKey: string, value: string) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.key === taskKey
          ? {
              ...task,
              actionLabels: task.actionLabels.map((label) => (label.key === labelKey ? { ...label, value } : label))
            }
          : task
      )
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const name = form.name.trim();
    const area = form.area.trim();
    const notes = form.notes.trim();
    const mobileInstructions = form.mobileInstructions.trim();

    if (!name) {
      setFormError("Location name is required.");
      return;
    }

    if (!area) {
      setFormError("Area/building is required.");
      return;
    }

    if (notes.length > MAX_NOTES_LENGTH) {
      setFormError(`Notes cannot exceed ${MAX_NOTES_LENGTH} characters.`);
      return;
    }

    if (mobileInstructions.length > MAX_MOBILE_INSTRUCTIONS_LENGTH) {
      setFormError(`Mobile instructions cannot exceed ${MAX_MOBILE_INSTRUCTIONS_LENGTH} characters.`);
      return;
    }

    if (form.tasks.length === 0) {
      setFormError("At least one cleaning task is required.");
      return;
    }

    for (const [index, task] of form.tasks.entries()) {
      if (!task.name.trim()) {
        setFormError(`Task ${index + 1} needs a name.`);
        return;
      }
      if (task.responseType === "checkbox" && task.actionLabels.every((label) => !label.value.trim())) {
        setFormError(`Task ${index + 1} needs at least one checkbox label.`);
        return;
      }
    }

    const payload = {
      name,
      area,
      frequency: form.frequency,
      notes: notes.length > 0 ? notes : null,
      mobileInstructions: mobileInstructions.length > 0 ? mobileInstructions : null,
      tasks: form.tasks.map((task) => ({
        name: task.name.trim(),
        responseType: task.responseType,
        actionLabels:
          task.responseType === "checkbox"
            ? task.actionLabels.map((label) => label.value.trim()).filter((value) => value.length > 0)
            : null
      }))
    };

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${API_BASE}/${editingId}` : API_BASE;

      const response = await apiFetch(url, { method, body: JSON.stringify(payload) });

      if (!response.ok) {
        let message = `${editingId ? "Update" : "Create"} failed`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // Ignore malformed error response and use fallback message.
        }
        throw new Error(message);
      }

      closeModal();
      await fetchLocations();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save location");
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(location: CleaningLocation) {
    setDeleteError(null);
    setDeleteTarget(location);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);

    try {
      const response = await apiFetch(`${API_BASE}/${deleteTarget.id}`, { method: "DELETE" });
      if (!response.ok) {
        let message = `Delete failed (${response.status})`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // Ignore malformed error response and use fallback message.
        }
        throw new Error(message);
      }

      setDeleteTarget(null);
      await fetchLocations();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to deactivate location");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Locations</h1>
        <p>Configure cleaning locations and the recurring tasks required at each one.</p>
      </header>

      {canEdit && (
        <div className="cleaning-locations-toolbar">
          <button type="button" onClick={openAddModal}>
            + Add Location
          </button>
        </div>
      )}

      {listError ? <p className="form-error">{listError}</p> : null}
      {loading ? <p>Loading...</p> : null}

      {!loading && locations.length === 0 ? <p>No cleaning locations added yet.</p> : null}

      {!loading && locations.length > 0 ? (
        <div className="cleaning-locations-list">
          {locations.map((location) => (
            <div className="cleaning-location-card" key={location.id}>
              <div className="cleaning-location-card-info">
                <div className="cleaning-location-card-name">{location.name}</div>
                <div className="cleaning-location-card-area">{location.area}</div>
                <div className="cleaning-location-card-stats">
                  <span>{location.tasks.length} cleaning task{location.tasks.length === 1 ? "" : "s"}</span>
                  <span>{FREQUENCY_LABELS[location.frequency]}</span>
                </div>
                {location.mobile_instructions ? (
                  <div className="cleaning-location-card-mobile-instructions">
                    <span className="cleaning-location-card-mobile-instructions-label">Mobile Instructions</span>
                    <p>{location.mobile_instructions}</p>
                  </div>
                ) : null}
              </div>

              {canEdit && (
                <div className="row-actions cleaning-location-card-actions">
                  <button type="button" onClick={() => beginEdit(location)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => requestDelete(location)}
                    aria-label={`Deactivate location ${location.name}`}
                  >
                    Deactivate
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {isModalOpen ? (
        <ModalOverlay
          onClose={closeModal}
          contentClassName="variety-modal cleaning-location-modal"
          titleId="food-safety-location-modal-title"
        >
            <h2 id="food-safety-location-modal-title">{editingId ? "Edit Location" : "Add Location"}</h2>

            <form className="varieties-form cleaning-location-form" onSubmit={handleSubmit}>
              <label>
                Location name
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="e.g. Lower Lunch Room"
                  required
                />
              </label>

              <label>
                Area / Building
                <input
                  type="text"
                  value={form.area}
                  onChange={(event) => setForm((current) => ({ ...current, area: event.target.value }))}
                  placeholder="e.g. Warehouse"
                  required
                />
              </label>

              <label>
                Frequency
                <select
                  value={form.frequency}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, frequency: event.target.value as CleaningLocationFrequency }))
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="annually">Annually</option>
                </select>
              </label>

              <label className="cleaning-location-notes-field">
                Notes
                <textarea
                  value={form.notes}
                  onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Cleaning instructions, access information, equipment used, or other important details for this location…"
                  maxLength={MAX_NOTES_LENGTH}
                  rows={4}
                />
              </label>

              <label className="cleaning-location-mobile-instructions-field">
                Mobile Instructions
                <textarea
                  value={form.mobileInstructions}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, mobileInstructions: event.target.value }))
                  }
                  placeholder="Check both sinks for hot and cold water. Refill soap and toilet paper where needed. Report any leaks or damage to the supervisor."
                  maxLength={MAX_MOBILE_INSTRUCTIONS_LENGTH}
                  rows={4}
                />
                <span className="cleaning-location-mobile-instructions-counter">
                  {form.mobileInstructions.trim().length} / {MAX_MOBILE_INSTRUCTIONS_LENGTH}
                </span>
              </label>

              <div className="cleaning-tasks-section">
                <div className="cleaning-tasks-header">
                  <span>Cleaning Tasks</span>
                  <button type="button" onClick={addTaskRow}>
                    + Add Field
                  </button>
                </div>

                {form.tasks.length === 0 ? (
                  <p className="cleaning-tasks-empty">No cleaning tasks yet. Add at least one.</p>
                ) : null}

                {form.tasks.map((task, taskIndex) => {
                  const taskLabel = task.name.trim() || `task ${taskIndex + 1}`;
                  return (
                  <div className="cleaning-task-row" key={task.key}>
                    <div className="cleaning-task-row-main">
                      <input
                        type="text"
                        value={task.name}
                        onChange={(event) => updateTaskName(task.key, event.target.value)}
                        placeholder="Task name, e.g. Floor"
                        aria-label={`Task ${taskIndex + 1} name`}
                      />
                      <button
                        type="button"
                        className="danger"
                        onClick={() => removeTaskRow(task.key)}
                        aria-label={`Remove task ${taskLabel}`}
                      >
                        Remove
                      </button>
                    </div>

                    <div className="cleaning-task-row-options">
                      <select
                        value={task.responseType}
                        onChange={(event) =>
                          updateTaskResponseType(task.key, event.target.value as CleaningTaskResponseType)
                        }
                        aria-label={`Response type for ${taskLabel}`}
                      >
                        {(Object.keys(RESPONSE_TYPE_LABELS) as CleaningTaskResponseType[]).map((type) => (
                          <option key={type} value={type}>
                            {RESPONSE_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </select>
                    </div>

                    {task.responseType === "checkbox" ? (
                      <div className="cleaning-task-checkboxes">
                        <div className="cleaning-task-checkboxes-header">
                          <span>Checkboxes</span>
                          <button
                            type="button"
                            onClick={() => addActionLabel(task.key)}
                            aria-label={`Add checkbox to ${taskLabel}`}
                          >
                            + Add Checkbox
                          </button>
                        </div>

                        {task.actionLabels.length === 0 ? (
                          <p className="cleaning-tasks-empty">No checkboxes yet. Add at least one.</p>
                        ) : null}

                        {task.actionLabels.map((label, labelIndex) => {
                          const labelText = label.value.trim() || `checkbox ${labelIndex + 1}`;
                          return (
                          <div className="cleaning-task-checkbox-row" key={label.key}>
                            <input
                              type="text"
                              value={label.value}
                              onChange={(event) => updateActionLabel(task.key, label.key, event.target.value)}
                              placeholder="Checkbox label, e.g. Cleaned"
                              aria-label={`Checkbox ${labelIndex + 1} label for ${taskLabel}`}
                            />
                            <button
                              type="button"
                              className="danger"
                              onClick={() => removeActionLabel(task.key, label.key)}
                              aria-label={`Remove checkbox ${labelText} from ${taskLabel}`}
                            >
                              Remove
                            </button>
                          </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  );
                })}
              </div>

              {formError ? <p className="form-error">{formError}</p> : null}

              <div className="form-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : editingId ? "Save changes" : "Add Location"}
                </button>
                <button type="button" className="secondary" onClick={closeModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {deleteTarget ? (
        <ModalOverlay
          onClose={() => setDeleteTarget(null)}
          contentClassName="cleaning-location-confirm-modal"
          titleId="food-safety-location-delete-title"
        >
            <h3 id="food-safety-location-delete-title">Deactivate {deleteTarget.name}?</h3>
            <p>
              This location will be deactivated, not erased. It will disappear from this list and from mobile
              task completion, but its completed reports stay fully intact and remain visible (marked Inactive)
              on the Reports page. You can reuse this name for a new location afterward.
            </p>

            {deleteError ? <p className="form-error">{deleteError}</p> : null}

            <div className="form-actions">
              <button type="button" className="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Deactivating..." : "Deactivate Location"}
              </button>
              <button type="button" className="secondary" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
            </div>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
