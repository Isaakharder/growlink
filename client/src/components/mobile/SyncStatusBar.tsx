import type { SyncStatus } from "../../hooks/useOfflineQueue";

type Props = {
  queuePending: number;
  queueFailed: number;
  failureReasons: string[];
  syncStatus: SyncStatus;
  onClearFailed: () => void;
};

export function SyncStatusBar({ queuePending, queueFailed, failureReasons, syncStatus, onClearFailed }: Props) {
  if (syncStatus === "syncing") {
    return (
      <div className="sync-status-bar sync-status-bar--syncing">
        Syncing {queuePending} saved change{queuePending !== 1 ? "s" : ""}…
      </div>
    );
  }

  if (queueFailed > 0) {
    return (
      <div className="sync-status-bar sync-status-bar--failed">
        {queueFailed} change{queueFailed !== 1 ? "s" : ""} could not sync
        {failureReasons.length > 0 ? `: ${failureReasons.join("; ")}` : "."}{" "}
        <button
          type="button"
          onClick={onClearFailed}
          style={{
            background: "none",
            border: "none",
            color: "inherit",
            textDecoration: "underline",
            cursor: "pointer",
            padding: 0,
            font: "inherit",
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (queuePending > 0) {
    return (
      <div className="sync-status-bar sync-status-bar--pending">
        {queuePending} change{queuePending !== 1 ? "s" : ""} saved offline — will sync when connected
      </div>
    );
  }

  return null;
}
