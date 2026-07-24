import { FormEvent, useEffect, useState } from "react";
import { apiFetch, apiUrl } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

type VarietyStatus = "active" | "inactive";
type VarietyColor = "red" | "orange" | "yellow" | "green";
type YieldSizeStatus = "active" | "inactive";

type Variety = {
  id: string;
  name: string;
  area_m2: number;
  case_kg: number;
  planting_date: string | null;
  pull_out_date: string | null;
  status: VarietyStatus;
  color: VarietyColor;
  created_at: string;
  updated_at: string;
};

type VarietyFormState = {
  name: string;
  area_m2: string;
  case_kg: string;
  planting_date: string;
  pull_out_date: string;
  status: VarietyStatus;
  color: VarietyColor;
};

type YieldSize = {
  id: string;
  name: string;
  sort_order: number;
  status: YieldSizeStatus;
  created_at: string;
  updated_at: string;
};

type YieldSizeFormState = {
  name: string;
  sort_order: string;
  status: YieldSizeStatus;
};

const API_BASE = apiUrl("/api/varieties");
const YIELD_SIZES_API_BASE = apiUrl("/api/yield-sizes");

const INITIAL_FORM: VarietyFormState = {
  name: "",
  area_m2: "0",
  case_kg: "0",
  planting_date: "",
  pull_out_date: "",
  status: "active",
  color: "red"
};

const INITIAL_SIZE_FORM: YieldSizeFormState = {
  name: "",
  sort_order: "0",
  status: "active"
};

function toFormState(variety: Variety): VarietyFormState {
  return {
    name: variety.name,
    area_m2: String(variety.area_m2),
    case_kg: String(variety.case_kg),
    planting_date: variety.planting_date ?? "",
    pull_out_date: variety.pull_out_date ?? "",
    status: variety.status,
    color: variety.color
  };
}

function toPayload(form: VarietyFormState) {
  return {
    name: form.name.trim(),
    area_m2: Number(form.area_m2),
    case_kg: Number(form.case_kg),
    planting_date: form.planting_date || null,
    pull_out_date: form.pull_out_date || null,
    status: form.status,
    color: form.color
  };
}

function toSizeFormState(size: YieldSize): YieldSizeFormState {
  return {
    name: size.name,
    sort_order: String(size.sort_order),
    status: size.status
  };
}

function toSizePayload(form: YieldSizeFormState) {
  return {
    name: form.name.trim(),
    sort_order: Number(form.sort_order),
    status: form.status
  };
}

export function VarietiesSetupPage() {
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [sizes, setSizes] = useState<YieldSize[]>([]);
  const [loading, setLoading] = useState(true);
  const [sizesLoading, setSizesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sizeSaving, setSizeSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizesError, setSizesError] = useState<string | null>(null);
  const [form, setForm] = useState<VarietyFormState>(INITIAL_FORM);
  const [sizeForm, setSizeForm] = useState<YieldSizeFormState>(INITIAL_SIZE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSizeId, setEditingSizeId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSizeModalOpen, setIsSizeModalOpen] = useState(false);

  async function fetchVarieties() {
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(API_BASE);
      if (!res.ok) {
        throw new Error("Failed to fetch");
      }

      const data = (await res.json()) as Variety[];
      setVarieties(data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  async function fetchSizes() {
    setSizesLoading(true);
    setSizesError(null);

    try {
      const response = await apiFetch(YIELD_SIZES_API_BASE);
      if (!response.ok) {
        throw new Error("Failed to fetch sizes");
      }

      const data = (await response.json()) as YieldSize[];
      setSizes(data);
    } catch (fetchError) {
      setSizesError(
        fetchError instanceof Error ? fetchError.message : "Failed to fetch sizes"
      );
    } finally {
      setSizesLoading(false);
    }
  }

  useEffect(() => {
    void fetchVarieties();
  }, []);

  useEffect(() => {
    void fetchSizes();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = toPayload(form);

    if (!payload.name) {
      setError("Variety name is required.");
      return;
    }

    if (payload.area_m2 < 0 || payload.case_kg < 0) {
      setError("Area and Case kg must be 0 or greater.");
      return;
    }

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${API_BASE}/${editingId}` : API_BASE;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `${editingId ? "Update" : "Create"} failed`;

        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore malformed error response and use fallback message.
        }

        throw new Error(message);
      }

      setIsModalOpen(false);
      setForm(INITIAL_FORM);
      setEditingId(null);
      await fetchVarieties();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save variety"
      );
    } finally {
      setSaving(false);
    }
  }

  function openAddModal() {
    setEditingId(null);
    setForm(INITIAL_FORM);
    setError(null);
    setIsModalOpen(true);
  }

  function beginEdit(variety: Variety) {
    setEditingId(variety.id);
    setForm(toFormState(variety));
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
    setError(null);
  }

  async function deleteVariety(id: string) {
    const confirmed = window.confirm("Delete this variety?");
    if (!confirmed) {
      return;
    }

    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }

      if (editingId === id) {
        closeModal();
      }

      await fetchVarieties();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete variety"
      );
    }
  }

  async function handleSizeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSizesError(null);

    const payload = toSizePayload(sizeForm);

    if (!payload.name) {
      setSizesError("Size name is required.");
      return;
    }

    if (!Number.isInteger(payload.sort_order) || payload.sort_order < 0) {
      setSizesError("Sort order must be 0 or greater.");
      return;
    }

    setSizeSaving(true);

    try {
      const method = editingSizeId ? "PUT" : "POST";
      const url = editingSizeId
        ? `${YIELD_SIZES_API_BASE}/${editingSizeId}`
        : YIELD_SIZES_API_BASE;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `${editingSizeId ? "Update" : "Create"} failed`;

        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore malformed error response and use fallback message.
        }

        throw new Error(message);
      }

      closeSizeModal();
      await fetchSizes();
    } catch (submitError) {
      setSizesError(
        submitError instanceof Error ? submitError.message : "Failed to save size"
      );
    } finally {
      setSizeSaving(false);
    }
  }

  function openAddSizeModal() {
    setEditingSizeId(null);
    setSizeForm(INITIAL_SIZE_FORM);
    setSizesError(null);
    setIsSizeModalOpen(true);
  }

  function beginEditSize(size: YieldSize) {
    setEditingSizeId(size.id);
    setSizeForm(toSizeFormState(size));
    setSizesError(null);
    setIsSizeModalOpen(true);
  }

  function closeSizeModal() {
    setIsSizeModalOpen(false);
    setEditingSizeId(null);
    setSizeForm(INITIAL_SIZE_FORM);
    setSizesError(null);
  }

  async function deleteSize(id: string) {
    const confirmed = window.confirm("Delete this size?");
    if (!confirmed) {
      return;
    }

    setSizesError(null);

    try {
      const response = await apiFetch(`${YIELD_SIZES_API_BASE}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }

      if (editingSizeId === id) {
        closeSizeModal();
      }

      await fetchSizes();
    } catch (deleteError) {
      setSizesError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete size"
      );
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Varieties Setup</h1>
        <p>Manage crop varieties and baseline growing attributes.</p>
      </header>

      <div className="varieties-toolbar">
        <button type="button" onClick={openAddModal}>
          + Add Variety
        </button>
      </div>

      <div className="coming-soon-card">
        <h2>Existing Varieties</h2>

        {error ? <p className="form-error">{error}</p> : null}

        {loading ? <p>Loading...</p> : null}

        {!loading && varieties.length === 0 ? <p>No varieties added yet.</p> : null}

        {!loading && varieties.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Color</th>
                  <th>Area m²</th>
                  <th>Case kg</th>
                  <th>Planting date</th>
                  <th>Pull-out date</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {varieties.map((variety) => (
                  <tr key={variety.id}>
                    {(() => {
                      const color = variety.color ?? "red";

                      return (
                        <>
                          <td>{variety.name}</td>
                          <td>
                            <span className={`color-badge ${color}`}>
                              {color.charAt(0).toUpperCase() + color.slice(1)}
                            </span>
                          </td>
                          <td>{variety.area_m2}</td>
                          <td>{variety.case_kg}</td>
                          <td>{variety.planting_date ?? "-"}</td>
                          <td>{variety.pull_out_date ?? "-"}</td>
                          <td>
                            <span
                              className={
                                variety.status === "active"
                                  ? "status-badge active"
                                  : "status-badge inactive"
                              }
                            >
                              {variety.status === "active" ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button type="button" onClick={() => beginEdit(variety)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => deleteVariety(variety.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </>
                      );
                    })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="varieties-toolbar">
        <button type="button" onClick={openAddSizeModal}>
          + Add Size
        </button>
      </div>

      <div className="coming-soon-card">
        <h2>Yield Sizes</h2>

        {sizesError ? <p className="form-error">{sizesError}</p> : null}

        {sizesLoading ? <p>Loading...</p> : null}

        {!sizesLoading && sizes.length === 0 ? <p>No sizes added yet.</p> : null}

        {!sizesLoading && sizes.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sort Order</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sizes.map((size) => (
                  <tr key={size.id}>
                    <td>{size.name}</td>
                    <td>{size.sort_order}</td>
                    <td>
                      <span
                        className={
                          size.status === "active"
                            ? "status-badge active"
                            : "status-badge inactive"
                        }
                      >
                        {size.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => beginEditSize(size)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => deleteSize(size.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {isModalOpen ? (
        <ModalOverlay onClose={closeModal} contentClassName="variety-modal" titleId="variety-modal-title">
            <h2 id="variety-modal-title">{editingId ? "Edit Variety" : "Add Variety"}</h2>

            <form className="varieties-form" onSubmit={handleSubmit}>
              <label>
                Variety name
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Area in m²
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.area_m2}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, area_m2: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Case kg
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.case_kg}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, case_kg: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Planting date
                <input
                  type="date"
                  value={form.planting_date}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      planting_date: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Pull-out date
                <input
                  type="date"
                  value={form.pull_out_date}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      pull_out_date: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Status
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      status: event.target.value as VarietyStatus
                    }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>

              <label>
                Color
                <select
                  value={form.color}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      color: event.target.value as VarietyColor
                    }))
                  }
                >
                  <option value="red">Red</option>
                  <option value="orange">Orange</option>
                  <option value="yellow">Yellow</option>
                  <option value="green">Green</option>
                </select>
              </label>

              <div className="form-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save variety"}
                </button>
                <button type="button" className="secondary" onClick={closeModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {isSizeModalOpen ? (
        <ModalOverlay onClose={closeSizeModal} contentClassName="variety-modal" titleId="variety-size-modal-title">
            <h2 id="variety-size-modal-title">{editingSizeId ? "Edit Size" : "Add Size"}</h2>

            <form className="varieties-form" onSubmit={handleSizeSubmit}>
              <label>
                Size name
                <input
                  type="text"
                  value={sizeForm.name}
                  onChange={(event) =>
                    setSizeForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Sort order
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={sizeForm.sort_order}
                  onChange={(event) =>
                    setSizeForm((current) => ({
                      ...current,
                      sort_order: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Status
                <select
                  value={sizeForm.status}
                  onChange={(event) =>
                    setSizeForm((current) => ({
                      ...current,
                      status: event.target.value as YieldSizeStatus
                    }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>

              <div className="form-actions">
                <button type="submit" disabled={sizeSaving}>
                  {sizeSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeSizeModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
