import {
  COLOR_ORDER,
  buildColorYieldSummary,
  buildYieldPieSlices,
  buildYieldTrendPoints,
  formatColorKgPerM2,
  normalizeColorCaseEntries,
  normalizeYieldEntries,
  type ColorYieldSummary,
  type ColorYieldVariety,
  type VarietyColor,
  type YieldPieSlice,
  type YieldTrendPoint
} from "../../lib/dashboard/yieldByColor";
import { getWorkspaceJson, useWorkspaceResource } from "./workspaceData";
import { WorkspacePageFrame } from "./WorkspacePageFrame";

// Compact Yield by Color: the desktop Dashboard's Yield by Color, Total
// Picked by Color and weekly kg by colour, from the same endpoints and the
// same shared calculations, laid out as cards and a week list instead of
// charts so it fits a 320 pt iPhone.

const RECENT_WEEKS = 6;

type YieldByColorData = { summary: ColorYieldSummary[]; slices: YieldPieSlice[]; weeks: YieldTrendPoint[] };

async function loadYieldByColor(): Promise<YieldByColorData> {
  const [entriesRaw, varieties, caseEntriesRaw] = await Promise.all([
    getWorkspaceJson<unknown>("/api/yield-entries"),
    getWorkspaceJson<ColorYieldVariety[]>("/api/varieties"),
    getWorkspaceJson<unknown>("/api/color-case-entries")
  ]);
  const entries = normalizeYieldEntries(entriesRaw);
  const summary = buildColorYieldSummary(entries, varieties ?? [], normalizeColorCaseEntries(caseEntriesRaw));
  return { summary, slices: buildYieldPieSlices(summary), weeks: buildYieldTrendPoints(entries, varieties ?? []) };
}

const COLOR_LABELS: Record<VarietyColor, string> = { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green" };
const formatKg = (kg: number) => `${kg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg`;

function ColorCard({ entry, slice }: { entry: ColorYieldSummary; slice: YieldPieSlice }) {
  const titleId = `iosws-color-${entry.color}`;
  return (
    <li className={`iosws-card iosws-color-card iosws-color-${entry.color}`} aria-labelledby={titleId}>
      <h3 id={titleId} className="iosws-card-title">
        <span className="iosws-color-dot" aria-hidden="true" />
        {COLOR_LABELS[entry.color]}
      </h3>
      <dl className="iosws-metrics">
        <div className="iosws-metric">
          <dt>Harvested</dt>
          <dd>{formatColorKgPerM2(entry.harvestedKgPerM2)}</dd>
        </div>
        <div className="iosws-metric">
          <dt>Shipped</dt>
          <dd>{formatColorKgPerM2(entry.exportedKgPerM2)}</dd>
        </div>
        <div className="iosws-metric iosws-metric-wide">
          <dt>Total picked</dt>
          <dd>
            {formatKg(slice.kg)} · {slice.percent}%
          </dd>
        </div>
      </dl>
      <div className="iosws-share" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(0, slice.percent))}%` }} />
      </div>
    </li>
  );
}

function WeekRow({ point }: { point: YieldTrendPoint }) {
  const year = Math.floor(point.sortKey / 100);
  const week = point.sortKey % 100;
  const colors = COLOR_ORDER.filter((c) => point[c] > 0);
  return (
    <li className="iosws-week">
      <h4 className="iosws-week-title">
        Week {week} · {year}
      </h4>
      {colors.length === 0 ? (
        <p className="iosws-page-note">No kg recorded.</p>
      ) : (
        <dl className="iosws-week-values">
          {colors.map((c) => (
            <div key={c} className={`iosws-week-value iosws-color-${c}`}>
              <dt>
                <span className="iosws-color-dot" aria-hidden="true" />
                {COLOR_LABELS[c]}
              </dt>
              <dd>{formatKg(point[c])}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export default function YieldByColorPage() {
  const { state, refresh } = useWorkspaceResource("yield-by-color", loadYieldByColor);

  return (
    <WorkspacePageFrame
      title="Yield by Color"
      subtitle="Harvested and shipped kg/m² by color, all recorded weeks."
      state={state}
      onRefresh={() => void refresh()}
      loadingText="Loading yield by color…"
      errorText="Couldn't load yield by color. Check your connection and try again."
      forbiddenText="You don't have access to yield by color. It needs yield, varieties and cases access."
    >
      {(data) => {
        const hasYield = data.weeks.length > 0 || data.summary.some((s) => s.totalKg > 0 || s.exportedKg > 0);
        if (!hasYield) return <p className="iosws-empty">No yield recorded yet.</p>;
        const recent = [...data.weeks].reverse().slice(0, RECENT_WEEKS);
        return (
          <>
            <ul className="iosws-card-list iosws-color-grid" aria-label="Yield by color">
              {data.summary.map((entry) => (
                <ColorCard key={entry.color} entry={entry} slice={data.slices.find((s) => s.color === entry.color)!} />
              ))}
            </ul>
            <h3 className="iosws-section-title">Recent weeks</h3>
            {recent.length === 0 ? (
              <p className="iosws-empty">No weekly kg recorded yet.</p>
            ) : (
              <ul className="iosws-week-list" aria-label={`Kg by color, last ${recent.length} ${recent.length === 1 ? "week" : "weeks"}`}>
                {recent.map((point) => (
                  <WeekRow key={point.label} point={point} />
                ))}
              </ul>
            )}
          </>
        );
      }}
    </WorkspacePageFrame>
  );
}
