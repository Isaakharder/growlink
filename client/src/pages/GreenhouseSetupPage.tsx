import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";
type RowPattern = "all" | "odd" | "even";

type GreenhouseGroup = {
  id: string;
  type: GroupType;
  name: string;
  status: StatusType;
  created_at: string;
  updated_at: string;
};

type GreenhouseRowSection = {
  id: string;
  group_id: string;
  start_row: number;
  end_row: number;
  row_pattern: RowPattern;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  created_at: string;
  updated_at: string;
};

type GreenhouseRow = {
  id: string;
  group_id: string;
  section_id: string | null;
  row_number: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  created_at: string;
  updated_at: string;
};

type GreenhouseVarietyAssignment = {
  id: string;
  group_id: string;
  variety_id: string;
  start_row: number;
  end_row: number;
  created_at: string;
  updated_at: string;
};

type Variety = {
  id: string;
  name: string;
  color: string;
  status: "active" | "inactive";
};

type SetupResponse = {
  groups: GreenhouseGroup[];
  rowSections: GreenhouseRowSection[];
  rows: GreenhouseRow[];
  varietyAssignments: GreenhouseVarietyAssignment[];
  varieties: Variety[];
};

type GroupFormState = {
  type: GroupType;
  name: string;
  status: StatusType;
};

type RowSectionFormState = {
  group_id: string;
  start_row: string;
  end_row: string;
  row_pattern: RowPattern;
  slab_count: string;
  plants_per_slab: string;
  stems_per_plant: string;
};

type RowDraft = {
  slab_count: string;
  plants_per_slab: string;
  stems_per_plant: string;
};

type AssignmentFormState = {
  group_id: string;
  variety_id: string;
  start_row: string;
  end_row: string;
};

const SETUP_URL = "/api/greenhouse-setup";
const GROUPS_URL = "/api/greenhouse-groups";
const ROW_SECTIONS_URL = "/api/greenhouse-row-sections";
const ROWS_URL = "/api/greenhouse-rows";
const ASSIGNMENTS_URL = "/api/greenhouse-variety-assignments";

const TYPE_LABELS: Record<GroupType, string> = {
  phase: "Phase",
  zone: "Zone",
  color: "Color"
};

const PATTERN_LABELS: Record<RowPattern, string> = {
  all: "All rows",
  odd: "Odd rows only",
  even: "Even rows only"
};

const INITIAL_GROUP_FORM: GroupFormState = {
  type: "phase",
  name: "",
  status: "active"
};

const INITIAL_SECTION_FORM: RowSectionFormState = {
  group_id: "",
  start_row: "1",
  end_row: "1",
  row_pattern: "all",
  slab_count: "0",
  plants_per_slab: "0",
  stems_per_plant: "1"
};

const INITIAL_ASSIGNMENT_FORM: AssignmentFormState = {
  group_id: "",
  variety_id: "",
  start_row: "1",
  end_row: "1"
};

const ROW_PREVIEW_LIMIT = 2;

function parseNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function countPatternRows(startRow: number, endRow: number, pattern: RowPattern) {
  let total = 0;
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    if (pattern === "odd" && rowNumber % 2 === 0) {
      continue;
    }
    if (pattern === "even" && rowNumber % 2 !== 0) {
      continue;
    }
    total += 1;
  }
  return total;
}

export function GreenhouseSetupPage() {
  const [groups, setGroups] = useState<GreenhouseGroup[]>([]);
  const [rowSections, setRowSections] = useState<GreenhouseRowSection[]>([]);
  const [rows, setRows] = useState<GreenhouseRow[]>([]);
  const [varietyAssignments, setVarietyAssignments] = useState<
    GreenhouseVarietyAssignment[]
  >([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [rowSectionModalOpen, setRowSectionModalOpen] = useState(false);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingRowSectionId, setEditingRowSectionId] = useState<string | null>(null);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);

  const [groupForm, setGroupForm] = useState<GroupFormState>(INITIAL_GROUP_FORM);
  const [rowSectionForm, setRowSectionForm] = useState<RowSectionFormState>(
    INITIAL_SECTION_FORM
  );
  const [assignmentForm, setAssignmentForm] = useState<AssignmentFormState>(
    INITIAL_ASSIGNMENT_FORM
  );

  const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({});
  const [editRowsMode, setEditRowsMode] = useState(false);
  const [savingRows, setSavingRows] = useState(false);
  const [expandedRowsByGroupId, setExpandedRowsByGroupId] = useState<Record<string, boolean>>(
    {}
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId]
  );

  const selectedGroupSections = useMemo(
    () =>
      rowSections
        .filter((section) => section.group_id === selectedGroupId)
        .sort((a, b) => a.start_row - b.start_row),
    [rowSections, selectedGroupId]
  );

  const selectedGroupRows = useMemo(
    () =>
      rows
        .filter((row) => row.group_id === selectedGroupId)
        .sort((a, b) => a.row_number - b.row_number),
    [rows, selectedGroupId]
  );

  const selectedGroupAssignments = useMemo(
    () =>
      varietyAssignments.filter((assignment) => assignment.group_id === selectedGroupId),
    [selectedGroupId, varietyAssignments]
  );

  const selectedGroupRowNumbers = useMemo(
    () => new Set(selectedGroupRows.map((row) => row.row_number)),
    [selectedGroupRows]
  );

  const varietiesById = useMemo(() => {
    return varieties.reduce<Record<string, Variety>>((accumulator, variety) => {
      accumulator[variety.id] = variety;
      return accumulator;
    }, {});
  }, [varieties]);

  const activeVarieties = useMemo(
    () => varieties.filter((variety) => variety.status === "active"),
    [varieties]
  );

  const isRowsExpanded = selectedGroupId
    ? expandedRowsByGroupId[selectedGroupId] === true
    : false;

  const visibleRows = useMemo(() => {
    if (isRowsExpanded) {
      return selectedGroupRows;
    }

    return selectedGroupRows.slice(0, ROW_PREVIEW_LIMIT);
  }, [isRowsExpanded, selectedGroupRows]);

  const changedRows = useMemo(() => {
    return selectedGroupRows.filter((row) => {
      const draft = rowDrafts[row.id];
      if (!draft) {
        return false;
      }

      return (
        Number(draft.slab_count) !== row.slab_count ||
        Number(draft.plants_per_slab) !== row.plants_per_slab ||
        Number(draft.stems_per_plant) !== row.stems_per_plant
      );
    });
  }, [selectedGroupRows, rowDrafts]);

  async function fetchSetup() {
    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch(SETUP_URL);
      if (!response.ok) {
        throw new Error("Failed to fetch greenhouse setup");
      }

      const data = (await response.json()) as SetupResponse;
      setGroups(data.groups ?? []);
      setRowSections(data.rowSections ?? []);
      setRows(data.rows ?? []);
      setVarietyAssignments(data.varietyAssignments ?? []);
      setVarieties(data.varieties ?? []);

      setRowDrafts(() => {
        const draft: Record<string, RowDraft> = {};
        for (const row of data.rows ?? []) {
          draft[row.id] = {
            slab_count: String(row.slab_count),
            plants_per_slab: String(row.plants_per_slab),
            stems_per_plant: String(row.stems_per_plant)
          };
        }
        return draft;
      });

      setSelectedGroupId((current) => {
        if (current && (data.groups ?? []).some((group) => group.id === current)) {
          return current;
        }

        return data.groups?.[0]?.id ?? null;
      });
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to fetch greenhouse setup"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchSetup();
  }, []);

  useEffect(() => {
    if (!groupModalOpen && !rowSectionModalOpen && !assignmentModalOpen) {
      return;
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (groupModalOpen) {
        closeGroupModal();
      }

      if (rowSectionModalOpen) {
        closeRowSectionModal();
      }

      if (assignmentModalOpen) {
        closeAssignmentModal();
      }
    }

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [groupModalOpen, rowSectionModalOpen, assignmentModalOpen]);

  function closeGroupModal() {
    setGroupModalOpen(false);
    setEditingGroupId(null);
    setGroupForm(INITIAL_GROUP_FORM);
  }

  function closeRowSectionModal() {
    setRowSectionModalOpen(false);
    setEditingRowSectionId(null);
    setRowSectionForm({
      ...INITIAL_SECTION_FORM,
      group_id: selectedGroupId ?? ""
    });
  }

  function closeAssignmentModal() {
    setAssignmentModalOpen(false);
    setEditingAssignmentId(null);
    setAssignmentForm({
      ...INITIAL_ASSIGNMENT_FORM,
      group_id: selectedGroupId ?? ""
    });
  }

  function openAddGroupModal() {
    setError(null);
    setEditingGroupId(null);
    setGroupForm(INITIAL_GROUP_FORM);
    setGroupModalOpen(true);
  }

  function openEditGroupModal(group: GreenhouseGroup) {
    setError(null);
    setEditingGroupId(group.id);
    setGroupForm({
      type: group.type,
      name: group.name,
      status: group.status
    });
    setGroupModalOpen(true);
  }

  function openAddRowSectionModal() {
    if (!selectedGroup) {
      return;
    }

    setError(null);
    setEditingRowSectionId(null);
    setRowSectionForm({
      ...INITIAL_SECTION_FORM,
      group_id: selectedGroup.id
    });
    setRowSectionModalOpen(true);
  }

  function openEditRowSectionModal(section: GreenhouseRowSection) {
    setError(null);
    setEditingRowSectionId(section.id);
    setRowSectionForm({
      group_id: section.group_id,
      start_row: String(section.start_row),
      end_row: String(section.end_row),
      row_pattern: section.row_pattern,
      slab_count: String(section.slab_count),
      plants_per_slab: String(section.plants_per_slab),
      stems_per_plant: String(section.stems_per_plant)
    });
    setRowSectionModalOpen(true);
  }

  function openAddAssignmentModal() {
    if (!selectedGroup) {
      return;
    }

    setError(null);
    setEditingAssignmentId(null);
    setAssignmentForm({
      ...INITIAL_ASSIGNMENT_FORM,
      group_id: selectedGroup.id,
      variety_id: activeVarieties[0]?.id ?? ""
    });
    setAssignmentModalOpen(true);
  }

  function openEditAssignmentModal(assignment: GreenhouseVarietyAssignment) {
    setError(null);
    setEditingAssignmentId(assignment.id);
    setAssignmentForm({
      group_id: assignment.group_id,
      variety_id: assignment.variety_id,
      start_row: String(assignment.start_row),
      end_row: String(assignment.end_row)
    });
    setAssignmentModalOpen(true);
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
        throw new Error("Failed to save greenhouse group");
      }

      const saved = (await response.json()) as GreenhouseGroup;
      closeGroupModal();
      await fetchSetup();

      if (!editingGroupId) {
        setSelectedGroupId(saved.id);
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save greenhouse group"
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitRowSection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      group_id: rowSectionForm.group_id,
      start_row: Number(rowSectionForm.start_row),
      end_row: Number(rowSectionForm.end_row),
      row_pattern: rowSectionForm.row_pattern,
      slab_count: Number(rowSectionForm.slab_count),
      plants_per_slab: Number(rowSectionForm.plants_per_slab),
      stems_per_plant: Number(rowSectionForm.stems_per_plant)
    };

    if (!payload.group_id) {
      setError("Please select a group first.");
      return;
    }

    if (!Number.isInteger(payload.start_row) || payload.start_row < 1) {
      setError("Start row must be 1 or greater.");
      return;
    }

    if (!Number.isInteger(payload.end_row) || payload.end_row < payload.start_row) {
      setError("End row must be greater than or equal to start row.");
      return;
    }

    if (!Number.isInteger(payload.slab_count) || payload.slab_count < 0) {
      setError("Slab count must be 0 or greater.");
      return;
    }

    if (!Number.isInteger(payload.plants_per_slab) || payload.plants_per_slab < 0) {
      setError("Plants per slab must be 0 or greater.");
      return;
    }

    if (!Number.isFinite(payload.stems_per_plant) || payload.stems_per_plant <= 0) {
      setError("Stems per plant must be greater than 0.");
      return;
    }

    setSaving(true);

    try {
      const method = editingRowSectionId ? "PUT" : "POST";
      const url = editingRowSectionId
        ? `${ROW_SECTIONS_URL}/${editingRowSectionId}`
        : ROW_SECTIONS_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error("Failed to save row section");
      }

      closeRowSectionModal();
      await fetchSetup();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save row section"
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      group_id: assignmentForm.group_id,
      variety_id: assignmentForm.variety_id,
      start_row: Number(assignmentForm.start_row),
      end_row: Number(assignmentForm.end_row)
    };

    if (!payload.group_id) {
      setError("Please select a group first.");
      return;
    }

    if (!payload.variety_id) {
      setError("Variety is required.");
      return;
    }

    if (!Number.isInteger(payload.start_row) || payload.start_row < 1) {
      setError("Start row must be 1 or greater.");
      return;
    }

    if (!Number.isInteger(payload.end_row) || payload.end_row < payload.start_row) {
      setError("End row must be greater than or equal to start row.");
      return;
    }

    for (let rowNumber = payload.start_row; rowNumber <= payload.end_row; rowNumber += 1) {
      if (!selectedGroupRowNumbers.has(rowNumber)) {
        setError(
          `Row range must stay inside this group's generated rows. Missing row ${rowNumber}.`
        );
        return;
      }
    }

    setSaving(true);

    try {
      const method = editingAssignmentId ? "PUT" : "POST";
      const url = editingAssignmentId
        ? `${ASSIGNMENTS_URL}/${editingAssignmentId}`
        : ASSIGNMENTS_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const responseBody = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(responseBody?.message ?? "Failed to save variety assignment");
      }

      closeAssignmentModal();
      await fetchSetup();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save variety assignment"
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveOneRow(row: GreenhouseRow) {
    const draft = rowDrafts[row.id];
    if (!draft) {
      return;
    }

    const payload = {
      row_number: row.row_number,
      slab_count: Number(draft.slab_count),
      plants_per_slab: Number(draft.plants_per_slab),
      stems_per_plant: Number(draft.stems_per_plant)
    };

    if (!Number.isInteger(payload.slab_count) || payload.slab_count < 0) {
      setError("Slab count must be 0 or greater.");
      return;
    }

    if (!Number.isInteger(payload.plants_per_slab) || payload.plants_per_slab < 0) {
      setError("Plants per slab must be 0 or greater.");
      return;
    }

    if (!Number.isFinite(payload.stems_per_plant) || payload.stems_per_plant <= 0) {
      setError("Stems per plant must be greater than 0.");
      return;
    }

      const response = await apiFetch(`${ROWS_URL}/${row.id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Failed to save row ${row.row_number}`);
    }
  }

  async function saveAllChangedRows() {
    if (changedRows.length === 0) {
      return;
    }

    setSavingRows(true);
    setError(null);

    try {
      for (const row of changedRows) {
        await saveOneRow(row);
      }
      await fetchSetup();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save rows");
    } finally {
      setSavingRows(false);
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

  function toggleRowsExpanded() {
    if (!selectedGroupId) {
      return;
    }

    setExpandedRowsByGroupId((current) => ({
      ...current,
      [selectedGroupId]: !(current[selectedGroupId] === true)
    }));
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Greenhouse Setup</h1>
        <p>Create groups, add row sections, and maintain generated greenhouse rows.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading...</p> : null}

      <div className="greenhouse-top-grid">
        <div className="coming-soon-card">
          <h2>Groups</h2>

          <div className="varieties-toolbar greenhouse-toolbar">
            <button type="button" onClick={openAddGroupModal}>
              + Add Group
            </button>
          </div>

          {groups.length === 0 ? <p>No greenhouse groups added yet.</p> : null}

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
                    <tr
                      key={group.id}
                      className={selectedGroupId === group.id ? "greenhouse-selected-row" : ""}
                      onClick={() => setSelectedGroupId(group.id)}
                    >
                      <td>{TYPE_LABELS[group.type]}</td>
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
                              void deleteItem(`${GROUPS_URL}/${group.id}`, "greenhouse group")
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

        <div className="coming-soon-card greenhouse-selected-group-card">
          <h2>Selected Group</h2>
          {!selectedGroup ? <p>Select a group from the table to view details.</p> : null}
          {selectedGroup ? (
            <dl className="greenhouse-selected-group-details">
              <div>
                <dt>Name</dt>
                <dd>{selectedGroup.name}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{TYPE_LABELS[selectedGroup.type]}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedGroup.status === "active" ? "Active" : "Inactive"}</dd>
              </div>
              <div>
                <dt>Total generated rows</dt>
                <dd>{selectedGroupRows.length}</dd>
              </div>
              <div>
                <dt>Total row sections</dt>
                <dd>{selectedGroupSections.length}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </div>

      <div className="coming-soon-card">
        <h2>3. Variety Assignments</h2>

        {!selectedGroup ? <p>Select a greenhouse group to manage variety assignments.</p> : null}

        {selectedGroup ? (
          <div className="varieties-toolbar greenhouse-toolbar">
            <button
              type="button"
              onClick={openAddAssignmentModal}
              disabled={activeVarieties.length === 0}
            >
              + Assign Variety
            </button>
          </div>
        ) : null}

        {selectedGroup && activeVarieties.length === 0 ? (
          <p>There are no active varieties available to assign.</p>
        ) : null}

        {selectedGroup && selectedGroupAssignments.length === 0 ? (
          <p>No variety assignments yet for this group.</p>
        ) : null}

        {selectedGroup && selectedGroupAssignments.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Variety</th>
                  <th>Color</th>
                  <th>Row range</th>
                  <th>Total rows</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedGroupAssignments.map((assignment) => {
                  const variety = varietiesById[assignment.variety_id];
                  const totalRows = assignment.end_row - assignment.start_row + 1;

                  return (
                    <tr key={assignment.id}>
                      <td>{variety?.name ?? "Unknown variety"}</td>
                      <td>
                        {variety?.color ? (
                          <span className={`color-badge ${variety.color}`}>
                            {variety.color}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>
                        {assignment.start_row} - {assignment.end_row}
                      </td>
                      <td>{totalRows}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            onClick={() => openEditAssignmentModal(assignment)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              void deleteItem(
                                `${ASSIGNMENTS_URL}/${assignment.id}`,
                                "variety assignment"
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
        <h2>4. Rows</h2>

        {!selectedGroup ? <p>Select a greenhouse group to view rows.</p> : null}

        {selectedGroup ? (
          <div className="varieties-toolbar greenhouse-toolbar">
            <button type="button" onClick={() => setEditRowsMode((value) => !value)}>
              {editRowsMode ? "Disable Edit Rows" : "Edit Rows"}
            </button>
            <button type="button" onClick={openAddRowSectionModal}>
              + Add Row Section
            </button>
            {editRowsMode ? (
              <button
                type="button"
                onClick={() => void saveAllChangedRows()}
                disabled={savingRows || changedRows.length === 0}
              >
                {savingRows
                  ? "Saving..."
                  : `Save All Changed Rows${
                      changedRows.length > 0 ? ` (${changedRows.length})` : ""
                    }`}
              </button>
            ) : null}
          </div>
        ) : null}

        {selectedGroup && selectedGroupRows.length === 0 ? (
          <p>No generated rows for this group yet.</p>
        ) : null}

        {selectedGroup && selectedGroupRows.length > 0 ? (
          <div className="greenhouse-rows-summary">
            {isRowsExpanded
              ? `Showing all ${selectedGroupRows.length} rows`
              : `Showing ${Math.min(ROW_PREVIEW_LIMIT, selectedGroupRows.length)} of ${selectedGroupRows.length} rows`}
          </div>
        ) : null}

        {selectedGroup && selectedGroupRows.length > ROW_PREVIEW_LIMIT ? (
          <button type="button" className="greenhouse-link-button" onClick={toggleRowsExpanded}>
            {isRowsExpanded ? "Collapse rows" : "Show all rows"}
          </button>
        ) : null}

        {selectedGroup && selectedGroupRows.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Row number</th>
                  <th>Slabs per row</th>
                  <th>Plants per slab</th>
                  <th>Stems per plant</th>
                  <th>Total plants</th>
                  <th>Total stems</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const draft = rowDrafts[row.id] ?? {
                    slab_count: String(row.slab_count),
                    plants_per_slab: String(row.plants_per_slab),
                    stems_per_plant: String(row.stems_per_plant)
                  };

                  const slabCount = parseNumber(draft.slab_count);
                  const plantsPerSlab = parseNumber(draft.plants_per_slab);
                  const stemsPerPlant = parseNumber(draft.stems_per_plant);
                  const totalPlants = slabCount * plantsPerSlab;
                  const totalStems = totalPlants * stemsPerPlant;

                  return (
                    <tr key={row.id}>
                      <td>{row.row_number}</td>
                      <td>
                        {editRowsMode ? (
                          <input
                            className="greenhouse-table-input"
                            type="number"
                            min="0"
                            step="1"
                            value={draft.slab_count}
                            onChange={(event) =>
                              setRowDrafts((current) => ({
                                ...current,
                                [row.id]: {
                                  ...draft,
                                  slab_count: event.target.value
                                }
                              }))
                            }
                          />
                        ) : (
                          row.slab_count
                        )}
                      </td>
                      <td>
                        {editRowsMode ? (
                          <input
                            className="greenhouse-table-input"
                            type="number"
                            min="0"
                            step="1"
                            value={draft.plants_per_slab}
                            onChange={(event) =>
                              setRowDrafts((current) => ({
                                ...current,
                                [row.id]: {
                                  ...draft,
                                  plants_per_slab: event.target.value
                                }
                              }))
                            }
                          />
                        ) : (
                          row.plants_per_slab
                        )}
                      </td>
                      <td>
                        {editRowsMode ? (
                          <input
                            className="greenhouse-table-input"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={draft.stems_per_plant}
                            onChange={(event) =>
                              setRowDrafts((current) => ({
                                ...current,
                                [row.id]: {
                                  ...draft,
                                  stems_per_plant: event.target.value
                                }
                              }))
                            }
                          />
                        ) : (
                          row.stems_per_plant
                        )}
                      </td>
                      <td>{roundTo(totalPlants, 2)}</td>
                      <td>{roundTo(totalStems, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {groupModalOpen ? (
        <div className="modal-overlay" onClick={closeGroupModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingGroupId ? "Edit Group" : "Add Group"}</h2>

            <form className="varieties-form" onSubmit={submitGroup}>
              <label>
                Setup type
                <select
                  value={groupForm.type}
                  onChange={(event) =>
                    setGroupForm((current) => ({
                      ...current,
                      type: event.target.value as GroupType
                    }))
                  }
                >
                  <option value="phase">Phase</option>
                  <option value="zone">Zone</option>
                  <option value="color">Color</option>
                </select>
              </label>

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
          </div>
        </div>
      ) : null}

      {rowSectionModalOpen ? (
        <div className="modal-overlay" onClick={closeRowSectionModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingRowSectionId ? "Edit Row Section" : "Add Row Section"}</h2>
            <p>These values apply to each generated row.</p>

            <form className="varieties-form" onSubmit={submitRowSection}>
              <label>
                Start row
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={rowSectionForm.start_row}
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      start_row: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                End row
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={rowSectionForm.end_row}
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      end_row: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Row pattern
                <select
                  value={rowSectionForm.row_pattern}
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      row_pattern: event.target.value as RowPattern
                    }))
                  }
                >
                  <option value="all">All rows</option>
                  <option value="odd">Odd rows only</option>
                  <option value="even">Even rows only</option>
                </select>
              </label>

              <label>
                Slabs per row
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={rowSectionForm.slab_count}
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      slab_count: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Plants per slab
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={rowSectionForm.plants_per_slab}
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      plants_per_slab: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Stems per plant
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={rowSectionForm.stems_per_plant}
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      stems_per_plant: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <div className="form-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeRowSectionModal}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {assignmentModalOpen ? (
        <div className="modal-overlay" onClick={closeAssignmentModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingAssignmentId ? "Edit Variety Assignment" : "Assign Variety"}</h2>

            <form className="varieties-form" onSubmit={submitAssignment}>
              <label>
                Variety
                <select
                  value={assignmentForm.variety_id}
                  onChange={(event) =>
                    setAssignmentForm((current) => ({
                      ...current,
                      variety_id: event.target.value
                    }))
                  }
                  required
                >
                  <option value="" disabled>
                    Select a variety
                  </option>
                  {activeVarieties.map((variety) => (
                    <option key={variety.id} value={variety.id}>
                      {variety.name} ({variety.color})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Start row
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={assignmentForm.start_row}
                  onChange={(event) =>
                    setAssignmentForm((current) => ({
                      ...current,
                      start_row: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                End row
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={assignmentForm.end_row}
                  onChange={(event) =>
                    setAssignmentForm((current) => ({
                      ...current,
                      end_row: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <div className="form-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeAssignmentModal}>
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
