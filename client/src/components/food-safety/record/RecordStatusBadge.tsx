import type { FoodSafetyRecordStatus } from "../../../lib/foodSafety/types";

type Props = {
  status: FoodSafetyRecordStatus;
};

export function RecordStatusBadge({ status }: Props) {
  if (status === "verified") {
    return <span className="status-badge active">Verified</span>;
  }
  if (status === "rejected") {
    return (
      <span className="status-badge inactive" style={{ background: "#f9eaea", color: "#8f2d1f", borderColor: "#f0c5be" }}>
        Rejected
      </span>
    );
  }
  if (status === "submitted") {
    return <span className="status-badge inactive">Awaiting Verification</span>;
  }
  if (status === "amended") {
    return <span className="status-badge inactive">Amended — Awaiting Review</span>;
  }
  return <span className="status-badge inactive">Draft</span>;
}
