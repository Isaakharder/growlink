import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { ModalOverlay } from "../../components/ModalOverlay";

type AnswerRow = {
  id: string;
  task_id: string | null;
  task_name_snapshot: string;
  task_sort_order: number;
  field_label_snapshot: string;
  field_type_snapshot: string;
  unit_snapshot: string | null;
  choice_options_snapshot: string[] | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_choices: string[] | null;
  is_within_range: boolean | null;
};

type RepeatingRow = {
  id: string;
  task_id: string | null;
  task_name_snapshot: string;
  row_index: number;
  answers: AnswerRow[];
};

type RecordDetail = {
  id: string;
  device_name_snapshot: string;
  device_identification_number_snapshot: string | null;
  device_area_snapshot: string | null;
  instructions_snapshot: string | null;
  completed_by_name: string;
  completed_at: string;
  effective_date: string;
  next_due_at: string | null;
  answers: AnswerRow[];
  repeating_rows: RepeatingRow[];
};

function formatAnswer(answer: AnswerRow): string {
  switch (answer.field_type_snapshot) {
    case "checkbox":
      return answer.value_choices && answer.value_choices.length > 0 ? answer.value_choices.join(", ") : "—";
    case "pass_fail": {
      if (answer.value_boolean === null) return "—";
      const [passLabel, failLabel] = [answer.choice_options_snapshot?.[0] ?? "Pass", answer.choice_options_snapshot?.[1] ?? "Fail"];
      return answer.value_boolean ? passLabel : failLabel;
    }
    case "number":
      return answer.value_number !== null
        ? `${answer.value_number}${answer.unit_snapshot ? ` ${answer.unit_snapshot}` : ""}${answer.is_within_range === false ? " (out of range)" : ""}`
        : "—";
    case "date":
      return answer.value_date ?? "—";
    default:
      return answer.value_text ?? "—";
  }
}

// Formats a "YYYY-MM-DD" calendar label without any timezone conversion of
// the label itself — builds the instant at UTC noon on that date and reads
// it back pinned to UTC, so it always prints the same date regardless of
// the viewing device's local timezone.
function formatEffectiveDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return instant.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// "YYYY-MM-DD" for the calendar date completed_at reads as in the org
// timezone — used only to decide whether the performed date differs from
// the entered date (never to derive an authoritative value; the server's
// effective_date column is always the source of truth for "performed on").
function completedAtDateInOrgTimezone(completedAtIso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(completedAtIso));
}

// A record can have several non-repeating tasks (Nozzle 1, Nozzle 2,
// Pressure...), each with its own set of fields — group flat answers back
// under their originating task so the detail view mirrors the builder,
// not one undifferentiated table. Falls back to the name when task_id is
// null (the task was later deleted). Relies on the API's
// .order("task_sort_order").order("sort_order") to keep both the task
// grouping and each task's field order stable.
function groupAnswersByTask(answers: AnswerRow[]): [string, AnswerRow[]][] {
  const byTask = new Map<string, AnswerRow[]>();
  for (const answer of answers) {
    const key = answer.task_id ?? `label:${answer.task_name_snapshot}`;
    const existing = byTask.get(key);
    if (existing) existing.push(answer);
    else byTask.set(key, [answer]);
  }
  return [...byTask.entries()];
}

// Same idea for repeating tasks — a record can have more than one (e.g.
// Nozzle Measurements AND a separate repeating task), so grouping must key
// off the actual task, not assume there's only ever one.
function groupRepeatingRowsByTask(rows: RepeatingRow[]): [string, RepeatingRow[]][] {
  const byTask = new Map<string, RepeatingRow[]>();
  for (const row of rows) {
    const key = row.task_id ?? `label:${row.task_name_snapshot}`;
    const existing = byTask.get(key);
    if (existing) existing.push(row);
    else byTask.set(key, [row]);
  }
  return [...byTask.entries()];
}

type RecordDetailModalProps = {
  recordId: string;
  onClose: () => void;
};

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
