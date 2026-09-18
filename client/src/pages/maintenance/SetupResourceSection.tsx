import { useEffect, useState } from "react";
import { ConfirmSheet } from "./ConfirmSheet";
import {
  createSetupResource, deactivateSetupResource, deleteSetupResource, listSetupResource, reactivateSetupResource, SetupResourceKey,
  updateSetupResource
} from "./api";
import { SetupRecord } from "./types";

type Props = { resource: SetupResourceKey; label: string; canEdit: boolean };

type FormDraft = { name: string; description: string; display_order: string };

const EMPTY_DRAFT: FormDraft = { name: "", description: "", display_order: "0" };

export function SetupResourceSection({ resource, label, canEdit }: Props) {
  const [records, setRecords] = useState<SetupRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SetupRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setRecords(await listSetupResource(resource, search.trim() || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to load ${label.toLowerCase()}.`);
    }
  }

  useEffect(() => {
    const timeout = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function startCreate() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  function startEdit(record: SetupRecord) {
    setEditingId(record.id);
    setDraft({ name: record.name, description: record.description ?? "", display_order: String(record.display_order) });
    setFormError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const name = draft.name.trim();
    if (!name) {
      setFormError("Name is required.");
      return;
    }
    const displayOrder = Number(draft.display_order);
    const payload = { name, description: draft.description.trim() || null, display_order: Number.isFinite(displayOrder) ? displayOrder : 0 };

    setSaving(true);
    setFormError(null);
    try {
      if (editingId === "new") {
        await createSetupResource(resource, payload);
      } else if (editingId) {
        await updateSetupResource(resource, editingId, payload);
      }
      setEditingId(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(record: SetupRecord) {
    if (togglingId) return;
    setTogglingId(record.id);
    try {
      if (record.is_active) await deactivateSetupResource(resource, record.id);
      else await reactivateSetupResource(resource, record.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status.");
    } finally {
      setTogglingId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSetupResource(resource, pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      // The server returns a 409 with a clear explanation when a record is
      // still referenced (e.g. equipment still assigned to this category) —
      // surface it verbatim rather than failing silently.
      setDeleteError(err instanceof Error ? err.message : "Failed to delete.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="maintenance-setup-section">
      <div className="maintenance-card-top-row">
        <h4>{label}</h4>
        {canEdit ? (
          <button type="button" onClick={startCreate}>+ Add</button>
        ) : null}
      </div>

      <input
        type="search"
        className="maintenance-search-input"
        placeholder={`Search ${label.toLowerCase()}`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      {error ? <p className="form-error">{error}</p> : null}
      {records === null && !error ? <p>Loading…</p> : null}
      {records && records.length === 0 ? <p>No {label.toLowerCase()} yet.</p> : null}

      <div className="maintenance-setup-list">
        {records?.map((record) => (
          <div key={record.id} className={`maintenance-setup-row ${record.is_active ? "" : "maintenance-setup-row-inactive"}`}>
            <div>
              <strong>{record.name}</strong>
              {!record.is_active ? <span className="maintenance-inactive-badge">Inactive</span> : null}
              {record.description ? <p>{record.description}</p> : null}
            </div>
            {canEdit ? (
              <div className="maintenance-button-row">
                <button type="button" className="btn-secondary" onClick={() => startEdit(record)}>Edit</button>
                <button type="button" className="btn-secondary" onClick={() => void toggleActive(record)} disabled={togglingId === record.id}>
                  {record.is_active ? "Deactivate" : "Activate"}
                </button>
                <button type="button" className="maintenance-danger-button" onClick={() => { setPendingDelete(record); setDeleteError(null); }}>
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {editingId ? (
        <form className="maintenance-form maintenance-inline-form" onSubmit={(event) => void submit(event)}>
          <label>
            Name
            <input type="text" value={draft.name} autoFocus onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label>
            Description (optional)
            <input type="text" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
          </label>
          <label>
            Display order
            <input type="number" value={draft.display_order} onChange={(event) => setDraft((current) => ({ ...current, display_order: event.target.value }))} />
          </label>
          {formError ? <p className="form-error">{formError}</p> : null}
          <div className="maintenance-button-row">
            <button type="button" className="btn-secondary" onClick={() => setEditingId(null)} disabled={saving}>Cancel</button>
            <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      ) : null}

      {pendingDelete ? (
        <ConfirmSheet
          title={`Delete "${pendingDelete.name}"?`}
          message="This cannot be undone. If it's still in use, the server will block the deletion instead — deactivate it in that case."
          confirmLabel="Delete"
          danger
          busy={deleting}
          error={deleteError}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}
