import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";
import { CalibrationDevice, CalibrationRecordSummary, DeviceDetail, DueStatus } from "./pestCalibration/types";
import { DeviceFormModal } from "./pestCalibration/DeviceFormModal";
import { StartCalibrationModal } from "./pestCalibration/StartCalibrationModal";
import { RecordDetailModal } from "./pestCalibration/RecordDetailModal";

type Tab = "devices" | "records";

function dueStatusLabel(status: DueStatus): string {
  switch (status) {
    case "overdue": return "Overdue";
    case "due_soon": return "Due Soon";
    case "on_demand": return "On Demand";
    default: return "OK";
  }
}

function dueStatusClass(status: DueStatus): string {
  return status === "overdue" ? "inactive" : "active";
}

// Formats a "YYYY-MM-DD" calendar label without any timezone conversion of
// the label itself — see the identical helper in RecordDetailModal.tsx.
function formatEffectiveDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return instant.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function completedAtDateInOrgTimezone(completedAtIso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(completedAtIso));
}

function formatPrintedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatFrequency(device: CalibrationDevice): string {
  if (device.frequency_type === "custom") {
    return `Every ${device.custom_interval_value} ${device.custom_interval_unit}`;
  }
  if (device.frequency_type === "on_demand") return "On demand";
  return device.frequency_type.charAt(0).toUpperCase() + device.frequency_type.slice(1);
}

type PrintAnswer = {
  task_id: string | null;
  task_name_snapshot: string;
  field_label_snapshot: string;
  field_type_snapshot: string;
  task_sort_order: number;
  sort_order: number;
  unit_snapshot: string | null;
  choice_options_snapshot: string[] | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_choices: string[] | null;
};

type PrintRepeatingRow = {
  task_id: string | null;
  task_name_snapshot: string;
  task_sort_order: number;
  row_index: number;
  answers: PrintAnswer[];
};

type PrintRecordDetail = {
  id: string;
  effective_date: string;
  completed_by_name: string;
  answers: PrintAnswer[];
  repeating_rows: PrintRepeatingRow[];
};

// Mirrors RecordDetailModal.tsx's formatAnswer, plus organization-local date
// formatting for date-type answers (formatAnswer prints the raw
// "YYYY-MM-DD" as-is, fine for an on-screen detail view, but not for a
// printed compliance document).
function formatPrintAnswerValue(answer: PrintAnswer): string {
  switch (answer.field_type_snapshot) {
    case "checkbox":
      return answer.value_choices && answer.value_choices.length > 0 ? answer.value_choices.join(", ") : "—";
    case "pass_fail": {
      if (answer.value_boolean === null) return "—";
      const [passLabel, failLabel] = [answer.choice_options_snapshot?.[0] ?? "Pass", answer.choice_options_snapshot?.[1] ?? "Fail"];
      return answer.value_boolean ? passLabel : failLabel;
    }
    case "number":
      return answer.value_number !== null ? `${answer.value_number}${answer.unit_snapshot ? ` ${answer.unit_snapshot}` : ""}` : "—";
    case "date":
      return answer.value_date ? formatEffectiveDate(answer.value_date) : "—";
    default:
      return answer.value_text ?? "—";
  }
}

function printTaskKey(taskId: string | null, taskName: string): string {
  return taskId ?? `label:${taskName}`;
}

type PrintColumn =
  | { kind: "field"; taskKey: string; label: string; unit: string | null; taskSortOrder: number; sortOrder: number }
  | { kind: "repeating"; taskKey: string; label: string; taskSortOrder: number };

// One column per distinct response field for non-repeating tasks, but only
// ONE column for an entire repeating task (e.g. "Nozzle Measurements") —
// its cell holds a multiline per-row summary instead of exploding into one
// column per field, since a repeating task can have any number of rows.
// Built from the union across every record being printed (not just the
// first/most recent one) so a device whose form changed over time, or where
// older/newer records carry different fields, still gets one stable,
// deduplicated column set — see cellValueForColumn's "—" fallback for
// records missing a given column's field entirely.
function buildPrintColumns(records: PrintRecordDetail[]): PrintColumn[] {
  const columns = new Map<string, PrintColumn>();

  for (const record of records) {
    for (const answer of record.answers) {
      const taskKey = printTaskKey(answer.task_id, answer.task_name_snapshot);
      const key = `field:${taskKey}:${answer.field_label_snapshot}`;
      if (!columns.has(key)) {
        columns.set(key, {
          kind: "field",
          taskKey,
          label: answer.field_label_snapshot,
          unit: answer.unit_snapshot,
          taskSortOrder: answer.task_sort_order,
          sortOrder: answer.sort_order
        });
      }
    }
    for (const row of record.repeating_rows) {
      const taskKey = printTaskKey(row.task_id, row.task_name_snapshot);
      const key = `repeating:${taskKey}`;
      if (!columns.has(key)) {
        columns.set(key, { kind: "repeating", taskKey, label: row.task_name_snapshot, taskSortOrder: row.task_sort_order });
      }
    }
  }

  return [...columns.values()].sort((a, b) => {
    if (a.taskSortOrder !== b.taskSortOrder) return a.taskSortOrder - b.taskSortOrder;
    return a.kind === "field" && b.kind === "field" ? a.sortOrder - b.sortOrder : 0;
  });
}

// A repeating task's rows are summarized as one line per row ("Row 1: ...",
// "Row 2: ...") rather than exploded into separate columns, since the
// number of rows varies per record. Long-text fields (e.g. a corrective-
// action note) get their own follow-up line under the row summary instead
// of being crammed onto the same line as short values — only when they
// actually have a value, so a blank corrective-action field doesn't add
// noise to every row.
function formatRepeatingSummary(rows: PrintRepeatingRow[]): string {
  const lines: string[] = [];
  const sortedRows = [...rows].sort((a, b) => a.row_index - b.row_index);

  sortedRows.forEach((row, index) => {
    const mainAnswers = row.answers.filter((a) => a.field_type_snapshot !== "long_text").sort((a, b) => a.sort_order - b.sort_order);
    const longTextAnswers = row.answers.filter((a) => a.field_type_snapshot === "long_text").sort((a, b) => a.sort_order - b.sort_order);

    const mainLine = mainAnswers.map((a) => formatPrintAnswerValue(a)).join(" — ");
    lines.push(`Row ${index + 1}: ${mainLine || "—"}`);

    for (const answer of longTextAnswers) {
      const value = formatPrintAnswerValue(answer);
      if (value !== "—") lines.push(`${answer.field_label_snapshot}: ${value}`);
    }
  });

  return lines.join("\n");
}

function cellValueForColumn(record: PrintRecordDetail, column: PrintColumn): string {
  if (column.kind === "field") {
    const match = record.answers.find(
      (a) => printTaskKey(a.task_id, a.task_name_snapshot) === column.taskKey && a.field_label_snapshot === column.label
    );
    return match ? formatPrintAnswerValue(match) : "—";
  }

  const rows = record.repeating_rows.filter((r) => printTaskKey(r.task_id, r.task_name_snapshot) === column.taskKey);
  return rows.length > 0 ? formatRepeatingSummary(rows) : "—";
}


export function PestControlCalibrationPage() {
  const { can } = usePermissions();
  const canEdit = can("calibration:edit");

  const [tab, setTab] = useState<Tab>("devices");

  // ── devices ──
  const [devices, setDevices] = useState<CalibrationDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<DeviceDetail | null>(null);
  const [startingDevice, setStartingDevice] = useState<CalibrationDevice | null>(null);

  async function fetchDevices() {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const res = await apiFetch("/api/pest/calibration/devices");
      if (!res.ok) throw new Error("Failed to load devices.");
      setDevices((await res.json()) as CalibrationDevice[]);
    } catch (error) {
      setDevicesError(error instanceof Error ? error.message : "Failed to load devices.");
    } finally {
      setDevicesLoading(false);
    }
  }

  useEffect(() => { void fetchDevices(); }, []);

  function openAdd() {
    setEditingDetail(null);
    setFormOpen(true);
  }

  async function openEdit(device: CalibrationDevice) {
    const res = await apiFetch(`/api/pest/calibration/devices/${device.id}`);
    if (res.ok) {
      setEditingDetail((await res.json()) as DeviceDetail);
      setFormOpen(true);
    }
  }

  function closeForm() {
    setFormOpen(false);
    setEditingDetail(null);
  }

  async function archiveDevice(device: CalibrationDevice) {
    if (!window.confirm(`Deactivate "${device.name}"? Its calibration history stays fully intact and searchable — you can reactivate it later.`)) return;
    const res = await apiFetch(`/api/pest/calibration/devices/${device.id}/archive`, { method: "POST" });
    if (res.ok) void fetchDevices();
  }

  async function reactivateDevice(device: CalibrationDevice) {
    const res = await apiFetch(`/api/pest/calibration/devices/${device.id}/reactivate`, { method: "POST" });
    if (res.ok) void fetchDevices();
  }

  // ── records ──
  const [records, setRecords] = useState<CalibrationRecordSummary[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [filterDeviceId, setFilterDeviceId] = useState("");
  const [filterEmployee, setFilterEmployee] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [viewingRecordId, setViewingRecordId] = useState<string | null>(null);

  // Populated on demand (fetched fresh right before printing, since the
  // records list only carries summary fields) with the full answers for
  // every record currently shown — only meaningful while filtered to one
  // device, since the print layout's title/notes/frequency are all
  // single-device values.
  const [printRecords, setPrintRecords] = useState<PrintRecordDetail[] | null>(null);
  const [printedAt, setPrintedAt] = useState<string | null>(null);
  const [printLoading, setPrintLoading] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const printRequested = useRef(false);

  async function fetchRecords() {
    setRecordsLoading(true);
    setRecordsError(null);
    setPrintRecords(null);
    try {
      const params = new URLSearchParams();
      if (filterDeviceId) params.set("device_id", filterDeviceId);
      if (filterEmployee) params.set("employee", filterEmployee);
      if (filterDateFrom) params.set("date_from", filterDateFrom);
      if (filterDateTo) params.set("date_to", filterDateTo);
      const query = params.toString();
      const res = await apiFetch(`/api/pest/calibration/records${query ? `?${query}` : ""}`);
      if (!res.ok) throw new Error("Failed to load calibration records.");
      setRecords((await res.json()) as CalibrationRecordSummary[]);
    } catch (error) {
      setRecordsError(error instanceof Error ? error.message : "Failed to load calibration records.");
    } finally {
      setRecordsLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "records") void fetchRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const employees = Array.from(
    new Map(records.map((r) => [r.completed_by_user_id, r.completed_by_name])).entries()
  ).filter(([id]) => id);

  const printDevice = devices.find((d) => d.id === filterDeviceId) ?? null;

  async function handlePrint() {
    if (!printDevice) return;
    setPrintError(null);
    setPrintLoading(true);
    try {
      const detailed = await Promise.all(
        records.map(async (r) => {
          const res = await apiFetch(`/api/pest/calibration/records/${r.id}`);
          if (!res.ok) throw new Error("Failed to load a record's details for printing.");
          return (await res.json()) as PrintRecordDetail;
        })
      );
      printRequested.current = true;
      setPrintedAt(formatPrintedAt(new Date()));
      setPrintRecords(detailed);
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "Failed to prepare records for printing.");
    } finally {
      setPrintLoading(false);
    }
  }

  const printColumns = printRecords ? buildPrintColumns(printRecords) : [];
  const printTotalColumns = 1 + printColumns.length + 1; // Date + fields + Employee

  // Fires window.print() only once printRecords has actually been populated
  // by handlePrint (not on every incidental re-render, and not before the
  // print-root DOM below has a chance to render the fetched detail). Also
  // injects a print-only @page rule — @page isn't selector-scoped, so the
  // page size/orientation can only be set by swapping the whole stylesheet
  // per print job, the same pattern BonusesTab.tsx already uses.
  useEffect(() => {
    if (!printRequested.current || !printRecords) return;
    printRequested.current = false;

    const style = document.createElement("style");
    style.setAttribute("data-calibration-print", "true");
    style.textContent = `@page { size: letter landscape; margin: 12mm; }`;
    document.head.appendChild(style);

    function finishPrint() {
      window.removeEventListener("afterprint", finishPrint);
      style.remove();
      setPrintRecords(null);
    }
    window.addEventListener("afterprint", finishPrint);

    const raf = window.requestAnimationFrame(() => window.print());

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("afterprint", finishPrint);
      style.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printRecords]);

  return (
    <section className="page-shell">
      <header>
        <h1>Calibration</h1>
        <p>Record and review pest-control equipment calibrations.</p>
      </header>

      <div className="varieties-toolbar">
        <button type="button" className={tab === "devices" ? "" : "secondary"} onClick={() => setTab("devices")}>Devices</button>
        <button type="button" className={tab === "records" ? "" : "secondary"} onClick={() => setTab("records")}>Calibration Records</button>
      </div>

      {tab === "devices" ? (
        <>
          {canEdit ? (
            <div className="cleaning-locations-toolbar">
              <button type="button" onClick={openAdd}>+ Add Device</button>
            </div>
          ) : null}

          {devicesError ? <p className="form-error">{devicesError}</p> : null}
          {devicesLoading ? <p>Loading...</p> : null}
          {!devicesLoading && devices.length === 0 ? <p>Calibration records will appear here.</p> : null}

          {!devicesLoading && devices.length > 0 ? (
            <div className="cleaning-locations-list">
              {devices.map((device) => (
                <div className="cleaning-location-card" key={device.id}>
                  <div className="cleaning-location-card-info">
                    <div className="cleaning-location-card-name">
                      {device.name}
                      {!device.is_active ? <span className="status-badge inactive" style={{ marginLeft: "0.4rem" }}>Inactive</span> : null}
                    </div>
                    {device.area ? <div className="cleaning-location-card-area">{device.area}</div> : null}
                    {/* Same stat-line shape as Food Safety's location cards
                        ("N cleaning tasks" + frequency) — extended with the
                        due-date info a calibration device needs and Food
                        Safety locations don't track. */}
                    <div className="cleaning-location-card-stats">
                      <span>{device.task_count} task{device.task_count === 1 ? "" : "s"}</span>
                      <span>{device.frequency_type === "custom" ? `Every ${device.custom_interval_value} ${device.custom_interval_unit}` : device.frequency_type}</span>
                      <span className={`status-badge ${dueStatusClass(device.due_status)}`}>{dueStatusLabel(device.due_status)}</span>
                      <span>
                        {device.last_completed_at ? `Last: ${new Date(device.last_completed_at).toLocaleDateString()}` : "Never completed"}
                      </span>
                      {device.next_due_at ? <span>Next due: {new Date(device.next_due_at).toLocaleDateString()}</span> : null}
                    </div>
                  </div>

                  <div className="row-actions cleaning-location-card-actions">
                    <button type="button" disabled={!device.is_active} onClick={() => setStartingDevice(device)}>Start Calibration</button>
                    <button type="button" onClick={() => { setTab("records"); setFilterDeviceId(device.id); }}>View History</button>
                    {canEdit ? <button type="button" onClick={() => void openEdit(device)}>Edit</button> : null}
                    {canEdit ? (
                      device.is_active ? (
                        <button type="button" className="danger" onClick={() => void archiveDevice(device)}>Deactivate</button>
                      ) : (
                        <button type="button" onClick={() => void reactivateDevice(device)}>Reactivate</button>
                      )
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="coming-soon-card">
          <h2>Calibration Records</h2>

          <div className="irrigation-toolbar">
            <label className="irrigation-filter-label">
              Device
              <select value={filterDeviceId} onChange={(e) => setFilterDeviceId(e.target.value)}>
                <option value="">All devices</option>
                {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="irrigation-filter-label">
              Employee
              <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
                <option value="">All employees</option>
                {employees.map(([id, name]) => <option key={id} value={id as string}>{name}</option>)}
              </select>
            </label>
            <label className="irrigation-filter-label">
              From
              <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} />
            </label>
            <label className="irrigation-filter-label">
              To
              <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} />
            </label>
            <button type="button" onClick={() => void fetchRecords()}>Apply</button>
            <button
              type="button"
              className="secondary"
              onClick={() => { setFilterDeviceId(""); setFilterEmployee(""); setFilterDateFrom(""); setFilterDateTo(""); void fetchRecords(); }}
            >
              Clear
            </button>
            {records.length > 0 ? (
              <button
                type="button"
                className="secondary"
                disabled={!printDevice || printLoading}
                title={printDevice ? undefined : "Select a specific device above to print its calibration log"}
                onClick={() => void handlePrint()}
              >
                {printLoading ? "Preparing…" : "Print"}
              </button>
            ) : null}
          </div>

          {recordsError ? <p className="form-error">{recordsError}</p> : null}
          {printError ? <p className="form-error">{printError}</p> : null}
          {recordsLoading ? <p>Loading...</p> : null}
          {!recordsLoading && records.length === 0 ? <p>No calibration records found.</p> : null}

          {records.length > 0 ? (
            <div className="varieties-table-wrapper">
              <table className="varieties-table">
                <thead>
                  <tr><th>Performed</th><th>Entered</th><th>Device</th><th>Area</th><th>Employee</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {records.map((record) => {
                    const backdated = record.effective_date !== completedAtDateInOrgTimezone(record.completed_at);
                    return (
                      <tr key={record.id}>
                        <td>{formatEffectiveDate(record.effective_date)}</td>
                        <td>{backdated ? new Date(record.completed_at).toLocaleDateString() : "—"}</td>
                        <td>{record.device_name_snapshot}</td>
                        <td>{record.device_area_snapshot ?? "—"}</td>
                        <td>{record.completed_by_name}</td>
                        <td><button type="button" onClick={() => setViewingRecordId(record.id)}>View</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* Only rendered once handlePrint has fetched full answer detail
              for every currently-filtered record — invisible on screen,
              shown only via the shared [data-print-root] print-isolation
              rule (index.css) once window.print() fires above. The device
              title/frequency/notes and the column-header row all live
              inside <thead> (repeated on every printed page via
              `display: table-header-group`, not JS-measured pagination),
              and the "Printed:" line lives in <tfoot> the same way. */}
          {printRecords && printDevice ? (
            <div className="calibration-device-print-root" data-print-root="true">
              <table className="calibration-device-print-table">
                <thead>
                  <tr>
                    <th colSpan={printTotalColumns} className="calibration-print-chrome-cell">
                      <div className="calibration-device-print-title-row">
                        <span className="calibration-device-print-title">{printDevice.name} Calibration</span>
                        <span className="calibration-device-print-frequency">
                          Frequency: <strong>{formatFrequency(printDevice)}</strong>
                        </span>
                      </div>
                    </th>
                  </tr>
                  <tr>
                    <th colSpan={printTotalColumns} className="calibration-print-chrome-cell">
                      <div className="calibration-device-print-notes">
                        <strong>Notes</strong>
                        <div>{printDevice.notes && printDevice.notes.trim() ? printDevice.notes : "No notes recorded."}</div>
                      </div>
                    </th>
                  </tr>
                  <tr>
                    <th>Date</th>
                    {printColumns.map((col) => (
                      <th key={col.taskKey + (col.kind === "field" ? col.label : "")}>
                        {col.label}
                        {col.kind === "field" && col.unit ? (
                          <>
                            <br />({col.unit})
                          </>
                        ) : null}
                      </th>
                    ))}
                    <th>Employee</th>
                  </tr>
                </thead>
                <tbody>
                  {printRecords.map((record) => (
                    <tr key={record.id}>
                      <td>{formatEffectiveDate(record.effective_date)}</td>
                      {printColumns.map((col) => (
                        <td key={col.taskKey + (col.kind === "field" ? col.label : "")} className="calibration-print-cell">
                          {cellValueForColumn(record, col)}
                        </td>
                      ))}
                      <td>{record.completed_by_name}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={printTotalColumns} className="calibration-print-chrome-cell">
                      <div className="calibration-device-print-signoff">
                        <span className="calibration-device-print-signature-line">Signature:</span>
                        <span className="calibration-device-print-date-line">Date:</span>
                      </div>
                      <div className="calibration-device-print-footer">
                        <span>Printed: {printedAt}</span>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}
        </div>
      )}

      {formOpen ? (
        <DeviceFormModal
          detail={editingDetail}
          onClose={closeForm}
          onSaved={() => { closeForm(); void fetchDevices(); }}
        />
      ) : null}

      {startingDevice ? (
        <StartCalibrationModal
          device={startingDevice}
          onClose={() => setStartingDevice(null)}
          onCompleted={() => void fetchDevices()}
        />
      ) : null}

      {viewingRecordId ? (
        <RecordDetailModal recordId={viewingRecordId} onClose={() => setViewingRecordId(null)} />
      ) : null}
    </section>
  );
}
