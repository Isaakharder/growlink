// Single shared renderer for every Calibration print record — used by
// DeviceHistoryModal.tsx's batch print root for both layout tiers. Avoids
// having two near-identical render paths (one for the normal/compact
// single-column layout, one for the compact-long two-column layout) that
// would drift out of sync with each other over time; the two tiers differ
// only in which CSS classes get applied (via `variant`), never in what
// data they render or how it's structured.
import { RecordDetail, PrintSection, formatEffectiveDate, buildPrintSections, isCompactRecord, splitSectionsForCompactLayout } from "./recordPrint";

type PrintVariant = "normal" | "long";

function sectionClassNames(variant: PrintVariant) {
  return variant === "long"
    ? {
        section: "calibration-long-record-section",
        title: "calibration-long-record-section-title",
        table: "calibration-long-record-table"
      }
    : {
        section: "calibration-record-print-section calibration-batch-print-task",
        title: "calibration-record-print-section-title",
        table: "calibration-record-print-table"
      };
}

function PrintTaskSection({ section, variant }: { section: PrintSection; variant: PrintVariant }) {
  const classNames = sectionClassNames(variant);
  return (
    <div className={classNames.section}>
      <h3 className={classNames.title}>{section.taskName}</h3>
      <table className={classNames.table}>
        <colgroup>
          <col style={{ width: "60%" }} />
          <col style={{ width: "40%" }} />
        </colgroup>
        {section.showHeader ? (
          <thead>
            <tr><th>{section.fieldColumnLabel}</th><th>{section.answerColumnLabel}</th></tr>
          </thead>
        ) : null}
        <tbody>
          {section.rows.map((row, index) => (
            <tr key={index}>
              <td>{row.label}</td>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrintRecordHeader({ record, variant }: { record: RecordDetail; variant: PrintVariant }) {
  const titleClass = variant === "long" ? "calibration-long-record-title" : "calibration-record-print-title";
  const metaClass = variant === "long" ? "calibration-long-record-meta" : "calibration-record-print-meta";
  return (
    <>
      <h2 className={titleClass}>{record.device_name_snapshot} Calibration Record</h2>
      <div className={metaClass}>
        <div><span>Performed date:</span> {formatEffectiveDate(record.effective_date)}</div>
        <div><span>Employee:</span> {record.completed_by_name}</div>
      </div>
    </>
  );
}

// Long-record tier: two-column layout so a many-row record (e.g. a
// 28-nozzle sprayer) can fit on one printed page. Column split is
// structural (see splitSectionsForCompactLayout), never a device-name check.
function LongRecordPrint({ record, sections }: { record: RecordDetail; sections: PrintSection[] }) {
  const [leftSections, rightSections] = splitSectionsForCompactLayout(sections);
  return (
    <div className="calibration-long-record">
      <PrintRecordHeader record={record} variant="long" />
      <div className="calibration-long-record-tasks">
        <div className="calibration-long-record-column">
          {leftSections.map((section) => <PrintTaskSection key={section.key} section={section} variant="long" />)}
        </div>
        <div className="calibration-long-record-column">
          {rightSections.map((section) => <PrintTaskSection key={section.key} section={section} variant="long" />)}
        </div>
      </div>
    </div>
  );
}

// Normal/compact tier: single-column layout on its own page. Records with
// <=10 total rows (e.g. Scale) additionally get the "compact-record" class
// so they stay intact and the next record can start right underneath them
// on the same page — see isCompactRecord in recordPrint.ts.
function NormalRecordPrint({ record, sections }: { record: RecordDetail; sections: PrintSection[] }) {
  const compact = isCompactRecord(sections);
  return (
    <div className={`calibration-batch-print-record${compact ? " compact-record" : ""}`}>
      <PrintRecordHeader record={record} variant="normal" />
      {sections.map((section) => <PrintTaskSection key={section.key} section={section} variant="normal" />)}
    </div>
  );
}

// Entry point for the batch print root: picks the long or normal tier
// purely from each record's own row count (needsCompactLongLayout), never
// from device name — Scale and Sprayer records both flow through this same
// component and this same decision.
export function PrintRecord({ record, needsLongLayout }: { record: RecordDetail; needsLongLayout: boolean }) {
  const sections = buildPrintSections(record);
  return needsLongLayout
    ? <LongRecordPrint record={record} sections={sections} />
    : <NormalRecordPrint record={record} sections={sections} />;
}
