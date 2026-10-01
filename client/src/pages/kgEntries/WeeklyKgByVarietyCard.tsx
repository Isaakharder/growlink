import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiFetch, getOrganizationName } from "../../lib/api";
import { downloadBlobFile } from "../../lib/downloadFile";
import {
  WEEKLY_KG_BY_VARIETY_URL,
  buildWeeklyKgTable,
  displayMatrix,
  parseWeeklyKgSource,
  weekLabel,
  weeklyKgCsv,
  weeklyKgFileBase,
  type WeeklyKgByVarietySource,
  type WeeklyKgTable
} from "../../lib/yieldEntries/weeklyKgByVariety";

// Kg Entries → "Weekly kg by Variety": a read-only week × variety summary of
// every saved yield entry of one year, with CSV and PDF exports of the same
// table. Reloads whenever refreshKey changes (the tab bumps it after any
// entry is created, edited, deleted or imported).

type LoadState =
  | { status: "loading" }
  | { status: "ready"; source: WeeklyKgByVarietySource; table: WeeklyKgTable | null; refreshing: boolean }
  | { status: "error"; message: string };

async function fetchSource(year: number | null): Promise<WeeklyKgByVarietySource> {
  const response = await apiFetch(year === null ? WEEKLY_KG_BY_VARIETY_URL : `${WEEKLY_KG_BY_VARIETY_URL}?year=${year}`);
  if (!response.ok) {
    let message = `Failed to load weekly kg by variety (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  return parseWeeklyKgSource(await response.json());
}

function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (kind: "csv" | "pdf") => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const choose = (kind: "csv" | "pdf") => {
    setOpen(false);
    onExport(kind);
  };

  return (
    <div className="weekly-kg-export" ref={wrapper}>
      <button
        type="button"
        ref={button}
        className="cases-entry-open-button weekly-kg-export-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        Export
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="weekly-kg-export-menu" role="menu" id={menuId}>
          <button type="button" role="menuitem" onClick={() => choose("csv")}>
            CSV
          </button>
          <button type="button" role="menuitem" onClick={() => choose("pdf")}>
            PDF
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function WeeklyKgByVarietyCard({ refreshKey }: { refreshKey: number }) {
  const titleId = useId();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // null: the latest year with entries (the server's default).
  const [year, setYear] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (requestedYear: number | null) => {
    const id = ++request.current;
    setState((current) => (current.status === "ready" ? { ...current, refreshing: true } : { status: "loading" }));
    try {
      let source = await fetchSource(requestedYear);
      // The chosen year lost its last entry: fall back to the latest year.
      if (requestedYear !== null && source.entryCount === 0 && source.years.length > 0 && !source.years.includes(requestedYear)) {
        source = await fetchSource(null);
      }
      const table = buildWeeklyKgTable(source);
      if (id !== request.current) return;
      setState({ status: "ready", source, table, refreshing: false });
    } catch (error) {
      if (id !== request.current) return;
      setState({ status: "error", message: error instanceof Error ? error.message : "Failed to load weekly kg by variety" });
    }
  }, []);

  useEffect(() => {
    void load(year);
  }, [load, year, refreshKey]);

  const ready = state.status === "ready" ? state : null;
  const table = ready?.table ?? null;
  const shownYear = ready?.source.year ?? null;

  async function handleExport(kind: "csv" | "pdf") {
    if (!table) return;
    setExportError(null);
    try {
      if (kind === "csv") {
        downloadBlobFile(new Blob([weeklyKgCsv(table)], { type: "text/csv;charset=utf-8" }), `${weeklyKgFileBase(table.year)}.csv`);
      } else {
        const [{ buildWeeklyKgPdf }, organizationName] = await Promise.all([
          import("../../lib/yieldEntries/weeklyKgByVarietyPdf"),
          getOrganizationName()
        ]);
        const doc = buildWeeklyKgPdf(table, { organizationName, exportedAt: new Date() });
        downloadBlobFile(doc.output("blob"), `${weeklyKgFileBase(table.year)}.pdf`);
      }
    } catch {
      setExportError(`Couldn't create the ${kind.toUpperCase()} file. Try again.`);
    }
  }

  const matrix = table ? displayMatrix(table) : null;

  return (
    <section className="coming-soon-card weekly-kg-variety-card" aria-labelledby={titleId} aria-busy={state.status === "loading" || Boolean(ready?.refreshing)}>
      <div className="weekly-kg-variety-header">
        <div>
          <h2 id={titleId}>Weekly kg by Variety</h2>
          <p className="weekly-kg-variety-subtitle">Harvested kg by recorded harvest week. “—” no entry · 0.0 recorded zero.</p>
        </div>
        <div className="weekly-kg-variety-actions">
          {ready && ready.source.years.length > 0 ? (
            <label className="weekly-kg-variety-year">
              <span>Year</span>
              <select value={String(shownYear ?? "")} onChange={(e) => setYear(Number(e.target.value))} disabled={ready.refreshing}>
                {ready.source.years.map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <ExportMenu disabled={!table || Boolean(ready?.refreshing)} onExport={(kind) => void handleExport(kind)} />
        </div>
      </div>

      <p className="weekly-kg-variety-status" role="status" aria-live="polite">
        {state.status === "loading" ? "Loading weekly kg by variety…" : ready?.refreshing ? "Updating…" : ""}
      </p>

      {state.status === "error" ? (
        <div className="form-error weekly-kg-variety-error" role="alert">
          <span>{state.message.replace(/\.$/, "")}. Totals are hidden until the full year loads.</span>
          <button type="button" className="cases-entry-open-button" onClick={() => void load(year)}>
            Retry
          </button>
        </div>
      ) : null}
      {exportError ? (
        <p className="form-error" role="alert">
          {exportError}
        </p>
      ) : null}

      {ready && !table ? (
        <p className="weekly-kg-variety-empty">
          {ready.source.years.length === 0 ? "No yield entries yet." : `No yield entries recorded for ${shownYear}.`}
        </p>
      ) : null}

      {table && matrix ? (
        <div
          className={`weekly-kg-variety-scroll${ready?.refreshing ? " is-refreshing" : ""}`}
          role="region"
          aria-label={`Weekly kg by variety, ${table.year}`}
          tabIndex={0}
        >
          <table className="weekly-kg-variety-table">
            <thead>
              <tr>
                <th scope="col" className="weekly-kg-week">
                  Week
                </th>
                {table.columns.map((c) => (
                  <th key={c.id} scope="col" title={c.label}>
                    {/* The label without "(inactive)", which is shown as a tag instead. */}
                    <span className="weekly-kg-variety-name">{c.inactive ? c.label.replace(" (inactive)", "") : c.label}</span>
                    {c.inactive ? <span className="weekly-kg-inactive">Inactive</span> : null}
                  </th>
                ))}
                <th scope="col" className="weekly-kg-total">
                  Weekly total
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={row.week} className={row.total === null ? "weekly-kg-gap-week" : undefined}>
                  <th scope="row" className="weekly-kg-week">
                    {weekLabel(row.week)}
                  </th>
                  {matrix.body[i].slice(1, -1).map((text, j) => (
                    <td key={table.columns[j].id} className={row.cells[j] === null ? "weekly-kg-none" : undefined}>
                      {text}
                    </td>
                  ))}
                  <td className={`weekly-kg-total${row.total === null ? " weekly-kg-none" : ""}`}>{matrix.body[i][matrix.body[i].length - 1]}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="weekly-kg-week">
                  Season total
                </th>
                {matrix.foot.slice(1, -1).map((text, j) => (
                  <td key={table.columns[j].id}>{text}</td>
                ))}
                <td className="weekly-kg-total">{matrix.foot[matrix.foot.length - 1]}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </section>
  );
}
