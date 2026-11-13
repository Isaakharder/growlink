import { FormEvent, useMemo, useState } from "react";
import { ModalOverlay } from "../ModalOverlay";
import { mapRowKey } from "../greenhouseMap/GreenhouseMapCanvas";
import { compressRows, rowEnd, type PlantingRowRef, type PlantsGreenhouse, type RowRef } from "../../lib/plants/plantingCards";
import { formatDate, type RowConflict } from "./LinkRowsDialog";

// One planting's own editor (preview): its dates, and partial pull-out, so
// some rows can end early while the planting and its other rows carry on.
// Every change here applies to this planting only. It opens from the card's
// Edit planting, or from a Link rows conflict ("Open Cadalora"), on top of
// the Link rows window, with the conflicting rows already selected.

export type EditorResult = { ok: true } | { ok: false; message: string; conflicts?: RowConflict[] };

type Props = {
  planting: { id: string; varietyName: string; planting_date: string; pull_out_date: string | null; rows: PlantingRowRef[] };
  greenhouse: PlantsGreenhouse;
  /** Rows to start selected (the rows in conflict, when opened from Link rows). */
  focusRows?: RowRef[];
  /** Suggested date for ending the selected rows (the day before the other planting starts). */
  suggestedEndDate?: string;
  openedFrom?: string;
  onSaveDates: (dates: { planting_date: string; pull_out_date: string | null }) => Promise<EditorResult>;
  onSetRowsPullOut: (rows: RowRef[], pullOutDate: string | null) => Promise<EditorResult>;
  onDelete?: () => void;
  onClose: () => void;
};

const key = (r: RowRef) => mapRowKey(r.group_id, r.row_number);
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function PlantingEditor({ planting, greenhouse, focusRows, suggestedEndDate, openedFrom, onSaveDates, onSetRowsPullOut, onDelete, onClose }: Props) {
  const [dates, setDates] = useState({ planting_date: planting.planting_date, pull_out_date: planting.pull_out_date ?? "" });
  const [selected, setSelected] = useState<Set<string>>(() => new Set((focusRows ?? []).map(key)));
  const [endDate, setEndDate] = useState(suggestedEndDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<RowConflict[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const groupName = useMemo(() => new Map(greenhouse.groups.map((g) => [g.id, g.name])), [greenhouse.groups]);
  const byGroup = useMemo(() => {
    const m = new Map<string, PlantingRowRef[]>();
    for (const r of planting.rows) m.set(r.group_id, [...(m.get(r.group_id) ?? []), r]);
    for (const list of m.values()) list.sort((a, b) => a.row_number - b.row_number);
    return [...m].sort(([a], [b]) => (groupName.get(a) ?? "").localeCompare(groupName.get(b) ?? ""));
  }, [planting.rows, groupName]);
  const rowByKey = useMemo(() => new Map(planting.rows.map((r) => [key(r), r])), [planting.rows]);
  const selectedRows = [...selected].map((k) => rowByKey.get(k)).filter((r): r is PlantingRowRef => Boolean(r));
  const selectedEnded = selectedRows.filter((r) => r.pull_out_date);
  const describe = (refs: RowRef[]) => {
    const m = new Map<string, number[]>();
    for (const r of refs) m.set(r.group_id, [...(m.get(r.group_id) ?? []), r.row_number]);
    return [...m].map(([g, nums]) => `${groupName.get(g) ?? "Phase"} row${nums.length === 1 ? "" : "s"} ${compressRows(nums)}`).join("; ");
  };

  function report(result: EditorResult, done: string) {
    if (result.ok) {
      setError(null);
      setConflicts([]);
      setNotice(done);
    } else {
      setNotice(null);
      setError(result.message);
      setConflicts(result.conflicts ?? []);
    }
  }

  async function saveDates(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await onSaveDates({ planting_date: dates.planting_date, pull_out_date: dates.pull_out_date || null });
    setBusy(false);
    report(result, `Dates saved: ${formatDate(dates.planting_date)} – ${dates.pull_out_date ? formatDate(dates.pull_out_date) : "no pull-out date"}.`);
  }

  async function endSelected() {
    if (!endDate || !selectedRows.length) return;
    setBusy(true);
    const rows = selectedRows.map(({ group_id, row_number }) => ({ group_id, row_number }));
    const result = await onSetRowsPullOut(rows, endDate);
    setBusy(false);
    report(result, `${describe(rows)} now end${rows.length === 1 ? "s" : ""} ${formatDate(endDate)}. The planting and its other rows carry on.`);
  }

  async function keepSelected() {
    setBusy(true);
    const rows = selectedEnded.map(({ group_id, row_number }) => ({ group_id, row_number }));
    const result = await onSetRowsPullOut(rows, null);
    setBusy(false);
    report(result, `${describe(rows)} now run to the planting's pull-out date.`);
  }

  function toggle(r: RowRef) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key(r))) next.delete(key(r));
      else next.add(key(r));
      return next;
    });
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="variety-modal plants-editor-modal" titleId="plants-editor-title" trapFocus>
      <h2 id="plants-editor-title">Edit planting · {planting.varietyName}</h2>
      <p className="plants-muted">
        Planted {formatDate(planting.planting_date)} · {planting.pull_out_date ? `pull-out ${formatDate(planting.pull_out_date)}` : "no pull-out date"} ·{" "}
        {plural(planting.rows.length, "row")}
      </p>
      {openedFrom ? <p className="form-hint">Opened from Link rows for {openedFrom}. Changes here apply to {planting.varietyName} only.</p> : null}

      <form className="plants-editor-dates" onSubmit={saveDates} aria-label="Planting dates">
        <label>Planting date<input type="date" value={dates.planting_date} onChange={(e) => setDates((d) => ({ ...d, planting_date: e.target.value }))} required /></label>
        <label>Pull-out date (optional)<input type="date" value={dates.pull_out_date} min={dates.planting_date || undefined} onChange={(e) => setDates((d) => ({ ...d, pull_out_date: e.target.value }))} /></label>
        <button type="submit" disabled={busy}>Save dates</button>
      </form>

      <section className="plants-editor-rows" aria-label="Rows of this planting">
        <h3>Rows</h3>
        <p className="form-hint">Select rows to end them early (partial pull-out). The planting and its other rows carry on.</p>
        {planting.rows.length === 0 ? <p className="plants-muted">No rows linked yet. Use Link rows on the card.</p> : null}
        {byGroup.map(([g, rows]) => (
          <div key={g} className="crop-plan-group">
            <div className="crop-plan-group-head"><strong>{groupName.get(g) ?? "Phase"}</strong></div>
            <div className="crop-plan-rows">
              {rows.map((r) => {
                const ended = r.pull_out_date && rowEnd(r.pull_out_date, planting.pull_out_date) === r.pull_out_date ? r.pull_out_date : null;
                return (
                  <button
                    key={key(r)}
                    type="button"
                    className={`crop-plan-row unassigned${selected.has(key(r)) ? " selected" : ""}${ended ? " ended" : ""}`}
                    aria-pressed={selected.has(key(r))}
                    aria-label={`${groupName.get(g) ?? "Phase"} row ${r.row_number}${ended ? `, ends ${formatDate(ended)}` : ""}`}
                    title={ended ? `Ends ${formatDate(ended)}` : "Runs to the planting's pull-out date"}
                    onClick={() => toggle(r)}
                  >
                    {r.row_number}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {planting.rows.length ? (
          <div className="plants-editor-end">
            <span><strong>{plural(selectedRows.length, "row")} selected</strong>{selectedRows.length ? ` · ${describe(selectedRows)}` : ""}</span>
            <label>End on<input type="date" value={endDate} min={planting.planting_date} max={planting.pull_out_date ?? undefined} onChange={(e) => setEndDate(e.target.value)} /></label>
            <button type="button" disabled={busy || !selectedRows.length || !endDate} onClick={() => void endSelected()}>
              End {plural(selectedRows.length, "row")}{endDate ? ` on ${formatDate(endDate)}` : ""}
            </button>
            {selectedEnded.length ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void keepSelected()}>
                Keep {plural(selectedEnded.length, "ended row")} to the planting's end
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={() => setSelected(new Set(planting.rows.map(key)))}>Select all rows</button>
            <button type="button" className="secondary" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        ) : null}
      </section>

      {notice ? <p className="plants-link-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {conflicts.length ? (
        <ul className="plants-issues" aria-label="Rows that need attention">
          {[...new Set(conflicts.map((c) => c.planting_id))].map((id) => {
            const list = conflicts.filter((c) => c.planting_id === id);
            return (
              <li key={id}>
                {describe(list)}: linked to {list[0].variety_name} ({formatDate(list[0].planting_date)} – {list[0].pull_out_date ? formatDate(list[0].pull_out_date) : "no pull-out date"})
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="form-actions">
        <button type="button" onClick={onClose}>{openedFrom ? "Back to Link rows" : "Done"}</button>
        {onDelete ? <button type="button" className="danger" onClick={onDelete}>Delete planting</button> : null}
      </div>
    </ModalOverlay>
  );
}
