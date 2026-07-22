import { FormEvent, useEffect, useState } from "react";
import { apiFetch, apiUrl } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";

type CleaningTaskFrequency = "daily" | "weekly" | "monthly" | "annually";
type CleaningTaskResponseType = "checkbox" | "number" | "short_text" | "long_text";

type CleaningTask = {
  id: string;
  name: string;
  frequency: CleaningTaskFrequency;
  response_type: CleaningTaskResponseType;
  action_label: string | null;
  sort_order: number;
};

type CleaningLocation = {
  id: string;
  name: string;
  area: string;
  tasks: CleaningTask[];
};

type TaskFormRow = {
  key: string;
  name: string;
  frequency: CleaningTaskFrequency;
  responseType: CleaningTaskResponseType;
  actionLabel: string;
};

const RESPONSE_TYPE_LABELS: Record<CleaningTaskResponseType, string> = {
  checkbox: "Checkbox",
  number: "Number",
  short_text: "Short text",
  long_text: "Long text"
};

type LocationFormState = {
  name: string;
  area: string;
  tasks: TaskFormRow[];
};

const API_BASE = apiUrl("/api/food-safety/cleaning-locations");

const FREQUENCY_LABELS: Record<CleaningTaskFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  annually: "Annually"
};

const FREQUENCY_ORDER: CleaningTaskFrequency[] = ["daily", "weekly", "monthly", "annually"];

function newTaskRow(): TaskFormRow {
  return { key: crypto.randomUUID(), name: "", frequency: "daily", responseType: "checkbox", actionLabel: "" };
}

function emptyForm(): LocationFormState {
  return { name: "", area: "", tasks: [newTaskRow()] };
}

function toFormState(location: CleaningLocation): LocationFormState {
  return {
    name: location.name,
    area: location.area,
    tasks: location.tasks.map((task) => ({
      key: crypto.randomUUID(),
      name: task.name,
      frequency: task.frequency,
      responseType: task.response_type,
      actionLabel: task.action_label ?? ""
    }))
  };
}

function frequencySummary(tasks: CleaningTask[]): string {
  const counts = new Map<CleaningTaskFrequency, number>();
  for (const task of tasks) {
    counts.set(task.frequency, (counts.get(task.frequency) ?? 0) + 1);
  }

  return FREQUENCY_ORDER
    .filter((frequency) => counts.has(frequency))
    .map((frequency) => `${counts.get(frequency)} ${FREQUENCY_LABELS[frequency]}`)
    .join(", ");
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

  useEffect(() => {
    if (!isModalOpen && !deleteTarget) return;

    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (isModalOpen) closeModal();
      if (deleteTarget) setDeleteTarget(null);
    }

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [isModalOpen, deleteTarget]);

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

  function updateTaskFrequency(key: string, frequency: CleaningTaskFrequency) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.key === key ? { ...task, frequency } : task))
    }));
  }

  function updateTaskResponseType(key: string, responseType: CleaningTaskResponseType) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.key === key ? { ...task, responseType } : task))
    }));
  }

  function updateTaskActionLabel(key: string, actionLabel: string) {
    setForm((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.key === key ? { ...task, actionLabel } : task))
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const name = form.name.trim();
    const area = form.area.trim();

    if (!name) {
      setFormError("Location name is required.");
      return;
    }

    if (!area) {
      setFormError("Area/building is required.");
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
      if (task.responseType === "checkbox" && !task.actionLabel.trim()) {
        setFormError(`Task ${index + 1} needs a checkbox label.`);
        return;
      }
    }

    const payload = {
      name,
      area,
      tasks: form.tasks.map((task) => ({
        name: task.name.trim(),
        frequency: task.frequency,
        responseType: task.responseType,
        actionLabel: task.responseType === "checkbox" ? task.actionLabel.trim() : null
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
        throw new Error(`Delete failed (${response.status})`);
      }

      setDeleteTarget(null);
      await fetchLocations();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to delete location");
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
                  <span>{frequencySummary(location.tasks)}</span>
                </div>
              </div>

              {canEdit && (
                <div className="row-actions cleaning-location-card-actions">
                  <button type="button" onClick={() => beginEdit(location)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => requestDelete(location)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="variety-modal cleaning-location-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingId ? "Edit Location" : "Add Location"}</h2>

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

                {form.tasks.map((task) => (
                  <div className="cleaning-task-row" key={task.key}>
                    <div className="cleaning-task-row-main">
                      <input
                        type="text"
                        value={task.name}
                        onChange={(event) => updateTaskName(task.key, event.target.value)}
                        placeholder="Task name, e.g. Floor"
                      />
                      <button type="button" className="danger" onClick={() => removeTaskRow(task.key)}>
                        Remove
                      </button>
                    </div>

                    <div className="cleaning-task-row-options">
                      <select
                        value={task.responseType}
                        onChange={(event) =>
                          updateTaskResponseType(task.key, event.target.value as CleaningTaskResponseType)
                        }
                      >
                        {(Object.keys(RESPONSE_TYPE_LABELS) as CleaningTaskResponseType[]).map((type) => (
                          <option key={type} value={type}>
                            {RESPONSE_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </select>

                      {task.responseType === "checkbox" ? (
                        <input
                          type="text"
                          value={task.actionLabel}
                          onChange={(event) => updateTaskActionLabel(task.key, event.target.value)}
                          placeholder="Checkbox label, e.g. Cleaned"
                        />
                      ) : null}

                      <select
                        value={task.frequency}
                        onChange={(event) => updateTaskFrequency(task.key, event.target.value as CleaningTaskFrequency)}
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="annually">Annually</option>
                      </select>
                    </div>
                  </div>
                ))}
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
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="cleaning-location-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Delete {deleteTarget.name}?</h3>
            <p>This will also remove all cleaning tasks configured for this location.</p>

            {deleteError ? <p className="form-error">{deleteError}</p> : null}

            <div className="form-actions">
              <button type="button" className="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete Location"}
              </button>
              <button type="button" className="secondary" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
