import { FormEvent, useEffect, useMemo, useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import {
  createLocation,
  listDepartments,
  listLocations,
  reorderLocations,
  updateLocation
} from "../../lib/foodSafety/api";
import type { FoodSafetyDepartment, FoodSafetyLocation, FoodSafetyLocationType } from "../../lib/foodSafety/types";

type LocationForm = {
  name: string;
  description: string;
  department_id: string;
  location_type: FoodSafetyLocationType;
  active: boolean;
};

const INITIAL_FORM: LocationForm = {
  name: "",
  description: "",
  department_id: "",
  location_type: "location",
  active: true
};

const TYPE_LABELS: Record<FoodSafetyLocationType, string> = {
  location: "Location",
  asset: "Asset"
};

export function FoodSafetyLocationsPage() {
  const { can } = usePermissions();
  const canManage = can("food_safety:manage_locations");

  const [locations, setLocations] = useState<FoodSafetyLocation[]>([]);
  const [departments, setDepartments] = useState<FoodSafetyDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LocationForm>(INITIAL_FORM);

  const departmentsById = useMemo(() => {
    const map = new Map<string, FoodSafetyDepartment>();
    for (const department of departments) map.set(department.id, department);
    return map;
  }, [departments]);

  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [locations]
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [locationRows, departmentRows] = await Promise.all([listLocations(), listDepartments()]);
      setLocations(locationRows);
      setDepartments(departmentRows);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load locations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openAddModal() {
    setError(null);
    setEditingId(null);
    setForm(INITIAL_FORM);
    setModalOpen(true);
  }

  function openEditModal(location: FoodSafetyLocation) {
    setError(null);
    setEditingId(location.id);
    setForm({
      name: location.name,
      description: location.description ?? "",
      department_id: location.department_id ?? "",
      location_type: location.location_type,
      active: location.active
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const name = form.name.trim();
    if (!name) {
      setError("Location name is required.");
      return;
    }

    setSaving(true);
    try {
      const editing = editingId ? locations.find((location) => location.id === editingId) : null;
      const payload = {
        name,
        description: form.description.trim() || null,
        department_id: form.department_id || null,
        location_type: form.location_type,
        active: form.active,
        sort_order: editing?.sort_order ?? locations.length
      };

      if (editingId) {
        await updateLocation(editingId, payload);
      } else {
        await createLocation(payload);
      }

      closeModal();
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save location.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(location: FoodSafetyLocation) {
    setError(null);
    try {
      await updateLocation(location.id, {
        name: location.name,
        description: location.description,
        department_id: location.department_id,
        location_type: location.location_type,
        active: !location.active,
        sort_order: location.sort_order
      });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Failed to update location.");
    }
  }

  async function move(location: FoodSafetyLocation, direction: -1 | 1) {
    const index = sortedLocations.findIndex((row) => row.id === location.id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= sortedLocations.length) return;

    const reordered = [...sortedLocations];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];

    setError(null);
    try {
      await reorderLocations(reordered.map((row) => row.id));
      await load();
    } catch (reorderError) {
      setError(reorderError instanceof Error ? reorderError.message : "Failed to reorder locations.");
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety — Locations &amp; Assets</h1>
        <p>Physical locations and assets — bathrooms, coolers, pack lines, forklifts, chemical rooms, and more.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        {canManage ? (
          <div className="varieties-toolbar">
            <button type="button" onClick={openAddModal}>
              + Add Location / Asset
            </button>
          </div>
        ) : null}

        {loading ? <p>Loading...</p> : null}
        {!loading && sortedLocations.length === 0 ? <p>No locations or assets added yet.</p> : null}

        {!loading && sortedLocations.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Department</th>
                  <th>Status</th>
                  {canManage ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {sortedLocations.map((location, index) => {
                  const department = location.department_id ? departmentsById.get(location.department_id) : null;
                  return (
                    <tr key={location.id}>
                      <td>{location.name}</td>
                      <td>{TYPE_LABELS[location.location_type]}</td>
                      <td>{department?.name ?? "-"}</td>
                      <td>
                        <span className={location.active ? "status-badge active" : "status-badge inactive"}>
                          {location.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      {canManage ? (
                        <td>
                          <div className="row-actions">
                            <button type="button" onClick={() => void move(location, -1)} disabled={index === 0}>
                              Move up
                            </button>
                            <button
                              type="button"
                              onClick={() => void move(location, 1)}
                              disabled={index === sortedLocations.length - 1}
                            >
                              Move down
                            </button>
                            <button type="button" onClick={() => openEditModal(location)}>
                              Edit
                            </button>
                            <button type="button" className="danger" onClick={() => void toggleActive(location)}>
                              {location.active ? "Deactivate" : "Activate"}
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {modalOpen ? (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingId ? "Edit Location / Asset" : "Add Location / Asset"}</h2>

            <form className="varieties-form" onSubmit={submitForm}>
              <label>
                Name
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  required
                />
              </label>

              <label>
                Description
                <input
                  type="text"
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                />
              </label>

              <label>
                Type
                <select
                  value={form.location_type}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      location_type: event.target.value as FoodSafetyLocationType
                    }))
                  }
                >
                  <option value="location">Location</option>
                  <option value="asset">Asset</option>
                </select>
              </label>

              <label>
                Department
                <select
                  value={form.department_id}
                  onChange={(event) => setForm((current) => ({ ...current, department_id: event.target.value }))}
                >
                  <option value="">No department</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Status
                <select
                  value={form.active ? "active" : "inactive"}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, active: event.target.value === "active" }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>

              <div className="form-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeModal}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
