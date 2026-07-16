import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { supabase } from "../../lib/supabase";
import {
  amendRecord,
  getRecord,
  listEmployees,
  listLocations,
  listRecordAuditEvents,
  listRecordRevisions,
  rejectRecord,
  verifyRecord
} from "../../lib/foodSafety/api";
import type {
  FoodSafetyEmployee,
  FoodSafetyLocation,
  FoodSafetyRecord,
  FoodSafetyRecordAuditEvent,
  FoodSafetyRecordRevisionSummary
} from "../../lib/foodSafety/types";
import type { FoodSafetyFormSchema } from "../../lib/foodSafety/formSchema";
import { RecordSection } from "../../components/food-safety/record/RecordSection";
import { RecordStatusBadge } from "../../components/food-safety/record/RecordStatusBadge";
import { RevisionHistory } from "../../components/food-safety/record/RevisionHistory";

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export function FoodSafetyRecordDetailPage() {
  const { recordId } = useParams<{ recordId: string }>();
  const { can } = usePermissions();
  const canVerify = can("food_safety:verify");
  const canComplete = can("food_safety:complete");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<FoodSafetyRecord | null>(null);
  const [schema, setSchema] = useState<FoodSafetyFormSchema | null>(null);
  const [versionNumber, setVersionNumber] = useState<number | null>(null);
  const [employees, setEmployees] = useState<FoodSafetyEmployee[]>([]);
  const [locations, setLocations] = useState<FoodSafetyLocation[]>([]);
  const [revisions, setRevisions] = useState<FoodSafetyRecordRevisionSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<FoodSafetyRecordAuditEvent[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  const [amendMode, setAmendMode] = useState(false);
  const [amendAnswers, setAmendAnswers] = useState<Record<string, unknown>>({});
  const [amendReason, setAmendReason] = useState("");

  const load = useCallback(async () => {
    if (!recordId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, employeeRows, locationRows, revisionRows, auditRows, { data: authData }] = await Promise.all([
        getRecord(recordId),
        listEmployees(),
        listLocations(),
        listRecordRevisions(recordId),
        listRecordAuditEvents(recordId),
        supabase.auth.getUser()
      ]);
      setRecord(detail.record);
      setSchema(detail.schema);
      setVersionNumber(detail.versionNumber);
      setEmployees(employeeRows);
      setLocations(locationRows);
      setRevisions(revisionRows);
      setAuditEvents(auditRows);
      setCurrentUserId(authData.user?.id ?? null);
      setAmendAnswers(detail.record.answers_json ?? {});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load record.");
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleVerify() {
    if (!recordId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyRecord(recordId);
      await load();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Failed to verify record.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!recordId || !rejectReason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rejectRecord(recordId, rejectReason.trim());
      setShowReject(false);
      setRejectReason("");
      await load();
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : "Failed to reject record.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAmend() {
    if (!recordId || !amendReason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await amendRecord(recordId, { answers_json: amendAnswers, reason: amendReason.trim() });
      setAmendMode(false);
      setAmendReason("");
      await load();
    } catch (amendError) {
      setError(amendError instanceof Error ? amendError.message : "Failed to amend record.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="page-shell">
        <p>Loading...</p>
      </section>
    );
  }

  if (!record || !schema) {
    return (
      <section className="page-shell">
        <p className="form-error">{error ?? "Record not found."}</p>
        <Link to="/food-safety/records">Back to Records</Link>
      </section>
    );
  }

  const canManageAnyRecord = canVerify;
  const isOwnRecord = record.completed_by_user_id === currentUserId;
  const canAmend = (canManageAnyRecord || (canComplete && isOwnRecord)) && ["submitted", "verified", "amended"].includes(record.status);
  const canVerifyThis = canVerify && (record.status === "submitted" || record.status === "amended");

  const sortedSections = [...schema.sections].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <section className="page-shell">
      <header>
        <p>
          <Link to="/food-safety/records">← Back to Records</Link>
        </p>
        <h1>{schema.title}</h1>
        <p>
          <RecordStatusBadge status={record.status} /> · Version {versionNumber} · Record date {record.record_date}
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        <h2>Lifecycle</h2>
        <p>Started: {formatDateTime(record.started_at)}</p>
        <p>Submitted: {formatDateTime(record.submitted_at)}</p>
        <p>Verified: {formatDateTime(record.verified_at)}</p>
        {record.status === "rejected" || record.rejected_at ? (
          <p>
            Rejected: {formatDateTime(record.rejected_at)} — {record.rejection_reason}
          </p>
        ) : null}
      </div>

      {schema.instructions ? (
        <div className="coming-soon-card">
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{schema.instructions}</p>
        </div>
      ) : null}

      {!amendMode ? (
        <>
          {sortedSections.map((section) => (
            <RecordSection
              key={section.id}
              section={section}
              answers={record.answers_json}
              onFieldChange={() => undefined}
              employees={employees}
              locations={locations}
              readOnly
            />
          ))}

          <div className="coming-soon-card">
            <div className="form-actions">
              {canVerifyThis ? (
                <button type="button" onClick={() => void handleVerify()} disabled={busy}>
                  Verify
                </button>
              ) : null}
              {canVerifyThis ? (
                <button type="button" className="secondary" onClick={() => setShowReject(true)} disabled={busy}>
                  Reject
                </button>
              ) : null}
              {canAmend ? (
                <button type="button" className="secondary" onClick={() => setAmendMode(true)} disabled={busy}>
                  Amend
                </button>
              ) : null}
            </div>

            {showReject ? (
              <div style={{ marginTop: "0.6rem" }}>
                <label style={{ display: "block" }}>
                  Rejection reason
                  <input type="text" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
                </label>
                <div className="form-actions" style={{ marginTop: "0.4rem" }}>
                  <button type="button" onClick={() => void handleReject()} disabled={!rejectReason.trim() || busy}>
                    Confirm Reject
                  </button>
                  <button type="button" className="secondary" onClick={() => setShowReject(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="coming-soon-card">
            <p style={{ margin: 0, fontWeight: 600 }}>Amending this record</p>
            <p style={{ margin: "0.3rem 0 0" }}>
              Editing a {record.status} record requires an explicit reason. If this record was verified, verification will be
              invalidated and it will need to be reviewed again.
            </p>
          </div>

          {sortedSections.map((section) => (
            <RecordSection
              key={section.id}
              section={section}
              answers={amendAnswers}
              onFieldChange={(fieldId, value) => setAmendAnswers((current) => ({ ...current, [fieldId]: value }))}
              employees={employees}
              locations={locations}
            />
          ))}

          <div className="coming-soon-card">
            <label style={{ display: "block" }}>
              Amendment reason (required)
              <input type="text" value={amendReason} onChange={(event) => setAmendReason(event.target.value)} />
            </label>
            <div className="form-actions" style={{ marginTop: "0.6rem" }}>
              <button type="button" onClick={() => void handleAmend()} disabled={!amendReason.trim() || busy}>
                Save Amendment
              </button>
              <button type="button" className="secondary" onClick={() => setAmendMode(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </>
      )}

      <div className="coming-soon-card">
        <h2>Revision History</h2>
        <RevisionHistory revisions={revisions} />
      </div>

      <div className="coming-soon-card">
        <h2>Audit Events</h2>
        {auditEvents.length === 0 ? (
          <p>No audit events yet.</p>
        ) : (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{event.event_type}</td>
                    <td>{formatDateTime(event.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
