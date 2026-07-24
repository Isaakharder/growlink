import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, apiUrl } from "../../lib/api";
import { PrintableLocationReport, type PrintReportData } from "./PrintableLocationReport";

type ReportSummary = {
  id: string;
  completedAt: string;
  completedByName: string;
  completedByInitials: string;
  taskChecks: Record<string, boolean>;
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export function FoodSafetyLocationReportPage() {
  const { locationId } = useParams<{ locationId: string }>();

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

  useEffect(() => {
    if (!locationId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await apiFetch(`${API_BASE}?location_id=${encodeURIComponent(locationId!)}`);
        if (!res.ok) throw new Error("Failed to load reports for this location");
        const data = (await res.json()) as { locations: LocationReportCard[] };
        const loaded = data.locations?.[0];
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
      const res = await apiFetch(
        `${API_BASE}?location_id=${encodeURIComponent(locationId)}&start_date=${filter.startDate}&end_date=${filter.endDate}`
      );
      if (!res.ok) throw new Error("Failed to load reports for the selected date range");
      const data = (await res.json()) as { locations: LocationReportCard[] };
      const loaded = data.locations?.[0];
      if (!loaded) throw new Error("Location not found");
      setCard(loaded);
      setFilter((f) => ({ ...f, applied: true, loading: false }));
    } catch (err) {
      setFilter((f) => ({ ...f, loading: false, error: err instanceof Error ? err.message : "Failed to load reports" }));
    }
  }

  function clearFilter() {
    setFilter(INITIAL_FILTER);
    setCard(defaultCard);
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
        taskChecks: r.taskChecks
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
                  className="secondary"
                  disabled={!filter.applied && !filter.startDate && !filter.endDate}
                  onClick={clearFilter}
                >
                  Clear
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
                      </tr>
                    </thead>
                    <tbody>
                      {card.reports.map((report) => (
                        <tr key={report.id}>
                          <td className="cleaning-reports-col-date">{formatDate(report.completedAt)}</td>
                          {card.taskColumns.map((column) => (
                            <td key={column.key} className="cleaning-reports-check-cell">
                              {report.taskChecks[column.key] ? (
                                <span className="cleaning-reports-checkmark" aria-label="Checked">
                                  ✓
                                </span>
                              ) : null}
                            </td>
                          ))}
                          <td className="cleaning-reports-col-employee">
                            {report.completedByName} ({report.completedByInitials})
                          </td>
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

      <PrintableLocationReport data={printData} onReady={() => window.print()} />
    </section>
  );
}
