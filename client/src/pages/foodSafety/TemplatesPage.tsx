import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { createTemplate, listDepartments, listTemplates, updateTemplate } from "../../lib/foodSafety/api";
import type { FoodSafetyDepartment, FoodSafetyFormTemplateListItem, TemplateInput } from "../../lib/foodSafety/types";

type TemplateForm = {
  name: string;
  description: string;
  department_id: string;
  form_code: string;
  canadagap_section: string;
  instructions: string;
  active: boolean;
};

const INITIAL_FORM: TemplateForm = {
  name: "",
  description: "",
  department_id: "",
  form_code: "",
  canadagap_section: "",
  instructions: "",
  active: true
};

type StatusFilter = "all" | "active" | "inactive";

export function FoodSafetyTemplatesPage() {
  const { can } = usePermissions();
  const canManage = can("food_safety:manage_templates");

  const [templates, setTemplates] = useState<FoodSafetyFormTemplateListItem[]>([]);
  const [departments, setDepartments] = useState<FoodSafetyDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>(INITIAL_FORM);

  const departmentsById = useMemo(() => {
    const map = new Map<string, FoodSafetyDepartment>();
    for (const department of departments) map.set(department.id, department);
    return map;
  }, [departments]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [templateRows, departmentRows] = await Promise.all([listTemplates(), listDepartments()]);
      setTemplates(templateRows);
      setDepartments(departmentRows);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load form templates.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    return templates.filter((template) => {
      if (departmentFilter && template.department_id !== departmentFilter) return false;
      if (statusFilter === "active" && !template.active) return false;
      if (statusFilter === "inactive" && template.active) return false;
      if (!query) return true;
      const haystack = [template.name, template.form_code, template.canadagap_section]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [templates, search, departmentFilter, statusFilter]);

  function openAddModal() {
    setError(null);
    setEditingId(null);
    setForm(INITIAL_FORM);
    setModalOpen(true);
  }

  function openEditModal(template: FoodSafetyFormTemplateListItem) {
    setError(null);
    setEditingId(template.id);
    setForm({
      name: template.name,
      description: template.description ?? "",
      department_id: template.department_id ?? "",
      form_code: template.form_code ?? "",
      canadagap_section: template.canadagap_section ?? "",
      instructions: template.instructions ?? "",
      active: template.active
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
  }

  function buildPayload(): TemplateInput {
    return {
      name: form.name.trim(),
      description: form.description.trim() || null,
      department_id: form.department_id || null,
      form_code: form.form_code.trim() || null,
      canadagap_section: form.canadagap_section.trim() || null,
      instructions: form.instructions.trim() || null,
      active: form.active
    };
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError("Template name is required.");
      return;
    }

    setSaving(true);
    try {
      const payload = buildPayload();
      if (editingId) {
        await updateTemplate(editingId, payload);
      } else {
        await createTemplate(payload);
      }
      closeModal();
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save form template.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(template: FoodSafetyFormTemplateListItem) {
    setError(null);
    try {
      await updateTemplate(template.id, {
        name: template.name,
        description: template.description,
        department_id: template.department_id,
        form_code: template.form_code,
        canadagap_section: template.canadagap_section,
        instructions: template.instructions,
        active: !template.active
      });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Failed to update form template.");
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety — Form Templates</h1>
        <p>Versioned form templates used across Food Safety departments.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        <div className="varieties-toolbar" style={{ flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Search by name, form code, or section..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ minWidth: 220 }}
          />
          <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">All statuses</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
          {canManage ? (
            <button type="button" onClick={openAddModal}>
              + Add Template
            </button>
          ) : null}
        </div>

        {loading ? <p>Loading...</p> : null}
        {!loading && filteredTemplates.length === 0 ? <p>No form templates match the current filters.</p> : null}

        {!loading && filteredTemplates.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Department</th>
                  <th>Form Code</th>
                  <th>Status</th>
                  <th>Latest Published</th>
                  <th>Draft</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTemplates.map((template) => {
                  const department = template.department_id ? departmentsById.get(template.department_id) : null;
                  return (
                    <tr key={template.id}>
                      <td>{template.name}</td>
                      <td>{department?.name ?? "-"}</td>
                      <td>{template.form_code ?? "-"}</td>
                      <td>
                        <span className={template.active ? "status-badge active" : "status-badge inactive"}>
                          {template.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        {template.latest_published_version_number != null
                          ? `v${template.latest_published_version_number}`
                          : "None"}
                      </td>
                      <td>
                        {template.has_draft ? (
                          <span className="status-badge inactive">Draft v{template.draft_version_number}</span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <Link to={`/food-safety/templates/${template.id}/edit`}>Open Editor</Link>
                          <Link to={`/food-safety/templates/${template.id}/versions`}>Version History</Link>
                          {canManage ? (
                            <>
                              <button type="button" onClick={() => openEditModal(template)}>
                                Edit
                              </button>
                              <button type="button" className="danger" onClick={() => void toggleActive(template)}>
                                {template.active ? "Deactivate" : "Activate"}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
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
            <h2>{editingId ? "Edit Template" : "Add Template"}</h2>

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
                Form code
                <input
                  type="text"
                  value={form.form_code}
                  onChange={(event) => setForm((current) => ({ ...current, form_code: event.target.value }))}
                  placeholder="e.g. H1, SAN-04"
                />
              </label>

              <label>
                CanadaGAP section
                <input
                  type="text"
                  value={form.canadagap_section}
                  onChange={(event) => setForm((current) => ({ ...current, canadagap_section: event.target.value }))}
                />
              </label>

              <label>
                Instructions
                <textarea
                  rows={3}
                  value={form.instructions}
                  onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))}
                />
              </label>

              <label>
                Status
                <select
                  value={form.active ? "active" : "inactive"}
                  onChange={(event) => setForm((current) => ({ ...current, active: event.target.value === "active" }))}
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
