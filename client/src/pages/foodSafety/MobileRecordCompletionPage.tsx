import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { supabase } from "../../lib/supabase";
import {
  getRecord,
  listEmployees,
  listLocations,
  listRecordRevisions,
  rejectRecord,
  resubmitRecord,
  submitRecord,
  updateRecordDraft,
  verifyRecord
} from "../../lib/foodSafety/api";
import type {
  FoodSafetyEmployee,
  FoodSafetyLocation,
  FoodSafetyRecord,
  FoodSafetyRecordRevisionSummary
} from "../../lib/foodSafety/types";
import type { FoodSafetyFormSchema } from "../../lib/foodSafety/formSchema";
import { RecordSection } from "../../components/food-safety/record/RecordSection";
import { EmployeeConfirmation } from "../../components/food-safety/record/EmployeeConfirmation";
import { RecordStatusBadge } from "../../components/food-safety/record/RecordStatusBadge";
import { RevisionHistory } from "../../components/food-safety/record/RevisionHistory";

export function MobileRecordCompletionPage() {
  const { recordId } = useParams<{ recordId: string }>();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canVerify = can("food_safety:verify");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<FoodSafetyRecord | null>(null);
  const [schema, setSchema] = useState<FoodSafetyFormSchema | null>(null);
  const [employees, setEmployees] = useState<FoodSafetyEmployee[]>([]);
  const [locations, setLocations] = useState<FoodSafetyLocation[]>([]);
  const [revisions, setRevisions] = useState<FoodSafetyRecordRevisionSummary[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [changeReason, setChangeReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!recordId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, employeeRows, locationRows, revisionRows, { data: authData }] = await Promise.all([
        getRecord(recordId),
        listEmployees(),
        listLocations(),
        listRecordRevisions(recordId),
        supabase.auth.getUser()
      ]);

      setRecord(detail.record);
      setSchema(detail.schema);
      setEmployees(employeeRows);
      setLocations(locationRows);
      setRevisions(revisionRows);
      setAnswers(detail.record.answers_json ?? {});
      setCurrentUserId(authData.user?.id ?? null);
      setDirty(false);

      if (!detail.record.completed_by_employee_id) {
        const linked = employeeRows.filter((employee) => employee.user_id === authData.user?.id && employee.active);
        if (linked.length === 1) setSelectedEmployeeId(linked[0].id);
      } else {
        setSelectedEmployeeId(detail.record.completed_by_employee_id);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load record.");
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  function handleFieldChange(fieldId: string, value: unknown) {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
    setDirty(true);
  }

  const isOwner = useMemo(() => record?.completed_by_user_id === currentUserId, [record, currentUserId]);

  async function saveDraft() {
    if (!recordId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateRecordDraft(recordId, { answers_json: answers, employee_id: selectedEmployeeId });
      setRecord(updated);
      setDirty(false);
      setLastSavedAt(new Date());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    if (!recordId || !selectedEmployeeId || !confirmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await submitRecord(recordId, { answers_json: answers, employee_id: selectedEmployeeId });
      setRecord(updated);
      setDirty(false);
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit record.");
    } finally {
      setSubmitting(false);
    }
  }

  async function correctAndResubmit() {
    if (!recordId || !selectedEmployeeId || !confirmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await resubmitRecord(recordId, {
        answers_json: answers,
        employee_id: selectedEmployeeId,
        change_reason: changeReason || null
      });
      setRecord(updated);
      setDirty(false);
      await load();
    } catch (resubmitError) {
      setError(resubmitError instanceof Error ? resubmitError.message : "Failed to resubmit record.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verify() {
    if (!recordId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await verifyRecord(recordId);
      setRecord(updated);
      await load();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Failed to verify record.");
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!recordId || !rejectReason.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await rejectRecord(recordId, rejectReason.trim());
      setRecord(updated);
      setShowRejectInput(false);
      setRejectReason("");
      await load();
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : "Failed to reject record.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <section className="mobile-page">
        <p>Loading...</p>
      </section>
    );
  }

  if (error && !record) {
    return (
      <section className="mobile-page">
        <p className="form-error">{error}</p>
        <Link to="/mobile/food-safety">Back to Food Safety</Link>
      </section>
    );
  }

  if (!record || !schema) {
    return (
      <section className="mobile-page">
        <p>Record not found.</p>
        <Link to="/mobile/food-safety">Back to Food Safety</Link>
      </section>
    );
  }

  const sortedSections = [...schema.sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const editable = record.status === "draft" || record.status === "rejected";
  const canActOnThis = editable && isOwner;

  return (
    <section className="mobile-page">
      <Link to="/mobile/food-safety">← Back to Food Safety</Link>
      <h2 style={{ marginBottom: "0.2rem" }}>{schema.title}</h2>
      <RecordStatusBadge status={record.status} />
      {schema.description ? <p>{schema.description}</p> : null}
      {schema.instructions ? (
        <div className="coming-soon-card">
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{schema.instructions}</p>
        </div>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}

      {record.status === "rejected" ? (
        <div className="coming-soon-card" style={{ background: "#f9eaea", borderColor: "#f0c5be" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Rejected</p>
          <p style={{ margin: "0.3rem 0 0" }}>{record.rejection_reason}</p>
        </div>
      ) : null}

      {sortedSections.map((section) => (
        <RecordSection
          key={section.id}
          section={section}
          answers={answers}
          onFieldChange={handleFieldChange}
          employees={employees}
          locations={locations}
          readOnly={!canActOnThis}
        />
      ))}

      {canActOnThis ? (
        <>
          {record.status === "rejected" ? (
            <label style={{ display: "block", margin: "0.6rem 0" }}>
              What did you change? (required if any answers changed)
              <input type="text" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} />
            </label>
          ) : null}

          <EmployeeConfirmation
            employees={employees}
            selectedEmployeeId={selectedEmployeeId}
            onSelectEmployee={(id) => {
              setSelectedEmployeeId(id);
              setDirty(true);
            }}
            confirmed={confirmed}
            onConfirmedChange={setConfirmed}
          />

          <div className="form-actions">
            <button type="button" onClick={() => void saveDraft()} disabled={saving}>
              {saving ? "Saving..." : "Save Draft"}
            </button>
            {record.status === "draft" ? (
              <button type="button" onClick={() => void submit()} disabled={!selectedEmployeeId || !confirmed || submitting}>
                {submitting ? "Submitting..." : "Sign & Submit"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void correctAndResubmit()}
                disabled={!selectedEmployeeId || !confirmed || submitting}
              >
                {submitting ? "Submitting..." : "Correct & Resubmit"}
              </button>
            )}
          </div>
          {lastSavedAt ? <p style={{ fontSize: "0.78rem" }}>Last saved {lastSavedAt.toLocaleTimeString()}</p> : null}
        </>
      ) : null}

      {!editable && canVerify && (record.status === "submitted" || record.status === "amended") ? (
        <div className="coming-soon-card">
          <h3 style={{ marginTop: 0 }}>Supervisor Review</h3>
          <div className="form-actions">
            <button type="button" onClick={() => void verify()} disabled={submitting}>
              {submitting ? "Please wait..." : "Verify"}
            </button>
            <button type="button" className="secondary" onClick={() => setShowRejectInput(true)} disabled={submitting}>
              Reject
            </button>
          </div>
          {showRejectInput ? (
            <div style={{ marginTop: "0.6rem" }}>
              <label style={{ display: "block" }}>
                Rejection reason
                <input type="text" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
              </label>
              <div className="form-actions" style={{ marginTop: "0.4rem" }}>
                <button type="button" onClick={() => void reject()} disabled={!rejectReason.trim() || submitting}>
                  Confirm Reject
                </button>
                <button type="button" className="secondary" onClick={() => setShowRejectInput(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="coming-soon-card">
        <h3 style={{ marginTop: 0 }}>History</h3>
        <RevisionHistory revisions={revisions} />
      </div>
    </section>
  );
}
