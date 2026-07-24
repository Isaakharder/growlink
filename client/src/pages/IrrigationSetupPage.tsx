import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";

type IrrigationGroup = {
  id: string;
  type: GroupType;
  name: string;
  status: StatusType;
  created_at: string;
  updated_at: string;
};

type IrrigationFeedValve = {
  id: string;
  name: string;
  group_id: string;
  dripper_count: number;
  status: StatusType;
  created_at: string;
  updated_at: string;
};

type IrrigationDrainBucket = {
  id: string;
  name: string;
  group_id: string;
  dripper_count: number;
  status: StatusType;
  created_at: string;
  updated_at: string;
};

type SetupResponse = {
  groups: IrrigationGroup[];
  feedValves: IrrigationFeedValve[];
  drainBuckets: IrrigationDrainBucket[];
};

type GroupForm = {
  type: GroupType;
  name: string;
  status: StatusType;
};

type LinkedForm = {
  name: string;
  group_id: string;
  dripper_count: string;
  status: StatusType;
};

const SETUP_URL = "/api/irrigation-setup";
const GROUPS_URL = "/api/irrigation-groups";
const FEED_VALVES_URL = "/api/irrigation-feed-valves";
const DRAIN_BUCKETS_URL = "/api/irrigation-drain-buckets";
const TRACK_TYPE_STORAGE_KEY = "irrigation.trackType";

const TYPE_LABELS: Record<GroupType, string> = {
  phase: "Phase",
  zone: "Zone",
  color: "Color"
};

const INITIAL_GROUP_FORM: GroupForm = {
  type: "phase",
  name: "",
  status: "active"
};

const INITIAL_LINKED_FORM: LinkedForm = {
  name: "",
  group_id: "",
  dripper_count: "1",
  status: "active"
};

function titleCaseType(value: GroupType) {
  return TYPE_LABELS[value];
}

export function IrrigationSetupPage() {
  const [groups, setGroups] = useState<IrrigationGroup[]>([]);
  const [feedValves, setFeedValves] = useState<IrrigationFeedValve[]>([]);
  const [drainBuckets, setDrainBuckets] = useState<IrrigationDrainBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [trackType, setTrackType] = useState<GroupType>(() => {
    const saved = localStorage.getItem(TRACK_TYPE_STORAGE_KEY);

    if (saved === "phase" || saved === "zone" || saved === "color") {
      return saved;
    }

    return "color";
  });
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [feedModalOpen, setFeedModalOpen] = useState(false);
  const [drainModalOpen, setDrainModalOpen] = useState(false);

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingFeedValveId, setEditingFeedValveId] = useState<string | null>(null);
  const [editingDrainBucketId, setEditingDrainBucketId] = useState<string | null>(null);

  const [groupForm, setGroupForm] = useState<GroupForm>(INITIAL_GROUP_FORM);
  const [feedForm, setFeedForm] = useState<LinkedForm>(INITIAL_LINKED_FORM);
  const [drainForm, setDrainForm] = useState<LinkedForm>(INITIAL_LINKED_FORM);

  const activeGroups = useMemo(
    () => groups.filter((group) => group.status === "active"),
    [groups]
  );

  const groupsById = useMemo(() => {
    const map = new Map<string, IrrigationGroup>();
    for (const group of groups) {
      map.set(group.id, group);
    }
    return map;
  }, [groups]);

  async function fetchSetup() {
    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch(SETUP_URL);
      if (!response.ok) {
        throw new Error("Failed to fetch irrigation setup");
      }

      const data = (await response.json()) as SetupResponse;
      setGroups(data.groups ?? []);
      setFeedValves(data.feedValves ?? []);
      setDrainBuckets(data.drainBuckets ?? []);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to fetch irrigation setup"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchSetup();
  }, []);

  useEffect(() => {
    localStorage.setItem(TRACK_TYPE_STORAGE_KEY, trackType);
  }, [trackType]);

  function closeGroupModal() {
    setGroupModalOpen(false);
    setEditingGroupId(null);
    setGroupForm({ ...INITIAL_GROUP_FORM, type: trackType });
  }

  function closeFeedModal() {
    setFeedModalOpen(false);
    setEditingFeedValveId(null);
    setFeedForm({
      ...INITIAL_LINKED_FORM,
      group_id: activeGroups[0]?.id ?? ""
    });
  }

  function closeDrainModal() {
    setDrainModalOpen(false);
    setEditingDrainBucketId(null);
    setDrainForm({
      ...INITIAL_LINKED_FORM,
      group_id: activeGroups[0]?.id ?? ""
    });
  }

  function openAddGroupModal() {
    setError(null);
    setEditingGroupId(null);
    setGroupForm({ ...INITIAL_GROUP_FORM, type: trackType });
    setGroupModalOpen(true);
  }

  function openEditGroupModal(group: IrrigationGroup) {
    setError(null);
    setEditingGroupId(group.id);
    setGroupForm({
      type: group.type,
      name: group.name,
      status: group.status
    });
    setGroupModalOpen(true);
  }

  function openAddFeedValveModal() {
    if (activeGroups.length === 0) {
      return;
    }

    setError(null);
    setEditingFeedValveId(null);
    setFeedForm({
      ...INITIAL_LINKED_FORM,
      group_id: activeGroups[0]?.id ?? ""
    });
    setFeedModalOpen(true);
  }

  function openEditFeedValveModal(valve: IrrigationFeedValve) {
    setError(null);
    setEditingFeedValveId(valve.id);
    setFeedForm({
      name: valve.name,
      group_id: valve.group_id,
      dripper_count: String(valve.dripper_count),
      status: valve.status
    });
    setFeedModalOpen(true);
  }

  function openAddDrainBucketModal() {
    if (activeGroups.length === 0) {
      return;
    }

    setError(null);
    setEditingDrainBucketId(null);
    setDrainForm({
      ...INITIAL_LINKED_FORM,
      group_id: activeGroups[0]?.id ?? ""
    });
    setDrainModalOpen(true);
  }

  function openEditDrainBucketModal(bucket: IrrigationDrainBucket) {
    setError(null);
    setEditingDrainBucketId(bucket.id);
    setDrainForm({
      name: bucket.name,
      group_id: bucket.group_id,
      dripper_count: String(bucket.dripper_count),
      status: bucket.status
    });
    setDrainModalOpen(true);
  }

  async function submitGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      type: groupForm.type,
      name: groupForm.name.trim(),
      status: groupForm.status
    };

    if (!payload.name) {
      setError("Group name is required.");
      return;
    }

    setSaving(true);

    try {
      const method = editingGroupId ? "PUT" : "POST";
      const url = editingGroupId ? `${GROUPS_URL}/${editingGroupId}` : GROUPS_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error("Failed to save irrigation group");
      }

      closeGroupModal();
      await fetchSetup();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save irrigation group"
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitFeedValve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      name: feedForm.name.trim(),
      group_id: feedForm.group_id,
      dripper_count: Number(feedForm.dripper_count),
      status: feedForm.status
    };

    if (!payload.name) {
      setError("Valve name is required.");
      return;
    }

    if (!payload.group_id) {
      setError("Linked group is required.");
      return;
    }

    if (!Number.isInteger(payload.dripper_count) || payload.dripper_count < 1) {
      setError("Dripper count must be 1 or greater.");
      return;
    }

    setSaving(true);

    try {
      const method = editingFeedValveId ? "PUT" : "POST";
      const url = editingFeedValveId
        ? `${FEED_VALVES_URL}/${editingFeedValveId}`
        : FEED_VALVES_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error("Failed to save feed valve");
      }

      closeFeedModal();
      await fetchSetup();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Failed to save feed valve"
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitDrainBucket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      name: drainForm.name.trim(),
      group_id: drainForm.group_id,
      dripper_count: Number(drainForm.dripper_count),
      status: drainForm.status
    };

    if (!payload.name) {
      setError("Bucket name is required.");
      return;
    }

    if (!payload.group_id) {
      setError("Linked group is required.");
      return;
    }

    if (!Number.isInteger(payload.dripper_count) || payload.dripper_count < 1) {
      setError("Dripper count must be 1 or greater.");
      return;
    }

    setSaving(true);

    try {
      const method = editingDrainBucketId ? "PUT" : "POST";
      const url = editingDrainBucketId
        ? `${DRAIN_BUCKETS_URL}/${editingDrainBucketId}`
        : DRAIN_BUCKETS_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error("Failed to save drain bucket");
      }

      closeDrainModal();
      await fetchSetup();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save drain bucket"
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem(url: string, label: string) {
    const confirmed = window.confirm(`Delete this ${label}?`);
    if (!confirmed) {
      return;
    }

    setError(null);

    try {
      const response = await apiFetch(url, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Failed to delete ${label}`);
      }

      await fetchSetup();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : `Failed to delete ${label}`
      );
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Irrigation Setup</h1>
        <p>
          Configure how water is tracked and collected (groups, feed valves, and drain buckets).
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading...</p> : null}

      <div className="coming-soon-card">
        <h2>Water Collecting Setup</h2>

        <div className="varieties-toolbar irrigation-toolbar">
          <label className="irrigation-filter-label">
            Track water by
            <select
              value={trackType}
              onChange={(event) => setTrackType(event.target.value as GroupType)}
            >
              <option value="phase">Phase</option>
              <option value="zone">Zone</option>
              <option value="color">Color</option>
            </select>
          </label>

          <button type="button" onClick={openAddGroupModal}>
            + Add {titleCaseType(trackType)}
          </button>
        </div>

        {groups.length === 0 ? <p>No groups added yet.</p> : null}

        {groups.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td>{titleCaseType(group.type)}</td>
                    <td>{group.name}</td>
                    <td>
                      <span
                        className={
                          group.status === "active"
                            ? "status-badge active"
                            : "status-badge inactive"
                        }
                      >
                        {group.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => openEditGroupModal(group)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() =>
                            void deleteItem(`${GROUPS_URL}/${group.id}`, "irrigation group")
                          }
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

      <div className="coming-soon-card">
        <h2>Feed Valves</h2>

        {activeGroups.length === 0 ? (
          <p>Add at least one active group before creating feed valves.</p>
        ) : null}

        <div className="varieties-toolbar">
          <button
            type="button"
            onClick={openAddFeedValveModal}
            disabled={activeGroups.length === 0}
          >
            + Add Feed Valve
          </button>
        </div>

        {feedValves.length === 0 ? <p>No feed valves added yet.</p> : null}

        {feedValves.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Linked group</th>
                  <th>Group type</th>
                  <th>Dripper count</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {feedValves.map((valve) => {
                  const linkedGroup = groupsById.get(valve.group_id);

                  return (
                    <tr key={valve.id}>
                      <td>{valve.name}</td>
                      <td>{linkedGroup?.name ?? "-"}</td>
                      <td>
                        {linkedGroup ? titleCaseType(linkedGroup.type) : "-"}
                      </td>
                      <td>{valve.dripper_count}</td>
                      <td>
                        <span
                          className={
                            valve.status === "active"
                              ? "status-badge active"
                              : "status-badge inactive"
                          }
                        >
                          {valve.status === "active" ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            onClick={() => openEditFeedValveModal(valve)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              void deleteItem(
                                `${FEED_VALVES_URL}/${valve.id}`,
                                "feed valve"
                              )
                            }
                          >
                            Delete
                          </button>
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

      <div className="coming-soon-card">
        <h2>Drain Buckets</h2>

        {activeGroups.length === 0 ? (
          <p>Add at least one active group before creating drain buckets.</p>
        ) : null}

        <div className="varieties-toolbar">
          <button
            type="button"
            onClick={openAddDrainBucketModal}
            disabled={activeGroups.length === 0}
          >
            + Add Drain Bucket
          </button>
        </div>

        {drainBuckets.length === 0 ? <p>No drain buckets added yet.</p> : null}

        {drainBuckets.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Linked group</th>
                  <th>Group type</th>
                  <th>Dripper count</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {drainBuckets.map((bucket) => {
                  const linkedGroup = groupsById.get(bucket.group_id);

                  return (
                    <tr key={bucket.id}>
                      <td>{bucket.name}</td>
                      <td>{linkedGroup?.name ?? "-"}</td>
                      <td>
                        {linkedGroup ? titleCaseType(linkedGroup.type) : "-"}
                      </td>
                      <td>{bucket.dripper_count}</td>
                      <td>
                        <span
                          className={
                            bucket.status === "active"
                              ? "status-badge active"
                              : "status-badge inactive"
                          }
                        >
                          {bucket.status === "active" ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            onClick={() => openEditDrainBucketModal(bucket)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              void deleteItem(
                                `${DRAIN_BUCKETS_URL}/${bucket.id}`,
                                "drain bucket"
                              )
                            }
                          >
                            Delete
                          </button>
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

      {groupModalOpen ? (
        <ModalOverlay onClose={closeGroupModal} contentClassName="variety-modal" titleId="irrigation-group-modal-title">
            <h2 id="irrigation-group-modal-title">{editingGroupId ? "Edit Group" : `Add ${titleCaseType(trackType)}`}</h2>

            <form className="varieties-form" onSubmit={submitGroup}>
              <label>
                Name
                <input
                  type="text"
                  value={groupForm.name}
                  onChange={(event) =>
                    setGroupForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Status
                <select
                  value={groupForm.status}
                  onChange={(event) =>
                    setGroupForm((current) => ({
                      ...current,
                      status: event.target.value as StatusType
                    }))
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
                <button type="button" className="secondary" onClick={closeGroupModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {feedModalOpen ? (
        <ModalOverlay onClose={closeFeedModal} contentClassName="variety-modal" titleId="irrigation-feed-modal-title">
            <h2 id="irrigation-feed-modal-title">{editingFeedValveId ? "Edit Feed Valve" : "Add Feed Valve"}</h2>

            <form className="varieties-form" onSubmit={submitFeedValve}>
              <label>
                Valve name
                <input
                  type="text"
                  value={feedForm.name}
                  onChange={(event) =>
                    setFeedForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Link to group
                <select
                  value={feedForm.group_id}
                  onChange={(event) =>
                    setFeedForm((current) => ({ ...current, group_id: event.target.value }))
                  }
                >
                  {activeGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({titleCaseType(group.type)})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Dripper count
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={feedForm.dripper_count}
                  onChange={(event) =>
                    setFeedForm((current) => ({
                      ...current,
                      dripper_count: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Status
                <select
                  value={feedForm.status}
                  onChange={(event) =>
                    setFeedForm((current) => ({
                      ...current,
                      status: event.target.value as StatusType
                    }))
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
                <button type="button" className="secondary" onClick={closeFeedModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {drainModalOpen ? (
        <ModalOverlay onClose={closeDrainModal} contentClassName="variety-modal" titleId="irrigation-drain-modal-title">
            <h2 id="irrigation-drain-modal-title">{editingDrainBucketId ? "Edit Drain Bucket" : "Add Drain Bucket"}</h2>

            <form className="varieties-form" onSubmit={submitDrainBucket}>
              <label>
                Bucket name
                <input
                  type="text"
                  value={drainForm.name}
                  onChange={(event) =>
                    setDrainForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Link to group
                <select
                  value={drainForm.group_id}
                  onChange={(event) =>
                    setDrainForm((current) => ({ ...current, group_id: event.target.value }))
                  }
                >
                  {activeGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({titleCaseType(group.type)})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Dripper count
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={drainForm.dripper_count}
                  onChange={(event) =>
                    setDrainForm((current) => ({
                      ...current,
                      dripper_count: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Status
                <select
                  value={drainForm.status}
                  onChange={(event) =>
                    setDrainForm((current) => ({
                      ...current,
                      status: event.target.value as StatusType
                    }))
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
                <button type="button" className="secondary" onClick={closeDrainModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
