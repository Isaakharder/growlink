import type { FoodSafetyRecordRevisionSummary } from "../../../lib/foodSafety/types";

function shortActor(userId: string | null, employeeId: string | null): string {
  if (employeeId) return `employee ${employeeId.slice(0, 8)}…`;
  if (userId) return `user ${userId.slice(0, 8)}…`;
  return "system";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

type Props = {
  revisions: FoodSafetyRecordRevisionSummary[];
};

// Read-only view over the immutable revision trail — never lets a viewer
// edit history, only see it.
export function RevisionHistory({ revisions }: Props) {
  if (revisions.length === 0) {
    return <p>No revisions yet.</p>;
  }

  return (
    <div className="varieties-table-wrapper">
      <table className="varieties-table">
        <thead>
          <tr>
            <th>Rev.</th>
            <th>Status</th>
            <th>When</th>
            <th>By</th>
            <th>Reason</th>
            <th>Field changes</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((revision) => (
            <tr key={revision.id}>
              <td>#{revision.revision_number}</td>
              <td>{revision.status_snapshot}</td>
              <td>{formatDate(revision.created_at)}</td>
              <td>{shortActor(revision.created_by_user_id, revision.created_by_employee_id)}</td>
              <td>{revision.reason ?? "-"}</td>
              <td>
                {revision.changes.length === 0 ? (
                  "-"
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                    {revision.changes.map((change) => (
                      <li key={change.id}>
                        {change.field_id ?? "record"}: {JSON.stringify(change.old_value)} → {JSON.stringify(change.new_value)}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
