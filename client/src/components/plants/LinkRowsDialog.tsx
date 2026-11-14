import { FormEvent, useEffect, useMemo, useState } from "react";
import { ModalOverlay } from "../ModalOverlay";
import { GreenhouseMapCanvas, mapRowKey } from "../greenhouseMap/GreenhouseMapCanvas";
import type { GreenhouseMapResponse, MapRow } from "../../lib/greenhouseMap/types";
import { compressRows, rowAreaOn, rowEnd, type PlantingRowRef, type PlantsGreenhouse, type RowRef } from "../../lib/plants/plantingCards";

// Link rows → Save rows for one dated planting (preview). Opens only when the
// person clicks Link rows. The planting's current rows start selected; rows
// are picked on the greenhouse map (click, Shift-click a range, click a phase
// name), by whole phase, by From/To rows, or from the rows listed off the map.
//
// Save rows sends the whole selection and changes only this planting. If the
// server refuses it (rows another planting occupies at an overlapping time,
// rows not in Greenhouse Setup, or any other failure), the window stays open
// and shows the exact rows and the planting they are linked to. The person can
// leave those rows out, or open that planting in its own editor (on top of
// this window, which keeps its selection) to change it there. Nothing here
// changes another planting. Cancel closes without changing anything.

export type OtherPlanting = {
  id: string;
  varietyName: string;
  planting_date: string;
  pull_out_date: string | null;
  rows: PlantingRowRef[];
};

export type RowConflict = RowRef & {
  planting_id: string;
  variety_name: string;
  planting_date: string;
  pull_out_date: string | null;
  /** The other planting's own pull-out date for this row, if it ends early. */
  row_pull_out_date?: string | null;
};

export type SaveRowsResult =
  | { ok: true }
  | { ok: false; message: string; conflicts?: RowConflict[]; rowsNotInSetup?: RowRef[] };

type Props = {
  planting: { id: string; varietyName: string; planting_date: string; pull_out_date: string | null; rows: RowRef[] };
  greenhouse: PlantsGreenhouse;
  others: OtherPlanting[];
  map: GreenhouseMapResponse["map"];
  onSave: (rows: RowRef[]) => Promise<SaveRowsResult>;
  /** Opens another planting in its own editor, with these rows selected there. */
  onOpenPlanting: (plantingId: string, rows: RowRef[]) => void;
  /** True while another editor is open on top: Escape belongs to that editor. */
  suspended?: boolean;
  onCancel: () => void;
};

const key = (r: RowRef) => mapRowKey(r.group_id, r.row_number);
const fromKey = (k: string): RowRef => {
  const i = k.lastIndexOf(":");
  return { group_id: k.slice(0, i), row_number: Number(k.slice(i + 1)) };
};
const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
export const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
export const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const overlaps = (aStart: string, aEnd: string | null, bStart: string, bEnd: string | null) =>
  aStart <= (bEnd ?? "9999-12-31") && bStart <= (aEnd ?? "9999-12-31");
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
const span = (start: string, end: string | null) => `${formatDate(start)} – ${end ? formatDate(end) : "no pull-out date"}`;

export function LinkRowsDialog({ planting, greenhouse, others, map, onSave, onOpenPlanting, suspended = false, onCancel }: Props) {
  const [selection, setSelection] = useState<Set<string>>(() => new Set(planting.rows.map(key)));
  const [anchor, setAnchor] = useState<RowRef | null>(null);
  const [view, setView] = useState<"map" | "list">(map ? "map" : "list");
  const [range, setRange] = useState({ group: "", from: "", to: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<RowConflict[]>([]);
  const [notInSetup, setNotInSetup] = useState<RowRef[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const groupName = useMemo(() => new Map(greenhouse.groups.map((g) => [g.id, g.name])), [greenhouse.groups]);
  const setupRows = useMemo(() => new Map(greenhouse.rows.map((r) => [key(r), r])), [greenhouse.rows]);
  const rowsByGroup = useMemo(() => {
    const m = new Map<string, RowRef[]>();
    for (const r of greenhouse.rows) m.set(r.group_id, [...(m.get(r.group_id) ?? []), { group_id: r.group_id, row_number: r.row_number }]);
    for (const list of m.values()) list.sort((a, b) => a.row_number - b.row_number);
    return m;
  }, [greenhouse.rows]);

  // Rows another planting occupies at a time that overlaps this planting's dates.
  const occupiedBy = useMemo(() => {
    const m = new Map<string, OtherPlanting & { rowEnd: string | null }>();
    for (const o of others) {
      for (const r of o.rows) {
        const end = rowEnd(r.pull_out_date, o.pull_out_date);
        if (overlaps(planting.planting_date, planting.pull_out_date, o.planting_date, end)) m.set(key(r), { ...o, rowEnd: end });
      }
    }
    return m;
  }, [others, planting.planting_date, planting.pull_out_date]);
  const conflictKeys = useMemo(() => new Set(conflicts.map(key)), [conflicts]);

  // After the other planting is changed in its own editor, the rows it no longer
  // holds at an overlapping time stop being conflicts. The selection is kept.
  useEffect(() => {
    if (!conflicts.length) return;
    const still = conflicts.filter((c) => occupiedBy.get(key(c))?.id === c.planting_id);
    if (still.length === conflicts.length) return;
    const freed = conflicts.length - still.length;
    setConflicts(still);
    setNotice(`${freed} row${freed === 1 ? " is" : "s are"} no longer in conflict. Save rows to link ${freed === 1 ? "it" : "them"}.`);
    if (!still.length) setError(null);
    // Only when the other plantings change; conflicts are read as they are now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occupiedBy]);

  // The map, limited to Greenhouse Setup rows; Setup rows the map doesn't place are listed under it.
  const pickerMap = useMemo(() => {
    if (!map) return null;
    return { ...map, phases: map.phases.map((p) => ({ ...p, rows: p.rows.filter((r) => setupRows.has(mapRowKey(p.group_id, r.row_number))) })) };
  }, [map, setupRows]);
  const offMap = useMemo(() => {
    if (!pickerMap) return [];
    const onMap = new Set(pickerMap.phases.flatMap((p) => p.rows.map((r) => mapRowKey(p.group_id, r.row_number))));
    return greenhouse.groups
      .map((g) => ({ group: g, rows: (rowsByGroup.get(g.id) ?? []).filter((r) => !onMap.has(key(r))) }))
      .filter((g) => g.rows.length > 0);
  }, [pickerMap, greenhouse.groups, rowsByGroup]);

  const selectedRows = useMemo(
    () => [...selection].map(fromKey).sort((a, b) => (groupName.get(a.group_id) ?? "").localeCompare(groupName.get(b.group_id) ?? "") || a.row_number - b.row_number),
    [selection, groupName]
  );
  const summary = useMemo(() => {
    let m2 = 0, plants = 0, heads = 0, missingArea = 0, missingPlants = 0;
    for (const r of selectedRows) {
      const s = setupRows.get(key(r));
      // The size that applies on this planting's date (Setup → Map measurements).
      const area = s ? rowAreaOn(s, planting.planting_date).area : null;
      if (area) m2 += area; else missingArea += 1;
      const p = s && s.slab_count > 0 && s.plants_per_slab > 0 ? s.slab_count * s.plants_per_slab : null;
      if (p === null) missingPlants += 1;
      else {
        plants += p;
        heads += p * (s?.stems_per_plant ?? 0);
      }
    }
    return { rows: selectedRows.length, m2, plants, heads, missingArea, missingPlants };
  }, [selectedRows, setupRows, planting.planting_date]);
  const occupiedInSelection = selectedRows.filter((r) => occupiedBy.has(key(r)));

  const describe = (refs: RowRef[]) => {
    const byGroup = new Map<string, number[]>();
    for (const r of refs) byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r.row_number]);
    return [...byGroup].map(([g, nums]) => `${groupName.get(g) ?? "Phase"} row${nums.length === 1 ? "" : "s"} ${compressRows(nums)}`).join("; ");
  };

  function toggle(ref: RowRef, extend: boolean) {
    setNotice(null);
    setSelection((current) => {
      const next = new Set(current);
      if (extend && anchor && anchor.group_id === ref.group_id) {
        const [lo, hi] = [Math.min(anchor.row_number, ref.row_number), Math.max(anchor.row_number, ref.row_number)];
        for (const r of rowsByGroup.get(ref.group_id) ?? []) if (r.row_number >= lo && r.row_number <= hi) next.add(key(r));
      } else if (next.has(key(ref))) next.delete(key(ref));
      else next.add(key(ref));
      return next;
    });
    setAnchor(ref);
  }
  function addRows(refs: RowRef[]) {
    setNotice(null);
    setSelection((current) => new Set([...current, ...refs.map(key)]));
  }
  function removeRows(refs: RowRef[]) {
    setSelection((current) => {
      const next = new Set(current);
      for (const r of refs) next.delete(key(r));
      return next;
    });
  }
  function addRange(e: FormEvent) {
    e.preventDefault();
    const from = Number(range.from), to = Number(range.to || range.from);
    if (!range.group || !Number.isInteger(from) || !Number.isInteger(to) || from < 1) return;
    const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
    addRows((rowsByGroup.get(range.group) ?? []).filter((r) => r.row_number >= lo && r.row_number <= hi));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = await onSave(selectedRows);
    setSaving(false);
    if (result.ok) return; // the page closes the window and returns to the card
    setError(result.message);
    setConflicts(result.conflicts ?? []);
    setNotInSetup(result.rowsNotInSetup ?? []);
  }

  // Conflicts grouped by the planting that holds the rows.
  const conflictGroups = useMemo(() => {
    const m = new Map<string, { first: RowConflict; rows: RowRef[] }>();
    for (const c of conflicts) {
      const g = m.get(c.planting_id) ?? { first: c, rows: [] };
      g.rows.push(c);
      m.set(c.planting_id, g);
    }
    return [...m.values()];
  }, [conflicts]);

  async function leaveOut(rows: RowRef[]) {
    removeRows(rows);
    const drop = new Set(rows.map(key));
    setConflicts((cs) => cs.filter((c) => !drop.has(key(c))));
    setNotice(`${describe(rows)} left out. Save rows to apply.`);
    setError(null);
  }
  const appearance = (groupId: string, row: MapRow) => {
    const k = mapRowKey(groupId, row.row_number);
    const other = occupiedBy.get(k);
    const name = `${groupName.get(groupId) ?? "Phase"} row ${row.row_number}`;
    if (conflictKeys.has(k)) return { className: "conflict", title: `${name}: needs attention (${other?.varietyName ?? "another planting"})` };
    if (other) return { className: "occupied", title: `${name}: ${other.varietyName}, ${span(other.planting_date, other.rowEnd)}` };
    return { className: "unassigned", title: `${name}: free for these dates` };
  };
  const tiles = (rows: RowRef[]) =>
    rows.map((r) => {
      const k = key(r);
      const other = occupiedBy.get(k);
      const name = `${groupName.get(r.group_id) ?? "Phase"} row ${r.row_number}`;
      return (
        <button
          key={k}
          type="button"
          className={`crop-plan-row unassigned${selection.has(k) ? " selected" : ""}${other ? " occupied" : ""}${conflictKeys.has(k) ? " conflict" : ""}`}
          aria-pressed={selection.has(k)}
          aria-label={`${name}${other ? `: ${other.varietyName}, ${span(other.planting_date, other.rowEnd)}` : ""}${conflictKeys.has(k) ? ", needs attention" : ""}`}
          title={other ? `${other.varietyName}, ${span(other.planting_date, other.rowEnd)}` : "Free for these dates"}
          onClick={(e) => toggle(r, e.shiftKey)}
        >
          {r.row_number}
        </button>
      );
    });

  return (
    <ModalOverlay onClose={onCancel} contentClassName="plants-link-modal" titleId="plants-link-title" trapFocus closeOnEscape={!suspended}>
      <header className="plants-link-head">
        <h2 id="plants-link-title">Link rows · {planting.varietyName}</h2>
        <p className="plants-muted">{span(planting.planting_date, planting.pull_out_date)}</p>
      </header>

      <div className="plants-link-body">
        <div className="plants-link-picker">
          {pickerMap ? (
            <div className="crop-plan-view" role="group" aria-label="Map view">
              <button type="button" aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}>Map</button>
              <button type="button" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}>Rows by phase</button>
            </div>
          ) : null}
          <p className="form-hint">
            {view === "map" && pickerMap
              ? "Click a row to select it, Shift-click another row in the same phase for the range, or click a phase name for the whole phase."
              : "Click a row to select it, Shift-click for a range, or select a whole phase."}{" "}
            Hatched rows are planted at an overlapping time.
          </p>
          {view === "map" && pickerMap ? (
            <>
              <GreenhouseMapCanvas
                map={pickerMap}
                ariaLabel={`${pickerMap.name} map`}
                groupName={(id) => groupName.get(id) ?? "Phase"}
                rowAppearance={appearance}
                selectedKeys={selection}
                onRowClick={(g, n, { shiftKey }) => toggle({ group_id: g, row_number: n }, shiftKey)}
                onPhaseClick={(g) => addRows(rowsByGroup.get(g) ?? [])}
                rotationStorageKey={`plants.mapRotation.${pickerMap.id ?? "map"}`}
              />
              {offMap.length ? (
                <div className="crop-plan-off-map">
                  <h3>Rows not on the map</h3>
                  {offMap.map(({ group, rows }) => (
                    <section key={group.id} className="crop-plan-group" aria-label={`${group.name} rows not on the map`}>
                      <div className="crop-plan-group-head"><strong>{group.name}</strong></div>
                      <div className="crop-plan-rows">{tiles(rows)}</div>
                    </section>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            greenhouse.groups.map((g) => (
              <section key={g.id} className="crop-plan-group" aria-label={g.name}>
                <div className="crop-plan-group-head">
                  <strong>{g.name}</strong>
                  <span className="form-hint">{plural(rowsByGroup.get(g.id)?.length ?? 0, "row")}</span>
                </div>
                <div className="crop-plan-rows">{tiles(rowsByGroup.get(g.id) ?? [])}</div>
              </section>
            ))
          )}
          <div className="crop-plan-phase-buttons" role="group" aria-label="Select a whole phase">
            {greenhouse.groups.map((g) => (
              <button key={g.id} type="button" onClick={() => addRows(rowsByGroup.get(g.id) ?? [])}>
                Select {g.name} ({fmt(rowsByGroup.get(g.id)?.length ?? 0)} rows)
              </button>
            ))}
          </div>
          <form className="crop-plan-range" onSubmit={addRange} aria-label="Select rows by number">
            <label>
              Phase
              <select value={range.group} onChange={(e) => setRange((f) => ({ ...f, group: e.target.value }))}>
                <option value="">Choose…</option>
                {greenhouse.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label>From row<input type="number" min="1" value={range.from} onChange={(e) => setRange((f) => ({ ...f, from: e.target.value }))} /></label>
            <label>To row<input type="number" min="1" value={range.to} onChange={(e) => setRange((f) => ({ ...f, to: e.target.value }))} /></label>
            <button type="submit">Select rows</button>
          </form>
        </div>

        <aside className="plants-link-side" aria-label="Selection">
          <p className="crop-plan-selection-count">
            <strong>{plural(summary.rows, "row")} selected</strong>
          </p>
          <dl className="plants-link-summary">
            <div><dt>Area</dt><dd>{fmt(summary.m2, 1)} m²{summary.missingArea ? <span className="plants-missing"> + {plural(summary.missingArea, "row")} missing</span> : null}</dd></div>
            <div><dt>Plants</dt><dd>{fmt(summary.plants)}{summary.missingPlants ? <span className="plants-missing"> + {plural(summary.missingPlants, "row")} missing</span> : null}</dd></div>
            <div><dt>Heads</dt><dd>{fmt(summary.heads)}</dd></div>
          </dl>
          {selectedRows.length ? <p className="plants-link-rows">{describe(selectedRows)}</p> : null}
          {selectedRows.length ? <button type="button" className="secondary" onClick={() => setSelection(new Set())}>Clear selection</button> : null}
          {occupiedInSelection.length && !conflicts.length ? (
            <p className="plants-missing" role="note">
              {plural(occupiedInSelection.length, "selected row")} {occupiedInSelection.length === 1 ? "is" : "are"} planted at an overlapping time. Saving will ask how to resolve {occupiedInSelection.length === 1 ? "it" : "them"}.
            </p>
          ) : null}

          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p className="plants-link-notice" role="status">{notice}</p> : null}
          {conflictGroups.length ? (
            <div className="crop-plan-conflict" aria-label="Rows that need attention">
              {conflictGroups.map(({ first, rows }) => {
                const byGroup = new Map<string, number[]>();
                for (const r of rows) byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r.row_number]);
                return (
                  <section key={first.planting_id} className="plants-link-conflict" aria-label={`Linked to ${first.variety_name}`}>
                    <p>
                      Already linked to <strong>{first.variety_name}</strong>, planted {formatDate(first.planting_date)},{" "}
                      {first.pull_out_date ? `pull-out ${formatDate(first.pull_out_date)}` : "no pull-out date"}:
                    </p>
                    <ul className="plants-link-conflict-rows">
                      {[...byGroup].map(([g, nums]) => (
                        <li key={g}>
                          {groupName.get(g) ?? "Phase"}: row{nums.length === 1 ? "" : "s"} {compressRows(nums)}
                        </li>
                      ))}
                    </ul>
                    <div className="plants-link-conflict-actions">
                      <button type="button" className="secondary" disabled={saving} onClick={() => void leaveOut(rows)}>
                        Leave {rows.length === 1 ? "this row" : `these ${fmt(rows.length)} rows`} out
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label={`Open ${first.variety_name} (planted ${formatDate(first.planting_date)}) in its own editor`}
                        onClick={() => onOpenPlanting(first.planting_id, rows.map(({ group_id, row_number }) => ({ group_id, row_number })))}
                      >
                        Open {first.variety_name}
                      </button>
                    </div>
                  </section>
                );
              })}
              <p className="form-hint">Opening a planting doesn't change it; it opens on top of this window, which keeps your selection.</p>
            </div>
          ) : null}
          {notInSetup.length ? (
            <p className="form-error" role="alert">Not in Greenhouse Setup: {describe(notInSetup)}.</p>
          ) : null}

          <div className="form-actions">
            <button type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save rows"}</button>
            <button type="button" className="secondary" disabled={saving} onClick={onCancel}>Cancel</button>
          </div>
        </aside>
      </div>
    </ModalOverlay>
  );
}
