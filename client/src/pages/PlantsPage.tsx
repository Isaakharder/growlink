import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";
import { ModalOverlay } from "../components/ModalOverlay";
import { LinkRowsDialog, dayBefore, formatDate, type OtherPlanting, type RowConflict, type SaveRowsResult } from "../components/plants/LinkRowsDialog";
import { PlantingEditor, type EditorResult } from "../components/plants/PlantingEditor";
import type { GreenhouseMapResponse } from "../lib/greenhouseMap/types";
import { buildBoard, compressRows, type DatedPlantingsData, type Measure, type PlantingCard, type PlantingStatus, type RowRef } from "../lib/plants/plantingCards";

// Crop Planner → Plants (PREVIEW of the dated planting model, 0156): cards in
// Active, Upcoming and Past, each a variety on its own rows from its planting
// date to its optional pull-out date. Add planting → choose variety → set
// dates → Link rows → Save rows (this planting only). Edit planting changes one
// planting's dates or ends some of its rows early (partial pull-out). Dates are
// compared with the organization's local today. This preview never reads or
// writes Greenhouse Setup's live assignments.

const PLANTINGS_URL = "/api/crop-planner/dated-plantings";
const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

const SECTIONS: Array<{ status: PlantingStatus; title: string; empty: string }> = [
  { status: "active", title: "Active", empty: "Nothing is planted today." },
  { status: "upcoming", title: "Upcoming", empty: "No plantings scheduled after today." },
  { status: "past", title: "Past", empty: "No past plantings." }
];
const COLOR_SWATCH: Record<string, string> = { red: "#d64545", orange: "#e8862a", yellow: "#e2c12b", green: "#3f9a4f" };

type OnDate = { date: string; today: string; totals: Array<{ variety_id: string; rows: number; m2: number; plants: number; heads: number; rows_missing_inputs: number }> };
type AddForm = { cropCode: string; varietyId: string; plantingDate: string; pullOutDate: string; error?: string };
type Editing = { plantingId: string; focusRows?: RowRef[]; suggestedEndDate?: string; openedFrom?: string };

async function readJson(res: Response) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function MeasureValue({ measure, unit, digits = 0 }: { measure: Measure; unit?: string; digits?: number }) {
  return (
    <>
      {fmt(measure.value, digits)}
      {unit ? ` ${unit}` : ""}
      {measure.missingRows ? (
        <span className="plants-missing" title="Rows missing an input are not counted">
          {" "}+ {measure.missingRows} row{measure.missingRows === 1 ? "" : "s"} missing
        </span>
      ) : null}
    </>
  );
}

function PlantingCardView({ card, canEdit, highlighted, onLink, onEdit }: { card: PlantingCard; canEdit: boolean; highlighted: boolean; onLink: () => void; onEdit: () => void }) {
  const multiPhase = card.phases.length > 1;
  return (
    <article className={`plants-card${highlighted ? " plants-card--updated" : ""}`} aria-label={card.varietyName} data-planting-id={card.plantingId}>
      <header className="plants-card-head">
        <h3 tabIndex={-1}>
          {card.color && COLOR_SWATCH[card.color] ? <span className="plants-swatch" style={{ background: COLOR_SWATCH[card.color] }} aria-hidden="true" /> : null}
          {card.varietyName}
        </h3>
        {card.cropName ? <span className="plants-crop">{card.cropName}</span> : null}
      </header>
      <p className="plants-dates">
        <span>Planted {card.plantingDate ? formatDate(card.plantingDate) : <span className="plants-missing">no date</span>}</span>
        <span>Pull-out {card.pullOutDate ? formatDate(card.pullOutDate) : <span className="plants-muted">not set</span>}</span>
      </p>
      {card.phases.length === 1 ? (
        <p className="plants-rows">
          {card.phases[0].groupName} · row{card.phases[0].rowNumbers.length === 1 ? "" : "s"} {card.phases[0].rowsLabel}
        </p>
      ) : null}
      <dl className="plants-totals">
        <div><dt>Rows</dt><dd>{fmt(card.rowCount)}</dd></div>
        <div><dt>Area</dt><dd><MeasureValue measure={card.m2} unit="m²" digits={1} /></dd></div>
        <div><dt>Plants</dt><dd><MeasureValue measure={card.plants} /></dd></div>
        <div><dt>Heads</dt><dd><MeasureValue measure={card.heads} /></dd></div>
      </dl>
      {multiPhase ? (
        <table className="plants-phase-table" aria-label={`${card.varietyName} by phase`}>
          <thead>
            <tr><th scope="col">Phase</th><th scope="col">Rows</th><th scope="col">m²</th><th scope="col">Plants</th><th scope="col">Heads</th></tr>
          </thead>
          <tbody>
            {card.phases.map((line) => (
              <tr key={line.groupId}>
                <th scope="row">{line.groupName}</th>
                <td>{line.rowsLabel}</td>
                <td><MeasureValue measure={line.m2} digits={1} /></td>
                <td><MeasureValue measure={line.plants} /></td>
                <td><MeasureValue measure={line.heads} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {card.endedEarly.length ? (
        <ul className="plants-ended" aria-label="Rows pulled out early">
          {card.endedEarly.map((e) => <li key={e.date}>{e.rows} pulled out {formatDate(e.date)}</li>)}
        </ul>
      ) : null}
      {card.issues.length ? (
        <ul className="plants-issues" aria-label="Needs attention">
          {card.issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
      {canEdit ? (
        <div className="plants-card-actions">
          <button type="button" onClick={onLink}>Link rows</button>
          <button type="button" className="secondary" onClick={onEdit}>Edit planting</button>
        </div>
      ) : null}
    </article>
  );
}

export function PlantsPage() {
  const { can } = usePermissions();
  const canEdit = can("greenhouse_setup:edit");
  const [data, setData] = useState<DatedPlantingsData | null>(null);
  const [today, setToday] = useState<OnDate | null>(null);
  const [map, setMap] = useState<GreenhouseMapResponse["map"] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [addForm, setAddForm] = useState<AddForm | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, onRes] = await Promise.all([apiFetch(PLANTINGS_URL), apiFetch(`${PLANTINGS_URL}/on`)]);
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.message ?? "Failed to load plantings.");
      setData(body as DatedPlantingsData);
      const onBody = await readJson(onRes);
      if (onRes.ok) setToday(onBody as OnDate);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plantings.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const board = useMemo(() => (data ? buildBoard(data, data.plantings) : null), [data]);
  const varietyName = useMemo(() => new Map((data?.varieties ?? []).map((v) => [v.id, v.name])), [data]);

  // Back on the card after Save rows: scroll to it, focus its name, and mark it briefly.
  useEffect(() => {
    if (!highlight) return;
    const el = document.querySelector<HTMLElement>(`[data-planting-id="${highlight}"]`);
    el?.scrollIntoView?.({ block: "center" });
    el?.querySelector<HTMLElement>("h3")?.focus();
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), 2500);
  }, [highlight, board]);

  async function openLink(id: string) {
    if (map === undefined) {
      try {
        const res = await apiFetch("/api/greenhouse-map");
        const body = (await readJson(res)) as GreenhouseMapResponse | null;
        setMap(res.ok ? body?.map ?? null : null);
      } catch {
        setMap(null);
      }
    }
    setLinking(id);
  }

  async function saveRows(id: string, rows: RowRef[]): Promise<SaveRowsResult> {
    try {
      const res = await apiFetch(`${PLANTINGS_URL}/${id}/rows`, { method: "PUT", body: JSON.stringify({ rows }) });
      const body = await readJson(res);
      if (!res.ok) {
        return { ok: false, message: body?.message ?? "Saving the rows failed. Nothing was changed.", conflicts: body?.conflicts, rowsNotInSetup: body?.rowsNotInSetup };
      }
      setLinking(null);
      await load();
      setHighlight(id);
      return { ok: true };
    } catch {
      return { ok: false, message: "Saving the rows failed (no connection). Nothing was changed." };
    }
  }

  const activeCrops = (data?.products ?? []).filter((p) => p.status === "active");
  function openAdd() {
    const crop = activeCrops.find((c) => c.code === "bell_pepper")?.code ?? activeCrops[0]?.code ?? "";
    setAddForm({ cropCode: crop, varietyId: "", plantingDate: "", pullOutDate: "" });
  }
  async function submitAdd(e: FormEvent) {
    e.preventDefault();
    if (!addForm) return;
    const f = addForm;
    try {
      const res = await apiFetch(PLANTINGS_URL, {
        method: "POST",
        body: JSON.stringify({ variety_id: f.varietyId, planting_date: f.plantingDate, pull_out_date: f.pullOutDate || null })
      });
      const body = await readJson(res);
      if (!res.ok) {
        setAddForm({ ...f, error: body?.message ?? "Saving failed. Nothing was changed." });
        return;
      }
      setAddForm(null);
      await load();
      setHighlight(body.id);
    } catch {
      setAddForm({ ...f, error: "Saving failed (no connection). Nothing was changed." });
    }
  }

  // The planting editor: every call changes the edited planting only.
  async function editorCall(path: string, body: unknown): Promise<EditorResult> {
    try {
      const res = await apiFetch(path, { method: "PUT", body: JSON.stringify(body) });
      const json = await readJson(res);
      if (!res.ok) return { ok: false, message: json?.message ?? "Saving failed. Nothing was changed.", conflicts: json?.conflicts };
      await load();
      return { ok: true };
    } catch {
      return { ok: false, message: "Saving failed (no connection). Nothing was changed." };
    }
  }
  async function deleteEdited() {
    if (!editing || !window.confirm("Delete this planting and its row links? Greenhouse Setup is not changed.")) return;
    const res = await apiFetch(`${PLANTINGS_URL}/${editing.plantingId}`, { method: "DELETE" });
    if (res.ok) {
      setEditing(null);
      await load();
    }
  }

  const linkingPlanting = data?.plantings.find((p) => p.id === linking) ?? null;
  const others: OtherPlanting[] = (data?.plantings ?? [])
    .filter((p) => p.id !== linking)
    .map((p) => ({ id: p.id, varietyName: varietyName.get(p.variety_id) ?? "Unknown variety", planting_date: p.planting_date, pull_out_date: p.pull_out_date, rows: p.rows }));
  const cropVarieties = (data?.varieties ?? []).filter((v) => (v.product_code ?? "bell_pepper") === addForm?.cropCode && v.status !== "inactive");
  const editedPlanting = data?.plantings.find((p) => p.id === editing?.plantingId) ?? null;
  const todayTotals = today?.totals.reduce(
    (t, v) => ({ varieties: t.varieties + 1, rows: t.rows + v.rows, m2: t.m2 + v.m2, plants: t.plants + v.plants, heads: t.heads + v.heads, missing: t.missing + v.rows_missing_inputs }),
    { varieties: 0, rows: 0, m2: 0, plants: 0, heads: 0, missing: 0 }
  );
  return (
    <section className="page-shell plants-page">
      <header className="plants-page-head">
        <div>
          <h1>Plants</h1>
          <p>
            Each planting is a variety on its own rows, from its planting date to its pull-out date. Rows come from{" "}
            <Link to="/setup/greenhouse">Greenhouse Setup</Link>.
          </p>
        </div>
        {canEdit && data ? <button type="button" onClick={openAdd}>+ Add planting</button> : null}
      </header>
      <p className="plants-preview-banner" role="note">
        Preview of dated plantings. These plantings are kept apart from Greenhouse Setup's live variety assignments, which nothing here changes.
      </p>
      {today && todayTotals ? (
        <section className="plants-today" aria-label="In the ground today">
          <h2>In the ground today · {formatDate(today.today)}</h2>
          <p className="plants-muted">What today's live reports would count ({data?.timeZone}). Upcoming plantings aren't included.</p>
          <dl className="plants-totals">
            <div><dt>Varieties</dt><dd>{fmt(todayTotals.varieties)}</dd></div>
            <div><dt>Rows</dt><dd>{fmt(todayTotals.rows)}</dd></div>
            <div><dt>Area</dt><dd>{fmt(todayTotals.m2, 1)} m²</dd></div>
            <div><dt>Plants</dt><dd>{fmt(todayTotals.plants)}</dd></div>
            <div><dt>Heads</dt><dd>{fmt(todayTotals.heads)}</dd></div>
          </dl>
          {todayTotals.missing ? (
            <p className="plants-missing">
              {todayTotals.missing === 1 ? "1 row is" : `${fmt(todayTotals.missing)} rows are`} missing an input; the totals leave out only what's missing.
            </p>
          ) : null}
        </section>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!board && !error ? <p className="plants-muted">Loading plantings…</p> : null}
      {board
        ? SECTIONS.map(({ status, title, empty }) => {
            const cards = board[status];
            const body = cards.length ? (
              <div className="plants-grid">
                {cards.map((card) => (
                  <PlantingCardView
                    key={card.plantingId}
                    card={card}
                    canEdit={canEdit}
                    highlighted={highlight === card.plantingId}
                    onLink={() => void openLink(card.plantingId)}
                    onEdit={() => setEditing({ plantingId: card.plantingId })}
                  />
                ))}
              </div>
            ) : (
              <p className="plants-muted">{empty}</p>
            );
            return status === "past" ? (
              <details key={status} className="plants-section" aria-label={`${title} plantings`}>
                <summary><h2>{title} <span className="plants-count">({cards.length})</span></h2></summary>
                {body}
              </details>
            ) : (
              <section key={status} className="plants-section" aria-label={`${title} plantings`}>
                <h2>{title} <span className="plants-count">({cards.length})</span></h2>
                {body}
              </section>
            );
          })
        : null}

      {linkingPlanting && data ? (
        <LinkRowsDialog
          planting={{
            id: linkingPlanting.id,
            varietyName: varietyName.get(linkingPlanting.variety_id) ?? "Planting",
            planting_date: linkingPlanting.planting_date,
            pull_out_date: linkingPlanting.pull_out_date,
            rows: linkingPlanting.rows
          }}
          greenhouse={data}
          others={others}
          map={map ?? null}
          onSave={(rows) => saveRows(linkingPlanting.id, rows)}
          onOpenPlanting={(plantingId, rows) =>
            setEditing({
              plantingId,
              focusRows: rows,
              suggestedEndDate: dayBefore(linkingPlanting.planting_date),
              openedFrom: varietyName.get(linkingPlanting.variety_id) ?? "this planting"
            })
          }
          suspended={Boolean(editing)}
          onCancel={() => setLinking(null)}
        />
      ) : null}

      {editedPlanting && data && editing ? (
        <PlantingEditor
          key={editing.plantingId}
          planting={{
            id: editedPlanting.id,
            varietyName: varietyName.get(editedPlanting.variety_id) ?? "Planting",
            planting_date: editedPlanting.planting_date,
            pull_out_date: editedPlanting.pull_out_date,
            rows: editedPlanting.rows
          }}
          greenhouse={data}
          focusRows={editing.focusRows}
          suggestedEndDate={editing.suggestedEndDate}
          openedFrom={editing.openedFrom}
          onSaveDates={(dates) => editorCall(`${PLANTINGS_URL}/${editedPlanting.id}`, dates)}
          onSetRowsPullOut={(rows, pullOutDate) => editorCall(`${PLANTINGS_URL}/${editedPlanting.id}/rows/pull-out`, { rows, pull_out_date: pullOutDate })}
          onDelete={editing.openedFrom ? undefined : () => void deleteEdited()}
          onClose={() => {
            const id = editing.plantingId;
            setEditing(null);
            if (!linking) setHighlight(id);
          }}
        />
      ) : null}

      {addForm ? (
        <ModalOverlay onClose={() => setAddForm(null)} contentClassName="variety-modal" titleId="plants-add-title" trapFocus>
          <h2 id="plants-add-title">Add planting</h2>
          <form className="varieties-form" onSubmit={submitAdd}>
            <label>
              Crop
              <select value={addForm.cropCode} onChange={(e) => setAddForm({ ...addForm, cropCode: e.target.value, varietyId: "" })}>
                {activeCrops.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Variety
              <select value={addForm.varietyId} onChange={(e) => setAddForm({ ...addForm, varietyId: e.target.value })} required>
                <option value="">Choose a variety…</option>
                {cropVarieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label>Planting date<input type="date" value={addForm.plantingDate} onChange={(e) => setAddForm({ ...addForm, plantingDate: e.target.value })} required /></label>
            <label>Pull-out date (optional)<input type="date" value={addForm.pullOutDate} min={addForm.plantingDate || undefined} onChange={(e) => setAddForm({ ...addForm, pullOutDate: e.target.value })} /></label>
            <p className="form-hint">The planting counts from its planting date in the greenhouse's time zone. Rows are linked next, with Link rows.</p>
            {addForm.error ? <p className="form-error" role="alert">{addForm.error}</p> : null}
            <div className="form-actions">
              <button type="submit">Add planting</button>
              <button type="button" className="secondary" onClick={() => setAddForm(null)}>Cancel</button>
            </div>
          </form>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
