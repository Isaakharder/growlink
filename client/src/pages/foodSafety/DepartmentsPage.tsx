import { FormEvent, useEffect, useMemo, useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { createDepartment, listDepartments, reorderDepartments, updateDepartment } from "../../lib/foodSafety/api";
import type { FoodSafetyDepartment } from "../../lib/foodSafety/types";

type DepartmentForm = {
  name: string;
  description: string;
  active: boolean;
};

const INITIAL_FORM: DepartmentForm = { name: "", description: "", active: true };

export function FoodSafetyDepartmentsPage() {
  const { can } = usePermissions();
  const canManage = can("food_safety:manage_departments");

  const [departments, setDepartments] = useState<FoodSafetyDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DepartmentForm>(INITIAL_FORM);

  const sortedDepartments = useMemo(
    () => [...departments].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [departments]
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDepartments(await listDepartments());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load departments.");
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

  function openEditModal(department: FoodSafetyDepartment) {
    setError(null);
    setEditingId(department.id);
    setForm({
      name: department.name,
      description: department.description ?? "",
      active: department.active
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
      setError("Department name is required.");
      return;
    }

    setSaving(true);
    try {
      const editing = editingId ? departments.find((department) => department.id === editingId) : null;
      const payload = {
        name,
        description: form.description.trim() || null,
        active: form.active,
        sort_order: editing?.sort_order ?? departments.length
      };

      if (editingId) {
        await updateDepartment(editingId, payload);
      } else {
        await createDepartment(payload);
      }

      closeModal();
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save department.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(department: FoodSafetyDepartment) {
    setError(null);
    try {
      await updateDepartment(department.id, {
        name: department.name,
        description: department.description,
        active: !department.active,
        sort_order: department.sort_order
      });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Failed to update department.");
    }
  }

  async function move(department: FoodSafetyDepartment, direction: -1 | 1) {
    const index = sortedDepartments.findIndex((row) => row.id === department.id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= sortedDepartments.length) return;

    const reordered = [...sortedDepartments];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];

    setError(null);
    try {
      await reorderDepartments(reordered.map((row) => row.id));
      await load();
    } catch (reorderError) {
      setError(reorderError instanceof Error ? reorderError.message : "Failed to reorder departments.");
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety — Departments</h1>
        <p>Program areas such as Irrigation Room, Packing, Sanitation, or Chemical Storage.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        {canManage ? (
          <div className="varieties-toolbar">
            <button type="button" onClick={openAddModal}>
              + Add Department
            </button>
          </div>
        ) : null}

        {loading ? <p>Loading...</p> : null}
        {!loading && sortedDepartments.length === 0 ? <p>No departments added yet.</p> : null}

        {!loading && sortedDepartments.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Status</th>
                  {canManage ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {sortedDepartments.map((department, index) => (
                  <tr key={department.id}>
                    <td>{department.name}</td>
                    <td>{department.description ?? "-"}</td>
                    <td>
                      <span className={department.active ? "status-badge active" : "status-badge inactive"}>
                        {department.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    {canManage ? (
                      <td>
                        <div className="row-actions">
                          <button type="button" onClick={() => void move(department, -1)} disabled={index === 0}>
                            Move up
                          </button>
                          <button
                            type="button"
                            onClick={() => void move(department, 1)}
                            disabled={index === sortedDepartments.length - 1}
                          >
                            Move down
                          </button>
                          <button type="button" onClick={() => openEditModal(department)}>
                            Edit
                          </button>
                          <button type="button" className="danger" onClick={() => void toggleActive(department)}>
                            {department.active ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {modalOpen ? (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingId ? "Edit Department" : "Add Department"}</h2>

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
