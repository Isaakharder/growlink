import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { downloadBlobFile } from "../../lib/downloadFile";
import { compressRows } from "../../lib/plants/plantingCards";

// Setup → Map: each row's real width and length (meters), the source of truth
// for every area figure (preview, migration 0157). The baseline is copied
// exactly from Greenhouse Setup; the map drawing's sizes are only for drawing,
// and moving a row on the map changes only where it's drawn. A resize applies
// from a date and a new row exists from a date, so earlier dates keep the size
// that applied then.

type Version = { row_id: string; width_m: number | null; length_m: number | null; effective_from: string | null; source: string };
type MeasuredRow = {
  id: string;
  group_id: string;
  row_number: number;
  available_from: string | null;
  current: { width_m: number | null; length_m: number | null; area_m2: number | null; effective_from: string | null; source: string } | null;
  versions: Version[];
};
const FUTURE_OFF = "Sizes that apply after today are turned off for now, until every area and yield report has been checked with dated sizes. Use today's date or an earlier one.";

type Data = { today: string; future_dates_enabled?: boolean; available: boolean; copied: boolean; groups: Array<{ id: string; name: string }>; rows: MeasuredRow[] };
type PhaseLine = { phase: string; rows: number; area_before_m2: number; area_after_m2: number; missing: number; differs_from_section: number; drawing_differs: number; not_on_map: number; area_changed: number };
type ReportRow = {
  phase: string;
  row_number: number;
  setup_width_m: number | null;
  setup_length_m: number | null;
  copied_width_m: number | null;
  copied_length_m: number | null;
  copied_from: string | null;
  drawn_width_ft: number | null;
  drawn_length_ft: number | null;
  area_before_m2: number | null;
  area_after_m2: number | null;
  flags: string[];
};
type Report = { total: { rows: number; area_before_m2: number; area_after_m2: number; missing: number; area_changed: number; not_copied: number }; phases: PhaseLine[]; rows: ReportRow[] };

const URL_BASE = "/api/setup/map/measurements";
const fmt = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits }));
const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const sizeOn = (row: MeasuredRow, date: string) => {
  let found: Version | null = null;
  for (const v of row.versions) if (v.effective_from === null || v.effective_from <= date) found = v;
  return found;
};
const latestFrom = (row: MeasuredRow) => row.versions.reduce<string | null>((m, v) => (v.effective_from && (!m || v.effective_from > m) ? v.effective_from : m), null);
async function readJson(res: Response) {
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

export function RowMeasurementsPanel({ selectedOnMap }: { selectedOnMap?: Set<string> }) {
  const [data, setData] = useState<Data | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [resize, setResize] = useState({ width: "", length: "", from: "" });
  const [add, setAdd] = useState({ from: "", to: "", width: "", length: "", slabs: "", plants: "", stems: "", exists: "" });

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(URL_BASE);
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.message ?? "Failed to load row measurements.");
      setData(body as Data);
      if (body.copied) {
        const r = await apiFetch(`${URL_BASE}/report`);
        if (r.ok) setReport((await readJson(r)) as Report);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load row measurements.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // Defaults once, when the data first arrives; a field the person clears stays clear.
  const [defaulted, setDefaulted] = useState(false);
  useEffect(() => {
    if (!data || defaulted) return;
    if (data.groups.length) setPhase((p) => p || data.groups[0].id);
    setResize((r) => ({ ...r, from: r.from || data.today }));
    setAdd((a) => ({ ...a, exists: a.exists || data.today }));
    setDefaulted(true);
  }, [data, defaulted]);

  const groupName = useMemo(() => new Map((data?.groups ?? []).map((g) => [g.id, g.name])), [data]);
  // Sizes that apply after today stay off until every report reads dated sizes (server: ROW_SIZES_FUTURE_DATES).
  const futureOff = data?.future_dates_enabled === false;
  const today = data?.today ?? "";
  const resizeTooLate = futureOff && Boolean(resize.from) && resize.from > today;
  const addTooLate = futureOff && Boolean(add.exists) && add.exists > today;
  const phaseRows = useMemo(() => (data?.rows ?? []).filter((r) => r.group_id === phase).sort((a, b) => a.row_number - b.row_number), [data, phase]);
  const selectedRows = useMemo(() => (data?.rows ?? []).filter((r) => selected.has(r.id)), [data, selected]);

  async function copyFromSetup() {
    setBusy(true);
    setError(null);
    const res = await apiFetch(`${URL_BASE}/copy`, { method: "POST", body: JSON.stringify({}) });
    const body = await readJson(res);
    setBusy(false);
    if (!res.ok) return setError(body?.message ?? "Copying failed. Nothing was changed.");
    setNotice(`Copied ${plural(body.copied_from_row, "row")} from their own Greenhouse Setup size, ${plural(body.copied_from_section, "row")} from their section${body.missing ? `; ${plural(body.missing, "row")} have no measurement` : ""}.`);
    await load();
  }
  async function downloadCsv() {
    const res = await apiFetch(`${URL_BASE}/report?format=csv`);
    if (res.ok) downloadBlobFile(new Blob([await res.text()], { type: "text/csv;charset=utf-8" }), "row-measurements-before-after.csv");
  }

  // Resize preview: the size in effect on the "applies from" date, before and after.
  const preview = useMemo(() => {
    const w = Number(resize.width), l = Number(resize.length);
    if (!selectedRows.length || !resize.from) return null;
    const lines = selectedRows.map((r) => {
      const old = sizeOn(r, resize.from);
      const width = resize.width ? w : old?.width_m ?? null;
      const length = resize.length ? l : old?.length_m ?? null;
      const oldArea = old?.width_m && old.length_m ? old.width_m * old.length_m : null;
      const newArea = width && length && width > 0 && length > 0 ? width * length : null;
      const latest = latestFrom(r);
      return { row: r, old, width, length, oldArea, newArea, tooEarly: Boolean(latest && resize.from <= latest), latest };
    });
    const byPhase = new Map<string, { old: number; next: number; rows: number }>();
    for (const x of lines) {
      const t = byPhase.get(x.row.group_id) ?? { old: 0, next: 0, rows: 0 };
      t.old += x.oldArea ?? 0;
      t.next += x.newArea ?? 0;
      t.rows += 1;
      byPhase.set(x.row.group_id, t);
    }
    const valid = lines.every((x) => x.newArea !== null && !x.tooEarly) && (resize.width !== "" || resize.length !== "");
    return { lines, byPhase, valid };
  }, [selectedRows, resize]);

  async function saveResize(e: FormEvent) {
    e.preventDefault();
    if (!preview?.valid || resizeTooLate) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(URL_BASE, {
      method: "PUT",
      body: JSON.stringify({ effective_from: resize.from, rows: preview.lines.map((x) => ({ row_id: x.row.id, width_m: x.width, length_m: x.length })) })
    });
    const body = await readJson(res);
    setBusy(false);
    if (!res.ok) return setError(body?.message ?? "Saving failed. Nothing was changed.");
    setNotice(`New size saved for ${plural(preview.lines.length, "row")} from ${fmtDate(resize.from)}. Dates before that keep the earlier size.`);
    setSelected(new Set());
    setResize((r) => ({ ...r, width: "", length: "" }));
    await load();
  }

  const addPreview = useMemo(() => {
    const from = Number(add.from), to = add.to ? Number(add.to) : from;
    const w = Number(add.width), l = Number(add.length);
    if (!phase || !Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from || !(w > 0) || !(l > 0) || !add.exists) return null;
    const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const taken = new Set(phaseRows.map((r) => r.row_number));
    return { numbers, clash: numbers.filter((n) => taken.has(n)), each: w * l, total: w * l * numbers.length };
  }, [add, phase, phaseRows]);

  async function saveAdd(e: FormEvent) {
    e.preventDefault();
    if (!addPreview || addPreview.clash.length || addTooLate) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/setup/map/rows", {
      method: "POST",
      body: JSON.stringify({
        group_id: phase,
        from_row: Number(add.from),
        to_row: add.to ? Number(add.to) : Number(add.from),
        width_m: Number(add.width),
        length_m: Number(add.length),
        slab_count: add.slabs || 0,
        plants_per_slab: add.plants || 0,
        stems_per_plant: add.stems || 1,
        effective_from: add.exists
      })
    });
    const body = await readJson(res);
    setBusy(false);
    if (!res.ok) return setError(body?.message ?? "Adding rows failed. Nothing was changed.");
    setNotice(`${groupName.get(phase)} rows ${compressRows(addPreview.numbers)} added, in the greenhouse from ${fmtDate(add.exists)}. Place them on the map with Place rows.`);
    setAdd((a) => ({ ...a, from: "", to: "" }));
    await load();
  }

  if (!data) return error ? <p className="form-error" role="alert">{error}</p> : null;

  return (
    <section className="coming-soon-card gh-measure" aria-label="Row measurements">
      <h2>Row measurements</h2>
      <p className="form-hint">
        Each row's real width and length in meters. These are the source of truth for every area figure; the map drawing's sizes are only
        for drawing, and moving a row on the map changes only where it's drawn. A new size applies from a date, so earlier dates keep the
        size that applied then.
      </p>
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {!data.available ? <p className="crop-plan-flag">Row measurements aren't set up yet (migration 0157).</p> : null}

      {data.available && !data.copied ? (
        <div className="gh-measure-copy">
          <p>
            Start by copying each row's measured width and length from Greenhouse Setup: the row's own size (keeping per-row differences),
            else its section's. Rows keep their ids, phases and row numbers, and nothing in Greenhouse Setup changes. The map drawing's sizes are not used.
          </p>
          <button type="button" disabled={busy} onClick={() => void copyFromSetup()}>Copy measurements from Greenhouse Setup</button>
        </div>
      ) : null}

      {report ? (
        <details className="gh-measure-report" open>
          <summary><h3>Before and after: Greenhouse Setup vs measurements</h3></summary>
          <table className="gh-measure-table" aria-label="Before and after by phase">
            <thead>
              <tr><th scope="col">Phase</th><th scope="col">Rows</th><th scope="col">m² before</th><th scope="col">m² after</th><th scope="col">Missing</th><th scope="col">Row differs from section</th><th scope="col">Drawing differs</th><th scope="col">Not on map</th></tr>
            </thead>
            <tbody>
              {report.phases.map((p) => (
                <tr key={p.phase} className={p.area_before_m2 !== p.area_after_m2 ? "gh-measure-changed" : undefined}>
                  <th scope="row">{p.phase}</th>
                  <td>{p.rows}</td>
                  <td>{fmt(p.area_before_m2)}</td>
                  <td>{fmt(p.area_after_m2)}</td>
                  <td className={p.missing ? "crop-plan-flag" : undefined}>{p.missing}</td>
                  <td>{p.differs_from_section}</td>
                  <td>{p.drawing_differs}</td>
                  <td>{p.not_on_map}</td>
                </tr>
              ))}
              <tr className="gh-measure-total">
                <th scope="row">All phases</th>
                <td>{report.total.rows}</td>
                <td>{fmt(report.total.area_before_m2)}</td>
                <td>{fmt(report.total.area_after_m2)}</td>
                <td className={report.total.missing ? "crop-plan-flag" : undefined}>{report.total.missing}</td>
                <td colSpan={3}>{report.total.area_changed ? <span className="crop-plan-flag">{plural(report.total.area_changed, "row")} changed area</span> : "No row's area changed"}</td>
              </tr>
            </tbody>
          </table>
          <div className="gh-measure-tools">
            <label className="gh-map-toggle"><input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> Only rows with a flag</label>
            <button type="button" className="secondary" onClick={() => void downloadCsv()}>Download comparison (CSV)</button>
          </div>
          <div className="gh-measure-scroll">
            <table className="gh-measure-table" aria-label="Before and after by row">
              <thead>
                <tr><th scope="col">Phase</th><th scope="col">Row</th><th scope="col">Greenhouse Setup (m)</th><th scope="col">Measurement (m)</th><th scope="col">m² before</th><th scope="col">m² after</th><th scope="col">Drawing (ft)</th><th scope="col">Flags</th></tr>
              </thead>
              <tbody>
                {report.rows.filter((r) => !flaggedOnly || r.flags.length).map((r) => (
                  <tr key={`${r.phase}-${r.row_number}`}>
                    <td>{r.phase}</td>
                    <td>{r.row_number}</td>
                    <td>{r.setup_width_m === null ? "—" : `${r.setup_width_m} × ${r.setup_length_m}`}</td>
                    <td>{r.copied_width_m === null ? <span className="crop-plan-flag">missing</span> : `${r.copied_width_m} × ${r.copied_length_m}`}</td>
                    <td>{fmt(r.area_before_m2, 4)}</td>
                    <td>{fmt(r.area_after_m2, 4)}</td>
                    <td>{r.drawn_width_ft === null ? "—" : `${r.drawn_width_ft} × ${r.drawn_length_ft}`}</td>
                    <td>{r.flags.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {data.copied ? (
        <>
          <div className="gh-measure-head">
            <label>
              Phase
              <select value={phase} onChange={(e) => { setPhase(e.target.value); setSelected(new Set()); }}>
                {data.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            {selectedOnMap?.size ? (
              <button type="button" className="secondary" onClick={() => setSelected(new Set(data.rows.filter((r) => selectedOnMap.has(`${r.group_id}:${r.row_number}`)).map((r) => r.id)))}>
                Use the {plural(selectedOnMap.size, "row")} selected on the map
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={() => setSelected(new Set(phaseRows.map((r) => r.id)))}>Select all in phase</button>
            {selected.size ? <button type="button" className="secondary" onClick={() => setSelected(new Set())}>Clear ({selected.size})</button> : null}
          </div>
          <div className="gh-measure-scroll gh-measure-rows">
            <table className="gh-measure-table" aria-label={`${groupName.get(phase) ?? "Phase"} row sizes`}>
              <thead>
                <tr><th scope="col"><span className="visually-hidden">Select</span></th><th scope="col">Row</th><th scope="col">Width (m)</th><th scope="col">Length (m)</th><th scope="col">m² today</th><th scope="col">Since</th><th scope="col">Sizes</th></tr>
              </thead>
              <tbody>
                {phaseRows.map((r) => (
                  <tr key={r.id} className={selected.has(r.id) ? "selected" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select row ${r.row_number}`}
                        checked={selected.has(r.id)}
                        onChange={() => setSelected((cur) => { const next = new Set(cur); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); return next; })}
                      />
                    </td>
                    <td>{r.row_number}</td>
                    <td>{r.current ? fmt(r.current.width_m, 4) : <span className="crop-plan-flag">{r.available_from ? `from ${fmtDate(r.available_from)}` : "missing"}</span>}</td>
                    <td>{r.current ? fmt(r.current.length_m, 4) : "—"}</td>
                    <td>{r.current?.area_m2 ? fmt(r.current.area_m2) : <span className="crop-plan-flag">—</span>}</td>
                    <td>{r.current?.effective_from ? fmtDate(r.current.effective_from) : r.current ? "copied" : "—"}</td>
                    <td title={r.versions.map((v) => `${v.effective_from ? fmtDate(v.effective_from) : "baseline"}: ${v.width_m ?? "?"} × ${v.length_m ?? "?"}`).join("\n")}>{r.versions.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form className="gh-measure-form" onSubmit={saveResize} aria-label="Resize rows">
            <h3>Resize {selected.size ? plural(selected.size, "selected row") : "rows"}</h3>
            <div className="gh-map-fields">
              <label>Width (m)<input type="number" step="any" min="0" value={resize.width} onChange={(e) => setResize({ ...resize, width: e.target.value })} placeholder="keep" /></label>
              <label>Length (m)<input type="number" step="any" min="0" value={resize.length} onChange={(e) => setResize({ ...resize, length: e.target.value })} placeholder="keep" /></label>
              <label>Applies from<input type="date" value={resize.from} max={futureOff ? today : undefined} onChange={(e) => setResize({ ...resize, from: e.target.value })} required /></label>
            </div>
            {resizeTooLate ? <p className="crop-plan-flag" role="alert">{FUTURE_OFF}</p> : null}
            {preview ? (
              <div className="gh-measure-preview" aria-label="Resize preview">
                <table className="gh-measure-table">
                  <thead><tr><th scope="col">Row</th><th scope="col">Old size</th><th scope="col">Old m²</th><th scope="col">New size</th><th scope="col">New m²</th><th scope="col">Change</th></tr></thead>
                  <tbody>
                    {preview.lines.map((x) => (
                      <tr key={x.row.id}>
                        <td>{groupName.get(x.row.group_id)} {x.row.row_number}</td>
                        <td>{x.old ? `${x.old.width_m ?? "?"} × ${x.old.length_m ?? "?"}` : "—"}</td>
                        <td>{fmt(x.oldArea)}</td>
                        <td>{x.width ?? "?"} × {x.length ?? "?"}</td>
                        <td>{fmt(x.newArea)}</td>
                        <td>{x.tooEarly ? <span className="crop-plan-flag">has a size from {fmtDate(x.latest!)}; pick a later date</span> : x.oldArea !== null && x.newArea !== null ? `${x.newArea - x.oldArea >= 0 ? "+" : ""}${fmt(x.newArea - x.oldArea)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {[...preview.byPhase].map(([g, t]) => (
                      <tr key={g}>
                        <th scope="row">{groupName.get(g)} ({plural(t.rows, "row")})</th>
                        <td></td><td>{fmt(t.old)}</td><td></td><td>{fmt(t.next)}</td><td>{`${t.next - t.old >= 0 ? "+" : ""}${fmt(t.next - t.old)}`}</td>
                      </tr>
                    ))}
                  </tfoot>
                </table>
                <p className="form-hint">Old m² is the size in effect on {fmtDate(resize.from)}. Dates before {fmtDate(resize.from)} keep their size; plant and head counts don't change.</p>
              </div>
            ) : <p className="form-hint">Select rows above (or on the map) to preview a new size.</p>}
            <button type="submit" disabled={busy || !preview?.valid || resizeTooLate}>Save new size{preview ? ` for ${plural(preview.lines.length, "row")}` : ""}</button>
          </form>

          <form className="gh-measure-form" onSubmit={saveAdd} aria-label="Add rows">
            <h3>Add rows to {groupName.get(phase) ?? "the phase"}</h3>
            <div className="gh-map-fields">
              <label>From row<input type="number" min="1" value={add.from} onChange={(e) => setAdd({ ...add, from: e.target.value })} required /></label>
              <label>To row<input type="number" min="1" value={add.to} onChange={(e) => setAdd({ ...add, to: e.target.value })} /></label>
              <label>Width (m)<input type="number" step="any" min="0" value={add.width} onChange={(e) => setAdd({ ...add, width: e.target.value })} required /></label>
              <label>Length (m)<input type="number" step="any" min="0" value={add.length} onChange={(e) => setAdd({ ...add, length: e.target.value })} required /></label>
              <label>Slabs per row<input type="number" min="0" value={add.slabs} onChange={(e) => setAdd({ ...add, slabs: e.target.value })} /></label>
              <label>Plants per slab<input type="number" min="0" value={add.plants} onChange={(e) => setAdd({ ...add, plants: e.target.value })} /></label>
              <label>Stems per plant<input type="number" step="any" min="0" value={add.stems} onChange={(e) => setAdd({ ...add, stems: e.target.value })} placeholder="1" /></label>
              <label>In the greenhouse from<input type="date" value={add.exists} max={futureOff ? today : undefined} onChange={(e) => setAdd({ ...add, exists: e.target.value })} required /></label>
            </div>
            {addTooLate ? <p className="crop-plan-flag" role="alert">{FUTURE_OFF}</p> : null}
            {addPreview ? (
              <p className={addPreview.clash.length ? "crop-plan-flag" : "form-hint"} aria-label="Add rows preview">
                {addPreview.clash.length
                  ? `Rows ${compressRows(addPreview.clash)} already exist in ${groupName.get(phase)}.`
                  : `${plural(addPreview.numbers.length, "new row")} (${compressRows(addPreview.numbers)}) × ${fmt(addPreview.each)} m² = ${fmt(addPreview.total)} m², from ${fmtDate(add.exists)}. Earlier dates don't include them.`}
              </p>
            ) : null}
            <button type="submit" disabled={busy || !addPreview || addPreview.clash.length > 0 || addTooLate}>Add {addPreview ? plural(addPreview.numbers.length, "row") : "rows"}</button>
          </form>
        </>
      ) : null}
    </section>
  );
}
