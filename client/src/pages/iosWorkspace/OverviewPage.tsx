import {
  TRACKING_LABELS,
  formatSnapshotNumber,
  getAvgFeedMl,
  getDrainPercent,
  getLastReadingDate,
  pairGreenhouseSnapshots,
  selectGreenhouseSnapshotGroups,
  type GreenhouseSnapshot,
  type IrrigationGroup,
  type IrrigationGroupType,
  type IrrigationLogRecord
} from "../../lib/dashboard/greenhouseSnapshots";
import { getWorkspaceJson, useWorkspaceResource } from "./workspaceData";
import { WorkspacePageFrame } from "./WorkspacePageFrame";

// Compact Overview: the desktop Dashboard's Greenhouse Snapshot, from the
// same endpoints and the same shared calculations.

type OverviewData = { trackingMode: IrrigationGroupType | null; snapshots: GreenhouseSnapshot[] };

async function loadOverview(): Promise<OverviewData> {
  const [setup, logs] = await Promise.all([
    getWorkspaceJson<{ groups?: IrrigationGroup[] }>("/api/irrigation-setup"),
    getWorkspaceJson<IrrigationLogRecord[]>("/api/irrigation/logs?days=365")
  ]);
  const { trackingMode, groups, latestLogsByGroupId } = selectGreenhouseSnapshotGroups(setup.groups, logs);
  return { trackingMode, snapshots: pairGreenhouseSnapshots(groups, latestLogsByGroupId) };
}

function SnapshotCard({ group, log }: GreenhouseSnapshot) {
  const metrics: Array<[string, string]> = [
    ["Feed EC", formatSnapshotNumber(log?.feed_ec, 2)],
    ["Feed pH", formatSnapshotNumber(log?.feed_ph, 2)],
    ["Drain EC", formatSnapshotNumber(log?.drain_ec, 2)],
    ["Drain pH", formatSnapshotNumber(log?.drain_ph, 2)],
    ["Avg Feed ml", getAvgFeedMl(log)],
    ["Drain %", getDrainPercent(log)]
  ];
  const titleId = `iosws-snapshot-${group.id}`;
  return (
    <li className="iosws-card" aria-labelledby={titleId}>
      <div className="iosws-card-head">
        <h3 id={titleId} className="iosws-card-title">
          {group.name}
        </h3>
        <span className="iosws-badge">{TRACKING_LABELS[group.type]}</span>
      </div>
      <dl className="iosws-metrics">
        {metrics.map(([label, value]) => (
          <div key={label} className="iosws-metric">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="iosws-card-foot">
        <span>Last reading</span> <span>{getLastReadingDate(log)}</span>
      </p>
    </li>
  );
}

export default function OverviewPage() {
  const { state, refresh } = useWorkspaceResource("overview", loadOverview);

  return (
    <WorkspacePageFrame
      title="Overview"
      subtitle="Latest greenhouse irrigation readings."
      state={state}
      onRefresh={() => void refresh()}
      loadingText="Loading greenhouse readings…"
      errorText="Couldn't load greenhouse readings. Check your connection and try again."
      forbiddenText="You don't have access to irrigation readings."
    >
      {(data) =>
        data.snapshots.length === 0 ? (
          <p className="iosws-empty">No active irrigation groups yet. Add them in Irrigation Setup on the desktop app.</p>
        ) : (
          <>
            <h3 className="iosws-section-title">
              Greenhouse Snapshot{data.trackingMode ? ` · by ${TRACKING_LABELS[data.trackingMode].toLowerCase()}` : ""}
            </h3>
            <ul className="iosws-card-list" aria-label="Greenhouse Snapshot">
              {data.snapshots.map((s) => (
                <SnapshotCard key={s.group.id} {...s} />
              ))}
            </ul>
          </>
        )
      }
    </WorkspacePageFrame>
  );
}
