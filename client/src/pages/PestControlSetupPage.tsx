import { FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type Sprayer = {
  id: string;
  name: string;
  nozzle_count: number;
  nozzle_volume_l_per_min: number;
  nozzle_psi: number;
  speed_m_per_min: number;
  created_at: string;
  updated_at: string;
};

type SprayerFormState = {
  name: string;
  nozzle_count: string;
  nozzle_volume_l_per_min: string;
  nozzle_psi: string;
  speed_m_per_min: string;
};

const SPRAYERS_URL = "/api/pest/sprayers";

const INITIAL_FORM: SprayerFormState = {
  name: "",
  nozzle_count: "1",
  nozzle_volume_l_per_min: "0",
  nozzle_psi: "0",
  speed_m_per_min: "50"
};

const SPEED_OPTIONS = Array.from({ length: 61 }, (_, i) => 20 + i);

function toFormState(sprayer: Sprayer): SprayerFormState {
  return {
    name: sprayer.name,
    nozzle_count: String(sprayer.nozzle_count),
    nozzle_volume_l_per_min: String(sprayer.nozzle_volume_l_per_min),
    nozzle_psi: String(sprayer.nozzle_psi),
    speed_m_per_min: String(sprayer.speed_m_per_min)
  };
}

export function PestControlSetupPage() {
  const [sprayers, setSprayers] = useState<Sprayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<SprayerFormState>(INITIAL_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  async function fetchSprayers() {
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(SPRAYERS_URL);
      if (!res.ok) {
        throw new Error("Failed to load sprayers");
      }
      const data = (await res.json()) as Sprayer[];
      setSprayers(data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load sprayers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchSprayers();
  }, []);

  useEffect(() => {
    if (!isModalOpen) {
      return;
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeModal();
      }
    }

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [isModalOpen]);

  function openAddModal() {
    setEditingId(null);
    setForm(INITIAL_FORM);
    setError(null);
    setIsModalOpen(true);
  }

  function beginEdit(sprayer: Sprayer) {
    setEditingId(sprayer.id);
    setForm(toFormState(sprayer));
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }

    const nozzle_count = Number(form.nozzle_count);
    if (!Number.isInteger(nozzle_count) || nozzle_count < 1) {
      setError("Nozzle count must be 1 or greater.");
      return;
    }

    const nozzle_volume_l_per_min = Number(form.nozzle_volume_l_per_min);
    if (!Number.isFinite(nozzle_volume_l_per_min) || nozzle_volume_l_per_min < 0) {
      setError("Nozzle volume must be 0 or greater.");
      return;
    }

    const nozzle_psi = Number(form.nozzle_psi);
    if (!Number.isFinite(nozzle_psi) || nozzle_psi < 0) {
      setError("PSI must be 0 or greater.");
      return;
    }

    const speed_m_per_min = Number(form.speed_m_per_min);
    if (!Number.isFinite(speed_m_per_min) || speed_m_per_min < 20 || speed_m_per_min > 80) {
      setError("Speed must be between 20 and 80 m/min.");
      return;
    }

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${SPRAYERS_URL}/${editingId}` : SPRAYERS_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name,
          nozzle_count,
          nozzle_volume_l_per_min,
          nozzle_psi,
          speed_m_per_min
        })
      });

      if (!response.ok) {
        let message = editingId ? "Update failed" : "Create failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) {
            message = body.message;
          }
        } catch {
          // use fallback
        }
        throw new Error(message);
      }

      closeModal();
      await fetchSprayers();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Failed to save sprayer"
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteSprayer(id: string) {
    const confirmed = window.confirm("Delete this sprayer?");
    if (!confirmed) {
      return;
    }

    setError(null);

    try {
      const response = await apiFetch(`${SPRAYERS_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }
      await fetchSprayers();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete sprayer"
      );
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Pest Control Setup</h1>
        <p>Configure sprayers and other pest control defaults for your organization.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        <h2>Sprayers</h2>

        <div className="varieties-toolbar">
          <button type="button" onClick={openAddModal}>
            + Add Sprayer
          </button>
        </div>

        {loading ? <p>Loading...</p> : null}

        {!loading && sprayers.length === 0 ? (
          <p>No sprayers added yet.</p>
        ) : null}

        {sprayers.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Nozzles</th>
                  <th>Volume (L/min)</th>
                  <th>PSI</th>
                  <th>Speed (m/min)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sprayers.map((sprayer) => (
                  <tr key={sprayer.id}>
                    <td>{sprayer.name}</td>
                    <td>{sprayer.nozzle_count}</td>
                    <td>{sprayer.nozzle_volume_l_per_min}</td>
                    <td>{sprayer.nozzle_psi}</td>
                    <td>{sprayer.speed_m_per_min}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => beginEdit(sprayer)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void deleteSprayer(sprayer.id)}
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
        <div className="modal-overlay" onClick={closeModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingId ? "Edit Sprayer" : "Add Sprayer"}</h2>

            <form className="varieties-form" onSubmit={handleSubmit}>
              <label>
                Name
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
                Nozzle count
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.nozzle_count}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, nozzle_count: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Nozzle volume (L/min)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.nozzle_volume_l_per_min}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      nozzle_volume_l_per_min: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Nozzle PSI
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.nozzle_psi}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, nozzle_psi: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Speed (m/min)
                <select
                  value={form.speed_m_per_min}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      speed_m_per_min: event.target.value
                    }))
                  }
                >
                  {SPEED_OPTIONS.map((speed) => (
                    <option key={speed} value={String(speed)}>
                      {speed}
                    </option>
                  ))}
                </select>
              </label>

              {error ? <p className="form-error">{error}</p> : null}

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
