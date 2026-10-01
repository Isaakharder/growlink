import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { displayMatrix, tableHeader, type WeeklyKgTable } from "./weeklyKgByVariety";

// PDF of the full Weekly kg by Variety table: landscape A4, with the same
// header, cells and rounding as the card (displayMatrix). Headers repeat on
// every page; when there are more varieties than fit, the extra columns go
// onto following pages with the Week column repeated, instead of shrinking
// the text. Loaded on demand (jsPDF is large).

const MARGIN = 36;
const FONT_SIZE = 8.5;
const KG_COLUMN_MIN_WIDTH = 58;
// Wide enough that "Season total" stays on one line in bold.
const WEEK_COLUMN_WIDTH = 66;

export function buildWeeklyKgPdf(
  table: WeeklyKgTable,
  { organizationName, exportedAt }: { organizationName: string | null; exportedAt: Date }
): jsPDF {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const exportDate = exportedAt.toLocaleDateString("en-CA");
  const header = tableHeader(table);
  const { body, foot } = displayMatrix(table);
  const lastColumn = header.length - 1;

  doc.setFontSize(15);
  doc.setTextColor(24, 35, 32);
  doc.text("Weekly kg by Variety", MARGIN, MARGIN + 6);
  doc.setFontSize(9.5);
  doc.setTextColor(75, 90, 85);
  doc.text(
    `${organizationName ?? "Organization"}  ·  ${table.year}  ·  Harvested kg by recorded harvest week  ·  Units: kg`,
    MARGIN,
    MARGIN + 24
  );
  doc.text(`Exported ${exportDate}  ·  ${table.entryCount} entries  ·  "—" = no entry recorded`, MARGIN, MARGIN + 38);

  // Each kg column is at least as wide as its widest value set in bold, so a
  // number never wraps mid-figure (e.g. a seven-figure season total).
  const PADDING = 3.5;
  doc.setFont("helvetica", "bold");
  const widest = (i: number) =>
    Math.max(...[...body.map((row) => row[i]), foot[i]].map((text) => doc.getStringUnitWidth(text) * FONT_SIZE));
  doc.setFont("helvetica", "normal");
  const columnStyles: Record<number, Record<string, unknown>> = {
    0: { cellWidth: WEEK_COLUMN_WIDTH, halign: "left", fontStyle: "bold" }
  };
  for (let i = 1; i <= lastColumn; i += 1) {
    columnStyles[i] = {
      minCellWidth: Math.max(KG_COLUMN_MIN_WIDTH, Math.ceil(widest(i) + 2 * PADDING + 2)),
      halign: "right",
      ...(i === lastColumn ? { fontStyle: "bold" } : {})
    };
  }

  autoTable(doc, {
    head: [header],
    body,
    foot: [foot],
    startY: MARGIN + 50,
    margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN + 10 },
    showHead: "everyPage",
    showFoot: "lastPage",
    horizontalPageBreak: true,
    horizontalPageBreakRepeat: 0,
    styles: {
      fontSize: FONT_SIZE,
      cellPadding: PADDING,
      overflow: "linebreak",
      lineColor: [214, 223, 219],
      lineWidth: 0.5,
      textColor: [24, 35, 32]
    },
    headStyles: { fillColor: [228, 243, 237], textColor: [15, 80, 64], fontStyle: "bold", halign: "center", valign: "middle" },
    footStyles: { fillColor: [238, 245, 242], textColor: [24, 35, 32], fontStyle: "bold", halign: "right" },
    alternateRowStyles: { fillColor: [250, 252, 251] },
    columnStyles
  });

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(110, 122, 118);
    const { width, height } = doc.internal.pageSize;
    doc.text(`Weekly kg by Variety · ${table.year}`, MARGIN, height - MARGIN + 8);
    doc.text(`Page ${page} of ${pages}`, width - MARGIN, height - MARGIN + 8, { align: "right" });
  }
  return doc;
}
