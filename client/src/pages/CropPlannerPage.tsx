import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";
import { ModalOverlay } from "../components/ModalOverlay";
import { downloadBlobFile } from "../lib/downloadFile";
import { GreenhouseMapCanvas, mapRowKey } from "../components/greenhouseMap/GreenhouseMapCanvas";
import type { GreenhouseMapResponse, MapRow } from "../lib/greenhouseMap/types";
import {
  formatRowRanges,
  layoutIndex,
  orderCsv,
  rowKey,
  rowsInRange,
  seedOrder,
  selectionSummary,
  slabOrder,
  unassignedRows,
  type PlanGreenhouseRow,
  type PlanGroup,
  type PlanSlabType,
  type PlanVariety,
  type PlantingAssignment,
  type RowLayoutInput,
  type RowRef,
  type SlabAssignment
} from "../lib/cropPlanner/planCalc";

// Crop Planner: a draft plan per season, kept apart from the live greenhouse
// (Greenhouse Setup's variety assignments are never changed here). Plant
// varieties and assign slab types to rows on the greenhouse map, then read
// off how many seeds and slabs to order. Nothing is ordered automatically.

type PlanSummary = { id: string; season: string; name: string; notes: string | null; updated_at: string };
type Product = { code: string; name: string; status: string };
type PlanDetail = {
  plan: PlanSummary;
  plantings: PlantingAssignment[];
  slabs: SlabAssignment[];
  layouts: RowLayoutInput[];
  oversow: Array<{ variety_id: string; oversow_pct: number }>;
  greenhouse: { groups: PlanGroup[]; rows: PlanGreenhouseRow[] };
  varieties: PlanVariety[];
  slabTypes: PlanSlabType[];
  products: Product[];
};
type Mode = "planting" | "slabs";
type View = "map" | "list";
type Conflict = { rows: RowRef[]; message: string };

const PLANS_URL = "/api/crop-planner/plans";
const SLAB_TYPES_URL = "/api/crop-planner/slab-types";
const LAST_PLAN_KEY = "cropPlanner.lastPlanId";
const VIEW_KEY = "cropPlanner.view";
// Colours for assignments on the map, in the order assignments appear.
const PALETTE = ["#2f7d5b", "#c0563f", "#d49a1f", "#3d6fb6", "#8a5cb8", "#2a9aa0", "#b5487d", "#6b8e23", "#a0662b", "#4b5d9c"];

const fmt = (n: number) => n.toLocaleString("en-US");

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

function readLastPlan() {
  try {
    return localStorage.getItem(LAST_PLAN_KEY);
  } catch {
    return null;
  }
}
function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "map";
  } catch {
    return "map";
  }
}
function rememberView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // A per-viewer convenience only.
  }
}
function rememberPlan(id: string) {
  try {
    localStorage.setItem(LAST_PLAN_KEY, id);
  } catch {
    // A per-viewer convenience only.
  }
}

export function CropPlannerPage() {
  const { can } = usePermissions();
  const canEdit = can("greenhouse_setup:edit");
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [planId, setPlanId] = useState<string>("");
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("planting");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<RowRef | null>(null);
  const [cropCode, setCropCode] = useState("");
  const [varietyId, setVarietyId] = useState("");
  const [slabTypeId, setSlabTypeId] = useState("");
  const [newSlabType, setNewSlabType] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [rangeForm, setRangeForm] = useState({ group: "", from: "", to: "" });
  const [layoutForm, setLayoutForm] = useState({ slabs_per_trough: "", troughs_per_row: "", plants_per_slab: "" });
  const [planModal, setPlanModal] = useState<{ editing: boolean; season: string; name: string } | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [oversowDraft, setOversowDraft] = useState<Record<string, string>>({});
  // The organization's greenhouse map (Setup → Map). Without one,
  // or with the list chosen, rows are shown as tiles by phase.
  const [greenhouseMap, setGreenhouseMap] = useState<GreenhouseMapResponse["map"]>(null);
  const [view, setView] = useState<View>(readView);

  async function loadPlans(preferId?: string) {
    const response = await apiFetch(PLANS_URL);
    if (!response.ok) throw new Error(await errorMessage(response, "Failed to load crop plans"));
    const list = (await response.json()) as PlanSummary[];
    setPlans(list);
    const wanted = preferId ?? readLastPlan();
    const next = list.find((p) => p.id === wanted)?.id ?? list[0]?.id ?? "";
    setPlanId(next);
    if (!next) setDetail(null);
  }

  async function loadDetail(id: string) {
    const response = await apiFetch(`${PLANS_URL}/${id}`);
    if (!response.ok) throw new Error(await errorMessage(response, "Failed to load the plan"));
    const body = (await response.json()) as PlanDetail;
    setDetail(body);
    setOversowDraft({});
  }

  useEffect(() => {
    // The map is optional: if it can't be loaded the planner keeps the list.
    apiFetch("/api/greenhouse-map")
      .then(async (response) => (response.ok ? ((await response.json()) as GreenhouseMapResponse).map : null))
      .then((map) => setGreenhouseMap(map ?? null))
      .catch(() => setGreenhouseMap(null));
  }, []);

  useEffect(() => {
    loadPlans()
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load crop plans"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!planId) return;
    rememberPlan(planId);
    setSelection(new Set());
    setAnchor(null);
    setConflict(null);
    loadDetail(planId).catch((e) => setError(e instanceof Error ? e.message : "Failed to load the plan"));
  }, [planId]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    if (!detail) return [] as PlanGroup[];
    const withRows = new Set(detail.greenhouse.rows.map((r) => r.group_id));
    // Phases first, then other groups that hold rows.
    return detail.greenhouse.groups
      .filter((g) => withRows.has(g.id))
      .sort((a, b) => Number(b.type === "phase") - Number(a.type === "phase"));
  }, [detail]);
  const rowsByGroup = useMemo(() => {
    const map = new Map<string, PlanGreenhouseRow[]>();
    for (const row of detail?.greenhouse.rows ?? []) map.set(row.group_id, [...(map.get(row.group_id) ?? []), row]);
    for (const list of map.values()) list.sort((a, b) => a.row_number - b.row_number);
    return map;
  }, [detail]);
  const layoutOf = useMemo(() => layoutIndex(detail?.greenhouse.rows ?? [], detail?.layouts ?? []), [detail]);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const varietyName = useMemo(() => new Map((detail?.varieties ?? []).map((v) => [v.id, v.name])), [detail]);
  const slabTypeName = useMemo(() => new Map((detail?.slabTypes ?? []).map((t) => [t.id, t.name])), [detail]);

  // The assignment of each row in the current mode.
  const assignmentByRow = useMemo(() => {
    const map = new Map<string, string>();
    if (!detail) return map;
    if (mode === "planting") for (const p of detail.plantings) map.set(rowKey(p), p.variety_id);
    else for (const s of detail.slabs) map.set(rowKey(s), s.slab_type_id);
    return map;
  }, [detail, mode]);
  const colourOf = useMemo(() => {
    const ids = Array.from(new Set(assignmentByRow.values())).sort();
    return new Map(ids.map((id, index) => [id, PALETTE[index % PALETTE.length]]));
  }, [assignmentByRow]);
  const labelOf = (id: string) => (mode === "planting" ? varietyName.get(id) : slabTypeName.get(id)) ?? "Unknown";
  const plantingByRow = useMemo(() => new Map((detail?.plantings ?? []).map((p) => [rowKey(p), p.variety_id])), [detail]);
  const slabByRow = useMemo(() => new Map((detail?.slabs ?? []).map((s) => [rowKey(s), s.slab_type_id])), [detail]);

  // The map, limited to rows that are in Greenhouse Setup (and so in the plan);
  // Setup rows the map doesn't place are listed under it so they stay selectable.
  const setupKeys = useMemo(() => new Set((detail?.greenhouse.rows ?? []).map(rowKey)), [detail]);
  const plannerMap = useMemo(() => {
    if (!greenhouseMap || !detail) return null;
    return {
      ...greenhouseMap,
      phases: greenhouseMap.phases.map((p) => ({ ...p, rows: p.rows.filter((r) => setupKeys.has(mapRowKey(p.group_id, r.row_number))) }))
    };
  }, [greenhouseMap, detail, setupKeys]);
  const showMap = Boolean(plannerMap) && view === "map";
  const offMapGroups = useMemo(() => {
    if (!plannerMap) return [] as Array<{ group: PlanGroup; rows: PlanGreenhouseRow[] }>;
    const onMap = new Set(plannerMap.phases.flatMap((p) => p.rows.map((r) => mapRowKey(p.group_id, r.row_number))));
    return groups
      .map((group) => ({ group, rows: (rowsByGroup.get(group.id) ?? []).filter((r) => !onMap.has(rowKey(r))) }))
      .filter((g) => g.rows.length > 0);
  }, [plannerMap, groups, rowsByGroup]);

  const seeds = useMemo(
    () => (detail ? seedOrder({ plantings: detail.plantings, groups, varieties: detail.varieties, oversow: detail.oversow, layoutOf }) : []),
    [detail, groups, layoutOf]
  );
  const slabs = useMemo(
    () => (detail ? slabOrder({ slabs: detail.slabs, groups, slabTypes: detail.slabTypes, layoutOf }) : []),
    [detail, groups, layoutOf]
  );
  const unplanted = useMemo(() => (detail ? unassignedRows(detail.greenhouse.rows, detail.plantings) : []), [detail]);
  const unslabbed = useMemo(() => (detail ? unassignedRows(detail.greenhouse.rows, detail.slabs) : []), [detail]);

  const selectedRows = useMemo<RowRef[]>(
    () =>
      Array.from(selection)
        .map((key) => {
          const i = key.lastIndexOf(":");
          return { group_id: key.slice(0, i), row_number: Number(key.slice(i + 1)) };
        })
        .sort((a, b) => a.group_id.localeCompare(b.group_id) || a.row_number - b.row_number),
    [selection]
  );
  const preview = useMemo(() => selectionSummary(selectedRows, layoutOf), [selectedRows, layoutOf]);
  const assignedInSelection = selectedRows.filter((r) => assignmentByRow.has(rowKey(r)));
  const targetId = mode === "planting" ? varietyId : slabTypeId;
  const conflictsInSelection = assignedInSelection.filter((r) => assignmentByRow.get(rowKey(r)) !== targetId);
  const unassignedInSelection = selectedRows.filter((r) => !assignmentByRow.has(rowKey(r)));

  const activeCrops = (detail?.products ?? []).filter((p) => p.status === "active");
  const cropVarieties = (detail?.varieties ?? []).filter(
    (v) => (v.product_code ?? "bell_pepper") === cropCode && v.status !== "inactive"
  );
  const activeSlabTypes = (detail?.slabTypes ?? []).filter((t) => t.status !== "inactive");

  useEffect(() => {
    if (!cropCode && activeCrops.length) setCropCode(activeCrops.find((c) => c.code === "bell_pepper")?.code ?? activeCrops[0].code);
  }, [activeCrops, cropCode]);
  useEffect(() => {
    if (!cropVarieties.some((v) => v.id === varietyId)) setVarietyId(cropVarieties[0]?.id ?? "");
  }, [cropVarieties, varietyId]);
  useEffect(() => {
    if (!activeSlabTypes.some((t) => t.id === slabTypeId)) setSlabTypeId(activeSlabTypes[0]?.id ?? "");
  }, [activeSlabTypes, slabTypeId]);

  // Groups selected rows by group, as "Phase 1 rows 1–20".
  const describeRows = (refs: RowRef[]) => {
    const byGroup = new Map<string, number[]>();
    for (const r of refs) byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r.row_number]);
    return Array.from(byGroup.entries())
      .map(([g, nums]) => `${groupName.get(g) ?? "Group"} row${nums.length === 1 ? "" : "s"} ${formatRowRanges(nums)}`)
      .join("; ");
  };
  // Assigned rows in the selection, by what they're assigned to.
  const assignedSummary = useMemo(() => {
    const byValue = new Map<string, RowRef[]>();
    for (const r of assignedInSelection) {
      const value = assignmentByRow.get(rowKey(r))!;
      byValue.set(value, [...(byValue.get(value) ?? []), r]);
    }
    return Array.from(byValue.entries());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, assignmentByRow]);

  // ── Selection ──────────────────────────────────────────────────────────────
  function toggleRow(ref: RowRef, extend: boolean) {
    setConflict(null);
    setSelection((current) => {
      const next = new Set(current);
      if (extend && anchor && anchor.group_id === ref.group_id) {
        for (const r of rowsInRange(detail?.greenhouse.rows ?? [], ref.group_id, anchor.row_number, ref.row_number)) next.add(rowKey(r));
      } else if (next.has(rowKey(ref))) {
        next.delete(rowKey(ref));
      } else {
        next.add(rowKey(ref));
      }
      return next;
    });
    setAnchor(ref);
  }
  function selectRows(refs: RowRef[]) {
    setConflict(null);
    setSelection((current) => {
      const next = new Set(current);
      for (const r of refs) next.add(rowKey(r));
      return next;
    });
  }
  function clearSelection() {
    setSelection(new Set());
    setAnchor(null);
    setConflict(null);
  }
  function addRange(event: FormEvent) {
    event.preventDefault();
    const from = Number(rangeForm.from);
    const to = Number(rangeForm.to || rangeForm.from);
    if (!rangeForm.group || !Number.isInteger(from) || !Number.isInteger(to)) return;
    selectRows(rowsInRange(detail?.greenhouse.rows ?? [], rangeForm.group, from, to));
  }

  // ── Saves ──────────────────────────────────────────────────────────────────
  async function post(url: string, body: unknown, method = "POST") {
    return apiFetch(url, { method, body: JSON.stringify(body) });
  }

  async function assign(onAssigned: "skip" | "reassign" | null) {
    if (!detail || !targetId || selectedRows.length === 0) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const url = `${PLANS_URL}/${detail.plan.id}/${mode === "planting" ? "plantings" : "slabs"}`;
      const body = {
        rows: selectedRows,
        ...(mode === "planting" ? { variety_id: targetId } : { slab_type_id: targetId }),
        ...(onAssigned ? { on_assigned: onAssigned } : {})
      };
      const response = await post(url, body);
      if (response.status === 409) {
        // Never overwritten silently: the user chooses what to do with them.
        const conflictBody = (await response.json()) as { message: string; conflicts?: RowRef[] };
        setConflict({ rows: conflictBody.conflicts ?? [], message: conflictBody.message });
        await loadDetail(detail.plan.id);
        return;
      }
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to save"));
      const result = (await response.json()) as { assigned: number; reassigned: number; skipped: number };
      const what = mode === "planting" ? varietyName.get(targetId) : slabTypeName.get(targetId);
      setNotice(
        `${what}: ${result.assigned} row${result.assigned === 1 ? "" : "s"} assigned` +
          (result.reassigned ? `, ${result.reassigned} reassigned` : "") +
          (result.skipped ? `, ${result.skipped} already assigned left as they were` : "") +
          "."
      );
      clearSelection();
      await loadDetail(detail.plan.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function removeAssignments() {
    if (!detail || assignedInSelection.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const url = `${PLANS_URL}/${detail.plan.id}/${mode === "planting" ? "plantings" : "slabs"}/remove`;
      const response = await post(url, { rows: assignedInSelection });
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to remove"));
      const { removed } = (await response.json()) as { removed: number };
      setNotice(`${mode === "planting" ? "Planting" : "Slab assignment"} removed from ${removed} row${removed === 1 ? "" : "s"}.`);
      clearSelection();
      await loadDetail(detail.plan.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setSaving(false);
    }
  }

  async function saveLayout(clear: boolean) {
    if (!detail || selectedRows.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const body = clear
        ? { rows: selectedRows }
        : {
            rows: selectedRows,
            slabs_per_trough: layoutForm.slabs_per_trough || null,
            troughs_per_row: layoutForm.troughs_per_row || null,
            plants_per_slab: layoutForm.plants_per_slab || null
          };
      const response = await post(`${PLANS_URL}/${detail.plan.id}/layouts`, body, "PUT");
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to save layout inputs"));
      setNotice(clear ? `${selectedRows.length} rows use their Greenhouse Setup layout again.` : `Layout inputs saved for ${selectedRows.length} rows.`);
      await loadDetail(detail.plan.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save layout inputs");
    } finally {
      setSaving(false);
    }
  }

  async function saveOversow(id: string) {
    if (!detail) return;
    const raw = oversowDraft[id];
    if (raw === undefined) return;
    setError(null);
    const response = await post(`${PLANS_URL}/${detail.plan.id}/varieties/${id}`, { oversow_pct: raw === "" ? 0 : Number(raw) }, "PUT");
    if (!response.ok) {
      setError(await errorMessage(response, "Failed to save oversow"));
      return;
    }
    await loadDetail(detail.plan.id);
  }

  async function addSlabType(event: FormEvent) {
    event.preventDefault();
    if (!newSlabType.trim() || !detail) return;
    const response = await post(SLAB_TYPES_URL, { name: newSlabType.trim() });
    if (!response.ok) {
      setError(await errorMessage(response, "Failed to add slab type"));
      return;
    }
    const created = (await response.json()) as PlanSlabType;
    setNewSlabType("");
    await loadDetail(detail.plan.id);
    setSlabTypeId(created.id);
  }

  async function savePlan(event: FormEvent) {
    event.preventDefault();
    if (!planModal) return;
    setError(null);
    const body = { season: planModal.season, name: planModal.name, notes: planModal.editing ? detail?.plan.notes ?? null : null };
    const response = planModal.editing && detail
      ? await post(`${PLANS_URL}/${detail.plan.id}`, body, "PUT")
      : await post(PLANS_URL, body);
    if (!response.ok) {
      setError(await errorMessage(response, "Failed to save the plan"));
      return;
    }
    const saved = (await response.json()) as PlanSummary;
    setPlanModal(null);
    await loadPlans(saved.id);
    if (planModal.editing) await loadDetail(saved.id);
  }

  async function deletePlan() {
    if (!detail || !window.confirm(`Delete the ${detail.plan.season} plan "${detail.plan.name}"? Its plantings, slabs and inputs are removed. The live greenhouse is not affected.`)) return;
    const response = await apiFetch(`${PLANS_URL}/${detail.plan.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await errorMessage(response, "Failed to delete the plan"));
      return;
    }
    await loadPlans("");
  }

  function exportCsv() {
    if (!detail) return;
    const csv = orderCsv({ season: detail.plan.season, planName: detail.plan.name, seeds, slabs });
    const slug = `${detail.plan.season}-${detail.plan.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadBlobFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), `crop-plan-order-${slug}.csv`);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const rowTiles = (group: PlanGroup, groupRows: PlanGreenhouseRow[]) =>
    groupRows.map((row) => {
      const key = rowKey(row);
      const assigned = assignmentByRow.get(key);
      const layout = layoutOf(row);
      const missing = mode === "planting" ? layout.plants === null : layout.slabsPerRow === null;
      return (
        <button
          key={key}
          type="button"
          className={`crop-plan-row${selection.has(key) ? " selected" : ""}${assigned ? "" : " unassigned"}`}
          style={assigned ? { background: colourOf.get(assigned) } : undefined}
          aria-pressed={selection.has(key)}
          aria-label={`${group.name} row ${row.row_number}: ${assigned ? labelOf(assigned) : "unassigned"}${missing ? ", missing layout inputs" : ""}`}
          title={`Row ${row.row_number} · ${assigned ? labelOf(assigned) : "Unassigned"} · ${layout.plants === null ? `missing ${layout.missing.join(", ")}` : `${layout.slabsPerRow} slabs × ${layout.plantsPerSlab} plants = ${layout.plants} plants`}`}
          onClick={(e) => toggleRow(row, e.shiftKey)}
        >
          {row.row_number}
          {missing ? <span className="crop-plan-row-flag" aria-hidden="true">!</span> : null}
        </button>
      );
    });

  // On the map a row shows its assignment in the current mode, and both
  // assignments in its tooltip, so neither mode's work is hidden.
  const mapRowAppearance = (groupId: string, row: MapRow) => {
    const ref = { group_id: groupId, row_number: row.row_number };
    const key = rowKey(ref);
    const assigned = assignmentByRow.get(key);
    const layout = layoutOf(ref);
    const missing = mode === "planting" ? layout.plants === null : layout.slabsPerRow === null;
    const planting = plantingByRow.get(key);
    const slab = slabByRow.get(key);
    const title = [
      `${groupName.get(groupId) ?? "Phase"} row ${row.row_number}: ${assigned ? labelOf(assigned) : "unassigned"}${missing ? ", missing layout inputs" : ""}`,
      `Planting: ${planting ? varietyName.get(planting) ?? "Unknown" : "none"}`,
      `Slab type: ${slab ? slabTypeName.get(slab) ?? "Unknown" : "none"}`,
      layout.plants === null ? `Missing ${layout.missing.join(", ")}` : `${layout.slabsPerRow} slabs × ${layout.plantsPerSlab} plants = ${layout.plants} plants`
    ].join("\n");
    return {
      fill: assigned ? colourOf.get(assigned) : undefined,
      className: `${assigned ? "assigned" : "unassigned"}${missing ? " missing-inputs" : ""}`,
      title
    };
  };

  const anyIncomplete = seeds.some((s) => s.incomplete) || slabs.some((s) => s.incomplete);
  // A phase breakdown when a variety or slab type spans phases, or when its
  // one phase has rows still missing inputs; otherwise the total says it all.
  const phaseBreakdown = <T extends { missingRows: RowRef[] }>(phases: T[]) =>
    phases.length > 1 || phases.some((phase) => phase.missingRows.length > 0) ? phases : [];
  const missingText = (refs: RowRef[], what: string) =>
    refs.length ? `${describeRows(refs)} ${refs.length === 1 ? "is" : "are"} missing ${what}.` : null;

  const orderTables = (printable: boolean) => (
    <>
      <h3>Seed order</h3>
      {seeds.length === 0 ? <p className="form-hint">No rows planted yet.</p> : (
        <table className="varieties-table crop-plan-order-table" aria-label="Seed order">
          <thead>
            <tr><th>Variety</th><th>Phase</th><th>Rows</th><th>Target plants</th><th>Oversow %</th><th>Base seeds</th><th>Extra seeds</th><th>Total seeds to order</th></tr>
          </thead>
          <tbody>
            {seeds.map((line) => [
              ...phaseBreakdown(line.phases).map((phase) => (
                <tr key={`${line.variety_id}-${phase.group_id}`} className="crop-plan-phase-line">
                  <td>{line.variety_name}</td>
                  <td>{phase.group_name}</td>
                  <td>{phase.rows}</td>
                  <td>{fmt(phase.quantity)}{phase.missingRows.length ? <span className="crop-plan-flag"> · {phase.missingRows.length} row{phase.missingRows.length === 1 ? "" : "s"} missing inputs</span> : null}</td>
                  <td colSpan={4}></td>
                </tr>
              )),
              <tr key={`${line.variety_id}-total`} className="crop-plan-total-line">
                <td>{line.variety_name}</td>
                <td>{line.phases.length > 1 ? "All phases" : line.phases[0]?.group_name}</td>
                <td>{line.rows}</td>
                <td>{fmt(line.targetPlants)}</td>
                <td>
                  {canEdit && !printable ? (
                    <input
                      type="number"
                      min="0"
                      max="1000"
                      step="0.01"
                      aria-label={`Oversow % for ${line.variety_name}`}
                      value={oversowDraft[line.variety_id] ?? String(line.oversowPct)}
                      onChange={(e) => setOversowDraft((d) => ({ ...d, [line.variety_id]: e.target.value }))}
                      onBlur={() => void saveOversow(line.variety_id)}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveOversow(line.variety_id); }}
                      className="crop-plan-oversow"
                    />
                  ) : `${line.oversowPct}%`}
                </td>
                <td>{fmt(line.baseSeeds)}</td>
                <td>{fmt(line.extraSeeds)}</td>
                <td>
                  <strong>{fmt(line.totalSeeds)}</strong>
                  {line.incomplete ? <span className="crop-plan-incomplete"> Incomplete</span> : null}
                </td>
              </tr>
            ])}
          </tbody>
        </table>
      )}
      <h3>Slab order</h3>
      {slabs.length === 0 ? <p className="form-hint">No slab types assigned yet.</p> : (
        <table className="varieties-table crop-plan-order-table" aria-label="Slab order">
          <thead>
            <tr><th>Slab type</th><th>Phase</th><th>Rows</th><th>Slabs to order</th></tr>
          </thead>
          <tbody>
            {slabs.map((line) => [
              ...phaseBreakdown(line.phases).map((phase) => (
                <tr key={`${line.slab_type_id}-${phase.group_id}`} className="crop-plan-phase-line">
                  <td>{line.slab_type_name}</td>
                  <td>{phase.group_name}</td>
                  <td>{phase.rows}</td>
                  <td>{fmt(phase.quantity)}{phase.missingRows.length ? <span className="crop-plan-flag"> · {phase.missingRows.length} row{phase.missingRows.length === 1 ? "" : "s"} missing inputs</span> : null}</td>
                </tr>
              )),
              <tr key={`${line.slab_type_id}-total`} className="crop-plan-total-line">
                <td>{line.slab_type_name}</td>
                <td>{line.phases.length > 1 ? "All phases" : line.phases[0]?.group_name}</td>
                <td>{line.rows}</td>
                <td>
                  <strong>{fmt(line.slabs)}</strong>
                  {line.incomplete ? <span className="crop-plan-incomplete"> Incomplete</span> : null}
                </td>
              </tr>
            ])}
          </tbody>
        </table>
      )}
    </>
  );

  return (
    <section className="page-shell crop-planner-page">
      <header>
        <h1>Crop Planner</h1>
        <p>Plan a season's planting and slabs, and work out what to order. Plans are drafts: they never change what is growing today.</p>
      </header>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-success" role="status">{notice}</p> : null}

      <div className="crop-plan-toolbar">
        <label>
          Plan
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={plans.length === 0}>
            {plans.length === 0 ? <option value="">No plans yet</option> : null}
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.season} · {p.name}</option>
            ))}
          </select>
        </label>
        {canEdit ? (
          <>
            <button type="button" onClick={() => setPlanModal({ editing: false, season: String(new Date().getFullYear() + 1), name: "" })}>+ New plan</button>
            {detail ? <button type="button" onClick={() => setPlanModal({ editing: true, season: detail.plan.season, name: detail.plan.name })}>Rename</button> : null}
            {detail ? <button type="button" className="danger" onClick={() => void deletePlan()}>Delete plan</button> : null}
          </>
        ) : null}
        {detail ? (
          <>
            <button type="button" onClick={() => setPrintOpen(true)}>Print order summary</button>
            <button type="button" onClick={exportCsv}>Export CSV</button>
          </>
        ) : null}
      </div>

      {loading ? <p>Loading...</p> : null}
      {!loading && plans.length === 0 ? (
        <div className="coming-soon-card"><p>No crop plans yet.{canEdit ? " Start one with + New plan." : ""}</p></div>
      ) : null}

      {detail ? (
        <>
          <div className="crop-plan-mode" role="tablist" aria-label="Map mode">
            <button type="button" role="tab" aria-selected={mode === "planting"} className={mode === "planting" ? "active" : ""} onClick={() => { setMode("planting"); setConflict(null); }}>
              Planting
            </button>
            <button type="button" role="tab" aria-selected={mode === "slabs"} className={mode === "slabs" ? "active" : ""} onClick={() => { setMode("slabs"); setConflict(null); }}>
              Slabs
            </button>
          </div>

          <div className="crop-plan-layout">
            <div className="coming-soon-card crop-plan-map" aria-label="Greenhouse map">
              <div className="crop-plan-map-head">
                <h2>Greenhouse map · {mode === "planting" ? "planting" : "slab types"}</h2>
                {plannerMap ? (
                  <div className="crop-plan-view" role="group" aria-label="Map view">
                    <button type="button" aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => { setView("map"); rememberView("map"); }}>Map</button>
                    <button type="button" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => { setView("list"); rememberView("list"); }}>Rows by phase</button>
                  </div>
                ) : null}
                {canEdit ? <a className="crop-plan-map-edit" href="/setup/map">{greenhouseMap ? "Edit map" : "Build a map"}</a> : null}
              </div>
              <p className="form-hint">
                {showMap
                  ? "Click a row on the map to select it, Shift-click another row in the same phase to select the range, or click a phase name to select the whole phase. Drag to pan, scroll to zoom. Rows with a dashed amber edge are missing layout inputs."
                  : "Click a row to select it, Shift-click to select a range, or select a whole phase. Rows marked ! are missing layout inputs."}
              </p>
              <div className="crop-plan-legend">
                {Array.from(colourOf.entries()).map(([id, colour]) => (
                  <span key={id}><i style={{ background: colour }} /> {labelOf(id)}</span>
                ))}
                <span><i className="unassigned" /> Unassigned ({fmt(mode === "planting" ? unplanted.length : unslabbed.length)})</span>
              </div>
              {groups.length === 0 ? <p>No greenhouse rows yet. Add phases and rows in Greenhouse Setup.</p> : null}
              {showMap && plannerMap ? (
                <>
                  <GreenhouseMapCanvas
                    map={plannerMap}
                    ariaLabel={`${plannerMap.name} map`}
                    groupName={(id) => groupName.get(id) ?? "Phase"}
                    rowAppearance={mapRowAppearance}
                    selectedKeys={selection}
                    onRowClick={(groupId, rowNumber, { shiftKey }) => toggleRow({ group_id: groupId, row_number: rowNumber }, shiftKey)}
                    onPhaseClick={(groupId) => selectRows(rowsByGroup.get(groupId) ?? [])}
                    rotationStorageKey={`cropPlanner.mapRotation.${plannerMap.id ?? "map"}`}
                  />
                  <div className="crop-plan-phase-buttons" role="group" aria-label="Select a whole phase">
                    {groups.map((group) => (
                      <button key={group.id} type="button" onClick={() => selectRows(rowsByGroup.get(group.id) ?? [])}>
                        Select {group.name} ({fmt(rowsByGroup.get(group.id)?.length ?? 0)} rows)
                      </button>
                    ))}
                  </div>
                  {offMapGroups.length ? (
                    <div className="crop-plan-off-map">
                      <h3>Rows not on the map</h3>
                      <p className="form-hint">These Greenhouse Setup rows have no place on the map yet. They can still be selected here.</p>
                      {offMapGroups.map(({ group, rows: groupRows }) => (
                        <section key={group.id} className="crop-plan-group" aria-label={`${group.name} rows not on the map`}>
                          <div className="crop-plan-group-head">
                            <strong>{group.name}</strong>
                            <span className="form-hint">{groupRows.length} row{groupRows.length === 1 ? "" : "s"}</span>
                          </div>
                          <div className="crop-plan-rows">{rowTiles(group, groupRows)}</div>
                        </section>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                groups.map((group) => {
                  const groupRows = rowsByGroup.get(group.id) ?? [];
                  return (
                    <section key={group.id} className="crop-plan-group" aria-label={group.name}>
                      <div className="crop-plan-group-head">
                        <strong>{group.name}</strong>
                        <span className="form-hint">{group.type === "phase" ? "Phase" : group.type} · {groupRows.length} rows</span>
                        <button type="button" onClick={() => selectRows(groupRows)}>Select phase</button>
                      </div>
                      <div className="crop-plan-rows">{rowTiles(group, groupRows)}</div>
                    </section>
                  );
                })
              )}
              <form className="crop-plan-range" onSubmit={addRange}>
                <label>
                  Phase
                  <select value={rangeForm.group} onChange={(e) => setRangeForm((f) => ({ ...f, group: e.target.value }))}>
                    <option value="">Choose…</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label>From row<input type="number" min="1" value={rangeForm.from} onChange={(e) => setRangeForm((f) => ({ ...f, from: e.target.value }))} /></label>
                <label>To row<input type="number" min="1" value={rangeForm.to} onChange={(e) => setRangeForm((f) => ({ ...f, to: e.target.value }))} /></label>
                <button type="submit">Select rows</button>
              </form>
            </div>

            <aside className="coming-soon-card crop-plan-panel" aria-label="Selection">
              <h2>Selection</h2>
              {selectedRows.length === 0 ? <p className="form-hint">No rows selected.</p> : (
                <>
                  <p className="crop-plan-selection-count">
                    <strong>{fmt(preview.rows)}</strong> row{preview.rows === 1 ? "" : "s"} selected ·{" "}
                    {mode === "planting" ? <><strong>{fmt(preview.plants)}</strong> plants</> : <><strong>{fmt(preview.slabs)}</strong> slabs</>}
                    {(mode === "planting" ? preview.missingPlants : preview.missingSlabs).length ? " (incomplete)" : ""}
                  </p>
                  <p className="form-hint">{describeRows(selectedRows)}</p>
                  {mode === "planting" && preview.missingPlants.length ? <p className="crop-plan-flag">{missingText(preview.missingPlants, "layout inputs")}</p> : null}
                  {mode === "slabs" && preview.missingSlabs.length ? <p className="crop-plan-flag">{missingText(preview.missingSlabs, "slabs per row")}</p> : null}
                  {assignedSummary.length ? (
                    <div className="crop-plan-assigned">
                      <strong>Already assigned:</strong>
                      <ul>
                        {assignedSummary.map(([value, refs]) => <li key={value}>{describeRows(refs)} → {labelOf(value)}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  <button type="button" className="secondary crop-plan-clear" onClick={clearSelection}>Clear selection</button>
                </>
              )}

              {canEdit ? (
                <div className="crop-plan-assign">
                  {mode === "planting" ? (
                    <>
                      <label>
                        Crop
                        <select value={cropCode} onChange={(e) => setCropCode(e.target.value)}>
                          {activeCrops.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Variety
                        <select value={varietyId} onChange={(e) => setVarietyId(e.target.value)}>
                          {cropVarieties.length === 0 ? <option value="">No active varieties</option> : null}
                          {cropVarieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      </label>
                    </>
                  ) : (
                    <>
                      <label>
                        Slab type
                        <select value={slabTypeId} onChange={(e) => setSlabTypeId(e.target.value)}>
                          {activeSlabTypes.length === 0 ? <option value="">No slab types yet</option> : null}
                          {activeSlabTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </label>
                      <form className="crop-plan-inline" onSubmit={addSlabType}>
                        <input aria-label="New slab type" placeholder="New slab type" value={newSlabType} onChange={(e) => setNewSlabType(e.target.value)} />
                        <button type="submit">Add</button>
                      </form>
                    </>
                  )}

                  {selectedRows.length > 0 && targetId ? (
                    conflictsInSelection.length === 0 && !conflict ? (
                      <button type="button" disabled={saving || unassignedInSelection.length === 0} onClick={() => void assign(null)}>
                        Assign {labelOf(targetId)} to {fmt(unassignedInSelection.length)} row{unassignedInSelection.length === 1 ? "" : "s"}
                      </button>
                    ) : (
                      <div className="crop-plan-conflict" role="group" aria-label="Rows already assigned">
                        <p>
                          {conflict?.message ??
                            `${conflictsInSelection.length} of the selected rows already ${conflictsInSelection.length === 1 ? "has an assignment" : "have assignments"}. Nothing is overwritten unless you reassign.`}
                        </p>
                        <button type="button" disabled={saving || unassignedInSelection.length === 0} onClick={() => void assign("skip")}>
                          Add only the {fmt(unassignedInSelection.length)} unassigned row{unassignedInSelection.length === 1 ? "" : "s"}
                        </button>
                        <button type="button" className="danger" disabled={saving} onClick={() => void assign("reassign")}>
                          Reassign all {fmt(selectedRows.length)} rows to {labelOf(targetId)}
                        </button>
                      </div>
                    )
                  ) : null}
                  {assignedInSelection.length > 0 ? (
                    <button type="button" className="secondary" disabled={saving} onClick={() => void removeAssignments()}>
                      Remove {mode === "planting" ? "planting" : "slab type"} from {fmt(assignedInSelection.length)} row{assignedInSelection.length === 1 ? "" : "s"}
                    </button>
                  ) : null}

                  {selectedRows.length > 0 ? (
                    <details className="crop-plan-layout-inputs">
                      <summary>Layout inputs for the selected rows</summary>
                      <p className="form-hint">
                        For rows whose layout differs from Greenhouse Setup, or has none: slabs per row = slabs per trough × troughs per row.
                      </p>
                      <label>Slabs per trough<input type="number" min="1" step="1" value={layoutForm.slabs_per_trough} onChange={(e) => setLayoutForm((f) => ({ ...f, slabs_per_trough: e.target.value }))} /></label>
                      <label>Troughs per row<input type="number" min="1" step="1" value={layoutForm.troughs_per_row} onChange={(e) => setLayoutForm((f) => ({ ...f, troughs_per_row: e.target.value }))} /></label>
                      <label>Plants per slab<input type="number" min="1" step="1" value={layoutForm.plants_per_slab} onChange={(e) => setLayoutForm((f) => ({ ...f, plants_per_slab: e.target.value }))} /></label>
                      {layoutForm.slabs_per_trough && layoutForm.troughs_per_row && layoutForm.plants_per_slab ? (
                        <p className="form-hint">
                          {layoutForm.slabs_per_trough} × {layoutForm.troughs_per_row} × {layoutForm.plants_per_slab} ={" "}
                          {fmt(Number(layoutForm.slabs_per_trough) * Number(layoutForm.troughs_per_row) * Number(layoutForm.plants_per_slab))} plants per row
                        </p>
                      ) : null}
                      <div className="form-actions">
                        <button type="button" disabled={saving} onClick={() => void saveLayout(false)}>Save layout inputs</button>
                        <button type="button" className="secondary" disabled={saving} onClick={() => void saveLayout(true)}>Use Greenhouse Setup layout</button>
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </aside>
          </div>

          <div className="coming-soon-card crop-plan-order" aria-label="Order summary">
            <h2>Order summary · {detail.plan.season} · {detail.plan.name}</h2>
            {anyIncomplete ? (
              <p className="crop-plan-incomplete-banner" role="note">
                Incomplete: some rows are missing layout inputs, so their plants or slabs aren't counted yet. Select them on the map and add layout inputs.
              </p>
            ) : null}
            {orderTables(false)}
            <h3>Unassigned rows</h3>
            <p>Planting: {unplanted.length ? describeRows(unplanted) : "none"}</p>
            <p>Slabs: {unslabbed.length ? describeRows(unslabbed) : "none"}</p>
            <p className="form-hint">Quantities to order only. Nothing is ordered from GrowLink.</p>
          </div>
        </>
      ) : null}

      {planModal ? (
        <ModalOverlay onClose={() => setPlanModal(null)} contentClassName="variety-modal" titleId="crop-plan-modal-title">
          <h2 id="crop-plan-modal-title">{planModal.editing ? "Rename plan" : "New plan"}</h2>
          <form className="varieties-form" onSubmit={savePlan}>
            <label>Season<input value={planModal.season} onChange={(e) => setPlanModal((m) => m && { ...m, season: e.target.value })} required /></label>
            <label>Plan name<input value={planModal.name} onChange={(e) => setPlanModal((m) => m && { ...m, name: e.target.value })} required /></label>
            <div className="form-actions">
              <button type="submit">Save plan</button>
              <button type="button" className="secondary" onClick={() => setPlanModal(null)}>Cancel</button>
            </div>
          </form>
        </ModalOverlay>
      ) : null}

      {printOpen && detail ? (
        <ModalOverlay onClose={() => setPrintOpen(false)} contentClassName="crop-plan-print-modal" titleId="crop-plan-print-title">
          <div data-print-root className="crop-plan-print">
            <h2 id="crop-plan-print-title">Order summary — {detail.plan.season} · {detail.plan.name}</h2>
            <p>Printed {new Date().toLocaleDateString()} · Quantities to order; not an order.</p>
            {anyIncomplete ? <p className="crop-plan-incomplete-banner">Incomplete: some rows are missing layout inputs.</p> : null}
            {orderTables(true)}
          </div>
          <div className="form-actions">
            <button type="button" onClick={() => window.print()}>Print</button>
            <button type="button" className="secondary" onClick={() => setPrintOpen(false)}>Close</button>
          </div>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
