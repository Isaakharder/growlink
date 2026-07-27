import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveTaskCell, type TaskCellValue } from "./taskCellFormat";

// Landscape Letter content box: (11in - 2*10mm margin) x (8.5in - 2*10mm
// margin), matching the @page rule in index.css. Confirmed empirically (a
// fixed-height marker-block sweep against real Chromium PDF output) rather
// than assumed -- an earlier version of this file assumed the same number
// but a since-fixed bug elsewhere in the print CSS was silently inflating
// physical page counts, which made that assumption look wrong until the
// real bug (hidden elements still occupying normal-flow layout height) was
// found and fixed in index.css.
const PAGE_CONTENT_HEIGHT_MM = 195.9;
// Same content box's width, in CSS px at the browser's fixed 96px/inch
// (true in both screen and print layout -- this is what lets the hidden
// measurement instance below reproduce the real print column widths/wrap
// behaviour without needing actual print-media activation).
const PAGE_CONTENT_WIDTH_PX = 980;
const MM_PER_PX = 25.4 / 96;
// Real Chromium PDF verification (page.pdf() vs pdf-lib physical page count)
// on Washroom 1's full 156-report history and Washroom 2's full 160-report
// history calibrated this margin twice: with a 2-line header (title +
// location) a margin of 1 landed exactly on the real safe maximum in both
// cases (37 raw vs a verified-safe 36; 32 raw vs a verified-safe 31). Adding
// the optional location-notes line (a 3rd header line -- see
// PrintHeaderBlock) made a margin of 1 insufficient: Washroom 2 overflowed
// badly (6 logical pages needing 11 physical sheets) despite the raw
// estimate only nominally requiring 1 fewer row than before. Re-verified at
// margin 2 for both locations with notes present (36→34 raw, 32→30 raw, both
// exact matches) -- kept at 2 generally since a taller/more variable header
// has less margin for the same per-row measurement error to matter.
const SAFETY_MARGIN_ROWS = 2;

// Keyed by layout signature (see layoutSignatureFor) so locations that share
// the same effective column set never re-measure after the first location
// using that layout has already resolved a row count.
const rowsPerPageCache = new Map<string, number>();

export type PrintTaskColumn = {
  key: string;
  label: string;
};

export type PrintReportRow = {
  id: string;
  completedAt: string;
  completedByInitials: string;
  taskValues: Record<string, TaskCellValue>;
};

export type PrintReportData = {
  locationName: string;
  locationArea: string;
  locationNotes: string | null;
  taskColumns: PrintTaskColumn[];
  reports: PrintReportRow[];
};

function formatPrintDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages.length > 0 ? pages : [[]];
}

function isCompact(taskColumns: PrintTaskColumn[]): boolean {
  return taskColumns.length > 6;
}

function tableClassFor(taskColumns: PrintTaskColumn[]): string {
  return `food-safety-print-table${isCompact(taskColumns) ? " food-safety-print-table-compact" : ""}`;
}

// A checkbox task's cell is always "" or "✓" -- one line, height never
// varies. A number/text task's cell can be several sentences of wrapped
// text, so the tallest actual saved answer in a given column drives that
// column's row height far more than the column count does. Picking the
// single longest cell (by character count, a reasonable proxy for wrapped
// line count at a fixed column width) per column and combining them into one
// synthetic row gives measureRowsPerPage a same-or-taller-than-any-real-row
// sample to measure -- rowsPerPage then comes out same-or-lower than the true
// max, so pages under-fill in the rare worst case instead of overflowing.
function longestCellForColumn(reports: PrintReportRow[], columnKey: string): TaskCellValue {
  let longest: TaskCellValue = { display: "", isCheckmark: false };
  for (const report of reports) {
    const cell = resolveTaskCell(report.taskValues, columnKey);
    if (cell.display.length > longest.display.length) longest = cell;
  }
  return longest;
}

// Column count alone doesn't capture what actually drives row height (font
// tier) or header height (whether labels are long enough to wrap at this
// location's actual column widths, or whether a notes line adds a 3rd header
// row) -- two locations with the same columns but different notes need
// different row counts, and reusing one's cached count for the other would
// silently overflow (or under-fill) the page. Notes are included by value,
// not just presence, since a longer note could wrap onto more lines than a
// short one at the same column layout. The per-column longest-cell lengths
// are included too -- report content (e.g. a location with unusually long
// Maintenance Required notes) changes the tallest possible row just as much
// as the column layout does, so the cache must not reuse a row-height
// measurement taken against shorter text.
function layoutSignatureFor(taskColumns: PrintTaskColumn[], locationNotes: string | null, reports: PrintReportRow[]): string {
  const longestLengths = taskColumns.map((c) => longestCellForColumn(reports, c.key).display.length).join(",");
  return `${isCompact(taskColumns) ? "compact" : "normal"}::${taskColumns.map((c) => c.label).join("|")}::notes=${locationNotes ?? ""}::lens=${longestLengths}`;
}

// Shared by the measurement instance and every real page so the two never
// drift apart -- measureRowsPerPage reads this exact markup's rendered
// height, so if the notes line only appeared on real pages (or vice versa),
// the measured header height would silently stop matching what's printed.
function PrintHeaderBlock({
  locationName,
  locationArea,
  locationNotes,
  pageLabel
}: {
  locationName: string;
  locationArea: string;
  locationNotes: string | null;
  pageLabel: string;
}) {
  return (
    <div className="food-safety-print-header">
      <div className="food-safety-print-header-top">
        <span className="food-safety-print-brand">GrowLink</span>
        <span className="food-safety-print-page-number">{pageLabel}</span>
      </div>
      <div className="food-safety-print-title">Food Safety Cleaning Log</div>
      <div className="food-safety-print-location">
        {locationName} — {locationArea}
      </div>
      {locationNotes ? <div className="food-safety-print-location-notes">{locationNotes}</div> : null}
    </div>
  );
}

function measureRowsPerPage(container: HTMLDivElement): number | null {
  const headerEl = container.querySelector<HTMLElement>(".food-safety-print-header");
  const theadEl = container.querySelector<HTMLElement>("thead");
  const rowEl = container.querySelector<HTMLElement>("tbody tr");
  const sigEl = container.querySelector<HTMLElement>(".food-safety-print-signature");
  if (!headerEl || !theadEl || !rowEl || !sigEl) return null;

  const headerMm = headerEl.getBoundingClientRect().height * MM_PER_PX;
  const theadMm = theadEl.getBoundingClientRect().height * MM_PER_PX;
  const rowMm = rowEl.getBoundingClientRect().height * MM_PER_PX;
  const sigMm = sigEl.getBoundingClientRect().height * MM_PER_PX;
  if (rowMm <= 0) return null;

  // The extra safety margin (see SAFETY_MARGIN_ROWS's comment) was only
  // needed once the header grew a 3rd line (location notes) -- locations
  // without notes keep the tighter, still-verified 2-line margin instead of
  // losing a row they don't need to.
  const hasNotesLine = !!container.querySelector(".food-safety-print-location-notes");
  const safetyMargin = hasNotesLine ? SAFETY_MARGIN_ROWS : SAFETY_MARGIN_ROWS - 1;

  const availableMm = PAGE_CONTENT_HEIGHT_MM - headerMm - theadMm - sigMm;
  const rawMax = Math.floor(availableMm / rowMm);
  return Math.max(1, rawMax - safetyMargin);
}

// Hidden on screen (see .food-safety-print-report in index.css) — only
// rendered into the print output via the "hide everything except this"
// @media print rule. Deliberately not a copy of the on-screen card:
// measurement-derived pagination (see measureRowsPerPage), a repeated
// header/signature block on every page, and an initials-only final column,
// per the Food Safety print spec.
//
// `onReady` fires exactly once a real (non-null) rowsPerPage has been
// measured for the current `data`, and the caller should defer window.print()
// until then. This used to be handled implicitly -- the parent called
// window.print() in its own effect right after setting `data`, relying on
// React running this component's layout effect first. That ordering broke
// under React StrictMode's dev-only double effect invocation: if the second
// invocation's DOM read happened to land while print media was transiently
// active, measureRowsPerPage legitimately returned null (its container
// collapses under the real @media print rules), the effect bailed out
// without calling setRowsPerPage, and the state was left at whatever it was
// initialized to -- silently printing with an arbitrary/undersized row count
// instead of the real measured one. Gating window.print() on an explicit
// onReady callback removes the dependency on effect-ordering entirely.
export function PrintableLocationReport({
  data,
  onReady
}: {
  data: PrintReportData | null;
  onReady?: () => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [rowsPerPage, setRowsPerPage] = useState<number | null>(null);
  const readyFiredForRef = useRef<PrintReportData | null>(null);

  const signature = data ? layoutSignatureFor(data.taskColumns, data.locationNotes, data.reports) : null;

  useLayoutEffect(() => {
    if (!data || !signature) {
      setRowsPerPage(null);
      return;
    }

    const cached = rowsPerPageCache.get(signature);
    if (cached !== undefined) {
      setRowsPerPage(cached);
      return;
    }

    setRowsPerPage(null);

    const container = measureRef.current;
    if (!container) return;

    const measured = measureRowsPerPage(container);
    if (measured !== null) {
      rowsPerPageCache.set(signature, measured);
      setRowsPerPage(measured);
      return;
    }

    // The container measured as collapsed (e.g. a StrictMode double-invoke
    // landed while print media was transiently active) -- retry on the next
    // frame instead of leaving rowsPerPage unset.
    const raf = requestAnimationFrame(() => {
      const retried = measureRowsPerPage(container);
      if (retried !== null) {
        rowsPerPageCache.set(signature, retried);
        setRowsPerPage(retried);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [data, signature]);

  // Passive effect (not layout) so it fires after the row count above has
  // definitely committed -- and only once per distinct `data`, so a later
  // unrelated re-render doesn't call window.print() again.
  useEffect(() => {
    if (data && rowsPerPage !== null && readyFiredForRef.current !== data) {
      readyFiredForRef.current = data;
      onReady?.();
    }
  }, [data, rowsPerPage, onReady]);

  if (!data) return null;

  // rowsPerPage may still be null here (measurement in flight) -- the
  // measurement instance below must keep rendering regardless, since it's
  // the thing being measured. Only the actual paginated report is withheld
  // until a real count exists; rendering it with a guessed row count is
  // exactly the bug this component used to have.
  const pages = rowsPerPage !== null ? chunk(data.reports, rowsPerPage) : null;
  const tableClass = tableClassFor(data.taskColumns);

  return (
    <>
      {/* Off-screen measurement instance: one real header block, one real
          thead (this location's actual task columns, so genuine header
          wrapping is captured if it ever occurs), one sample data row, and
          one signature block, laid out at the real print content width via
          .food-safety-print-measure (see index.css -- those rules mirror
          @media print's declarations and MUST stay in sync with them). This
          is what measureRowsPerPage reads to compute rowsPerPage above. */}
      <div ref={measureRef} className="food-safety-print-measure" aria-hidden="true">
        <PrintHeaderBlock
          locationName={data.locationName}
          locationArea={data.locationArea}
          locationNotes={data.locationNotes}
          pageLabel="Page 1 of 1"
        />

        <table className={tableClass}>
          <thead>
            <tr>
              <th className="food-safety-print-col-date">Date</th>
              {data.taskColumns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
              <th className="food-safety-print-col-initials">Initials</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="food-safety-print-col-date">1 January 2026</td>
              {data.taskColumns.map((col) => {
                const cell = longestCellForColumn(data.reports, col.key);
                return (
                  <td
                    key={col.key}
                    className={cell.isCheckmark ? "food-safety-print-check-cell" : "food-safety-print-text-cell"}
                  >
                    {cell.display || "✓"}
                  </td>
                );
              })}
              <td className="food-safety-print-col-initials">XX</td>
            </tr>
          </tbody>
        </table>

        <div className="food-safety-print-signature">
          <div className="food-safety-print-signature-field food-safety-print-signature-field-main">
            <span className="food-safety-print-signature-label">Confirmation Signature:</span>
            <span className="food-safety-print-signature-line" />
          </div>
          <div className="food-safety-print-signature-field">
            <span className="food-safety-print-signature-label">Date:</span>
            <span className="food-safety-print-signature-line food-safety-print-signature-line-short" />
          </div>
        </div>
      </div>

      <div className="food-safety-print-report">
        {(pages ?? []).map((pageReports, pageIndex) => (
          <div className="food-safety-print-page" key={pageIndex}>
            <PrintHeaderBlock
              locationName={data.locationName}
              locationArea={data.locationArea}
              locationNotes={data.locationNotes}
              pageLabel={`Page ${pageIndex + 1} of ${pages?.length}`}
            />

            <table className={tableClass}>
              <thead>
                <tr>
                  <th className="food-safety-print-col-date">Date</th>
                  {data.taskColumns.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                  <th className="food-safety-print-col-initials">Initials</th>
                </tr>
              </thead>
              <tbody>
                {pageReports.map((report) => (
                  <tr key={report.id}>
                    <td className="food-safety-print-col-date">{formatPrintDate(report.completedAt)}</td>
                    {data.taskColumns.map((col) => {
                      const cell = resolveTaskCell(report.taskValues, col.key);
                      return (
                        <td
                          key={col.key}
                          className={cell.isCheckmark ? "food-safety-print-check-cell" : "food-safety-print-text-cell"}
                        >
                          {cell.display}
                        </td>
                      );
                    })}
                    <td className="food-safety-print-col-initials">{report.completedByInitials}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="food-safety-print-signature">
              <div className="food-safety-print-signature-field food-safety-print-signature-field-main">
                <span className="food-safety-print-signature-label">Confirmation Signature:</span>
                <span className="food-safety-print-signature-line" />
              </div>
              <div className="food-safety-print-signature-field">
                <span className="food-safety-print-signature-label">Date:</span>
                <span className="food-safety-print-signature-line food-safety-print-signature-line-short" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
