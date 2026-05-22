import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type GroupType = "phase" | "zone" | "color";
type StatusType = "active" | "inactive";
type RowPattern = "all" | "every_other";
type LegacyRowPattern = RowPattern | "odd" | "even";
type AssignmentPattern = "all" | "every_other";

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
  row_pattern: LegacyRowPattern;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  width_meters: number | null;
  length_meters: number | null;
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
  width_meters: number | null;
  length_meters: number | null;
  created_at: string;
  updated_at: string;
};

type GreenhouseVarietyAssignment = {
  id: string;
  group_id: string;
  variety_id: string;
  start_row: number;
  end_row: number;
  assignment_pattern: AssignmentPattern | null;
  created_at: string;
  updated_at: string;
};

type Variety = {
  id: string;
  name: string;
  color: string;
  status: "active" | "inactive";
};

type IrrigationFeedValve = {
  id: string;
  name: string;
  group_id: string;
  organization_id: string;
  status: string;
};


type RowValve = {
  id: string;
  valve_id: string;
  row_id: string;
};

type ValveAssignForm = {
  valve_id: string;
  row_pattern: "all" | "every_other";
  start_row: string;
  end_row: string;
};

type SetupResponse = {
  groups: GreenhouseGroup[];
  rowSections: GreenhouseRowSection[];
  rows: GreenhouseRow[];
  varietyAssignments: GreenhouseVarietyAssignment[];
  varieties: Variety[];
  rowValves?: RowValve[];
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
  width_meters: string;
  length_meters: string;
};

type RowDraft = {
  slab_count: string;
  plants_per_slab: string;
  stems_per_plant: string;
  width_meters: string;
  length_meters: string;
};

type VarietyAreaSummary = {
  assignmentId: string;
  varietyId: string;
  varietyName: string;
  varietyColor: string;
  rowRange: string;
  rowCount: number;
  m2: number;
  ft2: number;
  plants: number;
  slabs: number;
};

type GroupedVarietySummary = {
  varietyId: string;
  varietyName: string;
  varietyColor: string;
  rowDisplay: string;
  totalRowCount: number;
  totalM2: number;
  totalFt2: number;
  totalPlants: number;
  totalSlabs: number;
  assignments: VarietyAreaSummary[];
};

type GroupedValveLink = {
  valveId: string;
  valveName: string;
  rowNumbers: number[];
  rvIds: string[];
  minRow: number | null;
  maxRow: number | null;
  patternLabel: string;
  totalM2: number;
};

type AssignmentFormState = {
  group_id: string;
  variety_id: string;
  start_row: string;
  end_row: string;
  assignment_pattern: AssignmentPattern;
};

const SETUP_URL = "/api/greenhouse-setup";
const GROUPS_URL = "/api/greenhouse-groups";
const ROW_SECTIONS_URL = "/api/greenhouse-row-sections";
const ROWS_URL = "/api/greenhouse-rows";
const ASSIGNMENTS_URL = "/api/greenhouse-variety-assignments";
const BIN_SETTINGS_URL = "/api/greenhouse-setup/bin-settings";

const TYPE_LABELS: Record<GroupType, string> = {
  phase: "Phase",
  zone: "Zone",
  color: "Color"
};

const PATTERN_LABELS: Record<RowPattern, string> = {
  all: "All rows",
  every_other: "Every other row"
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
  stems_per_plant: "1",
  width_meters: "",
  length_meters: ""
};

const INITIAL_ASSIGNMENT_FORM: AssignmentFormState = {
  group_id: "",
  variety_id: "",
  start_row: "1",
  end_row: "1",
  assignment_pattern: "all"
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

const SQ_FT_PER_M2 = 10.7639;

function parseNullableNumber(value: string): number | null {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rowAreaM2(row: { width_meters: number | null; length_meters: number | null }): number {
  return (row.width_meters ?? 0) * (row.length_meters ?? 0);
}

function m2ToFt2(m2: number): number {
  return m2 * SQ_FT_PER_M2;
}

function countPatternRows(startRow: number, endRow: number, pattern: RowPattern) {
  const rowStep = pattern === "every_other" ? 2 : 1;
  let total = 0;
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += rowStep) {
    total += 1;
  }
  return total;
}

function normalizeRowPattern(pattern: LegacyRowPattern | null | undefined): RowPattern {
  return pattern === "all" ? "all" : "every_other";
}

function getAssignmentPattern(
  assignment: Pick<GreenhouseVarietyAssignment, "assignment_pattern">
): AssignmentPattern {
  return assignment.assignment_pattern === "every_other" ? "every_other" : "all";
}

function formatAssignmentRange(assignment: GreenhouseVarietyAssignment) {
  const rangeLabel = `${assignment.start_row} - ${assignment.end_row}`;
  return getAssignmentPattern(assignment) === "every_other"
    ? `${rangeLabel} every other`
    : rangeLabel;
}

function compressRowNumbers(rowNumbers: number[]): string {
  if (rowNumbers.length === 0) return "";
  const sorted = [...new Set(rowNumbers)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      ranges.push(rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}–${rangeEnd}`);
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }
  ranges.push(rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}–${rangeEnd}`);
  return ranges.join(", ");
}

function getAssignmentTotalRows(assignment: GreenhouseVarietyAssignment) {
  const pattern = getAssignmentPattern(assignment);
  if (pattern === "all") {
    return assignment.end_row - assignment.start_row + 1;
  }

  return Math.floor((assignment.end_row - assignment.start_row) / 2) + 1;
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
  const [activeTab, setActiveTab] = useState<"rows" | "varieties" | "valves">("rows");

  const [valves, setValves] = useState<IrrigationFeedValve[]>([]);
  const [rowValves, setRowValves] = useState<RowValve[]>([]);
  const [valveAssignForm, setValveAssignForm] = useState<ValveAssignForm>({
    valve_id: "",
    row_pattern: "all",
    start_row: "",
    end_row: ""
  });
  const [valveAssigning, setValveAssigning] = useState(false);
  const [valveAssignError, setValveAssignError] = useState<string | null>(null);
  const [editingValveId, setEditingValveId] = useState<string | null>(null);
  const [valveModalOpen, setValveModalOpen] = useState(false);

  const [pickingBinKgDraft, setPickingBinKgDraft] = useState("");
  const [caseKgDraft, setCaseKgDraft] = useState("");
  const [binSettingsSaving, setBinSettingsSaving] = useState(false);
  const [binSettingsSaved, setBinSettingsSaved] = useState(false);
  const [binSettingsError, setBinSettingsError] = useState<string | null>(null);

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

  const selectedGroupRowNumbersSorted = useMemo(
    () => selectedGroupRows.map((row) => row.row_number),
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

  const groupsById = useMemo(() => {
    return groups.reduce<Record<string, GreenhouseGroup>>((acc, group) => {
      acc[group.id] = group;
      return acc;
    }, {});
  }, [groups]);

  const rowsByGroupAndNumber = useMemo(() => {
    const map: Record<string, Record<number, GreenhouseRow>> = {};
    for (const row of rows) {
      if (!map[row.group_id]) {
        map[row.group_id] = {};
      }
      map[row.group_id][row.row_number] = row;
    }
    return map;
  }, [rows]);

  const selectedGroupTotals = useMemo(() => {
    let totalM2 = 0;
    let totalPlants = 0;
    let totalSlabs = 0;
    for (const row of selectedGroupRows) {
      totalM2 += rowAreaM2(row);
      totalSlabs += row.slab_count;
      totalPlants += row.slab_count * row.plants_per_slab;
    }
    return {
      m2: roundTo(totalM2, 2),
      ft2: roundTo(m2ToFt2(totalM2), 1),
      plants: totalPlants,
      slabs: totalSlabs,
      plantsPerM2: totalM2 > 0 ? roundTo(totalPlants / totalM2, 2) : null
    };
  }, [selectedGroupRows]);

  const greenhouseTotals = useMemo(() => {
    let totalM2 = 0;
    let totalPlants = 0;
    let totalSlabs = 0;
    for (const row of rows) {
      totalM2 += rowAreaM2(row);
      totalSlabs += row.slab_count;
      totalPlants += row.slab_count * row.plants_per_slab;
    }
    return {
      rows: rows.length,
      sections: rowSections.length,
      m2: roundTo(totalM2, 2),
      ft2: roundTo(m2ToFt2(totalM2), 1),
      plants: totalPlants,
      slabs: totalSlabs,
      plantsPerM2: totalM2 > 0 ? roundTo(totalPlants / totalM2, 2) : null
    };
  }, [rows, rowSections]);

  const varietyAreaSummaries = useMemo((): VarietyAreaSummary[] => {
    return varietyAssignments
      .filter((assignment) => assignment.group_id === selectedGroupId)
      .map((assignment): VarietyAreaSummary => {
        const variety = varietiesById[assignment.variety_id];
        const pattern = getAssignmentPattern(assignment);
        const step = pattern === "every_other" ? 2 : 1;
        const groupRows = rowsByGroupAndNumber[assignment.group_id] ?? {};
        let totalM2 = 0;
        let totalPlants = 0;
        let totalSlabs = 0;
        let rowCount = 0;
        for (let r = assignment.start_row; r <= assignment.end_row; r += step) {
          const row = groupRows[r];
          if (row) {
            totalM2 += rowAreaM2(row);
            totalSlabs += row.slab_count;
            totalPlants += row.slab_count * row.plants_per_slab;
            rowCount++;
          }
        }
        return {
          assignmentId: assignment.id,
          varietyId: assignment.variety_id,
          varietyName: variety?.name ?? "Unknown variety",
          varietyColor: variety?.color ?? "",
          rowRange: formatAssignmentRange(assignment),
          rowCount,
          m2: roundTo(totalM2, 2),
          ft2: roundTo(m2ToFt2(totalM2), 1),
          plants: totalPlants,
          slabs: totalSlabs
        };
      });
  }, [varietyAssignments, selectedGroupId, rowsByGroupAndNumber, varietiesById]);

  const groupedVarietyAreaSummaries = useMemo((): GroupedVarietySummary[] => {
    const orderMap = new Map<string, number>();
    const groupMap = new Map<string, GroupedVarietySummary>();

    for (const summary of varietyAreaSummaries) {
      if (!groupMap.has(summary.varietyId)) {
        orderMap.set(summary.varietyId, orderMap.size);
        groupMap.set(summary.varietyId, {
          varietyId: summary.varietyId,
          varietyName: summary.varietyName,
          varietyColor: summary.varietyColor,
          rowDisplay: "",
          totalRowCount: 0,
          totalM2: 0,
          totalFt2: 0,
          totalPlants: 0,
          totalSlabs: 0,
          assignments: []
        });
      }
      const grp = groupMap.get(summary.varietyId)!;
      grp.totalM2 = roundTo(grp.totalM2 + summary.m2, 2);
      grp.totalFt2 = roundTo(grp.totalFt2 + summary.ft2, 1);
      grp.totalPlants += summary.plants;
      grp.totalSlabs += summary.slabs;
      grp.assignments.push(summary);
    }

    // Collect actual row numbers per variety and compress into display string.
    const groupRows = rowsByGroupAndNumber[selectedGroupId ?? ""] ?? {};
    for (const grp of groupMap.values()) {
      const allRowNumbers: number[] = [];
      for (const summary of grp.assignments) {
        const assignment = selectedGroupAssignments.find((a) => a.id === summary.assignmentId);
        if (!assignment) continue;
        const step = getAssignmentPattern(assignment) === "every_other" ? 2 : 1;
        for (let r = assignment.start_row; r <= assignment.end_row; r += step) {
          if (groupRows[r]) allRowNumbers.push(r);
        }
      }
      grp.rowDisplay = compressRowNumbers(allRowNumbers);
      grp.totalRowCount = new Set(allRowNumbers).size;
    }

    return [...groupMap.values()].sort(
      (a, b) => (orderMap.get(a.varietyId) ?? 0) - (orderMap.get(b.varietyId) ?? 0)
    );
  }, [varietyAreaSummaries, selectedGroupAssignments, rowsByGroupAndNumber, selectedGroupId]);

  const groupedValveLinks = useMemo((): GroupedValveLink[] => {
    const orderMap = new Map<string, number>();
    const groupMap = new Map<string, GroupedValveLink>();
    const rowObjectsMap = new Map<string, GreenhouseRow[]>();

    for (const rv of rowValves) {
      if (!groupMap.has(rv.valve_id)) {
        orderMap.set(rv.valve_id, orderMap.size);
        const valve = valves.find((v) => v.id === rv.valve_id);
        groupMap.set(rv.valve_id, {
          valveId: rv.valve_id,
          valveName: valve?.name ?? rv.valve_id,
          rowNumbers: [],
          rvIds: [],
          minRow: null,
          maxRow: null,
          patternLabel: "All rows",
          totalM2: 0
        });
        rowObjectsMap.set(rv.valve_id, []);
      }
      const grp = groupMap.get(rv.valve_id)!;
      const row = rows.find((r) => r.id === rv.row_id);
      if (row) {
        grp.rowNumbers.push(row.row_number);
        rowObjectsMap.get(rv.valve_id)!.push(row);
      }
      grp.rvIds.push(rv.id);
    }

    for (const grp of groupMap.values()) {
      if (grp.rowNumbers.length === 0) continue;
      const sorted = grp.rowNumbers.slice().sort((a, b) => a - b);
      grp.minRow = sorted[0];
      grp.maxRow = sorted[sorted.length - 1];
      if (sorted.length === 1) {
        grp.patternLabel = "All rows";
      } else {
        const gaps = sorted.slice(1).map((n, i) => n - sorted[i]);
        const allGap1 = gaps.every((g) => g === 1);
        const allGap2 = gaps.every((g) => g === 2);
        const sameParity = sorted.every((n) => n % 2 === sorted[0] % 2);
        if (allGap1) {
          grp.patternLabel = "All rows";
        } else if (allGap2 && sameParity) {
          grp.patternLabel = "Every other row";
        } else {
          grp.patternLabel = "Custom pattern";
        }
      }
      const linkedRows = rowObjectsMap.get(grp.valveId) ?? [];
      grp.totalM2 = linkedRows.reduce((sum, r) => sum + rowAreaM2(r), 0);
    }

    return [...groupMap.values()].sort(
      (a, b) => (orderMap.get(a.valveId) ?? 0) - (orderMap.get(b.valveId) ?? 0)
    );
  }, [rowValves, valves, rows]);

  const sortedRowNumbers = useMemo(() => {
    const nums = Array.from(new Set(rows.map((r) => r.row_number)));
    return nums.sort((a, b) => a - b);
  }, [rows]);

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
        Number(draft.stems_per_plant) !== row.stems_per_plant ||
        parseNullableNumber(draft.width_meters) !== row.width_meters ||
        parseNullableNumber(draft.length_meters) !== row.length_meters
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
      setRowSections(
        (data.rowSections ?? []).map((section) => ({
          ...section,
          row_pattern: normalizeRowPattern(section.row_pattern)
        }))
      );
      setRows(data.rows ?? []);
      setVarietyAssignments(data.varietyAssignments ?? []);
      setVarieties(data.varieties ?? []);
      setRowValves(data.rowValves ?? []);

      setRowDrafts(() => {
        const draft: Record<string, RowDraft> = {};
        for (const row of data.rows ?? []) {
          draft[row.id] = {
            slab_count: String(row.slab_count),
            plants_per_slab: String(row.plants_per_slab),
            stems_per_plant: String(row.stems_per_plant),
            width_meters: row.width_meters !== null ? String(row.width_meters) : "",
            length_meters: row.length_meters !== null ? String(row.length_meters) : ""
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
    async function loadBinSettings() {
      try {
        const res = await apiFetch(BIN_SETTINGS_URL);
        if (!res.ok) return;
        const data = (await res.json()) as { picking_bin_kg: number | null; case_kg: number | null };
        setPickingBinKgDraft(data.picking_bin_kg !== null && data.picking_bin_kg !== undefined ? String(data.picking_bin_kg) : "");
        setCaseKgDraft(data.case_kg !== null && data.case_kg !== undefined ? String(data.case_kg) : "");
      } catch {
        // silently ignore — bin settings are supplemental
      }
    }
    void loadBinSettings();
  }, []);

  async function saveBinSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBinSettingsError(null);
    setBinSettingsSaved(false);
    setBinSettingsSaving(true);

    const rawPickingBinKg = pickingBinKgDraft.trim();
    const rawCaseKg = caseKgDraft.trim();

    const pickingBinKg = rawPickingBinKg !== "" ? Number(rawPickingBinKg) : null;
    const caseKg = rawCaseKg !== "" ? Number(rawCaseKg) : null;

    if (pickingBinKg !== null && (!Number.isFinite(pickingBinKg) || pickingBinKg <= 0)) {
      setBinSettingsError("Kg per full bin must be greater than 0.");
      setBinSettingsSaving(false);
      return;
    }

    if (caseKg !== null && (!Number.isFinite(caseKg) || caseKg <= 0)) {
      setBinSettingsError("Kg per case must be greater than 0.");
      setBinSettingsSaving(false);
      return;
    }

    try {
      const res = await apiFetch(BIN_SETTINGS_URL, {
        method: "PUT",
        body: JSON.stringify({
          picking_bin_kg: pickingBinKg,
          case_kg: caseKg
        })
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save bin settings");
      }

      setBinSettingsSaved(true);
      setTimeout(() => setBinSettingsSaved(false), 3000);
    } catch (err) {
      setBinSettingsError(err instanceof Error ? err.message : "Failed to save bin settings");
    } finally {
      setBinSettingsSaving(false);
    }
  }

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
      row_pattern: normalizeRowPattern(section.row_pattern),
      slab_count: String(section.slab_count),
      plants_per_slab: String(section.plants_per_slab),
      stems_per_plant: String(section.stems_per_plant),
      width_meters: section.width_meters !== null ? String(section.width_meters) : "",
      length_meters: section.length_meters !== null ? String(section.length_meters) : ""
    });
    setRowSectionModalOpen(true);
  }

  function openAddAssignmentModal() {
    if (!selectedGroup) {
      return;
    }

    const firstRow = selectedGroupRowNumbersSorted[0];
    const defaultRow = firstRow !== undefined ? String(firstRow) : "1";
    setError(null);
    setEditingAssignmentId(null);
    setAssignmentForm({
      ...INITIAL_ASSIGNMENT_FORM,
      group_id: selectedGroup.id,
      variety_id: activeVarieties[0]?.id ?? "",
      start_row: defaultRow,
      end_row: defaultRow
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
      end_row: String(assignment.end_row),
      assignment_pattern: getAssignmentPattern(assignment)
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
      stems_per_plant: Number(rowSectionForm.stems_per_plant),
      width_meters: parseNullableNumber(rowSectionForm.width_meters),
      length_meters: parseNullableNumber(rowSectionForm.length_meters)
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
      end_row: Number(assignmentForm.end_row),
      assignment_pattern: assignmentForm.assignment_pattern
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

    const rowStep = payload.assignment_pattern === "every_other" ? 2 : 1;
    for (let rowNumber = payload.start_row; rowNumber <= payload.end_row; rowNumber += rowStep) {
      if (!selectedGroupRowNumbers.has(rowNumber)) {
        setError(
          `Selected rows must stay inside this group's generated rows. Missing row ${rowNumber}.`
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
      stems_per_plant: Number(draft.stems_per_plant),
      width_meters: parseNullableNumber(draft.width_meters),
      length_meters: parseNullableNumber(draft.length_meters)
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

  useEffect(() => {
    async function loadValves() {
      try {
        const res = await apiFetch("/api/irrigation-setup");
        if (!res.ok) return;
        const data = (await res.json()) as { feedValves: IrrigationFeedValve[] };
        setValves(data.feedValves ?? []);
      } catch {
        // silently ignore — valves are supplemental to the main setup
      }
    }
    void loadValves();
  }, []);

  async function assignValveRows(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValveAssignError(null);

    const startRow = parseInt(valveAssignForm.start_row, 10);
    const endRow = parseInt(valveAssignForm.end_row, 10);

    if (!valveAssignForm.valve_id) {
      setValveAssignError("Select a valve.");
      return;
    }
    if (!valveAssignForm.start_row) {
      setValveAssignError("Select a start row.");
      return;
    }
    if (!valveAssignForm.end_row || endRow < startRow) {
      setValveAssignError("End row must be >= start row.");
      return;
    }

    setValveAssigning(true);
    try {
      if (editingValveId) {
        const grp = groupedValveLinks.find((g) => g.valveId === editingValveId);
        if (grp) {
          for (const id of grp.rvIds) {
            await apiFetch(`/api/greenhouse/row-valves/${id}`, { method: "DELETE" });
          }
        }
      }

      const res = await apiFetch("/api/greenhouse/row-valves", {
        method: "POST",
        body: JSON.stringify({
          valve_id: valveAssignForm.valve_id,
          row_pattern: valveAssignForm.row_pattern,
          start_row: startRow,
          end_row: endRow
        })
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to assign rows");
      }

      closeValveModal();
      await fetchSetup();
    } catch (err) {
      setValveAssignError(err instanceof Error ? err.message : "Failed to assign rows");
    } finally {
      setValveAssigning(false);
    }
  }

  async function removeRowValve(id: string) {
    setError(null);
    const { error: delError } = await (async () => {
      try {
        const res = await apiFetch(`/api/greenhouse/row-valves/${id}`, { method: "DELETE" });
        return res.ok ? { error: null } : { error: new Error("Failed to remove link") };
      } catch (e) {
        return { error: e instanceof Error ? e : new Error("Failed to remove link") };
      }
    })();

    if (delError) {
      setError(delError.message);
      return;
    }

    await fetchSetup();
  }

  async function removeAllValveLinks(rvIds: string[]) {
    setError(null);
    for (const id of rvIds) {
      const res = await apiFetch(`/api/greenhouse/row-valves/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Failed to remove some links. Refresh to see current state.");
        break;
      }
    }
    await fetchSetup();
  }

  function closeValveModal() {
    setValveModalOpen(false);
    setEditingValveId(null);
    setValveAssignForm({ valve_id: "", row_pattern: "all", start_row: "", end_row: "" });
    setValveAssignError(null);
  }

  function openEditValve(grp: GroupedValveLink) {
    const nums = grp.rowNumbers.slice().sort((a, b) => a - b);
    const startRow = nums[0];
    const endRow = nums[nums.length - 1];
    const rowPattern: "all" | "every_other" =
      grp.patternLabel === "Every other row" ? "every_other" : "all";
    setEditingValveId(grp.valveId);
    setValveAssignForm({
      valve_id: grp.valveId,
      row_pattern: rowPattern,
      start_row: startRow !== undefined ? String(startRow) : "",
      end_row: endRow !== undefined ? String(endRow) : ""
    });
    setValveAssignError(null);
    setValveModalOpen(true);
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

        <div className="greenhouse-right-column">
          <div className="coming-soon-card greenhouse-selected-group-card">
            <h2>Selected Group</h2>
            {!selectedGroup ? <p>Select a group from the table to view details.</p> : null}
            {selectedGroup ? (
              <div className="greenhouse-group-compact">
                <div className="greenhouse-group-identity">
                  <div className="greenhouse-group-name">{selectedGroup.name}</div>
                  <div className="greenhouse-group-meta">
                    <span className="greenhouse-group-type">{TYPE_LABELS[selectedGroup.type]}</span>
                    <span className={`status-badge ${selectedGroup.status}`}>
                      {selectedGroup.status === "active" ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <div className="greenhouse-group-stats">
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Rows</span>
                    <span className="greenhouse-stat-value">{selectedGroupRows.length.toLocaleString()}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Sections</span>
                    <span className="greenhouse-stat-value">{selectedGroupSections.length.toLocaleString()}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Plants</span>
                    <span className="greenhouse-stat-value">{selectedGroupTotals.plants.toLocaleString()}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Slabs</span>
                    <span className="greenhouse-stat-value">{selectedGroupTotals.slabs.toLocaleString()}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">m²</span>
                    <span className="greenhouse-stat-value">{selectedGroupTotals.m2.toLocaleString()}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">ft²</span>
                    <span className="greenhouse-stat-value">{selectedGroupTotals.ft2.toLocaleString()}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Plants / m²</span>
                    <span className="greenhouse-stat-value">
                      {selectedGroupTotals.plantsPerM2 !== null ? selectedGroupTotals.plantsPerM2.toLocaleString() : "—"}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="coming-soon-card">
            <h2>Total Greenhouse</h2>
            <div className="greenhouse-group-stats greenhouse-total-stats">
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">Rows</span>
                <span className="greenhouse-stat-value">{greenhouseTotals.rows.toLocaleString()}</span>
              </div>
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">Sections</span>
                <span className="greenhouse-stat-value">{greenhouseTotals.sections.toLocaleString()}</span>
              </div>
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">Plants</span>
                <span className="greenhouse-stat-value">{greenhouseTotals.plants.toLocaleString()}</span>
              </div>
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">Slabs</span>
                <span className="greenhouse-stat-value">{greenhouseTotals.slabs.toLocaleString()}</span>
              </div>
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">m²</span>
                <span className="greenhouse-stat-value">{greenhouseTotals.m2.toLocaleString()}</span>
              </div>
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">ft²</span>
                <span className="greenhouse-stat-value">{greenhouseTotals.ft2.toLocaleString()}</span>
              </div>
              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">Plants / m²</span>
                <span className="greenhouse-stat-value">
                  {greenhouseTotals.plantsPerM2 !== null ? greenhouseTotals.plantsPerM2.toLocaleString() : "—"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="coming-soon-card" style={{ marginBottom: "1.5rem" }}>
        <h2>Picking Bins</h2>
        <p style={{ fontSize: "0.88rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
          Used by Mobile Daily Yield to project bins and cases from sampled stems.
        </p>
        {binSettingsError ? (
          <p className="form-error" style={{ marginBottom: "0.75rem" }}>{binSettingsError}</p>
        ) : null}
        <form className="picking-bins-form" onSubmit={(e) => void saveBinSettings(e)}>
          <label className="picking-bins-label">
            Kg per full bin
            <input
              className="setup-input"
              type="number"
              min="0.01"
              step="0.01"
              value={pickingBinKgDraft}
              placeholder="e.g. 25"
              onChange={(e) => { setPickingBinKgDraft(e.target.value); setBinSettingsSaved(false); }}
            />
          </label>
          <label className="picking-bins-label">
            Kg per case
            <input
              className="setup-input"
              type="number"
              min="0.01"
              step="0.01"
              value={caseKgDraft}
              placeholder="e.g. 12"
              onChange={(e) => { setCaseKgDraft(e.target.value); setBinSettingsSaved(false); }}
            />
          </label>
          <button className="setup-action-button" type="submit" disabled={binSettingsSaving}>
            {binSettingsSaving ? "Saving..." : "Save"}
          </button>
        </form>
        {binSettingsSaved ? (
          <p style={{ marginTop: "0.5rem", color: "var(--brand)", fontWeight: 600, fontSize: "0.88rem" }}>
            Bin settings saved.
          </p>
        ) : null}
      </div>

      <div className="coming-soon-card">
        <div className="greenhouse-tabs">
          <button
            type="button"
            className={`greenhouse-tab-button${activeTab === "rows" ? " active" : ""}`}
            onClick={() => setActiveTab("rows")}
          >
            Rows &amp; Sections
          </button>
          <button
            type="button"
            className={`greenhouse-tab-button${activeTab === "varieties" ? " active" : ""}`}
            onClick={() => setActiveTab("varieties")}
          >
            Linked Varieties
          </button>
          <button
            type="button"
            className={`greenhouse-tab-button${activeTab === "valves" ? " active" : ""}`}
            onClick={() => setActiveTab("valves")}
          >
            Linked Valves
          </button>
        </div>

        {activeTab === "varieties" ? (
          <div className="greenhouse-tab-content">
            {!selectedGroup ? <p>Select a greenhouse group to manage variety assignments.</p> : null}

            {selectedGroup ? (
              <div className="varieties-toolbar greenhouse-toolbar">
                <button
                  type="button"
                  onClick={openAddAssignmentModal}
                  disabled={activeVarieties.length === 0 || selectedGroupRows.length === 0}
                >
                  + Assign Variety
                </button>
              </div>
            ) : null}

            {selectedGroup && activeVarieties.length === 0 ? (
              <p>There are no active varieties available to assign.</p>
            ) : null}

            {selectedGroup && selectedGroupRows.length === 0 ? (
              <p>Add row sections before assigning varieties.</p>
            ) : null}

            {selectedGroup && selectedGroupAssignments.length === 0 ? (
              <p>No variety assignments yet for this group.</p>
            ) : null}

            {selectedGroup && selectedGroupAssignments.length > 0 ? (
              <div className="variety-card-list">
                {groupedVarietyAreaSummaries.map((grp) => (
                  <div key={grp.varietyId} className="variety-card">
                    <div className="variety-card-info">
                      <div className="variety-card-header">
                        {grp.varietyColor ? (
                          <span className={`color-badge ${grp.varietyColor}`}>
                            {grp.varietyColor}
                          </span>
                        ) : null}
                        <span className="variety-card-name">{grp.varietyName}</span>
                      </div>
                      <div className="variety-card-rows">
                        {grp.rowDisplay || "–"}
                        {grp.totalRowCount > 0 ? (
                          <span className="variety-card-count">
                            ({grp.totalRowCount} rows)
                          </span>
                        ) : null}
                      </div>
                      {grp.totalM2 > 0 || grp.totalPlants > 0 || grp.totalSlabs > 0 ? (
                        <div className="variety-card-stats">
                          {grp.totalM2 > 0 ? <span>{grp.totalM2} m²</span> : null}
                          {grp.totalFt2 > 0 ? <span>{grp.totalFt2} ft²</span> : null}
                          {grp.totalPlants > 0 ? (
                            <span>{grp.totalPlants} plants</span>
                          ) : null}
                          {grp.totalSlabs > 0 ? (
                            <span>{grp.totalSlabs} slabs</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div className="variety-card-actions">
                      {grp.assignments.length === 1 ? (
                        (() => {
                          const assignment = selectedGroupAssignments.find(
                            (a) => a.id === grp.assignments[0].assignmentId
                          );
                          return assignment ? (
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
                          ) : null;
                        })()
                      ) : (
                        <div className="variety-card-multi-actions">
                          {grp.assignments.map((summary) => {
                            const assignment = selectedGroupAssignments.find(
                              (a) => a.id === summary.assignmentId
                            );
                            if (!assignment) return null;
                            return (
                              <div
                                key={summary.assignmentId}
                                className="variety-card-action-row"
                              >
                                <span className="variety-card-action-label">
                                  {summary.rowRange}:
                                </span>
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
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {activeTab === "rows" ? (
          <div className="greenhouse-tab-content">
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
                      <th>Row #</th>
                      <th>Slabs</th>
                      <th>Plants/slab</th>
                      <th>Stems/plant</th>
                      <th>Width (m)</th>
                      <th>Length (m)</th>
                      <th>m²</th>
                      <th>Total plants</th>
                      <th>Total stems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const draft = rowDrafts[row.id] ?? {
                        slab_count: String(row.slab_count),
                        plants_per_slab: String(row.plants_per_slab),
                        stems_per_plant: String(row.stems_per_plant),
                        width_meters: row.width_meters !== null ? String(row.width_meters) : "",
                        length_meters: row.length_meters !== null ? String(row.length_meters) : ""
                      };

                      const slabCount = parseNumber(draft.slab_count);
                      const plantsPerSlab = parseNumber(draft.plants_per_slab);
                      const stemsPerPlant = parseNumber(draft.stems_per_plant);
                      const totalPlants = slabCount * plantsPerSlab;
                      const totalStems = totalPlants * stemsPerPlant;
                      const draftWidth = parseNullableNumber(draft.width_meters);
                      const draftLength = parseNullableNumber(draft.length_meters);
                      const areaM2 = roundTo((draftWidth ?? 0) * (draftLength ?? 0), 2);

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
                                    [row.id]: { ...draft, slab_count: event.target.value }
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
                                    [row.id]: { ...draft, plants_per_slab: event.target.value }
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
                                    [row.id]: { ...draft, stems_per_plant: event.target.value }
                                  }))
                                }
                              />
                            ) : (
                              row.stems_per_plant
                            )}
                          </td>
                          <td>
                            {editRowsMode ? (
                              <input
                                className="greenhouse-table-input"
                                type="number"
                                min="0.01"
                                step="0.01"
                                value={draft.width_meters}
                                onChange={(event) =>
                                  setRowDrafts((current) => ({
                                    ...current,
                                    [row.id]: { ...draft, width_meters: event.target.value }
                                  }))
                                }
                              />
                            ) : (
                              row.width_meters ?? "-"
                            )}
                          </td>
                          <td>
                            {editRowsMode ? (
                              <input
                                className="greenhouse-table-input"
                                type="number"
                                min="0.01"
                                step="0.01"
                                value={draft.length_meters}
                                onChange={(event) =>
                                  setRowDrafts((current) => ({
                                    ...current,
                                    [row.id]: { ...draft, length_meters: event.target.value }
                                  }))
                                }
                              />
                            ) : (
                              row.length_meters ?? "-"
                            )}
                          </td>
                          <td>{areaM2 > 0 ? areaM2 : "-"}</td>
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
        ) : null}

        {activeTab === "valves" ? (
          <div className="greenhouse-tab-content">
            <div className="varieties-toolbar greenhouse-toolbar">
              <span className="greenhouse-toolbar-label">Link rows to irrigation valves</span>
              {valves.length > 0 && sortedRowNumbers.length > 0 ? (
                <button
                  className="primary-action-button"
                  type="button"
                  onClick={() => {
                    setValveModalOpen(true);
                    setEditingValveId(null);
                    setValveAssignForm({ valve_id: "", row_pattern: "all", start_row: "", end_row: "" });
                    setValveAssignError(null);
                  }}
                >
                  Assign rows to valve
                </button>
              ) : null}
            </div>

            {valves.length === 0 ? (
              <p>No irrigation valves found. Set up valves in Irrigation Setup first.</p>
            ) : sortedRowNumbers.length === 0 ? (
              <p>Create rows in Rows &amp; Sections before linking valves.</p>
            ) : null}

            {rowValves.length === 0 ? (
              <p className="valve-empty-state">No rows are linked to valves yet.</p>
            ) : (
              <div className="variety-card-list">
                {groupedValveLinks.map((grp) => (
                  <div key={grp.valveId} className="variety-card">
                    <div className="variety-card-info">
                      <div className="variety-card-header">
                        <span className="variety-card-name">{grp.valveName}</span>
                      </div>
                      <div className="variety-card-rows">
                        {grp.minRow !== null && grp.maxRow !== null
                          ? `Rows ${grp.minRow} – ${grp.maxRow}`
                          : "–"}
                      </div>
                      <div className="variety-card-stats">
                        <span>{grp.patternLabel}</span>
                        <span>{grp.rowNumbers.length} total rows</span>
                        {/* totalM2 is 0 when row width_meters/length_meters are not set */}
                        <span>
                          {grp.totalM2 > 0
                            ? `${roundTo(grp.totalM2, 1)} m²`
                            : "Square meters: —"}
                        </span>
                      </div>
                    </div>
                    <div className="variety-card-actions">
                      <div className="row-actions">
                        <button type="button" onClick={() => openEditValve(grp)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void removeAllValveLinks(grp.rvIds)}
                        >
                          Remove all ({grp.rvIds.length})
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
                  <option value="every_other">Every other row</option>
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

              <label>
                Row width (m)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={rowSectionForm.width_meters}
                  placeholder="Optional"
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      width_meters: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Row length (m)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={rowSectionForm.length_meters}
                  placeholder="Optional"
                  onChange={(event) =>
                    setRowSectionForm((current) => ({
                      ...current,
                      length_meters: event.target.value
                    }))
                  }
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
                <select
                  value={assignmentForm.start_row}
                  onChange={(event) =>
                    setAssignmentForm((current) => ({
                      ...current,
                      start_row: event.target.value
                    }))
                  }
                  required
                >
                  {selectedGroupRowNumbersSorted.map((rowNumber) => (
                    <option key={rowNumber} value={String(rowNumber)}>
                      {rowNumber}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                End row
                <select
                  value={assignmentForm.end_row}
                  onChange={(event) =>
                    setAssignmentForm((current) => ({
                      ...current,
                      end_row: event.target.value
                    }))
                  }
                  required
                >
                  {selectedGroupRowNumbersSorted.map((rowNumber) => (
                    <option key={rowNumber} value={String(rowNumber)}>
                      {rowNumber}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Assignment pattern
                <select
                  value={assignmentForm.assignment_pattern}
                  onChange={(event) =>
                    setAssignmentForm((current) => ({
                      ...current,
                      assignment_pattern: event.target.value as AssignmentPattern
                    }))
                  }
                >
                  <option value="all">All rows</option>
                  <option value="every_other">Every other row</option>
                </select>
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

      {valveModalOpen ? (
        <div className="modal-overlay" onClick={closeValveModal}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>
              {editingValveId
                ? "Edit valve row assignment"
                : "Assign rows to irrigation valve"}
            </h2>
            <form className="varieties-form" onSubmit={(event) => void assignValveRows(event)}>
              <label>
                Valve
                <select
                  value={valveAssignForm.valve_id}
                  onChange={(event) =>
                    setValveAssignForm((current) => ({
                      ...current,
                      valve_id: event.target.value
                    }))
                  }
                  required
                  disabled={editingValveId !== null}
                >
                  <option value="">Select valve…</option>
                  {valves.map((valve) => (
                    <option key={valve.id} value={valve.id}>
                      {valve.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Row pattern
                <select
                  value={valveAssignForm.row_pattern}
                  onChange={(event) =>
                    setValveAssignForm((current) => ({
                      ...current,
                      row_pattern: event.target.value as "all" | "every_other"
                    }))
                  }
                >
                  <option value="all">All rows</option>
                  <option value="every_other">Every other row</option>
                </select>
              </label>
              <label>
                Start row
                <select
                  value={valveAssignForm.start_row}
                  onChange={(event) =>
                    setValveAssignForm((current) => ({
                      ...current,
                      start_row: event.target.value
                    }))
                  }
                  required
                >
                  <option value="">Select…</option>
                  {sortedRowNumbers.map((n) => (
                    <option key={n} value={String(n)}>
                      Row {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                End row
                <select
                  value={valveAssignForm.end_row}
                  onChange={(event) =>
                    setValveAssignForm((current) => ({
                      ...current,
                      end_row: event.target.value
                    }))
                  }
                  required
                >
                  <option value="">Select…</option>
                  {sortedRowNumbers.map((n) => (
                    <option key={n} value={String(n)}>
                      Row {n}
                    </option>
                  ))}
                </select>
              </label>
              {valveAssignError ? (
                <p className="form-error" style={{ gridColumn: "1 / -1" }}>
                  {valveAssignError}
                </p>
              ) : null}
              <div className="form-actions">
                <button
                  type="submit"
                  disabled={
                    valveAssigning ||
                    !valveAssignForm.valve_id ||
                    !valveAssignForm.start_row ||
                    !valveAssignForm.end_row ||
                    parseInt(valveAssignForm.end_row, 10) <
                      parseInt(valveAssignForm.start_row, 10)
                  }
                >
                  {valveAssigning ? "Saving…" : editingValveId ? "Update" : "Assign"}
                </button>
                <button type="button" className="secondary" onClick={closeValveModal}>
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
