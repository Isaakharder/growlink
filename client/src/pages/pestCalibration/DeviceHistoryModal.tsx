import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { ModalOverlay } from "../../components/ModalOverlay";
import { runCalibrationPrint } from "../../lib/calibrationPrintMode";
import { CalibrationDevice, CalibrationRecordSummary } from "./types";
import { RecordDetailModal } from "./RecordDetailModal";
import { PrintRecord } from "./PrintRecord";
import {
  RecordDetail,
  formatEffectiveDate,
  completedAtDateInOrgTimezone,
  buildPrintSections,
  needsCompactLongLayout
} from "./recordPrint";

type DeviceHistoryModalProps = {
  device: CalibrationDevice;
  onClose: () => void;
};

// One device's calibration history — opened via "View History" on a device
// card. Always scoped to this one device (the server now requires
// device_id on the list endpoint; there is no more cross-device records
// view). Printing here batch-prints every record CURRENTLY shown by the
// active filters (not a single selected/viewed record) — see handlePrint.
export function DeviceHistoryModal({ device, onClose }: DeviceHistoryModalProps) {
  const [records, setRecords] = useState<CalibrationRecordSummary[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [filterEmployee, setFilterEmployee] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // View is entirely independent of Print now — opening/closing a record's
  // detail modal has no effect on whether Print is enabled or what it prints.
  const [viewingRecordId, setViewingRecordId] = useState<string | null>(null);

  const [printRecords, setPrintRecords] = useState<RecordDetail[] | null>(null);
  const [printLoading, setPrintLoading] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const printRequested = useRef(false);

  function buildRecordsQuery(): string {
    const params = new URLSearchParams();
    params.set("device_id", device.id);
    if (filterEmployee) params.set("employee", filterEmployee);
    if (filterDateFrom) params.set("date_from", filterDateFrom);
    if (filterDateTo) params.set("date_to", filterDateTo);
    return `?${params.toString()}`;
  }

  async function fetchRecords() {
    setRecordsLoading(true);
    setRecordsError(null);
    try {
      const res = await apiFetch(`/api/pest/calibration/records${buildRecordsQuery()}`);
      if (!res.ok) throw new Error("Failed to load calibration records.");
      setRecords((await res.json()) as CalibrationRecordSummary[]);
    } catch (error) {
      setRecordsError(error instanceof Error ? error.message : "Failed to load calibration records.");
    } finally {
      setRecordsLoading(false);
    }
  }

  useEffect(() => {
    void fetchRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  const employees = Array.from(
    new Map(records.map((r) => [r.completed_by_user_id, r.completed_by_name])).entries()
  ).filter(([id]) => id);

  // Prints every record CURRENTLY shown by the table (`records`, already in
  // the exact filtered order the server returned — effective_date desc,
  // completed_at/created_at/id as tiebreakers), not a single selected
  // record. One batch request for full detail, preserving that order,
  // rather than N sequential GET /records/:id calls. If the batch endpoint
  // reports any record missing, the whole print is aborted with a clear
  // error instead of silently printing fewer records than the table shows.
  async function handlePrint() {
    if (records.length === 0) return;
    setPrintError(null);
    setPrintLoading(true);
    try {
      const res = await apiFetch(`/api/pest/calibration/records/print-details`, {
        method: "POST",
        body: JSON.stringify({ recordIds: records.map((r) => r.id) })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to prepare records for printing.");
      }
      const details = (await res.json()) as RecordDetail[];
      printRequested.current = true;
      setPrintRecords(details);
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "Failed to prepare records for printing.");
    } finally {
      setPrintLoading(false);
    }
  }

  // Fires window.print() only once printRecords has actually been
  // populated by handlePrint. See calibrationPrintMode.ts.
  //
  // @page is document-global — it can't vary per record within one print
  // job, so the margin choice below is based on whether ANY record in this
  // batch needs the compact-long two-column layout. In practice a device's
  // records are all shaped the same way (the same template drives every
  // completion), so a Scale print job never contains a long record and
  // always keeps its original 13mm margin; only a job containing at least
  // one long record (e.g. a Sprayer device) switches to the tighter margin
  // that layout was designed for.
  useEffect(() => {
    if (!printRequested.current || !printRecords) return;
    printRequested.current = false;

    const anyLongRecord = printRecords.some((record) => needsCompactLongLayout(buildPrintSections(record)));
    const margin = anyLongRecord ? "9mm" : "13mm";

    return runCalibrationPrint(
      `@page { size: letter portrait; margin: ${margin}; }`,
      () => setPrintRecords(null)
    );
  }, [printRecords, device.id]);

  const printButtonLabel = printLoading
    ? "Preparing…"
    : `Print${records.length > 0 ? ` ${records.length} Record${records.length === 1 ? "" : "s"}` : ""}`;

  return (
    <ModalOverlay onClose={onClose} contentClassName="variety-modal calibration-history-modal" titleId="calibration-device-history-title">
      <h2 id="calibration-device-history-title">{device.name} — History</h2>

      <div className="irrigation-toolbar">
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
          onClick={() => { setFilterEmployee(""); setFilterDateFrom(""); setFilterDateTo(""); void fetchRecords(); }}
        >
          Clear
        </button>
        <button
          type="button"
          className="secondary"
          disabled={records.length === 0 || printLoading}
          title={records.length === 0 ? "No records to print for the current filters." : undefined}
          onClick={() => void handlePrint()}
        >
          {printButtonLabel}
        </button>
      </div>

      {recordsError ? <p className="form-error">{recordsError}</p> : null}
      {printError ? <p className="form-error">{printError}</p> : null}
      {recordsLoading ? <p>Loading...</p> : null}
      {!recordsLoading && records.length === 0 ? <p>No calibration records found.</p> : null}

      {records.length > 0 ? (
        <div className="varieties-table-wrapper calibration-history-table-wrapper">
          <table className="varieties-table calibration-history-table">
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "28%" }} />
              <col style={{ width: "28%" }} />
            </colgroup>
            <thead>
              <tr><th>Performed</th><th>Entered</th><th>Employee</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const backdated = record.effective_date !== completedAtDateInOrgTimezone(record.completed_at);
                return (
                  <tr key={record.id}>
                    <td>{formatEffectiveDate(record.effective_date)}</td>
                    <td>{backdated ? new Date(record.completed_at).toLocaleDateString() : "—"}</td>
                    <td>{record.completed_by_name}</td>
                    <td className="calibration-history-actions-cell">
                      <button type="button" onClick={() => setViewingRecordId(record.id)}>View</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>

      {/* Batch print output — only rendered once handlePrint has fetched
          full detail for every currently-filtered record. Hidden on
          screen; shown only during an actual print job. PrintRecord (see
          PrintRecord.tsx) picks one of two tiers per record, purely
          structural (row-count based), never a device-name check:
            - Long record (>=20 total rows, e.g. a 28-nozzle sprayer): a
              two-column layout, entirely separate CSS classes from the
              normal tier below.
            - Normal record: single-column layout on its own page. Records
              with <=10 rows (e.g. Scale) additionally get the
              "compact-record" class so they stay intact and the next
              record can start right underneath them on the same page. */}
      {printRecords && printRecords.length > 0 ? (
        <div className="calibration-record-print-root" data-print-root="true">
          {printRecords.map((record) => (
            <PrintRecord
              key={record.id}
              record={record}
              needsLongLayout={needsCompactLongLayout(buildPrintSections(record))}
            />
          ))}
        </div>
      ) : null}

      {viewingRecordId ? (
        <RecordDetailModal recordId={viewingRecordId} onClose={() => setViewingRecordId(null)} />
      ) : null}
    </ModalOverlay>
  );
}
