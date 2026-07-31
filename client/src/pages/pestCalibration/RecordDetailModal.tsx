import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { ModalOverlay } from "../../components/ModalOverlay";
import {
  RecordDetail,
  formatAnswer,
  formatEffectiveDate,
  completedAtDateInOrgTimezone,
  groupAnswersByTask,
  groupRepeatingRowsByTask
} from "./recordPrint";

type RecordDetailModalProps = {
  recordId: string;
  onClose: () => void;
};

// Read-only viewer only — printing this record happens from the Print
// button on DeviceHistoryModal.tsx (which works whether or not this modal
// is still open; see recordPrint.ts for the shared print-building logic).
export function RecordDetailModal({ recordId, onClose }: RecordDetailModalProps) {
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/pest/calibration/records/${recordId}`);
        if (!res.ok) throw new Error("Failed to load record.");
        const data = (await res.json()) as RecordDetail;
        if (!cancelled) setRecord(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load record.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [recordId]);

  return (
    <ModalOverlay onClose={onClose} contentClassName="variety-modal" titleId="calibration-record-detail-title">
      <h2 id="calibration-record-detail-title">Calibration Record</h2>

      {loading ? <p>Loading...</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      {record ? (
        <div>
          <p>
            <strong>{record.device_name_snapshot}</strong>
            {record.device_identification_number_snapshot ? ` · ${record.device_identification_number_snapshot}` : ""}
            {record.device_area_snapshot ? ` · ${record.device_area_snapshot}` : ""}
          </p>
          {record.effective_date !== completedAtDateInOrgTimezone(record.completed_at) ? (
            <>
              <p>
                Performed date: <strong>{formatEffectiveDate(record.effective_date)}</strong>
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: "0.85em" }}>
                Entered: {new Date(record.completed_at).toLocaleString()} by {record.completed_by_name}
              </p>
            </>
          ) : (
            <p>
              Completed by {record.completed_by_name} on {new Date(record.completed_at).toLocaleString()}
            </p>
          )}
          {record.next_due_at ? <p>Next due: {new Date(record.next_due_at).toLocaleDateString()}</p> : null}

          {record.instructions_snapshot ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem", marginBottom: "0.75rem" }}>
              <p>{record.instructions_snapshot}</p>
            </div>
          ) : null}

          {groupAnswersByTask(record.answers).map(([taskKey, answers]) => (
            <div key={taskKey} style={{ marginBottom: "1rem" }}>
              <h3>{answers[0].task_name_snapshot}</h3>
              <table className="varieties-table">
                <thead><tr><th>Field</th><th>Answer</th></tr></thead>
                <tbody>
                  {answers.map((answer) => (
                    <tr key={answer.id}><td>{answer.field_label_snapshot}</td><td>{formatAnswer(answer)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {groupRepeatingRowsByTask(record.repeating_rows).map(([taskKey, rows]) => (
            <div key={taskKey} style={{ marginBottom: "1rem" }}>
              <h3>{rows[0].task_name_snapshot}</h3>
              <table className="varieties-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    {rows[0].answers.map((a) => <th key={a.id}>{a.field_label_snapshot}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.row_index + 1}</td>
                      {row.answers.map((a) => <td key={a.id}>{formatAnswer(a)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="form-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : null}
    </ModalOverlay>
  );
}
