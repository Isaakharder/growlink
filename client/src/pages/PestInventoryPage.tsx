import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

type ChemicalType = "fungicide" | "insecticide" | "herbicide" | "pesticide";

const CHEMICAL_TYPE_OPTIONS: { value: ChemicalType; label: string }[] = [
  { value: "fungicide", label: "Fungicide" },
  { value: "insecticide", label: "Insecticide" },
  { value: "herbicide", label: "Herbicide" },
  { value: "pesticide", label: "Pesticide" }
];

type Chemical = {
  id: string;
  name: string;
  active: boolean;
  inventory_qty: number;
  inventory_unit: string;
  pest_target: string;
  notes: string | null;
  phi: string | null;
  rei: string | null;
  chemical_group: string | null;
  chemical_type: ChemicalType | null;
  active_ingredients: string | null;
  registration_number: string | null;
  label_pdf_path: string | null;
  created_at: string;
  updated_at: string;
};

type ChemicalFormState = {
  name: string;
  active: boolean;
  inventory_qty: string;
  inventory_unit: string;
  pest_target: string;
  notes: string;
  phi: string;
  rei: string;
  chemical_group: string;
  chemical_type: ChemicalType | "";
  active_ingredients: string;
  registration_number: string;
};

const CHEMICALS_URL = "/api/pest/chemicals";

const INITIAL_FORM: ChemicalFormState = {
  name: "",
  active: true,
  inventory_qty: "0",
  inventory_unit: "L",
  pest_target: "",
  notes: "",
  phi: "",
  rei: "",
  chemical_group: "",
  chemical_type: "",
  active_ingredients: "",
  registration_number: ""
};

function toFormState(c: Chemical): ChemicalFormState {
  return {
    name: c.name,
    active: c.active,
    inventory_qty: String(c.inventory_qty),
    inventory_unit: c.inventory_unit,
    pest_target: c.pest_target,
    notes: c.notes ?? "",
    phi: c.phi ?? "",
    rei: c.rei ?? "",
    chemical_group: c.chemical_group ?? "",
    chemical_type: c.chemical_type ?? "",
    active_ingredients: c.active_ingredients ?? "",
    registration_number: c.registration_number ?? ""
  };
}

// Alphabetical base sort, then split into startsWith / contains when query is present.
// Within each group items stay alphabetical.
function filterAndSortChemicals(list: Chemical[], query: string): Chemical[] {
  const sorted = [...list].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
  const q = query.trim().toLowerCase();
  if (!q) return sorted;
  const startsWith: Chemical[] = [];
  const contains: Chemical[] = [];
  for (const c of sorted) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) startsWith.push(c);
    else if (name.includes(q)) contains.push(c);
  }
  return [...startsWith, ...contains];
}

export function PestInventoryPage() {
  const [chemicals, setChemicals] = useState<Chemical[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ChemicalFormState>(INITIAL_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isRestockModalOpen, setIsRestockModalOpen] = useState(false);
  const [restockChemicalId, setRestockChemicalId] = useState<string | null>(null);
  const [restockAmount, setRestockAmount] = useState<string>("");
  const [restockNote, setRestockNote] = useState<string>("");
  const [restockSaving, setRestockSaving] = useState(false);
  const [restockError, setRestockError] = useState<string | null>(null);

  // PDF upload state
  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const [removingLabel, setRemovingLabel] = useState(false);
  const [labelLoading, setLabelLoading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  async function fetchChemicals() {
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(CHEMICALS_URL);
      if (!res.ok) throw new Error("Failed to load chemicals");
      const data = (await res.json()) as Chemical[];
      setChemicals(data);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : "Failed to load chemicals"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchChemicals();
  }, []);

  useEffect(() => {
    if (!isModalOpen && !isRestockModalOpen) return;

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (isModalOpen) closeModal();
        if (isRestockModalOpen) closeRestockModal();
      }
    }

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [isModalOpen, isRestockModalOpen]);

  // Close suggestion dropdown on outside click
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const filteredChemicals = useMemo(
    () => filterAndSortChemicals(chemicals, searchQuery),
    [chemicals, searchQuery]
  );

  // Suggestions: top 8 matches when query is non-empty
  const suggestions = useMemo(
    () => (searchQuery.trim() ? filteredChemicals.slice(0, 8) : []),
    [filteredChemicals, searchQuery]
  );

  function openAddModal() {
    setEditingId(null);
    setForm(INITIAL_FORM);
    setPendingPdf(null);
    setError(null);
    setIsModalOpen(true);
  }

  function beginEdit(chemical: Chemical) {
    setEditingId(chemical.id);
    setForm(toFormState(chemical));
    setPendingPdf(null);
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
    setPendingPdf(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }

    const inventory_unit = form.inventory_unit.trim();
    if (!inventory_unit) {
      setError("Inventory unit is required.");
      return;
    }

    const inventory_qty = Number(form.inventory_qty);
    if (!Number.isFinite(inventory_qty) || inventory_qty < 0) {
      setError("Inventory quantity must be 0 or greater.");
      return;
    }

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${CHEMICALS_URL}/${editingId}` : CHEMICALS_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify({
          name,
          active: form.active,
          inventory_qty,
          inventory_unit,
          pest_target: form.pest_target.trim(),
          notes: form.notes.trim() || null,
          phi: form.phi.trim() || null,
          rei: form.rei.trim() || null,
          chemical_group: form.chemical_group.trim() || null,
          chemical_type: form.chemical_type || null,
          active_ingredients: form.active_ingredients.trim() || null,
          registration_number: form.registration_number.trim() || null
        })
      });

      if (!response.ok) {
        let message = editingId ? "Update failed" : "Create failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // use fallback
        }
        throw new Error(message);
      }

      const saved = (await response.json()) as Chemical;

      // Upload PDF if one was selected
      if (pendingPdf) {
        const formData = new FormData();
        formData.append("label", pendingPdf);

        const uploadRes = await apiFetch(`${CHEMICALS_URL}/${saved.id}/label`, {
          method: "POST",
          body: formData
        });

        if (!uploadRes.ok) {
          // Chemical saved — warn but don't roll back
          setError("Chemical saved, but PDF upload failed. Try re-uploading from the edit form.");
          await fetchChemicals();
          closeModal();
          return;
        }
      }

      closeModal();
      await fetchChemicals();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Failed to save chemical"
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteChemical(id: string) {
    if (!window.confirm("Delete this chemical?")) return;
    setError(null);

    try {
      const response = await apiFetch(`${CHEMICALS_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      await fetchChemicals();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete chemical"
      );
    }
  }

  function openRestockModal(chemical: Chemical) {
    setRestockChemicalId(chemical.id);
    setRestockAmount("");
    setRestockNote("");
    setRestockError(null);
    setIsRestockModalOpen(true);
  }

  function closeRestockModal() {
    setIsRestockModalOpen(false);
    setRestockChemicalId(null);
    setRestockAmount("");
    setRestockNote("");
    setRestockError(null);
    setRestockSaving(false);
  }

  async function handleRestockSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRestockError(null);

    if (!restockChemicalId) {
      setRestockError("Select a chemical to restock.");
      return;
    }

    const amount = Number(restockAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setRestockError("Restock amount must be greater than 0.");
      return;
    }

    setRestockSaving(true);
    try {
      const response = await apiFetch(`${CHEMICALS_URL}/${restockChemicalId}/restock`, {
        method: "POST",
        body: JSON.stringify({
          amount,
          note: restockNote.trim() || undefined
        })
      });

      if (!response.ok) {
        let message = "Restock failed";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // use fallback
        }
        throw new Error(message);
      }

      const updated = (await response.json()) as Chemical;
      setChemicals((current) =>
        current.map((chemical) => (chemical.id === updated.id ? updated : chemical))
      );
      closeRestockModal();
    } catch (submitError) {
      setRestockError(
        submitError instanceof Error ? submitError.message : "Failed to restock chemical"
      );
    } finally {
      setRestockSaving(false);
    }
  }

  async function removeLabel(chemical: Chemical) {
    if (!window.confirm("Remove the uploaded label PDF?")) return;
    setRemovingLabel(true);
    setError(null);

    try {
      const response = await apiFetch(`${CHEMICALS_URL}/${chemical.id}/label`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error("Failed to remove label");
      await fetchChemicals();
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : "Failed to remove label"
      );
    } finally {
      setRemovingLabel(false);
    }
  }

  async function viewLabel(chemicalId: string) {
    setLabelLoading(chemicalId);
    setError(null);

    try {
      const res = await apiFetch(`${CHEMICALS_URL}/${chemicalId}/label-url`);
      if (!res.ok) throw new Error("Failed to get label URL");
      const { url } = (await res.json()) as { url: string };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (viewError) {
      setError(
        viewError instanceof Error ? viewError.message : "Failed to open label"
      );
    } finally {
      setLabelLoading(null);
    }
  }

  const editingChemical = editingId
    ? chemicals.find((c) => c.id === editingId) ?? null
    : null;
  const restockChemical = restockChemicalId
    ? chemicals.find((c) => c.id === restockChemicalId) ?? null
    : null;

  return (
    <section className="page-shell">
      <header>
        <h1>Pest Control Inventory</h1>
        <p>Manage chemical inventory for spray planning.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        <h2>Chemicals</h2>

        <div className="varieties-toolbar">
          <button type="button" onClick={openAddModal}>
            + Add Chemical
          </button>
        </div>

        {/* ── Search / autocomplete ── */}
        <div ref={searchContainerRef} style={{ position: "relative", margin: "0.75rem 0 0.5rem" }}>
          <input
            type="search"
            placeholder="Search chemicals..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => { if (searchQuery.trim()) setSearchOpen(true); }}
            style={{
              width: "100%",
              border: "1px solid var(--border)",
              borderRadius: "10px",
              background: "var(--surface)",
              color: "var(--text)",
              font: "inherit",
              padding: "0.5rem 0.75rem",
            }}
          />

          {searchOpen && searchQuery.trim() ? (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "10px",
                boxShadow: "var(--shadow)",
                zIndex: 20,
                overflow: "hidden",
              }}
            >
              {suggestions.length === 0 ? (
                <p style={{ margin: 0, padding: "0.6rem 0.85rem", fontSize: "0.9em", color: "var(--text-muted)" }}>
                  No chemicals found.
                </p>
              ) : (
                suggestions.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      beginEdit(c);
                      setSearchQuery("");
                      setSearchOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "0.5rem",
                      width: "100%",
                      padding: "0.55rem 0.85rem",
                      background: "none",
                      border: "none",
                      borderTop: "1px solid var(--border)",
                      cursor: "pointer",
                      textAlign: "left",
                      font: "inherit",
                      color: "var(--text)",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--active, #e6f5ef)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    <span style={{ fontWeight: 600, fontSize: "0.92em" }}>{c.name}</span>
                    {c.chemical_type ? (
                      <span style={{ fontSize: "0.78em", color: "var(--text-muted)" }}>
                        {c.chemical_type.charAt(0).toUpperCase() + c.chemical_type.slice(1)}
                      </span>
                    ) : null}
                    {!c.active ? (
                      <span style={{ fontSize: "0.75em", color: "var(--text-muted)", marginLeft: "auto" }}>
                        Inactive
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {loading ? <p>Loading...</p> : null}

        {!loading && chemicals.length === 0 ? <p>No chemicals added yet.</p> : null}

        {chemicals.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Group</th>
                  <th>PHI</th>
                  <th>Reg. No.</th>
                  <th>In Stock</th>
                  <th>Active</th>
                  <th>Label</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredChemicals.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ color: "var(--text-muted)", textAlign: "center", padding: "1rem" }}>
                      No chemicals found.
                    </td>
                  </tr>
                ) : null}
                {filteredChemicals.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>
                      {c.chemical_type ? (
                        <span className="status-badge active">
                          {c.chemical_type.charAt(0).toUpperCase() +
                            c.chemical_type.slice(1)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{c.chemical_group || "—"}</td>
                    <td>{c.phi || "—"}</td>
                    <td>{c.registration_number || "—"}</td>
                    <td>
                      {c.inventory_qty} {c.inventory_unit}
                    </td>
                    <td>
                      <span
                        className={c.active ? "status-badge active" : "status-badge inactive"}
                      >
                        {c.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      {c.label_pdf_path ? (
                        <button
                          type="button"
                          className="secondary"
                          style={{ fontSize: "0.8em", padding: "0.2rem 0.5rem" }}
                          disabled={labelLoading === c.id}
                          onClick={() => void viewLabel(c.id)}
                        >
                          {labelLoading === c.id ? "Opening…" : "View PDF"}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => openRestockModal(c)}>
                          Restock
                        </button>
                        <button type="button" onClick={() => beginEdit(c)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void deleteChemical(c.id)}
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
            <h2>{editingId ? "Edit Chemical" : "Add Chemical"}</h2>

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
                Chemical type
                <select
                  value={form.chemical_type}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      chemical_type: event.target.value as ChemicalType | ""
                    }))
                  }
                >
                  <option value="">— Select type —</option>
                  {CHEMICAL_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                PHI (pre-harvest interval)
                <input
                  type="text"
                  value={form.phi}
                  placeholder="e.g. 0 days, 12 hours, 3 days"
                  onChange={(event) =>
                    setForm((current) => ({ ...current, phi: event.target.value }))
                  }
                />
              </label>

              <label>
                REI (re-entry interval)
                <input
                  type="text"
                  value={form.rei}
                  placeholder="e.g. 4 hours, 24 hours"
                  onChange={(event) =>
                    setForm((current) => ({ ...current, rei: event.target.value }))
                  }
                />
              </label>

              <label>
                Group
                <input
                  type="text"
                  value={form.chemical_group}
                  placeholder="e.g. Group 7, FRAC M03"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      chemical_group: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Active ingredients
                <input
                  type="text"
                  value={form.active_ingredients}
                  placeholder="e.g. Azoxystrobin 250 g/L"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      active_ingredients: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Registration number
                <input
                  type="text"
                  value={form.registration_number}
                  placeholder="e.g. 26568"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      registration_number: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Inventory quantity
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.inventory_qty}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      inventory_qty: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Inventory unit
                <input
                  type="text"
                  value={form.inventory_unit}
                  placeholder="e.g. L, mL, kg, g"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      inventory_unit: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Pest target / use case
                <input
                  type="text"
                  value={form.pest_target}
                  placeholder="e.g. Spider mites, Botrytis"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      pest_target: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Notes (optional)
                <textarea
                  value={form.notes}
                  rows={3}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, notes: event.target.value }))
                  }
                />
              </label>

              <label>
                Status
                <select
                  value={form.active ? "true" : "false"}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      active: event.target.value === "true"
                    }))
                  }
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </label>

              {/* PDF label upload */}
              <div>
                <label style={{ marginBottom: "0.25rem", display: "block" }}>
                  Label PDF
                </label>

                {editingChemical?.label_pdf_path && !pendingPdf ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      marginBottom: "0.4rem"
                    }}
                  >
                    <span style={{ fontSize: "0.9em" }}>Label uploaded</span>
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: "0.8em", padding: "0.2rem 0.5rem" }}
                      disabled={labelLoading === editingId}
                      onClick={() => void viewLabel(editingId!)}
                    >
                      {labelLoading === editingId ? "Opening…" : "View"}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      style={{ fontSize: "0.8em", padding: "0.2rem 0.5rem" }}
                      disabled={removingLabel}
                      onClick={() => void removeLabel(editingChemical)}
                    >
                      {removingLabel ? "Removing…" : "Remove"}
                    </button>
                  </div>
                ) : null}

                {pendingPdf ? (
                  <p style={{ fontSize: "0.85em", marginBottom: "0.25rem" }}>
                    Selected: {pendingPdf.name}
                    <button
                      type="button"
                      className="secondary"
                      style={{ marginLeft: "0.5rem", fontSize: "0.8em", padding: "0.1rem 0.4rem" }}
                      onClick={() => {
                        setPendingPdf(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                    >
                      Clear
                    </button>
                  </p>
                ) : null}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setPendingPdf(file);
                  }}
                />
                <p style={{ fontSize: "0.8em", color: "var(--color-text-muted, #888)", marginTop: "0.2rem" }}>
                  Max 10 MB. Replaces any existing label.
                </p>
              </div>

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

      {isRestockModalOpen && restockChemical ? (
        <div className="modal-overlay" onClick={closeRestockModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Restock chemical</h2>

            <form className="varieties-form" onSubmit={handleRestockSubmit}>
              <label>
                Chemical
                <input type="text" value={restockChemical.name} readOnly />
              </label>

              <label>
                Current inventory
                <input
                  type="text"
                  value={`${restockChemical.inventory_qty} ${restockChemical.inventory_unit}`}
                  readOnly
                />
              </label>

              <label>
                Restock amount ({restockChemical.inventory_unit})
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={restockAmount}
                  onChange={(event) => setRestockAmount(event.target.value)}
                  required
                />
              </label>

              <label>
                Note (optional)
                <textarea
                  value={restockNote}
                  rows={3}
                  onChange={(event) => setRestockNote(event.target.value)}
                />
              </label>

              {restockError ? <p className="form-error">{restockError}</p> : null}

              <div className="form-actions">
                <button type="submit" disabled={restockSaving}>
                  {restockSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeRestockModal} disabled={restockSaving}>
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
