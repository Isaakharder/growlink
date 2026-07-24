import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { ModalOverlay } from "../../components/ModalOverlay";
import { BackfillMonthCalendar } from "./BackfillMonthCalendar";

// Matches server/src/config/orgTimezone.ts — only used here to render a
// human-readable preview time and to compute "today" for disabling future
// dates; the server independently computes and saves the real UTC timestamp
// in this same timezone, and independently rejects future dates too.
const ORG_TIMEZONE = "America/Toronto";

type CleaningLocationFrequency = "daily" | "weekly" | "monthly" | "annually";
type CleaningTaskResponseType = "checkbox" | "number" | "short_text" | "long_text";

type CleaningTask = {
  id: string;
  name: string;
  response_type: CleaningTaskResponseType;
  action_labels: string[] | null;
  sort_order: number;
};

type CleaningLocation = {
  id: string;
  name: string;
  area: string;
  frequency: CleaningLocationFrequency;
  notes: string | null;
  tasks: CleaningTask[];
};

type Member = {
  userId: string;
  name: string;
  initials: string;
};

type Column = {
  key: string;
  taskId: string;
  name: string;
  actionLabel: string | null;
};

type PreviewDay = {
  date: string;
  completedAtIso: string;
  checks: Record<string, boolean>;
};

type PreviewResponse = {
  summary: {
    locationName: string;
    dateRange: { start: string; end: string };
    dailyReportCount: number;
    taskSelectionCount: number;
    skippedExisting: number;
    timeWindow: { earliest: string; latest: string };
  };
  taskColumns: Column[];
  days: PreviewDay[];
};

const FREQUENCY_LABELS: Record<CleaningLocationFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  annually: "Annually"
};

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: ORG_TIMEZONE });
}

function oneYearAgoIso(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function formatOrgTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: ORG_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Client-side copy of server/src/routes/foodSafety/services/backfillGeneration.ts's
// buildColumns()/columnKeyFor() (same purpose: expand a location's CURRENT
// live tasks into one column per action label, for previewing what a
// backfill will create). Deliberately duplicated rather than shared -- this
// runs in the browser, that runs on the server, and three call sites in
// this module build columns for three different reasons (see that file's
// comment for the other two). Key format here MUST stay `${taskId}::${actionLabel ?? ""}`,
// matching the server exactly: this preview's columns are matched up
// against /backfill/create's actual saved output purely by this key string,
// with no other correlation. If the server's key format ever changes,
// this function needs the same change or the preview will silently show
// dates under the wrong task column.
function buildColumns(tasks: CleaningTask[]): Column[] {
  const columns: Column[] = [];
  for (const task of [...tasks].sort((a, b) => a.sort_order - b.sort_order)) {
    const labels = task.action_labels && task.action_labels.length > 0 ? task.action_labels : [null];
    labels.forEach((label) => {
      columns.push({ key: `${task.id}::${label ?? ""}`, taskId: task.id, name: task.name, actionLabel: label });
    });
  }
  return columns;
}

function columnLabel(column: Column): string {
  return column.actionLabel ? `${column.name} — ${column.actionLabel}` : column.name;
}

function monthsInRange(start: string, end: string): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));

  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

async function readErrorBody(res: Response): Promise<{ message?: string } | null> {
  return (await res.json().catch(() => null)) as { message?: string } | null;
}

export function LogsBackfillTab() {
  const [locations, setLocations] = useState<CleaningLocation[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [earliestTime, setEarliestTime] = useState("06:00");
  const [latestTime, setLatestTime] = useState("09:00");

  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [startDate, setStartDate] = useState(oneYearAgoIso());
  const [endDate, setEndDate] = useState(todayIso());

  const [existingDates, setExistingDates] = useState<Set<string>>(new Set());
  const [existingDatesError, setExistingDatesError] = useState<string | null>(null);

  const [activeColumnKey, setActiveColumnKey] = useState<string | null>(null);
  const [draftDates, setDraftDates] = useState<Record<string, Set<string>>>({});

  const [completedByUserId, setCompletedByUserId] = useState("");

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<{ created: number; skipped: number } | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const [locationsRes, membersRes] = await Promise.all([
          apiFetch("/api/food-safety/cleaning-locations"),
          apiFetch("/api/food-safety/backfill/members")
        ]);
        if (!locationsRes.ok) throw new Error(`Failed to load locations (${locationsRes.status})`);
        if (!membersRes.ok) throw new Error(`Failed to load members (${membersRes.status})`);
        const locationsData = (await locationsRes.json()) as CleaningLocation[];
        const membersData = (await membersRes.json()) as Member[];
        if (!active) return;
        setLocations(locationsData);
        setMembers(membersData);
      } catch (err) {
        if (active) setLoadError(err instanceof Error ? err.message : "Failed to load setup data");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === selectedLocationId) ?? null,
    [locations, selectedLocationId]
  );

  const columns = useMemo(() => (selectedLocation ? buildColumns(selectedLocation.tasks) : []), [selectedLocation]);

  function clearResults() {
    setPreview(null);
    setPreviewError(null);
    setCreateResult(null);
  }

  function hasUnsavedDraft(): boolean {
    return Object.values(draftDates).some((set) => set.size > 0);
  }

  async function loadExistingDates(locationId: string) {
    setExistingDatesError(null);
    try {
      const res = await apiFetch(`/api/food-safety/backfill/existing-dates?locationId=${encodeURIComponent(locationId)}`);
      if (!res.ok) throw new Error("Failed to load existing report dates for this location");
      const data = (await res.json()) as { dates: string[] };
      setExistingDates(new Set(data.dates ?? []));
    } catch (err) {
      setExistingDates(new Set());
      setExistingDatesError(err instanceof Error ? err.message : "Failed to load existing report dates");
    }
  }

  function selectLocation(locationId: string) {
    if (locationId === selectedLocationId) return;
    if (hasUnsavedDraft()) {
      const confirmed = window.confirm(
        "Switching locations will clear your unsaved date selections for the current location. Continue?"
      );
      if (!confirmed) return;
    }

    setSelectedLocationId(locationId);
    setActiveColumnKey(null);
    setDraftDates({});
    setExistingDates(new Set());
    setExistingDatesError(null);
    clearResults();

    if (locationId) void loadExistingDates(locationId);
  }

  function selectTask(columnKey: string) {
    setActiveColumnKey(columnKey);
  }

  function finishTaskSelection() {
    setActiveColumnKey(null);
  }

  function toggleDate(date: string) {
    if (!activeColumnKey) return;
    setDraftDates((current) => {
      const next = { ...current };
      const set = new Set(next[activeColumnKey] ?? []);
      if (set.has(date)) set.delete(date);
      else set.add(date);
      next[activeColumnKey] = set;
      return next;
    });
    clearResults();
  }

  function updateDateRange(nextStart: string, nextEnd: string) {
    setStartDate(nextStart);
    setEndDate(nextEnd);
    // Previously selected dates that now fall outside the new range are
    // dropped so the draft never silently disagrees with what's clickable.
    setDraftDates((current) => {
      const next: Record<string, Set<string>> = {};
      for (const [key, dates] of Object.entries(current)) {
        const kept = new Set(Array.from(dates).filter((d) => d >= nextStart && d <= nextEnd));
        if (kept.size > 0) next[key] = kept;
      }
      return next;
    });
    clearResults();
  }

  const activeSelectedDates = activeColumnKey ? draftDates[activeColumnKey] ?? new Set<string>() : new Set<string>();

  const otherTaskDatesUnion = useMemo(() => {
    const set = new Set<string>();
    for (const [key, dates] of Object.entries(draftDates)) {
      if (key === activeColumnKey) continue;
      for (const d of dates) set.add(d);
    }
    return set;
  }, [draftDates, activeColumnKey]);

  const months = useMemo(() => monthsInRange(startDate, endDate), [startDate, endDate]);
  const today = useMemo(() => todayIso(), []);

  function buildRequestBody() {
    const taskDates: Record<string, string[]> = {};
    for (const [key, set] of Object.entries(draftDates)) {
      if (set.size > 0) taskDates[key] = Array.from(set);
    }
    return { locationId: selectedLocationId, startDate, endDate, earliestTime, latestTime, taskDates };
  }

  const canGeneratePreview = !!selectedLocationId && hasUnsavedDraft();

  async function generatePreview() {
    if (!canGeneratePreview) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setCreateResult(null);
    try {
      const res = await apiFetch("/api/food-safety/backfill/preview", {
        method: "POST",
        body: JSON.stringify(buildRequestBody())
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body?.message ?? `Failed to generate preview (${res.status})`);
      }
      const data = (await res.json()) as PreviewResponse;
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to generate preview");
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmCreate() {
    if (!preview || !completedByUserId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/food-safety/backfill/create", {
        method: "POST",
        body: JSON.stringify({ ...buildRequestBody(), completedByUserId })
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body?.message ?? `Failed to create backfill records (${res.status})`);
      }
      const data = (await res.json()) as { created: number; skipped: number };
      setCreateResult(data);
      setShowConfirmModal(false);
      setPreview(null);
      setDraftDates({});
      setActiveColumnKey(null);
      if (selectedLocationId) void loadExistingDates(selectedLocationId);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create backfill records");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (loadError) {
    return <p className="form-error">{loadError}</p>;
  }

  return (
    <div className="backfill-tab">
      {/* 1. Completion Time Window */}
      <div className="coming-soon-card">
        <h2>Completion Time Window</h2>
        <div className="varieties-form">
          <label>
            Earliest completion time
            <input
              type="time"
              value={earliestTime}
              onChange={(e) => {
                setEarliestTime(e.target.value);
                clearResults();
              }}
            />
          </label>
          <label>
            Latest completion time
            <input
              type="time"
              value={latestTime}
              onChange={(e) => {
                setLatestTime(e.target.value);
                clearResults();
              }}
            />
          </label>
        </div>
        <p className="form-hint">
          A random time in this window (organization timezone, {ORG_TIMEZONE}) is generated by the server for each
          day and shared across every task result in that day's report.
        </p>
      </div>

      {/* 2. Location */}
      <div className="coming-soon-card">
        <h2>Location</h2>
        <div className="varieties-form">
          <label>
            Location
            <select value={selectedLocationId} onChange={(e) => selectLocation(e.target.value)}>
              <option value="">Select a location…</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.area})
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedLocation ? (
          <div className="backfill-location-info">
            <span className="backfill-task-chip">{selectedLocation.name}</span>
            <span className="backfill-task-chip">{selectedLocation.area}</span>
            <span className="backfill-task-chip">{FREQUENCY_LABELS[selectedLocation.frequency]}</span>
            {selectedLocation.notes ? <p className="form-hint backfill-location-notes">{selectedLocation.notes}</p> : null}
          </div>
        ) : (
          <p className="form-hint">Select a location to load its cleaning tasks.</p>
        )}
        {existingDatesError ? <p className="form-error">{existingDatesError}</p> : null}
      </div>

      {/* 3. Task Selection */}
      {selectedLocation ? (
        <div className="coming-soon-card">
          <h2>Task Selection</h2>
          <p className="form-hint">Select one task, then click its completed dates on the calendar below.</p>
          <div className="backfill-task-chip-list">
            {columns.map((column) => {
              const count = draftDates[column.key]?.size ?? 0;
              const isActive = activeColumnKey === column.key;
              return (
                <button
                  key={column.key}
                  type="button"
                  className={`backfill-task-select-chip${isActive ? " active" : ""}`}
                  aria-pressed={isActive}
                  onClick={() => selectTask(column.key)}
                >
                  <span>{columnLabel(column)}</span>
                  <span className="backfill-task-select-chip-count">{count} date{count === 1 ? "" : "s"} selected</span>
                </button>
              );
            })}
          </div>

          {/* Persistent aria-live region so switching the active task is
              announced without requiring the screen reader user to
              re-locate this text; stays mounted (just empty) when no task
              is selected, which is what makes the live-region update fire
              reliably instead of only on first mount. */}
          <p className="form-hint" style={{ margin: activeColumnKey ? "0.75rem 0 0" : 0 }} aria-live="polite">
            {activeColumnKey ? (
              <>
                Selected task: <strong>{columnLabel(columns.find((c) => c.key === activeColumnKey)!)}</strong>
              </>
            ) : null}
          </p>

          {activeColumnKey ? (
            <div className="row-actions" style={{ marginTop: "0.75rem" }}>
              <button type="button" className="secondary" onClick={finishTaskSelection}>
                Add Task Dates
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 4. Date Range and Monthly Calendars */}
      {selectedLocation ? (
        <div className="coming-soon-card">
          <h2>Date Range</h2>
          <div className="varieties-form">
            <label>
              Start date
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => updateDateRange(e.target.value, endDate)}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={endDate}
                min={startDate}
                max={today}
                onChange={(e) => updateDateRange(startDate, e.target.value)}
              />
            </label>
          </div>

          {!activeColumnKey ? (
            <p className="form-hint">Select a task above to start clicking dates.</p>
          ) : null}

          <div className="backfill-calendar-grid-wrapper">
            {months.map(({ year, month }) => (
              <BackfillMonthCalendar
                key={`${year}-${month}`}
                year={year}
                month={month}
                rangeStart={startDate}
                rangeEnd={endDate}
                todayIso={today}
                existingDates={existingDates}
                selectedDates={activeSelectedDates}
                otherTaskDates={otherTaskDatesUnion}
                onToggleDate={toggleDate}
                disabled={!activeColumnKey}
              />
            ))}
          </div>

          <div className="backfill-calendar-legend">
            <span><span className="backfill-legend-swatch available" /> Available</span>
            <span><span className="backfill-legend-swatch selected" /> Selected for this task</span>
            <span><span className="backfill-legend-swatch available"><span className="backfill-calendar-dot" /></span> Selected for another task</span>
            <span><span className="backfill-legend-swatch existing" /> Existing report</span>
            <span><span className="backfill-legend-swatch disabled" /> Future / out of range</span>
          </div>
        </div>
      ) : null}

      {/* 5. Completed By */}
      <div className="coming-soon-card">
        <h2>Completed By</h2>
        <div className="varieties-form">
          <label>
            Completed By
            <select value={completedByUserId} onChange={(e) => setCompletedByUserId(e.target.value)}>
              <option value="">Select an employee…</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name} ({member.initials})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* 6. Preview */}
      <div className="coming-soon-card">
        <h2>Preview</h2>
        <div className="row-actions">
          <button
            type="button"
            className="primary-action-button"
            disabled={!canGeneratePreview || previewLoading}
            onClick={() => void generatePreview()}
          >
            {previewLoading ? "Generating…" : "Generate Report Preview"}
          </button>
        </div>

        {previewError ? <p className="form-error">{previewError}</p> : null}

        {preview ? (
          <>
            <div className="backfill-summary-grid">
              <div><span className="backfill-summary-label">Location</span>{preview.summary.locationName}</div>
              <div><span className="backfill-summary-label">Date range</span>{preview.summary.dateRange.start} to {preview.summary.dateRange.end}</div>
              <div><span className="backfill-summary-label">Daily reports</span>{preview.summary.dailyReportCount}</div>
              <div><span className="backfill-summary-label">Task selections</span>{preview.summary.taskSelectionCount}</div>
              <div><span className="backfill-summary-label">Existing dates skipped</span>{preview.summary.skippedExisting}</div>
              <div><span className="backfill-summary-label">Completion time window</span>{preview.summary.timeWindow.earliest} – {preview.summary.timeWindow.latest}</div>
            </div>

            <div className="varieties-table-wrapper" style={{ marginTop: "1rem" }}>
              <table className="varieties-table backfill-preview-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Generated Time</th>
                    {preview.taskColumns.map((col) => (
                      <th key={col.key}>{col.actionLabel ? `${col.name} — ${col.actionLabel}` : col.name}</th>
                    ))}
                    <th>Employee</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.days.map((day) => {
                    const employee = members.find((m) => m.userId === completedByUserId);
                    return (
                      <tr key={day.date}>
                        <td>{day.date}</td>
                        <td>{formatOrgTime(day.completedAtIso)}</td>
                        {preview.taskColumns.map((col) => (
                          <td key={col.key} style={{ textAlign: "center" }}>
                            {day.checks[col.key] ? "✓" : ""}
                          </td>
                        ))}
                        <td>{employee ? `${employee.name} (${employee.initials})` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>

      {/* 7. Create Backfill */}
      <div className="coming-soon-card">
        <h2>Create Backfill</h2>
        {createError ? <p className="form-error">{createError}</p> : null}
        {createResult ? (
          <p className="backfill-success">
            Created {createResult.created} record{createResult.created === 1 ? "" : "s"}
            {createResult.skipped > 0 ? ` (${createResult.skipped} existing date${createResult.skipped === 1 ? "" : "s"} skipped)` : ""}.
          </p>
        ) : null}
        <button
          type="button"
          className="primary-action-button"
          disabled={!preview || !completedByUserId || preview.summary.dailyReportCount === 0}
          onClick={() => setShowConfirmModal(true)}
        >
          Create Backfill Reports
        </button>
        {!completedByUserId ? <p className="form-hint">Select a Completed By employee before creating records.</p> : null}
        {preview && preview.summary.dailyReportCount === 0 ? (
          <p className="form-hint">All selected dates already have a completed record.</p>
        ) : null}
      </div>

      {showConfirmModal && preview ? (
        <ModalOverlay
          onClose={() => (!creating ? setShowConfirmModal(false) : undefined)}
          contentClassName="variety-modal"
          titleId="backfill-confirm-title"
        >
          <h2 id="backfill-confirm-title">Confirm Backfill</h2>
          <p>
            You are about to create {preview.summary.dailyReportCount} completed Food Safety report
            {preview.summary.dailyReportCount === 1 ? "" : "s"} for {preview.summary.locationName}.
          </p>
          <div className="form-actions">
            <button type="button" className="primary-action-button" disabled={creating} onClick={() => void confirmCreate()}>
              {creating ? "Creating…" : "Confirm and Create"}
            </button>
            <button type="button" className="secondary" disabled={creating} onClick={() => setShowConfirmModal(false)}>
              Cancel
            </button>
          </div>
        </ModalOverlay>
      ) : null}
    </div>
  );
}
