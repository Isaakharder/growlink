import { useEffect, useState } from "react";
import { createEquipment, listEquipment, listSetupResource, setEquipmentStatus, updateEquipment } from "./api";
import { equipmentStatusLabel } from "./formatters";
import { EquipmentPayload, EquipmentRow, EquipmentStatus, EQUIPMENT_STATUSES, MeterUnit, METER_UNITS, SetupRecord } from "./types";

type Draft = {
  name: string; asset_code: string; category_id: string; location_id: string; make: string; model: string;
  serial_number: string; description: string; meter_unit: MeterUnit; meter_unit_custom_label: string;
};

const EMPTY_DRAFT: Draft = {
  name: "", asset_code: "", category_id: "", location_id: "", make: "", model: "", serial_number: "", description: "",
  meter_unit: "hours", meter_unit_custom_label: ""
};

function toPayload(draft: Draft): EquipmentPayload {
  return {
    name: draft.name.trim(),
    asset_code: draft.asset_code.trim(),
    category_id: draft.category_id,
    location_id: draft.location_id,
    make: draft.make.trim() || null,
    model: draft.model.trim() || null,
    serial_number: draft.serial_number.trim() || null,
    description: draft.description.trim() || null,
    meter_unit: draft.meter_unit,
    meter_unit_custom_label: draft.meter_unit === "custom" ? draft.meter_unit_custom_label.trim() || null : null
  };
}

export function EquipmentSetupSection({ canEdit }: { canEdit: boolean }) {
  const [equipment, setEquipment] = useState<EquipmentRow[] | null>(null);
  const [categories, setCategories] = useState<SetupRecord[]>([]);
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
      setEquipment(await listEquipment({ search: search.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load equipment.");
    }
  }

  useEffect(() => {
    const timeout = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    void listSetupResource("categories", undefined, "true").then(setCategories).catch(() => setCategories([]));
    void listSetupResource("locations", undefined, "true").then(setLocations).catch(() => setLocations([]));
  }, []);

  function startCreate() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  function startEdit(item: EquipmentRow) {
    setEditingId(item.id);
    setDraft({
      name: item.name, asset_code: item.asset_code, category_id: item.category_id, location_id: item.location_id,
      make: item.make ?? "", model: item.model ?? "", serial_number: item.serial_number ?? "", description: item.description ?? "",
      meter_unit: item.meter_unit, meter_unit_custom_label: item.meter_unit_custom_label ?? ""
    });
    setFormError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!draft.name.trim() || !draft.asset_code.trim() || !draft.category_id || !draft.location_id) {
      setFormError("Name, asset code, category, and location are required.");
      return;
    }
    if (draft.meter_unit === "custom" && !draft.meter_unit_custom_label.trim()) {
      setFormError("A custom meter unit label is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = toPayload(draft);
      if (editingId === "new") await createEquipment(payload);
      else if (editingId) await updateEquipment(editingId, payload);
      setEditingId(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save equipment.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(item: EquipmentRow, status: EquipmentStatus) {
    if (togglingId) return;
    setTogglingId(item.id);
    try {
      await setEquipmentStatus(item.id, status);
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
        <h4>Equipment</h4>
        {canEdit ? <button type="button" onClick={startCreate}>+ Add</button> : null}
      </div>

      <input type="search" className="maintenance-search-input" placeholder="Search equipment" value={search} onChange={(event) => setSearch(event.target.value)} />

      {error ? <p className="form-error">{error}</p> : null}
      {equipment === null && !error ? <p>Loading…</p> : null}
      {equipment && equipment.length === 0 ? <p>No equipment yet.</p> : null}

      <div className="maintenance-setup-list">
        {equipment?.map((item) => (
          <div key={item.id} className="maintenance-setup-row">
            <div>
              <strong>{item.name}</strong> <span>{item.asset_code}</span>
              <p>{item.category?.name ?? "--"} · {item.location?.name ?? "--"} · {equipmentStatusLabel(item.status)}</p>
            </div>
            {canEdit ? (
              <div className="maintenance-button-row">
                <button type="button" className="btn-secondary" onClick={() => startEdit(item)}>Edit</button>
                <select
                  value={item.status}
                  disabled={togglingId === item.id}
                  onChange={(event) => void changeStatus(item, event.target.value as EquipmentStatus)}
                >
                  {EQUIPMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>{equipmentStatusLabel(status)}</option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {editingId ? (
        <form className="maintenance-form maintenance-inline-form" onSubmit={(event) => void submit(event)}>
          <label>Name<input type="text" value={draft.name} autoFocus onChange={(event) => setDraft((c) => ({ ...c, name: event.target.value }))} /></label>
          <label>Asset code<input type="text" value={draft.asset_code} onChange={(event) => setDraft((c) => ({ ...c, asset_code: event.target.value }))} /></label>
          <label>
            Category
            <select value={draft.category_id} onChange={(event) => setDraft((c) => ({ ...c, category_id: event.target.value }))}>
              <option value="">Select a category</option>
              {categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
            </select>
          </label>
          <label>
            Location
            <select value={draft.location_id} onChange={(event) => setDraft((c) => ({ ...c, location_id: event.target.value }))}>
              <option value="">Select a location</option>
              {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
            </select>
          </label>
          <label>Make<input type="text" value={draft.make} onChange={(event) => setDraft((c) => ({ ...c, make: event.target.value }))} /></label>
          <label>Model<input type="text" value={draft.model} onChange={(event) => setDraft((c) => ({ ...c, model: event.target.value }))} /></label>
          <label>Serial number<input type="text" value={draft.serial_number} onChange={(event) => setDraft((c) => ({ ...c, serial_number: event.target.value }))} /></label>
          <label>
            Meter unit
            <select value={draft.meter_unit} onChange={(event) => setDraft((c) => ({ ...c, meter_unit: event.target.value as MeterUnit }))}>
              {METER_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          {draft.meter_unit === "custom" ? (
            <label>Custom unit label<input type="text" value={draft.meter_unit_custom_label} onChange={(event) => setDraft((c) => ({ ...c, meter_unit_custom_label: event.target.value }))} /></label>
          ) : null}
          <label>Description (optional)<textarea rows={2} value={draft.description} onChange={(event) => setDraft((c) => ({ ...c, description: event.target.value }))} /></label>

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
