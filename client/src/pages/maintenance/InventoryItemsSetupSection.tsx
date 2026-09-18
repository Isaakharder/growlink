import { useEffect, useState } from "react";
import { activateInventoryItem, createInventoryItem, deactivateInventoryItem, listInventoryItems, listSetupResource, updateInventoryItem } from "./api";
import { inventoryUnitLabel } from "./formatters";
import { InventoryItemPayload, InventoryItemRow, SetupRecord, UnitOfMeasure, UNITS_OF_MEASURE } from "./types";

type Draft = {
  name: string; part_number: string; part_type_id: string; location_id: string; unit_of_measure: UnitOfMeasure;
  unit_of_measure_custom_label: string; minimum_quantity: string; suggested_reorder_quantity: string; supplier: string;
  supplier_part_number: string; cost: string; notes: string;
};

const EMPTY_DRAFT: Draft = {
  name: "", part_number: "", part_type_id: "", location_id: "", unit_of_measure: "each", unit_of_measure_custom_label: "",
  minimum_quantity: "", suggested_reorder_quantity: "", supplier: "", supplier_part_number: "", cost: "", notes: ""
};

function toPayload(draft: Draft): InventoryItemPayload {
  return {
    name: draft.name.trim(),
    part_number: draft.part_number.trim() || null,
    part_type_id: draft.part_type_id || null,
    location_id: draft.location_id,
    unit_of_measure: draft.unit_of_measure,
    unit_of_measure_custom_label: draft.unit_of_measure === "custom" ? draft.unit_of_measure_custom_label.trim() || null : null,
    minimum_quantity: draft.minimum_quantity.trim() ? Number(draft.minimum_quantity) : null,
    suggested_reorder_quantity: draft.suggested_reorder_quantity.trim() ? Number(draft.suggested_reorder_quantity) : null,
    supplier: draft.supplier.trim() || null,
    supplier_part_number: draft.supplier_part_number.trim() || null,
    cost: draft.cost.trim() ? Number(draft.cost) : null,
    notes: draft.notes.trim() || null
  };
}

export function InventoryItemsSetupSection({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<InventoryItemRow[] | null>(null);
  const [partTypes, setPartTypes] = useState<SetupRecord[]>([]);
  const [locations, setLocations] = useState<SetupRecord[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setItems(await listInventoryItems({ search: search.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inventory parts.");
    }
  }

  useEffect(() => {
    const timeout = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    void listSetupResource("part-types", undefined, "true").then(setPartTypes).catch(() => setPartTypes([]));
    void listSetupResource("locations", undefined, "true").then(setLocations).catch(() => setLocations([]));
  }, []);

  function startCreate() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  function startEdit(item: InventoryItemRow) {
    setEditingId(item.id);
    setDraft({
      name: item.name, part_number: item.part_number ?? "", part_type_id: item.part_type_id ?? "", location_id: item.location_id,
      unit_of_measure: item.unit_of_measure, unit_of_measure_custom_label: item.unit_of_measure_custom_label ?? "",
      minimum_quantity: item.minimum_quantity !== null ? String(item.minimum_quantity) : "",
      suggested_reorder_quantity: item.suggested_reorder_quantity !== null ? String(item.suggested_reorder_quantity) : "",
      supplier: item.supplier ?? "", supplier_part_number: item.supplier_part_number ?? "", cost: item.cost !== null ? String(item.cost) : "",
      notes: item.notes ?? ""
    });
    setFormError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!draft.name.trim() || !draft.location_id) {
      setFormError("Name and location are required.");
      return;
    }
    if (draft.unit_of_measure === "custom" && !draft.unit_of_measure_custom_label.trim()) {
      setFormError("A custom unit label is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = toPayload(draft);
      if (editingId === "new") await createInventoryItem(payload);
      else if (editingId) await updateInventoryItem(editingId, payload);
      setEditingId(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save part.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(item: InventoryItemRow) {
    if (togglingId) return;
    setTogglingId(item.id);
    try {
      if (item.is_active) await deactivateInventoryItem(item.id);
      else await activateInventoryItem(item.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status.");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="maintenance-setup-section">
      <div className="maintenance-card-top-row">
        <h4>Inventory Parts</h4>
        {canEdit ? <button type="button" onClick={startCreate}>+ Add</button> : null}
      </div>

      <input type="search" className="maintenance-search-input" placeholder="Search parts" value={search} onChange={(event) => setSearch(event.target.value)} />

      {error ? <p className="form-error">{error}</p> : null}
      {items === null && !error ? <p>Loading…</p> : null}
      {items && items.length === 0 ? <p>No inventory parts yet.</p> : null}

      <div className="maintenance-setup-list">
        {items?.map((item) => (
          <div key={item.id} className={`maintenance-setup-row ${item.is_active ? "" : "maintenance-setup-row-inactive"}`}>
            <div>
              <strong>{item.name}</strong> {!item.is_active ? <span className="maintenance-inactive-badge">Inactive</span> : null}
              <p>{item.part_number ?? "--"} · {item.part_type?.name ?? "--"} · {item.location?.name ?? "--"} · {inventoryUnitLabel(item)}</p>
            </div>
            {canEdit ? (
              <div className="maintenance-button-row">
                <button type="button" className="btn-secondary" onClick={() => startEdit(item)}>Edit</button>
                <button type="button" className="btn-secondary" onClick={() => void toggleActive(item)} disabled={togglingId === item.id}>
                  {item.is_active ? "Deactivate" : "Activate"}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {editingId ? (
        <form className="maintenance-form maintenance-inline-form" onSubmit={(event) => void submit(event)}>
          <label>Name<input type="text" value={draft.name} autoFocus onChange={(event) => setDraft((c) => ({ ...c, name: event.target.value }))} /></label>
          <label>Part number (optional)<input type="text" value={draft.part_number} onChange={(event) => setDraft((c) => ({ ...c, part_number: event.target.value }))} /></label>
          <label>
            Part type (optional)
            <select value={draft.part_type_id} onChange={(event) => setDraft((c) => ({ ...c, part_type_id: event.target.value }))}>
              <option value="">None</option>
              {partTypes.map((pt) => <option key={pt.id} value={pt.id}>{pt.name}</option>)}
            </select>
          </label>
          <label>
            Location
            <select value={draft.location_id} onChange={(event) => setDraft((c) => ({ ...c, location_id: event.target.value }))}>
              <option value="">Select a location</option>
              {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
            </select>
          </label>
          <label>
            Unit of measure
            <select value={draft.unit_of_measure} onChange={(event) => setDraft((c) => ({ ...c, unit_of_measure: event.target.value as UnitOfMeasure }))}>
              {UNITS_OF_MEASURE.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          {draft.unit_of_measure === "custom" ? (
            <label>Custom unit label<input type="text" value={draft.unit_of_measure_custom_label} onChange={(event) => setDraft((c) => ({ ...c, unit_of_measure_custom_label: event.target.value }))} /></label>
          ) : null}
          <label>Reorder level (optional)<input type="number" min="0" step="0.01" value={draft.minimum_quantity} onChange={(event) => setDraft((c) => ({ ...c, minimum_quantity: event.target.value }))} /></label>
          <label>Suggested reorder quantity (optional)<input type="number" min="0" step="0.01" value={draft.suggested_reorder_quantity} onChange={(event) => setDraft((c) => ({ ...c, suggested_reorder_quantity: event.target.value }))} /></label>
          <label>Supplier (optional)<input type="text" value={draft.supplier} onChange={(event) => setDraft((c) => ({ ...c, supplier: event.target.value }))} /></label>
          <label>Supplier part number (optional)<input type="text" value={draft.supplier_part_number} onChange={(event) => setDraft((c) => ({ ...c, supplier_part_number: event.target.value }))} /></label>
          <label>Cost (optional)<input type="number" min="0" step="0.01" value={draft.cost} onChange={(event) => setDraft((c) => ({ ...c, cost: event.target.value }))} /></label>
          <label>Notes (optional)<textarea rows={2} value={draft.notes} onChange={(event) => setDraft((c) => ({ ...c, notes: event.target.value }))} /></label>

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
