import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, apiUrl } from "../../lib/api";
import { usePermissions } from "../../hooks/usePermissions";
import { ModalOverlay } from "../../components/ModalOverlay";
import { PrintableLocationReport, type PrintReportData } from "./PrintableLocationReport";
import { resolveTaskCell, type TaskCellValue } from "./taskCellFormat";

type ReportSummary = {
  id: string;
  completedAt: string;
  completedByName: string;
  completedByInitials: string;
  attemptNumber: number | null;
  taskValues: Record<string, TaskCellValue>;
};

type TaskColumn = {
  key: string;
  label: string;
};

type LocationReportCard = {
  id: string;
  name: string;
  area: string;
  notes: string | null;
  isActive: boolean;
  totalReports: number;
  mostRecentCompletedAt: string | null;
  mostRecentCompletedByInitials: string | null;
  taskColumns: TaskColumn[];
  reports: ReportSummary[];
};

type FilterState = {
  startDate: string;
  endDate: string;
  applied: boolean;
  loading: boolean;
  error: string | null;
};

const API_BASE = apiUrl("/api/food-safety/reports");

const INITIAL_FILTER: FilterState = { startDate: "", endDate: "", applied: false, loading: false, error: null };

// How long an authorized user must hold the Clear button before Record
// Management (delete) Mode activates -- see the Clear button's pointer
// handlers below. Unauthorized users never even get the timer wired up, so
// holding does nothing for them, with no observable difference from a
// normal press-and-release.
const DELETE_MODE_HOLD_MS = 3000;
// Delete mode exits itself if left idle this long, so a workstation left
// unattended mid-deletion doesn't stay exposed indefinitely.
const DELETE_MODE_INACTIVITY_MS = 2 * 60 * 1000;
const MIN_DELETE_REASON_LENGTH = 5;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// GrowLink's single organization timezone (see server/src/config/orgTimezone.ts
// and the same pattern in MobileFoodSafetyPage.tsx) -- report timestamps are
// formatted in this zone, not the viewer's device timezone, so two reports
// completed on either side of local midnight always read as belonging to
// whichever calendar day the organization actually experienced them on.
const ORG_TIMEZONE = "America/Toronto";

// "July 28, 2026 at 10:47 AM" — includes time so multiple same-day reports
// for one location (e.g. a failed swab test followed by a re-clean and a
// passing retest) read as distinct rows instead of looking duplicated.
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const datePart = date.toLocaleDateString("en-US", { timeZone: ORG_TIMEZONE, month: "long", day: "numeric", year: "numeric" });
  const timePart = date.toLocaleTimeString("en-US", { timeZone: ORG_TIMEZONE, hour: "numeric", minute: "2-digit" });
  return `${datePart} at ${timePart}`;
}

// Fetches one location's report card, optionally scoped to a date range —
// shared by the initial load, the Apply-filter action, and the post-deletion
// refresh, so all three ways of arriving at "the current view" agree on
// exactly what a card looks like. Throws on failure; callers decide how to
// surface that.
async function fetchLocationCard(locationId: string, range?: { startDate: string; endDate: string }): Promise<LocationReportCard | null> {
  const url = range
    ? `${API_BASE}?location_id=${encodeURIComponent(locationId)}&start_date=${range.startDate}&end_date=${range.endDate}`
    : `${API_BASE}?location_id=${encodeURIComponent(locationId)}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(range ? "Failed to load reports for the selected date range" : "Failed to load reports for this location");
  }
  const data = (await res.json()) as { locations: LocationReportCard[] };
  return data.locations?.[0] ?? null;
}

export function FoodSafetyLocationReportPage() {
  const { locationId } = useParams<{ locationId: string }>();
  const { can } = usePermissions();
  const canDeleteReports = can("food_safety:delete_reports");

  const [card, setCard] = useState<LocationReportCard | null>(null);
  const [defaultCard, setDefaultCard] = useState<LocationReportCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterState>(INITIAL_FILTER);
  const [printData, setPrintData] = useState<PrintReportData | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // ── Record Management (delete) Mode ─────────────────────────────────────
  // Entered only via a 3-second hold on the Clear button, and only for users
  // holding food_safety:delete_reports — see the button's pointer handlers
  // further down, which simply never start the timer for anyone else.
  const [deleteMode, setDeleteMode] = useState(false);
  const [holding, setHolding] = useState(false);
  const holdTimerRef = useRef<number | null>(null);
  // Set only when the hold timer actually completes, so the button's own
  // onClick (which always fires after pointerup, hold or not) can tell a
  // completed hold apart from a normal short click and skip running Clear.
  const holdFiredRef = useRef(false);
  const inactivityTimerRef = useRef<number | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<ReportSummary | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteModalError, setDeleteModalError] = useState<string | null>(null);
  const [deleteSuccessMessage, setDeleteSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!locationId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const loaded = await fetchLocationCard(locationId!);
        if (!active) return;
        if (!loaded) {
          setLoadError("This location was not found.");
          return;
        }
        setDefaultCard(loaded);
        setCard(loaded);
      } catch (err) {
        if (active) setLoadError(err instanceof Error ? err.message : "Failed to load reports for this location");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [locationId]);

  // Cleans up any pending hold/inactivity timers on unmount so a lingering
  // setTimeout never fires setState against an unmounted component.
  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      if (inactivityTimerRef.current !== null) window.clearTimeout(inactivityTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!deleteSuccessMessage) return;
    const timer = window.setTimeout(() => setDeleteSuccessMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [deleteSuccessMessage]);

  // Tracks whether the reports table currently overflows horizontally, and
  // in which direction(s) there's more to see — drives the scroll hint text
  // and the left/right fade indicators. Re-measures on scroll, on window
  // resize, and whenever the table's own size changes (e.g. after a filter
  // changes how many task columns are shown) via ResizeObserver rather than
  // guessing when layout has settled.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function measure() {
      if (!el) return;
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setIsScrollable(overflow);
      setCanScrollLeft(overflow && el.scrollLeft > 1);
      setCanScrollRight(overflow && el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
    }

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [card]);

  useEffect(() => {
    function clearAfterPrint() {
      setPrintData(null);
    }
    window.addEventListener("afterprint", clearAfterPrint);
    return () => window.removeEventListener("afterprint", clearAfterPrint);
  }, []);

  async function applyFilter() {
    if (!locationId) return;
    if (!filter.startDate || !filter.endDate) {
      setFilter((f) => ({ ...f, error: "Select both a start and end date." }));
      return;
    }
    if (filter.startDate > filter.endDate) {
      setFilter((f) => ({ ...f, error: "Start date must be on or before the end date." }));
      return;
    }

    setFilter((f) => ({ ...f, loading: true, error: null }));
    try {
      const loaded = await fetchLocationCard(locationId, { startDate: filter.startDate, endDate: filter.endDate });
      if (!loaded) throw new Error("Location not found");
      setCard(loaded);
      setFilter((f) => ({ ...f, applied: true, loading: false }));
    } catch (err) {
      setFilter((f) => ({ ...f, loading: false, error: err instanceof Error ? err.message : "Failed to load reports" }));
    }
  }

  // Normal Clear behavior — unchanged. Also reachable while delete mode is
  // active is intentionally NOT wired to this; see handleClearButtonClick.
  function clearFilter() {
    setFilter(INITIAL_FILTER);
    setCard(defaultCard);
  }

  function resetInactivityTimer() {
    if (inactivityTimerRef.current !== null) window.clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = window.setTimeout(() => {
      exitDeleteMode();
    }, DELETE_MODE_INACTIVITY_MS);
  }

  function enterDeleteMode() {
    setDeleteMode(true);
    resetInactivityTimer();
  }

  function exitDeleteMode() {
    setDeleteMode(false);
    setDeleteTarget(null);
    setDeleteReason("");
    setDeleteModalError(null);
    if (inactivityTimerRef.current !== null) {
      window.clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }

  function startHoldTimer() {
    if (holdTimerRef.current !== null) return; // already timing -- ignore a duplicate start
    setHolding(true);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      setHolding(false);
      holdFiredRef.current = true;
      enterDeleteMode();
    }, DELETE_MODE_HOLD_MS);
  }

  function cancelHoldTimer() {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHolding(false);
  }

  // Pointer Events cover mouse, touch, and pen with one code path, and fire
  // pointercancel for interruptions (e.g. a touch scroll taking over) that
  // pointerup would otherwise miss — mirrors the same pattern already used
  // for the mobile long-press date selector (MobileFoodSafetyLocationPage.tsx).
  // Deliberately never wired at all for a user without food_safety:delete_reports
  // — holding the button then behaves exactly like holding any other native
  // button: nothing happens until release, at which point onClick runs the
  // normal Clear action. There is no code path that reveals delete mode
  // exists to an unauthorized user.
  function handleClearPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!canDeleteReports || deleteMode) return;
    event.preventDefault();
    startHoldTimer();
  }

  function handleClearPointerUp() {
    cancelHoldTimer();
  }

  function handleClearPointerLeave() {
    cancelHoldTimer();
  }

  function handleClearPointerCancel() {
    cancelHoldTimer();
  }

  // The button's only click handler, for every user and every mode. A
  // completed 3-second hold sets holdFiredRef just before onClick fires
  // (pointerup precedes click), so this can tell "the hold just finished"
  // apart from an ordinary press-and-release and skip Clear entirely for it.
  function handleClearButtonClick() {
    if (holdFiredRef.current) {
      holdFiredRef.current = false;
      return;
    }
    if (deleteMode) {
      exitDeleteMode();
      return;
    }
    clearFilter();
  }

  function openDeleteModal(report: ReportSummary) {
    setDeleteTarget(report);
    setDeleteReason("");
    setDeleteModalError(null);
    resetInactivityTimer();
  }

  function closeDeleteModal() {
    setDeleteTarget(null);
    setDeleteReason("");
    setDeleteModalError(null);
  }

  async function confirmDeleteReport() {
    if (!deleteTarget || deleting) return;
    if (deleteReason.trim().length < MIN_DELETE_REASON_LENGTH) return;

    setDeleting(true);
    setDeleteModalError(null);

    try {
      const res = await apiFetch(`${API_BASE}/${deleteTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: deleteReason.trim() })
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to delete this report");
      }

      setDeleteSuccessMessage("Report permanently deleted.");
      closeDeleteModal();
      exitDeleteMode();

      // Refresh both the unfiltered default (so a later Clear shows accurate
      // data) and the currently-applied filtered view, if any — preserves
      // whatever date range the user had active.
      if (locationId) {
        try {
          const [unfiltered, filtered] = await Promise.all([
            fetchLocationCard(locationId),
            filter.applied && filter.startDate && filter.endDate
              ? fetchLocationCard(locationId, { startDate: filter.startDate, endDate: filter.endDate })
              : Promise.resolve(null)
          ]);
          if (unfiltered) setDefaultCard(unfiltered);
          setCard(filtered ?? unfiltered ?? null);
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : "Deleted, but failed to refresh the report list.");
        }
      }
    } catch (err) {
      // Keep the modal open, preserve the reason, show the error — no
      // optimistic row removal happened, so the table is already correct.
      setDeleteModalError(err instanceof Error ? err.message : "Failed to delete this report");
    } finally {
      setDeleting(false);
    }
  }

  function handlePrint() {
    if (!card || card.reports.length === 0) return;

    setPrintData({
      locationName: card.name,
      locationArea: card.area,
      locationNotes: card.notes,
      taskColumns: card.taskColumns,
      reports: card.reports.map((r) => ({
        id: r.id,
        completedAt: r.completedAt,
        completedByInitials: r.completedByInitials,
        taskValues: r.taskValues
      }))
    });
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety Reports</h1>
        <Link to="/food-safety/reports" className="desktop-back-link">
          ← Back to Locations
        </Link>
        {card ? (
          <>
            <div className="cleaning-location-card-name" style={{ marginTop: "0.75rem" }}>
              {card.name}
              {!card.isActive ? <span className="cleaning-location-inactive-badge">Inactive</span> : null}
            </div>
            <div className="cleaning-location-card-area">{card.area}</div>
          </>
        ) : null}
      </header>

      {loading ? <p>Loading...</p> : null}
      {loadError ? <p className="form-error">{loadError}</p> : null}

      {!loading && card ? (
        <div className="cleaning-report-card">
          <div className="cleaning-report-card-header">
            <div className="cleaning-report-card-summary">
              <span>{card.totalReports} saved report{card.totalReports === 1 ? "" : "s"}</span>
              {card.mostRecentCompletedAt ? (
                <span>
                  Most recent: {formatDate(card.mostRecentCompletedAt)} — {card.mostRecentCompletedByInitials}
                </span>
              ) : null}
            </div>
          </div>

          <div className="cleaning-report-toolbar">
            <div className="cleaning-report-filter-fields">
              <label>
                Start date
                <input
                  type="date"
                  value={filter.startDate}
                  max={filter.endDate || undefined}
                  onChange={(e) => setFilter((f) => ({ ...f, startDate: e.target.value }))}
                />
              </label>
              <label>
                End date
                <input
                  type="date"
                  value={filter.endDate}
                  min={filter.startDate || undefined}
                  onChange={(e) => setFilter((f) => ({ ...f, endDate: e.target.value }))}
                />
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  className="primary-action-button"
                  disabled={filter.loading}
                  onClick={() => void applyFilter()}
                >
                  {filter.loading ? "Applying…" : "Apply"}
                </button>
                <button
                  type="button"
                  className={`secondary cleaning-report-clear-button${deleteMode ? " delete-mode-active" : ""}`}
                  disabled={!deleteMode && !filter.applied && !filter.startDate && !filter.endDate}
                  onPointerDown={handleClearPointerDown}
                  onPointerUp={handleClearPointerUp}
                  onPointerLeave={handleClearPointerLeave}
                  onPointerCancel={handleClearPointerCancel}
                  onClick={handleClearButtonClick}
                >
                  {holding ? (
                    <span className="cleaning-report-clear-hold-progress" style={{ animationDuration: `${DELETE_MODE_HOLD_MS}ms` }} />
                  ) : null}
                  <span className="cleaning-report-clear-label">{deleteMode ? "Exit Delete Mode" : "Clear"}</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              className="secondary cleaning-report-print-button"
              disabled={card.reports.length === 0}
              onClick={handlePrint}
            >
              Print
            </button>
          </div>
          {deleteMode ? (
            <p className="form-error cleaning-report-delete-mode-banner" role="alert">
              Delete mode is active. Deleted Food Safety records cannot be restored.
            </p>
          ) : null}
          {deleteSuccessMessage ? <p className="form-success">{deleteSuccessMessage}</p> : null}
          {filter.error ? <p className="form-error">{filter.error}</p> : null}
          {filter.applied ? (
            <p className="form-hint">
              Showing {card.reports.length} record{card.reports.length === 1 ? "" : "s"} from {filter.startDate} to {filter.endDate}.
            </p>
          ) : null}

          {card.reports.length === 0 ? (
            <p className="cleaning-reports-empty">
              {filter.applied
                ? "No completed records exist for this location in the selected date range."
                : "No completed cleaning reports yet"}
            </p>
          ) : (
            <>
              {isScrollable ? (
                <p className="form-hint cleaning-reports-scroll-hint">Scroll horizontally to view all task columns.</p>
              ) : null}
              <div className="cleaning-reports-scroll-container">
                <div className="cleaning-reports-table-wrapper" ref={scrollRef}>
                  <table className="cleaning-reports-table">
                    <thead>
                      <tr>
                        <th className="cleaning-reports-col-date">Date</th>
                        {card.taskColumns.map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                        <th className="cleaning-reports-col-employee">Employee</th>
                        {deleteMode ? <th className="cleaning-reports-col-delete">Delete</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {card.reports.map((report) => (
                        <tr key={report.id}>
                          <td className="cleaning-reports-col-date">{formatDateTime(report.completedAt)}</td>
                          {card.taskColumns.map((column) => {
                            const cell = resolveTaskCell(report.taskValues, column.key);
                            return (
                              <td
                                key={column.key}
                                className={cell.isCheckmark ? "cleaning-reports-check-cell" : "cleaning-reports-text-cell"}
                              >
                                {cell.isCheckmark ? (
                                  <span className="cleaning-reports-checkmark" aria-label="Checked">
                                    ✓
                                  </span>
                                ) : (
                                  cell.display
                                )}
                              </td>
                            );
                          })}
                          <td className="cleaning-reports-col-employee">
                            {report.completedByName} ({report.completedByInitials})
                          </td>
                          {deleteMode ? (
                            <td className="cleaning-reports-col-delete">
                              <button
                                type="button"
                                className="cleaning-report-delete-row-button"
                                onClick={() => openDeleteModal(report)}
                              >
                                Delete
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div
                  className={`cleaning-reports-scroll-fade cleaning-reports-scroll-fade-left${canScrollLeft ? " visible" : ""}`}
                  aria-hidden="true"
                />
                <div
                  className={`cleaning-reports-scroll-fade cleaning-reports-scroll-fade-right${canScrollRight ? " visible" : ""}`}
                  aria-hidden="true"
                />
              </div>
            </>
          )}
        </div>
      ) : null}

      {deleteTarget && card ? (
        <ModalOverlay
          onClose={deleting ? () => {} : closeDeleteModal}
          contentClassName="cleaning-report-delete-modal"
          titleId="delete-report-modal-title"
        >
          <h3 id="delete-report-modal-title">Delete Food Safety Report?</h3>
          <p className="form-error cleaning-report-delete-modal-warning">
            This permanently removes this report and its recorded task results. This action cannot be undone.
          </p>

          <dl className="cleaning-report-delete-modal-details">
            <dt>Location</dt>
            <dd>{card.name}</dd>
            <dt>Completed</dt>
            <dd>{formatDateTime(deleteTarget.completedAt)}</dd>
            <dt>Employee</dt>
            <dd>
              {deleteTarget.completedByName} ({deleteTarget.completedByInitials})
            </dd>
            {deleteTarget.attemptNumber !== null ? (
              <>
                <dt>Attempt</dt>
                <dd>#{deleteTarget.attemptNumber}</dd>
              </>
            ) : null}
            {card.taskColumns.map((column) => {
              const cell = resolveTaskCell(deleteTarget.taskValues, column.key);
              return (
                <div key={column.key} className="cleaning-report-delete-modal-task-row">
                  <dt>{column.label}</dt>
                  <dd>{cell.isCheckmark ? "✓" : cell.display || "—"}</dd>
                </div>
              );
            })}
          </dl>

          <label className="cleaning-report-delete-modal-reason-field">
            Deletion reason
            <textarea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              rows={3}
              placeholder="Why is this report being deleted?"
              disabled={deleting}
            />
          </label>

          {deleteModalError ? <p className="form-error">{deleteModalError}</p> : null}

          <div className="form-actions">
            <button
              type="button"
              className="primary-action-button cleaning-report-delete-modal-confirm"
              disabled={deleting || deleteReason.trim().length < MIN_DELETE_REASON_LENGTH}
              onClick={() => void confirmDeleteReport()}
            >
              {deleting ? "Deleting…" : "Permanently Delete Report"}
            </button>
            <button type="button" className="secondary" disabled={deleting} onClick={closeDeleteModal}>
              Cancel
            </button>
          </div>
        </ModalOverlay>
      ) : null}

      <PrintableLocationReport data={printData} onReady={() => window.print()} />
    </section>
  );
}
