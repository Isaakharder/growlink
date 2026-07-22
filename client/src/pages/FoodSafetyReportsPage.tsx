import { useEffect, useState } from "react";
import { apiFetch, apiUrl } from "../lib/api";

type ReportSummary = {
  id: string;
  completedAt: string;
  completedByName: string;
  completedByInitials: string;
  taskCount: number;
};

type LocationReportCard = {
  id: string;
  name: string;
  area: string;
  totalReports: number;
  mostRecentCompletedAt: string | null;
  mostRecentCompletedByInitials: string | null;
  reports: ReportSummary[];
};

type ChecklistFrequency = "daily" | "weekly" | "monthly" | "annually";
type ChecklistResponseType = "checkbox" | "number" | "short_text" | "long_text";

type ReportDetailItem = {
  id: string;
  name: string;
  frequency: ChecklistFrequency;
  responseType: ChecklistResponseType;
  actionLabel: string | null;
  responseValue: string | null;
  checkedAt: string | null;
  checkedByName: string | null;
  checkedByInitials: string | null;
};

type ReportDetail = {
  id: string;
  locationName: string;
  locationArea: string;
  periodSignature: string;
  completedAt: string;
  completedByName: string;
  completedByInitials: string;
  taskCount: number;
  items: ReportDetailItem[];
};

const API_BASE = apiUrl("/api/food-safety/reports");

const FREQUENCY_LABELS: Record<ChecklistFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  annually: "Annually"
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// "daily:2026-07-21|weekly:2026-W30" -> "Daily: 2026-07-21, Weekly: 2026-W30"
function formatPeriodSignature(signature: string): string {
  return signature
    .split("|")
    .map((part) => {
      const [type, key] = part.split(":");
      const label = FREQUENCY_LABELS[type as ChecklistFrequency] ?? type;
      return `${label}: ${key}`;
    })
    .join(", ");
}

function formatResponseValue(item: ReportDetailItem): string {
  if (item.responseType === "checkbox") {
    return item.responseValue === "true" ? "Yes" : "No";
  }
  if (!item.responseValue) return "—";
  return item.responseType === "number" ? item.responseValue : item.responseValue;
}

export function FoodSafetyReportsPage() {
  const [locations, setLocations] = useState<LocationReportCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setListError(null);
      try {
        const res = await apiFetch(API_BASE);
        if (!res.ok) throw new Error("Failed to load cleaning reports");
        const data = (await res.json()) as { locations: LocationReportCard[] };
        setLocations(data.locations ?? []);
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Failed to load cleaning reports");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  useEffect(() => {
    if (!selectedReportId) return;

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeDetail();
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [selectedReportId]);

  async function openDetail(reportId: string) {
    setSelectedReportId(reportId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const res = await apiFetch(`${API_BASE}/${reportId}`);
      if (!res.ok) throw new Error("Failed to load report details");
      const data = (await res.json()) as ReportDetail;
      setDetail(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load report details");
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedReportId(null);
    setDetail(null);
    setDetailError(null);
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Reports</h1>
        <p>Completed cleaning checklist history, by location.</p>
      </header>

      {listError ? <p className="form-error">{listError}</p> : null}
      {loading ? <p>Loading...</p> : null}

      {!loading && locations.length === 0 ? <p>No cleaning locations configured yet.</p> : null}

      {!loading && locations.length > 0 ? (
        <div className="cleaning-reports-list">
          {locations.map((location) => (
            <div className="cleaning-report-card" key={location.id}>
              <div className="cleaning-report-card-header">
                <div>
                  <div className="cleaning-location-card-name">{location.name}</div>
                  <div className="cleaning-location-card-area">{location.area}</div>
                </div>
                <div className="cleaning-report-card-summary">
                  <span>{location.totalReports} saved report{location.totalReports === 1 ? "" : "s"}</span>
                  {location.mostRecentCompletedAt ? (
                    <span>
                      Most recent: {formatDate(location.mostRecentCompletedAt)} — {location.mostRecentCompletedByInitials}
                    </span>
                  ) : null}
                </div>
              </div>

              {location.reports.length === 0 ? (
                <p className="cleaning-reports-empty">No completed cleaning reports yet</p>
              ) : (
                <div className="varieties-table-wrapper">
                  <table className="varieties-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Time</th>
                        <th>Status</th>
                        <th>Employee</th>
                        <th>Initials</th>
                        <th>Tasks</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {location.reports.map((report) => (
                        <tr key={report.id}>
                          <td>{formatDate(report.completedAt)}</td>
                          <td>{formatTime(report.completedAt)}</td>
                          <td>
                            <span className="status-badge active">Complete</span>
                          </td>
                          <td>{report.completedByName}</td>
                          <td>{report.completedByInitials}</td>
                          <td>{report.taskCount} tasks</td>
                          <td>
                            <button type="button" onClick={() => void openDetail(report.id)}>
                              View Details
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {selectedReportId ? (
        <div className="modal-overlay" onClick={closeDetail}>
          <div className="variety-modal cleaning-report-detail-modal" onClick={(event) => event.stopPropagation()}>
            {detailLoading ? <p>Loading...</p> : null}
            {detailError ? <p className="form-error">{detailError}</p> : null}

            {detail ? (
              <>
                <h2>{detail.locationName}</h2>
                <p className="cleaning-location-card-area">{detail.locationArea}</p>

                <p className="cleaning-report-detail-line">
                  Completed by: {detail.completedByName} ({detail.completedByInitials})
                </p>
                <p className="cleaning-report-detail-line">
                  Completed: {formatDate(detail.completedAt)} at {formatTime(detail.completedAt)}
                </p>
                <p className="cleaning-report-detail-line">
                  Checklist period: {formatPeriodSignature(detail.periodSignature)}
                </p>

                <h3 className="cleaning-report-detail-tasks-title">Tasks</h3>
                <div className="cleaning-report-detail-tasks">
                  {detail.items.map((item) => (
                    <div className="cleaning-report-detail-task" key={item.id}>
                      <div className="cleaning-report-detail-task-name">{item.name}</div>
                      {item.responseType === "checkbox" && item.actionLabel ? (
                        <div className="cleaning-report-detail-task-row">Required action: {item.actionLabel}</div>
                      ) : null}
                      <div className="cleaning-report-detail-task-row">Response: {formatResponseValue(item)}</div>
                      <div className="cleaning-report-detail-task-row">
                        Completed by: {item.checkedByName ?? "—"}
                      </div>
                      <div className="cleaning-report-detail-task-row">
                        Time: {item.checkedAt ? formatTime(item.checkedAt) : "—"}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="form-actions">
                  <button type="button" className="secondary" onClick={closeDetail}>
                    Close
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
