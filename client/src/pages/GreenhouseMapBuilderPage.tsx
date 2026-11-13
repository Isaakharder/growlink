import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { downloadBlobFile } from "../lib/downloadFile";
import { GreenhouseMapCanvas, mapRowKey } from "../components/greenhouseMap/GreenhouseMapCanvas";
import {
  computeContinuationOffset,
  detectRowOverlap,
  generateRowNumbers,
  isValidSide,
  orientationForStartSide,
  placeBatchFromSide,
  sidesArePerpendicular,
  validateRowsInsidePhase,
  type NumberingMode,
  type RowRect,
  type Side
} from "../lib/greenhouseMap/rowLayout";
import type { GreenhouseMap, GreenhouseMapResponse, ImportReport, MapPhase, MapRow, SetupGroup, SetupRow } from "../lib/greenhouseMap/types";

// Setup → Map: build and edit the organization's own map
// from its Greenhouse Setup groups and rows, or import a LabourLink layout
// file. Modelled on LabourLink's Greenhouse Layout editor: a land in feet,
// phases placed on it (type a position or drag), and rows placed in a phase
// in batches from a start side and an anchor side.
//
// The map is drawing only. It never adds, changes or removes a Greenhouse
// Setup row, a live variety assignment or a plan; a row can only be placed if
// Greenhouse Setup already has it.

const MAP_URL = "/api/greenhouse-map";
const fmt = (n: number) => n.toLocaleString("en-US");
const SIDES: Side[] = ["north", "south", "east", "west"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type RowForm = {
  startSide: Side;
  anchorSide: Side;
  rowWidthFt: string;
  rowLengthFt: string;
  rowGapFt: string;
  startOffsetFt: string;
  anchorOffsetFt: string;
  numberingMode: NumberingMode;
  from: string;
  to: string;
  continueAfter: boolean;
};

type ImportState = {
  fileName: string;
  layout: unknown;
  landName: string | null;
  phaseMatches: Record<string, string>;
  rowResolutions: Record<string, number | "skip">;
  report: ImportReport | null;
  map: GreenhouseMap | null;
  busy: boolean;
};

async function errorBody(response: Response, fallback: string): Promise<{ message: string; problems: string[] }> {
  try {
    const body = (await response.json()) as { message?: string; problems?: string[] };
    return { message: body.message || fallback, problems: body.problems ?? [] };
  } catch {
    return { message: fallback, problems: [] };
  }
}

const toRow = (r: RowRect): MapRow => ({ row_number: r.rowNumber, x_ft: r.xFt, y_ft: r.yFt, width_ft: r.widthFt, length_ft: r.lengthFt, orientation: r.orientation });
const toRect = (r: MapRow): RowRect => ({ rowNumber: r.row_number, xFt: r.x_ft, yFt: r.y_ft, widthFt: r.width_ft, lengthFt: r.length_ft, orientation: r.orientation });
const phaseSize = (p: MapPhase) => ({ eastWestFeet: p.east_west_feet, northSouthFeet: p.north_south_feet });

export function GreenhouseMapBuilderPage() {
  const [loaded, setLoaded] = useState<GreenhouseMapResponse | null>(null);
  const [draft, setDraft] = useState<GreenhouseMap | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<{ message: string; problems: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<{ groupId: string; rowNumber: number } | null>(null);
  const [movePhases, setMovePhases] = useState(false);
  const [snap, setSnap] = useState(1);
  const [newLand, setNewLand] = useState({ name: "Greenhouse", ew: "", ns: "" });
  const [rowForm, setRowForm] = useState<RowForm>({
    startSide: "north", anchorSide: "west", rowWidthFt: "", rowLengthFt: "", rowGapFt: "0", startOffsetFt: "0", anchorOffsetFt: "0",
    numberingMode: "all", from: "", to: "", continueAfter: false
  });
  const [imp, setImp] = useState<ImportState | null>(null);

  async function load() {
    const response = await apiFetch(MAP_URL);
    if (!response.ok) throw new Error((await errorBody(response, "Failed to load the greenhouse map")).message);
    const body = (await response.json()) as GreenhouseMapResponse;
    setLoaded(body);
    setDraft(body.map ? structuredClone(body.map) : null);
    setDirty(false);
    setSelectedRows(new Set());
  }
  useEffect(() => {
    load().catch((e) => setError({ message: e instanceof Error ? e.message : "Failed to load the greenhouse map", problems: [] }));
  }, []);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const setup = loaded?.setup ?? { groups: [], rows: [] };
  const groupById = useMemo(() => new Map(setup.groups.map((g) => [g.id, g])), [setup.groups]);
  const setupRowsByGroup = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const r of setup.rows) m.set(r.group_id, [...(m.get(r.group_id) ?? []), r.row_number]);
    for (const list of m.values()) list.sort((a, b) => a - b);
    return m;
  }, [setup.rows]);
  const groupsWithRows = setup.groups.filter((g) => (setupRowsByGroup.get(g.id)?.length ?? 0) > 0);
  const groupName = (id: string) => groupById.get(id)?.name ?? "Unknown group";

  function edit(mutator: (m: GreenhouseMap) => void) {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutator(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  }

  const phase = draft?.phases.find((p) => p.group_id === selectedPhase) ?? null;

  // ── Row batch preview (LabourLink's row builder) ────────────────────────────
  const rowPreview = useMemo(() => {
    if (!phase) return null;
    const errors: string[] = [];
    const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
    const width = n(rowForm.rowWidthFt);
    const length = n(rowForm.rowLengthFt);
    const gap = n(rowForm.rowGapFt);
    const startOffset = n(rowForm.startOffsetFt);
    const anchorOffset = n(rowForm.anchorOffsetFt);
    const from = n(rowForm.from);
    const to = n(rowForm.to || rowForm.from);
    if (!rowForm.from.trim()) return null;
    if (!isValidSide(rowForm.startSide) || !isValidSide(rowForm.anchorSide) || !sidesArePerpendicular(rowForm.startSide, rowForm.anchorSide)) {
      errors.push("The anchor side must be perpendicular to the start side (a north or south start pairs with east or west).");
    }
    if (!(width > 0)) errors.push("Row width must be greater than 0.");
    if (!(length > 0)) errors.push("Row length must be greater than 0.");
    if (!(gap >= 0)) errors.push("Row gap must be 0 or more.");
    if (!(startOffset >= 0) || !(anchorOffset >= 0)) errors.push("Offsets must be 0 or more.");
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) errors.push("Enter a row range, from row ≤ to row.");
    if (errors.length) return { rows: [] as MapRow[], errors, missing: 0, moving: 0 };

    // Only rows Greenhouse Setup has; numbers it doesn't have are skipped, never created.
    const wanted = generateRowNumbers(rowForm.numberingMode, from, to);
    const inSetup = new Set(setupRowsByGroup.get(phase.group_id) ?? []);
    const numbers = wanted.filter((x) => inSetup.has(x));
    const missing = wanted.length - numbers.length;
    if (numbers.length === 0) return { rows: [], errors: ["Greenhouse Setup has no rows in that range for this phase."], missing, moving: 0 };

    const replacing = new Set(numbers);
    const others = phase.rows.filter((r) => !replacing.has(r.row_number)).map(toRect);
    const orientation = orientationForStartSide(rowForm.startSide);
    const base = rowForm.continueAfter
      ? computeContinuationOffset(others.filter((r) => r.orientation === orientation), phaseSize(phase), rowForm.startSide, gap)
      : 0;
    const rects = placeBatchFromSide(
      {
        startSide: rowForm.startSide, anchorSide: rowForm.anchorSide, rowWidthFt: width, rowLengthFt: length, rowGapFt: gap,
        startOffsetFt: base + startOffset, anchorOffsetFt: anchorOffset, numberingMode: rowForm.numberingMode, startRowNumber: from, endRowNumber: to
      },
      phaseSize(phase),
      numbers
    );
    const outside = validateRowsInsidePhase(rects, phaseSize(phase));
    if (outside.length) errors.push(`${outside.length} row(s) (e.g. row ${outside[0].rowNumber}) would fall outside the phase.`);
    const clash = detectRowOverlap(rects, others);
    if (clash.length) errors.push(`Row ${clash[0][0].rowNumber} would overlap row ${clash[0][1].rowNumber}, which is already placed.`);
    const self = detectRowOverlap(rects, rects);
    if (self.length) errors.push(`Row ${self[0][0].rowNumber} overlaps row ${self[0][1].rowNumber} — increase the gap.`);
    return { rows: rects.map(toRow), errors, missing, moving: phase.rows.length - others.length };
  }, [phase, rowForm, setupRowsByGroup]);

  function placeRows(e: FormEvent) {
    e.preventDefault();
    if (!phase || !rowPreview || rowPreview.errors.length || rowPreview.rows.length === 0) return;
    const placed = rowPreview.rows;
    const numbers = new Set(placed.map((r) => r.row_number));
    edit((m) => {
      const p = m.phases.find((x) => x.group_id === phase.group_id)!;
      p.rows = [...p.rows.filter((r) => !numbers.has(r.row_number)), ...placed].sort((a, b) => a.row_number - b.row_number);
    });
    setNotice(`${placed.length} row${placed.length === 1 ? "" : "s"} placed in ${groupName(phase.group_id)}. Save the map to keep them.`);
    setRowForm((f) => ({ ...f, from: "", to: "", continueAfter: true }));
  }

  // ── Selection on the canvas ─────────────────────────────────────────────────
  function clickRow(groupId: string, rowNumber: number, shiftKey: boolean) {
    setSelectedPhase(groupId);
    setSelectedRows((current) => {
      const next = new Set(current);
      if (shiftKey && anchor && anchor.groupId === groupId) {
        const lo = Math.min(anchor.rowNumber, rowNumber);
        const hi = Math.max(anchor.rowNumber, rowNumber);
        for (const r of draft?.phases.find((p) => p.group_id === groupId)?.rows ?? []) if (r.row_number >= lo && r.row_number <= hi) next.add(mapRowKey(groupId, r.row_number));
      } else if (next.has(mapRowKey(groupId, rowNumber))) next.delete(mapRowKey(groupId, rowNumber));
      else next.add(mapRowKey(groupId, rowNumber));
      return next;
    });
    setAnchor({ groupId, rowNumber });
  }
  function removeSelectedRows() {
    const keys = selectedRows;
    edit((m) => {
      for (const p of m.phases) p.rows = p.rows.filter((r) => !keys.has(mapRowKey(p.group_id, r.row_number)));
    });
    setNotice(`${keys.size} row${keys.size === 1 ? "" : "s"} taken off the map (Greenhouse Setup is unchanged). Save the map to keep this.`);
    setSelectedRows(new Set());
  }

  // ── Phases ──────────────────────────────────────────────────────────────────
  function addPhase(group: SetupGroup) {
    if (!draft) return;
    const w = Math.max(1, Math.round(draft.east_west_feet / 4));
    const h = Math.max(1, Math.round(draft.north_south_feet / 4));
    edit((m) => {
      m.phases.push({ group_id: group.id, x_feet_from_west: 0, y_feet_from_north: 0, east_west_feet: w, north_south_feet: h, sort_order: m.phases.length + 1, rows: [] });
    });
    setSelectedPhase(group.id);
  }
  function setPhaseField(field: "x_feet_from_west" | "y_feet_from_north" | "east_west_feet" | "north_south_feet", value: string) {
    if (!phase) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    edit((m) => {
      const p = m.phases.find((x) => x.group_id === phase.group_id)!;
      p[field] = v;
    });
  }
  function removePhase() {
    if (!phase) return;
    if (phase.rows.length && !window.confirm(`Take ${groupName(phase.group_id)} and its ${phase.rows.length} rows off the map? Greenhouse Setup and plans are not changed.`)) return;
    edit((m) => {
      m.phases = m.phases.filter((p) => p.group_id !== phase.group_id);
    });
    setSelectedPhase(null);
  }

  // ── Save / delete ───────────────────────────────────────────────────────────
  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch(MAP_URL, { method: "PUT", body: JSON.stringify({ map: draft, expected_updated_at: loaded?.map?.updated_at ?? null }) });
      if (!response.ok) {
        setError(await errorBody(response, "Failed to save the map"));
        return;
      }
      await load();
      setNotice("Map saved. The Crop Planner uses it now.");
    } finally {
      setSaving(false);
    }
  }
  function discard() {
    if (dirty && !window.confirm("Discard your unsaved map changes?")) return;
    setDraft(loaded?.map ? structuredClone(loaded.map) : null);
    setDirty(false);
    setError(null);
  }
  async function deleteMap() {
    if (!loaded?.map || !window.confirm("Delete the greenhouse map? The Crop Planner goes back to rows by phase. Greenhouse Setup and plans are not changed.")) return;
    const response = await apiFetch(MAP_URL, { method: "DELETE" });
    if (!response.ok) {
      setError(await errorBody(response, "Failed to delete the map"));
      return;
    }
    await load();
    setNotice("Map deleted.");
  }
  function startNewMap(e: FormEvent) {
    e.preventDefault();
    const ew = Number(newLand.ew);
    const ns = Number(newLand.ns);
    if (!newLand.name.trim() || !(ew > 0) || !(ns > 0)) return;
    setDraft({ name: newLand.name.trim(), east_west_feet: ew, north_south_feet: ns, phases: [] });
    setDirty(true);
  }

  // ── LabourLink import ───────────────────────────────────────────────────────
  async function runPreview(state: ImportState) {
    setImp({ ...state, busy: true });
    setError(null);
    const response = await apiFetch(`${MAP_URL}/import/preview`, {
      method: "POST",
      body: JSON.stringify({ layout: state.layout, land_name: state.landName, phase_matches: state.phaseMatches, row_resolutions: state.rowResolutions })
    });
    if (!response.ok) {
      setError(await errorBody(response, "Failed to read the layout file"));
      setImp({ ...state, busy: false });
      return;
    }
    const body = (await response.json()) as { report: ImportReport; map: GreenhouseMap | null };
    setImp({ ...state, report: body.report, map: body.map, busy: false, landName: state.landName ?? body.report.land?.name ?? null });
  }
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let layout: unknown;
    try {
      layout = JSON.parse(await file.text());
    } catch {
      setError({ message: `${file.name} isn't a JSON layout file.`, problems: [] });
      return;
    }
    await runPreview({ fileName: file.name, layout, landName: null, phaseMatches: {}, rowResolutions: {}, report: null, map: null, busy: false });
  }
  async function confirmImport() {
    if (!imp?.report?.ready) return;
    const replacing = loaded?.map ? ` This replaces the current map "${loaded.map.name}".` : "";
    if (!window.confirm(`Import ${fmt(imp.report.matched_rows + imp.report.resolved_rows)} rows in ${imp.map?.phases.length ?? 0} phases from ${imp.fileName}?${replacing} Greenhouse Setup and plans are not changed.`)) return;
    setImp({ ...imp, busy: true });
    const response = await apiFetch(`${MAP_URL}/import`, {
      method: "POST",
      body: JSON.stringify({
        layout: imp.layout, land_name: imp.landName, phase_matches: imp.phaseMatches, row_resolutions: imp.rowResolutions,
        expected_updated_at: loaded?.map?.updated_at ?? null
      })
    });
    if (!response.ok) {
      setError(await errorBody(response, "Failed to import the layout"));
      setImp({ ...imp, busy: false });
      return;
    }
    setImp(null);
    await load();
    setNotice("LabourLink layout imported. The Crop Planner uses this map now.");
  }
  function downloadReport() {
    if (!imp?.report) return;
    const r = imp.report;
    const lines = [
      ["Section", "LabourLink phase", "LabourLink row", "Status", "GrowLink group", "GrowLink row", "Detail"].join(","),
      ...r.phases.map((p) => ["Phase", p.source_name, "", p.status, p.group_name ?? "", "", `${p.matched_rows} of ${p.source_rows} rows matched${p.reason ? `; ${p.reason}` : ""}`].map(csvCell).join(",")),
      ...r.row_issues.map((i) => ["Row", i.phase, i.row_number, i.status, r.phases.find((p) => p.source_name === i.phase)?.group_name ?? "", i.resolved_row_number ?? "", i.reason].map(csvCell).join(",")),
      ...r.setup_rows_not_on_map.map((g) => ["Not on map", "", "", "GrowLink only", g.group_name, g.row_numbers.join(" "), "Greenhouse Setup rows with no LabourLink position"].map(csvCell).join(",")),
      ...r.groups_not_on_map.map((g) => ["Not on map", "", "", "GrowLink only", g.group_name, "", `${g.rows} rows; group not in the layout`].map(csvCell).join(","))
    ];
    downloadBlobFile(new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" }), "labourlink-map-match-report.csv");
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const selectedKeysForCanvas = selectedRows;
  const builderAppearance = (groupId: string, row: MapRow) => ({
    className: "builder",
    title: `${groupName(groupId)} row ${row.row_number}\n${row.width_ft} ft × ${row.length_ft} ft, ${row.orientation}`
  });

  return (
    <section className="page-shell crop-planner-page gh-map-builder">
      <header>
        <h1>Greenhouse map</h1>
        <p>
          Draw your greenhouse from the phases and rows in Greenhouse Setup, so the Crop Planner can select rows by clicking them.
          The map is a drawing only: it never adds or changes Greenhouse Setup rows, what is growing today, or any plan.
        </p>
      </header>

      {error ? (
        <div className="form-error" role="alert">
          <p>{error.message}</p>
          {error.problems.length ? <ul>{error.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
        </div>
      ) : null}
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      {!loaded ? <p>Loading...</p> : null}

      {loaded && !imp ? (
        <div className="crop-plan-toolbar">
          <label className="gh-map-file">
            Import from LabourLink…
            <input type="file" accept="application/json,.json" aria-label="LabourLink layout file" onChange={(e) => void onFile(e)} />
          </label>
          {draft ? (
            <>
              <button type="button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save map"}</button>
              <button type="button" className="secondary" disabled={!dirty} onClick={discard}>Discard changes</button>
              {loaded.map ? <button type="button" className="danger" onClick={() => void deleteMap()}>Delete map</button> : null}
              {dirty ? <span className="crop-plan-flag">Unsaved changes</span> : null}
            </>
          ) : null}
        </div>
      ) : null}

      {imp ? <ImportPanel imp={imp} setup={setup} onChange={(next) => void runPreview(next)} onCancel={() => setImp(null)} onImport={() => void confirmImport()} onDownload={downloadReport} /> : null}

      {loaded && !draft && !imp ? (
        <div className="coming-soon-card">
          <h2>No map yet</h2>
          {groupsWithRows.length === 0 ? <p>Add phases and rows in Greenhouse Setup first; the map is built from them.</p> : null}
          <p>Start with the size of your land, then place each phase and its rows. Or import a LabourLink layout file.</p>
          <form className="varieties-form gh-map-new" onSubmit={startNewMap}>
            <label>Map name<input value={newLand.name} onChange={(e) => setNewLand((f) => ({ ...f, name: e.target.value }))} required /></label>
            <label>East–west (ft)<input type="number" min="1" step="any" value={newLand.ew} onChange={(e) => setNewLand((f) => ({ ...f, ew: e.target.value }))} required /></label>
            <label>North–south (ft)<input type="number" min="1" step="any" value={newLand.ns} onChange={(e) => setNewLand((f) => ({ ...f, ns: e.target.value }))} required /></label>
            <div className="form-actions"><button type="submit">Start map</button></div>
          </form>
        </div>
      ) : null}

      {draft && !imp ? (
        <div className="crop-plan-layout">
          <div className="coming-soon-card crop-plan-map">
            <GreenhouseMapCanvas
              map={draft}
              ariaLabel={`${draft.name} map`}
              groupName={groupName}
              rowAppearance={builderAppearance}
              selectedKeys={selectedKeysForCanvas}
              selectedPhaseId={selectedPhase}
              onRowClick={(g, n, { shiftKey }) => clickRow(g, n, shiftKey)}
              onPhaseClick={(g) => setSelectedPhase(g)}
              onPhaseMove={movePhases ? (g, x, y) => edit((m) => {
                const p = m.phases.find((q) => q.group_id === g)!;
                p.x_feet_from_west = x;
                p.y_feet_from_north = y;
              }) : undefined}
              snapFeet={snap}
              preview={phase && rowPreview && rowPreview.rows.length ? { groupId: phase.group_id, rows: rowPreview.rows, valid: rowPreview.errors.length === 0 } : null}
              toolbar={
                <>
                  <label className="gh-map-toggle"><input type="checkbox" checked={movePhases} onChange={(e) => setMovePhases(e.target.checked)} /> Drag phases</label>
                  <label className="gh-map-toggle">Snap
                    <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
                      {[0, 1, 5, 10].map((s) => <option key={s} value={s}>{s ? `${s} ft` : "off"}</option>)}
                    </select>
                  </label>
                </>
              }
            />
            {selectedRows.size ? (
              <div className="form-actions">
                <span>{selectedRows.size} row{selectedRows.size === 1 ? "" : "s"} selected</span>
                <button type="button" className="secondary" onClick={removeSelectedRows}>Take off the map</button>
                <button type="button" className="secondary" onClick={() => setSelectedRows(new Set())}>Clear selection</button>
              </div>
            ) : null}
          </div>

          <aside className="coming-soon-card crop-plan-panel" aria-label="Map builder">
            <h2>Land</h2>
            <div className="gh-map-fields">
              <label>Name<input value={draft.name} onChange={(e) => edit((m) => { m.name = e.target.value; })} /></label>
              <label>East–west (ft)<input type="number" min="1" step="any" value={draft.east_west_feet} onChange={(e) => Number(e.target.value) > 0 && edit((m) => { m.east_west_feet = Number(e.target.value); })} /></label>
              <label>North–south (ft)<input type="number" min="1" step="any" value={draft.north_south_feet} onChange={(e) => Number(e.target.value) > 0 && edit((m) => { m.north_south_feet = Number(e.target.value); })} /></label>
            </div>

            <h2>Phases</h2>
            <ul className="gh-map-phase-list">
              {groupsWithRows.map((g) => {
                const onMap = draft.phases.find((p) => p.group_id === g.id);
                const total = setupRowsByGroup.get(g.id)?.length ?? 0;
                return (
                  <li key={g.id} className={selectedPhase === g.id ? "active" : ""}>
                    <span><strong>{g.name}</strong> <span className="form-hint">{g.type} · {onMap ? `${fmt(onMap.rows.length)} of ${fmt(total)} rows placed` : `${fmt(total)} rows, not on the map`}</span></span>
                    {onMap ? <button type="button" onClick={() => setSelectedPhase(g.id)}>Edit</button> : <button type="button" onClick={() => addPhase(g)}>Add to map</button>}
                  </li>
                );
              })}
            </ul>

            {phase ? (
              <>
                <h3>{groupName(phase.group_id)}</h3>
                <div className="gh-map-fields">
                  <label>From west (ft)<input type="number" min="0" step="any" value={phase.x_feet_from_west} onChange={(e) => setPhaseField("x_feet_from_west", e.target.value)} /></label>
                  <label>From north (ft)<input type="number" min="0" step="any" value={phase.y_feet_from_north} onChange={(e) => setPhaseField("y_feet_from_north", e.target.value)} /></label>
                  <label>East–west (ft)<input type="number" min="1" step="any" value={phase.east_west_feet} onChange={(e) => setPhaseField("east_west_feet", e.target.value)} /></label>
                  <label>North–south (ft)<input type="number" min="1" step="any" value={phase.north_south_feet} onChange={(e) => setPhaseField("north_south_feet", e.target.value)} /></label>
                </div>
                <button type="button" className="secondary" onClick={removePhase}>Take phase off the map</button>

                <h3>Place rows</h3>
                <p className="form-hint">
                  As in LabourLink: rows stack outward from the start side, each row's length runs from the anchor side.
                  Only row numbers in Greenhouse Setup are placed. Placing a row that's already on the map moves it.
                </p>
                <form className="gh-map-fields" onSubmit={placeRows} aria-label="Place rows">
                  <label>Start side
                    <select value={rowForm.startSide} onChange={(e) => {
                      const s = e.target.value as Side;
                      setRowForm((f) => ({ ...f, startSide: s, anchorSide: sidesArePerpendicular(s, f.anchorSide) ? f.anchorSide : s === "north" || s === "south" ? "west" : "north" }));
                    }}>
                      {SIDES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
                    </select>
                  </label>
                  <label>Anchor side
                    <select value={rowForm.anchorSide} onChange={(e) => setRowForm((f) => ({ ...f, anchorSide: e.target.value as Side }))}>
                      {SIDES.filter((s) => sidesArePerpendicular(rowForm.startSide, s)).map((s) => <option key={s} value={s}>{cap(s)}</option>)}
                    </select>
                  </label>
                  <label>Row width (ft)<input type="number" min="0" step="any" value={rowForm.rowWidthFt} onChange={(e) => setRowForm((f) => ({ ...f, rowWidthFt: e.target.value }))} /></label>
                  <label>Row length (ft)<input type="number" min="0" step="any" value={rowForm.rowLengthFt} onChange={(e) => setRowForm((f) => ({ ...f, rowLengthFt: e.target.value }))} /></label>
                  <label>Gap between rows (ft)<input type="number" min="0" step="any" value={rowForm.rowGapFt} onChange={(e) => setRowForm((f) => ({ ...f, rowGapFt: e.target.value }))} /></label>
                  <label>Start-side offset (ft)<input type="number" min="0" step="any" value={rowForm.startOffsetFt} onChange={(e) => setRowForm((f) => ({ ...f, startOffsetFt: e.target.value }))} /></label>
                  <label>Anchor-side offset (ft)<input type="number" min="0" step="any" value={rowForm.anchorOffsetFt} onChange={(e) => setRowForm((f) => ({ ...f, anchorOffsetFt: e.target.value }))} /></label>
                  <label>Numbering
                    <select value={rowForm.numberingMode} onChange={(e) => setRowForm((f) => ({ ...f, numberingMode: e.target.value as NumberingMode }))}>
                      <option value="all">All rows</option><option value="odd">Odd only</option><option value="even">Even only</option>
                    </select>
                  </label>
                  <label>From row<input type="number" min="1" step="1" value={rowForm.from} onChange={(e) => setRowForm((f) => ({ ...f, from: e.target.value }))} /></label>
                  <label>To row<input type="number" min="1" step="1" value={rowForm.to} onChange={(e) => setRowForm((f) => ({ ...f, to: e.target.value }))} /></label>
                  <label className="gh-map-toggle"><input type="checkbox" checked={rowForm.continueAfter} onChange={(e) => setRowForm((f) => ({ ...f, continueAfter: e.target.checked }))} /> Start after rows already placed from this side</label>
                  {rowPreview ? (
                    <div className="gh-map-preview-note">
                      {rowPreview.errors.length ? (
                        <ul className="crop-plan-flag">{rowPreview.errors.map((m) => <li key={m}>{m}</li>)}</ul>
                      ) : (
                        <p className="form-hint">
                          {fmt(rowPreview.rows.length)} row{rowPreview.rows.length === 1 ? "" : "s"} shown in blue
                          {rowPreview.moving ? `, ${rowPreview.moving} of them already on the map (they move)` : ""}.
                        </p>
                      )}
                      {rowPreview.missing ? <p className="form-hint">{rowPreview.missing} number{rowPreview.missing === 1 ? "" : "s"} in that range {rowPreview.missing === 1 ? "isn't" : "aren't"} in Greenhouse Setup and {rowPreview.missing === 1 ? "is" : "are"} skipped.</p> : null}
                    </div>
                  ) : null}
                  <div className="form-actions">
                    <button type="submit" disabled={!rowPreview || rowPreview.errors.length > 0 || rowPreview.rows.length === 0}>Place rows</button>
                  </div>
                </form>
                <UnplacedRows numbers={setupRowsByGroup.get(phase.group_id) ?? []} placed={phase.rows} />
              </>
            ) : (
              <p className="form-hint">Select a phase to place it and its rows.</p>
            )}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function csvCell(v: unknown) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ranges(nums: number[]) {
  const out: string[] = [];
  const sorted = [...nums].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return out.join(", ");
}

function UnplacedRows({ numbers, placed }: { numbers: number[]; placed: MapRow[] }) {
  const on = new Set(placed.map((r) => r.row_number));
  const off = numbers.filter((n) => !on.has(n));
  if (!off.length) return <p className="form-hint">Every Greenhouse Setup row of this phase is on the map.</p>;
  return <p className="form-hint">Not on the map yet: row{off.length === 1 ? "" : "s"} {ranges(off)}.</p>;
}

// ── Import: the recreated map and the match report ────────────────────────────

type LayoutFile = { lands?: Array<{ name: string; eastWestFeet: number; northSouthFeet: number; phases: Array<{ name: string; xFeetFromWest: number; yFeetFromNorth: number; eastWestFeet: number; northSouthFeet: number; rows: Array<{ rowNumber: number; xFt: number; yFt: number; widthFt: number; lengthFt: number; orientation: "horizontal" | "vertical" }> }> }> };

function ImportPanel({
  imp,
  setup,
  onChange,
  onCancel,
  onImport,
  onDownload
}: {
  imp: ImportState;
  setup: { groups: SetupGroup[]; rows: SetupRow[] };
  onChange: (next: ImportState) => void;
  onCancel: () => void;
  onImport: () => void;
  onDownload: () => void;
}) {
  const report = imp.report;
  const land = (imp.layout as LayoutFile).lands?.find((l) => l.name === (imp.landName ?? report?.land?.name));
  // The whole LabourLink layout as drawn there, each row coloured by its match.
  const issueByKey = useMemo(() => new Map((report?.row_issues ?? []).map((i) => [i.key, i])), [report]);
  const phaseStatus = useMemo(() => new Map((report?.phases ?? []).map((p) => [p.source_name, p])), [report]);
  const recreated = useMemo(() => {
    if (!land) return null;
    return {
      east_west_feet: land.eastWestFeet,
      north_south_feet: land.northSouthFeet,
      phases: land.phases.map((p, i) => ({
        group_id: `source-${i}`,
        x_feet_from_west: p.xFeetFromWest,
        y_feet_from_north: p.yFeetFromNorth,
        east_west_feet: p.eastWestFeet,
        north_south_feet: p.northSouthFeet,
        sort_order: i,
        rows: p.rows.map((r) => ({ row_number: r.rowNumber, x_ft: r.xFt, y_ft: r.yFt, width_ft: r.widthFt, length_ft: r.lengthFt, orientation: r.orientation }))
      }))
    };
  }, [land]);
  const sourceName = (id: string) => land?.phases[Number(id.replace("source-", ""))]?.name ?? "";

  const issueGroups = useMemo(() => {
    const byPhaseUnmatched = new Map<string, number>();
    const individual = [];
    for (const i of report?.row_issues ?? []) {
      if (i.reason === "Its phase isn't matched yet.") byPhaseUnmatched.set(i.phase, (byPhaseUnmatched.get(i.phase) ?? 0) + 1);
      else individual.push(i);
    }
    return { byPhaseUnmatched, individual };
  }, [report]);

  const groupOptions = setup.groups.filter((g) => setup.rows.some((r) => r.group_id === g.id));

  return (
    <div className="coming-soon-card gh-map-import" aria-label="LabourLink import">
      <h2>Import from LabourLink · {imp.fileName}</h2>
      <p className="form-hint">
        Each LabourLink row is matched to a Greenhouse Setup row by phase name and row number, only where that match is unique.
        Anything else is listed below for you to resolve. Nothing is guessed and no Greenhouse Setup rows are created.
        Only layout geometry is read from the file. Nothing is saved until you import.
      </p>
      {report && report.lands.length > 1 ? (
        <label>Land
          <select value={imp.landName ?? ""} onChange={(e) => onChange({ ...imp, landName: e.target.value || null, phaseMatches: {}, rowResolutions: {} })}>
            <option value="">Choose…</option>
            {report.lands.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      ) : null}

      {report?.land ? (
        <>
          <p className={report.ready ? "form-success" : "crop-plan-incomplete-banner"} role="status">
            {report.ready
              ? `Ready: ${fmt(report.matched_rows)} rows matched${report.resolved_rows ? `, ${fmt(report.resolved_rows)} resolved by you` : ""}${report.skipped_rows ? `, ${fmt(report.skipped_rows)} left off` : ""}.`
              : `${fmt(report.unresolved)} item${report.unresolved === 1 ? "" : "s"} to resolve before importing. ${fmt(report.matched_rows)} rows matched so far.`}
          </p>
          <div className="crop-plan-layout">
            <div className="crop-plan-map">
              {recreated ? (
                <GreenhouseMapCanvas
                  map={recreated}
                  ariaLabel={`Recreated ${report.land.name} map`}
                  groupName={sourceName}
                  rowAppearance={(groupId, row) => {
                    const phase = sourceName(groupId);
                    const issue = issueByKey.get(`${phase}#${row.row_number}`);
                    const p = phaseStatus.get(phase);
                    const status = issue?.status ?? (p?.status === "skipped" ? "skipped" : "matched");
                    const target = issue?.resolved_row_number ?? row.row_number;
                    return {
                      className: `import-${status}`,
                      title: `LabourLink ${phase} row ${row.row_number}: ${
                        status === "matched" || status === "resolved" ? `→ ${p?.group_name} row ${target}` : issue?.reason ?? status
                      }`
                    };
                  }}
                />
              ) : null}
              <div className="crop-plan-legend">
                <span><i className="import-matched" /> Matched</span>
                <span><i className="import-resolved" /> Resolved by you</span>
                <span><i className="import-unmatched" /> Unmatched or ambiguous</span>
                <span><i className="import-skipped" /> Left off</span>
              </div>
            </div>
            <aside className="crop-plan-panel">
              <h3>Phases</h3>
              <table className="varieties-table" aria-label="Phase matches">
                <thead><tr><th>LabourLink</th><th>GrowLink group</th><th>Rows</th></tr></thead>
                <tbody>
                  {report.phases.map((p) => (
                    <tr key={p.source_name}>
                      <td>{p.source_name}<div className="form-hint">{p.status}{p.reason ? ` · ${p.reason}` : ""}</div></td>
                      <td>
                        <select
                          aria-label={`GrowLink group for ${p.source_name}`}
                          value={imp.phaseMatches[p.source_name] ?? (p.status === "matched" ? p.group_id ?? "" : "")}
                          onChange={(e) => {
                            const next = { ...imp.phaseMatches };
                            if (e.target.value) next[p.source_name] = e.target.value;
                            else delete next[p.source_name];
                            onChange({ ...imp, phaseMatches: next });
                          }}
                        >
                          <option value="">{p.status === "matched" ? "(matched by name)" : "Choose…"}</option>
                          {groupOptions.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.type})</option>)}
                          <option value="skip">Leave off the map</option>
                        </select>
                      </td>
                      <td>{fmt(p.matched_rows)} / {fmt(p.source_rows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3>Rows to resolve</h3>
              {issueGroups.byPhaseUnmatched.size === 0 && issueGroups.individual.length === 0 ? <p className="form-hint">None.</p> : null}
              {Array.from(issueGroups.byPhaseUnmatched.entries()).map(([phase, n]) => (
                <p key={phase} className="crop-plan-flag">{fmt(n)} rows of {phase} wait for its phase to be matched.</p>
              ))}
              {issueGroups.individual.length ? (
                <table className="varieties-table" aria-label="Row issues">
                  <thead><tr><th>Row</th><th>Issue</th><th>Use</th></tr></thead>
                  <tbody>
                    {issueGroups.individual.slice(0, 300).map((i) => (
                      <tr key={i.key}>
                        <td>{i.phase} {i.row_number}</td>
                        <td>{i.status}<div className="form-hint">{i.reason}</div></td>
                        <td>
                          <select
                            aria-label={`Resolve ${i.phase} row ${i.row_number}`}
                            value={String(imp.rowResolutions[i.key] ?? "")}
                            onChange={(e) => {
                              const next = { ...imp.rowResolutions };
                              if (e.target.value === "") delete next[i.key];
                              else next[i.key] = e.target.value === "skip" ? "skip" : Number(e.target.value);
                              onChange({ ...imp, rowResolutions: next });
                            }}
                          >
                            <option value="">Choose…</option>
                            {i.resolved_row_number !== null ? <option value={i.resolved_row_number}>Row {i.resolved_row_number}</option> : null}
                            {(i.available_row_numbers ?? []).map((n) => <option key={n} value={n}>Row {n}</option>)}
                            <option value="skip">Leave off the map</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {issueGroups.individual.length > 300 ? <p className="form-hint">Showing 300 of {fmt(issueGroups.individual.length)}. Download the report for all of them.</p> : null}

              <h3>In GrowLink but not on this map</h3>
              {report.setup_rows_not_on_map.length === 0 && report.groups_not_on_map.length === 0 ? <p className="form-hint">Nothing: every Greenhouse Setup row has a place.</p> : null}
              <ul>
                {report.setup_rows_not_on_map.map((g) => <li key={g.group_id}>{g.group_name} row{g.row_numbers.length === 1 ? "" : "s"} {ranges(g.row_numbers)}</li>)}
                {report.groups_not_on_map.map((g) => <li key={g.group_id}>{g.group_name} ({fmt(g.rows)} rows) — not in the layout</li>)}
              </ul>
              <p className="form-hint">These stay selectable in the Crop Planner under the map. They can be placed in the builder after importing.</p>
              {report.geometry_problems.length ? (
                <>
                  <h3>Layout problems</h3>
                  <ul className="crop-plan-flag">{report.geometry_problems.map((p) => <li key={p}>{p}</li>)}</ul>
                </>
              ) : null}
            </aside>
          </div>
        </>
      ) : null}
      <div className="form-actions">
        <button type="button" disabled={!report?.ready || imp.busy} onClick={onImport}>Import this map</button>
        <button type="button" className="secondary" disabled={!report} onClick={onDownload}>Download match report (CSV)</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
