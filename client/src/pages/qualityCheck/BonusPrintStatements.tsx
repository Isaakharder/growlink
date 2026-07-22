import { createPortal } from "react-dom";
import { BonusEntry, JOB_LABEL, formatCAD } from "./BonusesTab";
import { BonusPrintEmployeeGroup, BonusWeekGroup, formatWeekLabel } from "./bonusWeeks";

export { buildDateRangeLabel, buildJobFilterLabel, buildPrintGroups } from "./bonusWeeks";
export type { BonusPrintEmployeeGroup } from "./bonusWeeks";

// Describes the weekly conditions and how they adjusted the standard
// threshold, e.g. "Weekly fruit set was 7.0 sets/m². The standard 600
// heads/hr threshold was adjusted by +20 heads/hr to 620 heads/hr." Empty
// string when no adjustment applied (fixed mode, or a zero net adjustment).
function buildAdjustmentContext(entry: BonusEntry): string {
  const isAdjusted =
    entry.base_threshold !== null && entry.applied_threshold !== null && entry.base_threshold !== entry.applied_threshold;
  if (!isAdjusted) return "";

  const delta = entry.applied_threshold! - entry.base_threshold!;
  const deltaText = `${delta >= 0 ? "+" : ""}${delta} ${entry.speed_unit}`;

  const conditionText =
    entry.check_type === "picking_peppers"
      ? entry.weekly_crop_load !== null
        ? `Weekly crop load was ${entry.weekly_crop_load} kg/m². `
        : ""
      : entry.weekly_sets_per_plant !== null
        ? `Weekly fruit set was ${entry.weekly_sets_per_plant} sets/m². `
        : "";

  return (
    `${conditionText}The standard ${entry.base_threshold} ${entry.speed_unit} threshold was adjusted by ` +
    `${deltaText} to ${entry.applied_threshold} ${entry.speed_unit}. `
  );
}

function buildExplanation(entry: BonusEntry): string {
  const context = buildAdjustmentContext(entry);

  if (entry.applied_threshold === null || entry.applied_rate <= 0) {
    return `${context}Speed was below the minimum bonus threshold, so no hourly bonus was earned.`;
  }
  if (context) {
    return (
      `${context}The employee reached ${entry.entered_speed} ${entry.speed_unit} and earned ` +
      `${formatCAD(entry.applied_rate)} per hour.`
    );
  }
  return (
    `Reached the ${entry.applied_threshold} ${entry.speed_unit} bonus tier. ` +
    `${formatCAD(entry.applied_rate)}/hr × ${entry.hours_worked} hours = ${formatCAD(entry.total_bonus)}.`
  );
}

// A week group with one raw entry gets the plain per-entry explanation.
// A week group combining several saved records (e.g. legacy daily entries
// landing in the same week) gets an aggregate explanation instead — the
// per-entry wording would be ambiguous once rows are merged.
function buildWeekExplanation(group: BonusWeekGroup): string {
  if (group.entries.length === 1) return buildExplanation(group.entries[0]);

  const context = buildAdjustmentContext(group.entries[0]);
  const anyQualified = group.entries.some((e) => e.applied_rate > 0);
  if (!anyQualified) {
    return `${context}${group.entries.length} entries this week, all below the minimum bonus threshold, so no hourly bonus was earned.`;
  }
  return (
    `${context}${group.entries.length} entries combined for this week. ` +
    `Blended rate ${formatCAD(group.blendedRate)}/hr × ${group.totalHours} hours = ${formatCAD(group.totalBonus)}.`
  );
}

// Self-contained print CSS, injected into <head> only while a print job is
// active and removed immediately after. Kept out of index.css on purpose:
// this statement needs a portrait letter @page, while the existing H1 print
// styles need landscape — @page rules aren't selector-scoped, so the two
// must never both be present in the stylesheet at the same time.
export const BONUS_PRINT_CSS = `
@page {
  size: letter portrait;
  margin: 0.6in;
}

body * {
  visibility: hidden !important;
}

.bonus-print-root,
.bonus-print-root * {
  visibility: visible !important;
}

.bonus-print-root {
  /* absolute (not fixed): fixed-position content is treated as a repeating
     header/footer by print engines and gets redrawn on every page, which is
     what caused employees to overlap. absolute still escapes the normal
     document flow (so hidden ancestor content above it doesn't push it down
     or clip it) but paginates normally across multiple pages. */
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  background: #ffffff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.bonus-print-page {
  background: #ffffff;
  color: #1a1a1a;
  font-family: Arial, Helvetica, sans-serif;
  padding: 0 0 20px;
  break-inside: avoid;
  page-break-inside: avoid;
}

.bonus-print-page-break {
  break-after: page;
  page-break-after: always;
}

.bonus-print-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 2px solid #0f7660;
  padding-bottom: 10px;
  margin-bottom: 14px;
}

.bonus-print-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bonus-print-mark {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 700;
  background: #d8f3eb;
  color: #0f7660;
}

.bonus-print-brand-name {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #0f7660;
}

.bonus-print-brand-subtitle {
  margin: 1px 0 0;
  font-size: 10px;
  color: #5c6b66;
}

.bonus-print-header h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #1a1a1a;
  text-align: right;
}

.bonus-print-meta {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px 16px;
  margin-bottom: 16px;
}

.bonus-print-meta div span {
  display: block;
  color: #5c6b66;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.bonus-print-meta div strong {
  display: block;
  font-size: 13px;
  color: #1a1a1a;
  margin-top: 2px;
}

.bonus-print-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
  margin-bottom: 14px;
}

.bonus-print-table th,
.bonus-print-table td {
  border: 1px solid #cfd8d4;
  padding: 5px 6px;
  text-align: left;
  vertical-align: top;
}

.bonus-print-table th {
  background: #f2f6f4;
  font-weight: 700;
  color: #1a1a1a;
}

.bonus-print-summary {
  display: flex;
  gap: 28px;
  border-top: 1px solid #cfd8d4;
  padding-top: 10px;
}

.bonus-print-summary div span {
  display: block;
  color: #5c6b66;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.bonus-print-summary div strong {
  display: block;
  font-size: 14px;
  margin-top: 2px;
  color: #1a1a1a;
}

.bonus-print-thanks {
  margin: 10px 0 0;
  font-size: 11px;
  color: #5c6b66;
  font-style: italic;
}
`;

type BonusPrintStatementsProps = {
  groups: BonusPrintEmployeeGroup[];
  dateRangeLabel: string;
  jobLabel: string;
};

export function BonusPrintStatements({ groups, dateRangeLabel, jobLabel }: BonusPrintStatementsProps) {
  // Portalled directly onto <body> so this content sits outside every app
  // layout container (sidebar flex/grid, page-shell width, etc.) — those
  // ancestors stay in the DOM (visibility: hidden, not display: none) during
  // print, and any positioned/overflow-constrained ancestor could otherwise
  // clip or reposition an absolutely-positioned descendant.
  return createPortal(
    <div className="bonus-print-root">
      {groups.map((group, idx) => (
        <section
          key={group.employeeId}
          className={`bonus-print-page${idx < groups.length - 1 ? " bonus-print-page-break" : ""}`}
        >
          <header className="bonus-print-header">
            <div className="bonus-print-brand">
              <span className="bonus-print-mark" aria-hidden="true">GL</span>
              <div>
                <p className="bonus-print-brand-name">GrowLink</p>
                <p className="bonus-print-brand-subtitle">Farm Data Platform</p>
              </div>
            </div>
            <h1>Employee Bonus Statement</h1>
          </header>

          <div className="bonus-print-meta">
            <div>
              <span>Employee</span>
              <strong>{group.employeeName}</strong>
            </div>
            <div>
              <span>Date range</span>
              <strong>{dateRangeLabel}</strong>
            </div>
            <div>
              <span>Job type</span>
              <strong>{jobLabel}</strong>
            </div>
            <div>
              <span>Total qualifying hours</span>
              <strong>{group.totalQualifyingHours}</strong>
            </div>
            <div>
              <span>Total bonus</span>
              <strong>{formatCAD(group.totalBonus)}</strong>
            </div>
          </div>

          <table className="bonus-print-table">
            <thead>
              <tr>
                <th>Week</th>
                <th>Job</th>
                <th>Production speed</th>
                <th>Hours worked</th>
                <th>Bonus threshold reached</th>
                <th>Bonus rate per hour</th>
                <th>Total bonus</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {group.weeks.map((week) => (
                <tr key={week.key}>
                  <td>{formatWeekLabel(week.weekStart)}</td>
                  <td>{JOB_LABEL[week.checkType]}</td>
                  <td>
                    {Math.round(week.avgSpeed * 100) / 100} {week.speedUnit}
                    {week.entries.length > 1 ? " (avg)" : ""}
                  </td>
                  <td>{week.totalHours}</td>
                  <td>{week.thresholdLabel}</td>
                  <td>{formatCAD(week.entries.length === 1 ? week.entries[0].applied_rate : week.blendedRate)}</td>
                  <td>{formatCAD(week.totalBonus)}</td>
                  <td>{buildWeekExplanation(week)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="bonus-print-summary">
            <div>
              <span>Total hours</span>
              <strong>{group.totalHours}</strong>
            </div>
            <div>
              <span>Total bonus</span>
              <strong>{formatCAD(group.totalBonus)}</strong>
            </div>
          </div>
          <p className="bonus-print-thanks">Thank you for your hard work.</p>
        </section>
      ))}
    </div>,
    document.body
  );
}
