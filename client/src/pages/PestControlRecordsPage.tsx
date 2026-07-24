import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { apiFetch } from "../lib/api";
import { H1SheetPreview } from "../components/pest/H1SheetPreview";
import { ModalOverlay } from "../components/ModalOverlay";

// ── Pest records types ────────────────────────────────────────────────────────

type ChemicalSnapshot = {
  name?: string;
  chemical_type?: string | null;
  rate_value?: number | null;
  rate_unit?: string | null;
};

type TargetSnapshot = {
  target_mode?: string;
  valve_names?: string[];
  group_names?: string[];
  total_m2?: number | null;
};

type CalcSnapshot = {
  total_chemical_ml?: number | null;
  rate_value?: number | null;
  rate_unit?: string | null;
  area_label?: string | null;
};

type ValveEntry = {
  valveId: string;
  valveName: string;
  areaM2: number;
  productAmount: number;
  productUnit: string;
  completed: boolean;
  completedAt: string | null;
};

type ProgressSnapshot = {
  type?: string;
  valves?: ValveEntry[];
};

type PestRecord = {
  id: string;
  type: "spray" | "drench";
  chemical_snapshot: ChemicalSnapshot;
  target_snapshot: TargetSnapshot;
  calculation_snapshot: CalcSnapshot;
  progress_snapshot: ProgressSnapshot;
  completed_at: string;
  notes: string | null;
};

// ── H1 log type ───────────────────────────────────────────────────────────────

type H1Log = {
  id: string;
  sheet_group_id: string | null;
  // top form
  operation_name: string | null;
  current_crop: string | null;
  previous_year_crops: string | null;
  variety: string | null;
  production_site_information: string | null;
  production_site_area: string | null;
  date_planted: string | null;
  // application row
  application_date: string;
  product_name: string;
  pcp_number: string | null;
  actual_quantity_used: number | null;
  actual_quantity_unit: string | null;
  rate_applied_per_unit: string | null;
  label_instructions_followed: boolean;
  area_quantity_treated_m2: number | null;
  method_of_application: string | null;
  row_house_zones: string | null;
  earliest_allowable_harvest_date: string | null;
  phi_daa: number | null;
  applicator_name: string | null;
  // bottom
  confirmation_signature: string | null;
  confirmation_date: string | null;
  version_label: string;
};

// A virtual "sheet" — one or more H1 logs sharing the same sheet_group_id.
type H1Sheet = {
  sheet_group_id: string;
  logs: H1Log[]; // sorted oldest-first (for display order)
};

// Group a flat list of H1 logs into sheets ordered most-recently-used first.
function groupIntoSheets(logs: H1Log[]): H1Sheet[] {
  const map = new Map<string, H1Log[]>();
  for (const log of logs) {
    const key = log.sheet_group_id ?? log.id;
    const group = map.get(key) ?? [];
    group.push(log);
    map.set(key, group);
  }
  return Array.from(map.entries())
    .map(([sheet_group_id, groupLogs]) => ({
      sheet_group_id,
      // Oldest first within a sheet (row order on the form)
      logs: [...groupLogs].sort((a, b) => a.application_date.localeCompare(b.application_date)),
    }))
    // Most recently used sheet first (newest log date)
    .sort((a, b) => {
      const aLatest = a.logs[a.logs.length - 1]?.application_date ?? "";
      const bLatest = b.logs[b.logs.length - 1]?.application_date ?? "";
      return bLatest.localeCompare(aLatest);
    });
}

// ── Draft type — all fields as strings for form inputs ───────────────────────

type H1Draft = {
  operation_name: string;
  current_crop: string;
  previous_year_crops: string;
  variety: string;
  production_site_information: string;
  production_site_area: string;
  date_planted: string;
  application_date: string;
  product_name: string;
  pcp_number: string;
  actual_quantity_used: string;
  actual_quantity_unit: string;
  rate_applied_per_unit: string;
  label_instructions_followed: boolean;
  area_quantity_treated_m2: string;
  method_of_application: string;
  row_house_zones: string;
  earliest_allowable_harvest_date: string;
  phi_daa: string;
  applicator_name: string;
  confirmation_signature: string;
  confirmation_date: string;
  version_label: string;
};

function logToDraft(log: H1Log): H1Draft {
  return {
    operation_name:                  log.operation_name ?? "",
    current_crop:                    log.current_crop ?? "",
    previous_year_crops:             log.previous_year_crops ?? "",
    variety:                         log.variety ?? "",
    production_site_information:     log.production_site_information ?? "",
    production_site_area:            log.production_site_area ?? "",
    date_planted:                    log.date_planted ?? "",
    application_date:                log.application_date ?? "",
    product_name:                    log.product_name ?? "",
    pcp_number:                      log.pcp_number ?? "",
    actual_quantity_used:            log.actual_quantity_used != null ? String(log.actual_quantity_used) : "",
    actual_quantity_unit:            log.actual_quantity_unit ?? "",
    rate_applied_per_unit:           log.rate_applied_per_unit ?? "",
    label_instructions_followed:     log.label_instructions_followed,
    area_quantity_treated_m2:        log.area_quantity_treated_m2 != null ? String(log.area_quantity_treated_m2) : "",
    method_of_application:           log.method_of_application ?? "",
    row_house_zones:                 log.row_house_zones ?? "",
    earliest_allowable_harvest_date: log.earliest_allowable_harvest_date ?? "",
    phi_daa:                         log.phi_daa != null ? String(log.phi_daa) : "",
    applicator_name:                 log.applicator_name ?? "",
    confirmation_signature:          log.confirmation_signature ?? "",
    confirmation_date:               log.confirmation_date ?? "",
    version_label:                   log.version_label ?? "Version 11.0",
  };
}

// Build a PATCH body from a draft, converting blanks to null and coercing numbers
function draftToPayload(d: H1Draft): Record<string, unknown> {
  const str = (v: string) => v.trim() || null;
  const num = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const int = (v: string) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
  return {
    operation_name:                  str(d.operation_name),
    current_crop:                    str(d.current_crop),
    previous_year_crops:             str(d.previous_year_crops),
    variety:                         str(d.variety),
    production_site_information:     str(d.production_site_information),
    production_site_area:            str(d.production_site_area),
    date_planted:                    date(d.date_planted),
    application_date:                d.application_date,
    product_name:                    str(d.product_name) ?? d.product_name,
    pcp_number:                      str(d.pcp_number),
    actual_quantity_used:            num(d.actual_quantity_used),
    actual_quantity_unit:            str(d.actual_quantity_unit),
    rate_applied_per_unit:           str(d.rate_applied_per_unit),
    label_instructions_followed:     d.label_instructions_followed,
    area_quantity_treated_m2:        num(d.area_quantity_treated_m2),
    method_of_application:           str(d.method_of_application),
    row_house_zones:                 str(d.row_house_zones),
    earliest_allowable_harvest_date: date(d.earliest_allowable_harvest_date),
    phi_daa:                         int(d.phi_daa),
    applicator_name:                 str(d.applicator_name),
    confirmation_signature:          str(d.confirmation_signature),
    confirmation_date:               date(d.confirmation_date),
    version_label:                   str(d.version_label) ?? "Version 11.0",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RATE_UNIT_LABELS: Record<string, string> = {
  ml_per_acre: "ml/acre", L_per_acre: "L/acre",
  ml_per_hectare: "ml/hectare", L_per_hectare: "L/hectare",
  g_per_acre: "g/acre", kg_per_acre: "kg/acre",
  g_per_hectare: "g/hectare", kg_per_hectare: "kg/hectare",
};

function isDryUnit(rateUnit: string | null | undefined): boolean {
  return !!(rateUnit?.startsWith("g_") || rateUnit?.startsWith("kg_"));
}

function formatProductTotal(calc: CalcSnapshot): string {
  const raw = calc.total_chemical_ml;
  if (raw == null || !Number.isFinite(raw)) return "—";
  const dry = isDryUnit(calc.rate_unit);
  if (dry) return raw >= 1000 ? `${(raw / 1000).toFixed(2)} kg` : `${Math.round(raw)} g`;
  return raw >= 1000 ? `${(raw / 1000).toFixed(2)} L` : `${raw.toFixed(1)} ml`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function targetSummary(target: TargetSnapshot): string {
  if (target.target_mode === "valve" && target.valve_names?.length) return target.valve_names.join(", ");
  if (target.group_names?.length) return target.group_names.join(", ");
  return "—";
}

function formatValveAmount(v: ValveEntry): string {
  const rounded = v.productUnit === "g"
    ? Math.round(v.productAmount / 5) * 5
    : Math.round(v.productAmount * 10) / 10;
  return `${rounded.toLocaleString()} ${v.productUnit}`;
}

// ── H1 PDF generation ─────────────────────────────────────────────────────────
// Accepts an array of H1Log rows (one sheet). Layout mirrors H1SheetPreview:
// CanadaGAP style, white background, black borders, same field order.

function generateH1Pdf(logs: H1Log[]): void {
  if (logs.length === 0) return;

  const header = logs[0]; // sheet header fields live on the first/oldest log

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.width;   // 297 mm
  const pageH = doc.internal.pageSize.height;  // 210 mm
  const mL = 10;
  const mR = 10;
  const cW = pageW - mL - mR;                  // 277 mm content width

  // ── Colors (defined early so outer border can use them) ───────────────────
  const BLK: [number, number, number] = [0, 0, 0];
  const GRY: [number, number, number] = [80, 80, 80];
  const WHT: [number, number, number] = [255, 255, 255];

  // ── Thick outer border (matches CanadaGAP original) ───────────────────────
  doc.setDrawColor(...BLK);
  doc.setLineWidth(1.5);
  doc.rect(8, 8, pageW - 16, pageH - 16);

  // ── Local helpers ──────────────────────────────────────────────────────────

  function fmtD(iso: string | null | undefined): string {
    if (!iso?.trim()) return "";
    try {
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
        year: "numeric", month: "short", day: "numeric",
      });
    } catch { return iso ?? ""; }
  }

  function fmtQty(log: H1Log): string {
    if (log.actual_quantity_used == null) return "";
    const u = log.actual_quantity_unit?.trim() ?? "";
    return u ? `${log.actual_quantity_used} ${u}` : String(log.actual_quantity_used);
  }

  function fmtRate(log: H1Log): string {
    const stored = log.rate_applied_per_unit?.trim();
    if (stored) return stored;
    const { actual_quantity_used: qty, area_quantity_treated_m2: areaM2, actual_quantity_unit: unit } = log;
    if (qty == null || areaM2 == null || areaM2 <= 0 || !unit?.trim()) return "";
    const ha = areaM2 / 10000;
    return `${Math.round(qty / ha * 100) / 100} ${unit.trim()}/ha`;
  }

  const lastY = () =>
    (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY ?? 0;

  // ── ONGOING box — top-right corner, shares edges with outer border ─────────

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setDrawColor(...BLK);
  doc.setLineWidth(0.4);
  const ongoingTxt = "ONGOING";
  const ongoingW = doc.getTextWidth(ongoingTxt) + 6;
  const ongoingX = pageW - 8 - ongoingW;   // flush with outer border right edge
  doc.rect(ongoingX, 8, ongoingW, 10);      // top aligned with outer border
  doc.setTextColor(...BLK);
  doc.text(ongoingTxt, ongoingX + ongoingW / 2, 14.5, { align: "center" });

  // ── Title ──────────────────────────────────────────────────────────────────

  let y = 16;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BLK);
  doc.text("H1.", mL, y);
  const afterH1 = mL + doc.getTextWidth("H1.") + 1.5;
  doc.text("Agronomic Inputs", afterH1, y);
  const afterBold = afterH1 + doc.getTextWidth("Agronomic Inputs");
  doc.setFont("helvetica", "normal");
  doc.text(" (Agricultural Chemicals)", afterBold, y);

  // ── Instructions (italic, black — no green bar, matches original) ──────────

  y += 4;
  doc.setFontSize(5.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(...BLK);
  const instrText =
    "Instructions: Includes all applications from pre-planting, through harvest, and including " +
    "post-harvest applications (e.g., during packing, before, during or after storage, before " +
    "holding, etc.). One Form must be completed for EACH PRODUCTION SITE.";
  const instrLines = doc.splitTextToSize(instrText, cW);
  doc.text(instrLines, mL, y);
  y += instrLines.length * 2.8 + 1.5;

  // ── Top info block — manual drawing for exact in-cell label/value layout ──
  // Each bordered cell contains a small bold gray label on top and the value below.

  doc.setDrawColor(...BLK);
  doc.setLineWidth(0.3);

  function infoCell(
    cx: number, cy: number, cw: number, ch: number,
    label: string, value: string
  ) {
    doc.rect(cx, cy, cw, ch);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(5.5);
    doc.setTextColor(...GRY);
    doc.text(label, cx + 1.5, cy + 3.2);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...BLK);
    const lines = doc.splitTextToSize(value, cw - 3);
    doc.text(lines[0] ?? "", cx + 1.5, cy + 7.2);
  }

  // Row 1: Operation Name | Current Crop | Previous Year Crop(s) | Variety
  // Proportions: 3fr 2fr 3fr 2fr = 30% 20% 30% 20%
  const r1h = 10;
  const r1w0 = Math.round(cW * 0.30);
  const r1w1 = Math.round(cW * 0.20);
  const r1w2 = Math.round(cW * 0.30);
  const r1w3 = cW - r1w0 - r1w1 - r1w2;
  infoCell(mL,               y, r1w0, r1h, "Operation Name:", header.operation_name ?? "");
  infoCell(mL + r1w0,        y, r1w1, r1h, "Current Crop:", header.current_crop ?? "");
  infoCell(mL + r1w0 + r1w1, y, r1w2, r1h, "Previous Year Crop(s):", header.previous_year_crops ?? "");
  infoCell(mL + r1w0 + r1w1 + r1w2, y, r1w3, r1h, "Variety:", header.variety ?? "");
  y += r1h;

  // Row 2: Production Site Information | Production Site Area | Date Planted
  // Proportions: 4fr 3fr 2fr = 44% 33% 22%
  const r2h = 10;
  const r2w0 = Math.round(cW * 0.44);
  const r2w1 = Math.round(cW * 0.33);
  const r2w2 = cW - r2w0 - r2w1;
  infoCell(mL,         y, r2w0, r2h, "Production Site Information (e.g., Row/House/Zone #):", header.production_site_information ?? "");
  infoCell(mL + r2w0,  y, r2w1, r2h, "Production Site Area (e.g., # of acres/hectares per Row/House/Zone #):", header.production_site_area ?? "");
  infoCell(mL + r2w0 + r2w1, y, r2w2, r2h, "Date Planted:", fmtD(header.date_planted));
  y += r2h;

  // ── Application table ──────────────────────────────────────────────────────
  // Column widths match H1SheetPreview colgroup percentages.

  const colPcts = [0.07, 0.09, 0.06, 0.08, 0.08, 0.06, 0.08, 0.08, 0.09, 0.08, 0.05, 0.18];
  const colW = colPcts.map(p => Math.round(cW * p));
  // Give rounding remainder to the signature column (last)
  colW[11] = cW - colW.slice(0, 11).reduce((a, b) => a + b, 0);

  const SHEET_CAPACITY = 10;
  const blankCount = Math.max(0, SHEET_CAPACITY - logs.length);

  const dataRows = logs.map(log => [
    fmtD(log.application_date),
    log.product_name ?? "",
    log.pcp_number ?? "",
    fmtQty(log),
    fmtRate(log),
    log.label_instructions_followed ? "✓" : "No",
    log.area_quantity_treated_m2 != null ? `${log.area_quantity_treated_m2} m²` : "",
    log.method_of_application ?? "",
    log.row_house_zones ?? "",
    fmtD(log.earliest_allowable_harvest_date),
    log.phi_daa != null ? String(log.phi_daa) : "",
    log.applicator_name ?? "",
  ]);

  const blankRows = Array.from({ length: blankCount }, () => Array<string>(12).fill(""));

  autoTable(doc, {
    startY: y,
    head: [[
      "Application Date",
      "Product/Trade Name",
      "PCP #",
      "Actual Quantity Used (e.g., 22.28 kg)",
      "Rate Applied Per Unit",
      "Label Instructions Followed (✓)",
      "Area/Quantity Treated",
      "Method of Application",
      "Row/House/Zone#/Pallet/Bin Tag/Lot ID",
      "Earliest Allowable Harvest Date (EAHD)",
      "PHI/DAA",
      "Signature of Applicator or if Custom Application Invoice is Attached",
    ]],
    body: [...dataRows, ...blankRows],
    headStyles: {
      fillColor: WHT,
      textColor: BLK,
      fontStyle: "bold",
      fontSize: 5.5,
      cellPadding: { top: 1.5, bottom: 1.5, left: 1.5, right: 1 },
      lineWidth: 0.3,
      lineColor: BLK,
      halign: "center",
      valign: "middle",
      overflow: "linebreak",
      minCellHeight: 0,
    },
    bodyStyles: {
      fillColor: WHT,
      textColor: BLK,
      fontSize: 7,
      cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1 },
      lineWidth: 0.3,
      lineColor: BLK,
      minCellHeight: 12,
      overflow: "linebreak",
    },
    columnStyles: {
      0:  { cellWidth: colW[0] },
      1:  { cellWidth: colW[1] },
      2:  { cellWidth: colW[2] },
      3:  { cellWidth: colW[3] },
      4:  { cellWidth: colW[4] },
      5:  { cellWidth: colW[5], halign: "center" },
      6:  { cellWidth: colW[6] },
      7:  { cellWidth: colW[7] },
      8:  { cellWidth: colW[8] },
      9:  { cellWidth: colW[9] },
      10: { cellWidth: colW[10], halign: "center" },
      11: { cellWidth: colW[11] },
    },
    theme: "plain",
    margin: { left: mL, right: mR },
  });

  // ── Confirmation section ───────────────────────────────────────────────────

  const confY = lastY() + 5;
  doc.setFont("helvetica", "bolditalic");
  doc.setFontSize(8);
  doc.setTextColor(...BLK);
  doc.setDrawColor(...BLK);
  doc.setLineWidth(0.3);

  // Confirmation Signature
  const sigLabel = "Confirmation Signature:";
  doc.text(sigLabel, mL, confY);
  const sigLabelW = doc.getTextWidth(sigLabel);
  doc.setFont("helvetica", "normal");
  doc.text(header.confirmation_signature ?? "", mL + sigLabelW + 2, confY);
  doc.line(mL + sigLabelW + 1, confY + 1, mL + cW * 0.42, confY + 1);

  // Date
  const dateX = mL + cW * 0.60;
  doc.setFont("helvetica", "bolditalic");
  doc.text("Date:", dateX, confY);
  const dateLW = doc.getTextWidth("Date:");
  doc.setFont("helvetica", "normal");
  doc.text(fmtD(header.confirmation_date), dateX + dateLW + 2, confY);
  doc.line(dateX + dateLW + 1, confY + 1, pageW - mR, confY + 1);

  // ── Footer ─────────────────────────────────────────────────────────────────

  // Footer — pinned inside outer border (bottom at y=202), three right-hand lines
  const footY = pageH - 11;   // = 199, inside outer border bottom (202)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.5);
  doc.setTextColor(...BLK);
  doc.text(header.version_label ?? "Version 11.0", mL, footY);

  doc.setFont("helvetica", "italic");
  const cgL1 = "CanadaGAP Food Safety Manual for";
  const cgL2 = "Greenhouse Product";
  const cgL3 = "2026";
  const cgW = Math.max(doc.getTextWidth(cgL1), doc.getTextWidth(cgL2), doc.getTextWidth(cgL3));
  doc.text(cgL1, pageW - mR - cgW, footY - 5);
  doc.text(cgL2, pageW - mR - cgW, footY - 2.5);
  doc.text(cgL3, pageW - mR - cgW, footY);

  // ── Save ───────────────────────────────────────────────────────────────────

  const safeDate = (header.application_date ?? "").replace(/-/g, "");
  const safeName = (header.product_name ?? "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
  doc.save(`H1_${safeDate}_${safeName}.pdf`);
}

// ── H1 Preview Modal ──────────────────────────────────────────────────────────
// Shows the H1 form as a read-only document. Provides Print / Download PDF /
// Edit Sheet / Close actions. "Edit Sheet" opens the editable H1Modal.

function H1PreviewModal({
  sheet,
  onClose,
  onEditLog,
}: {
  sheet: H1Sheet;
  onClose: () => void;
  onEditLog: (log: H1Log) => void;
}) {
  const { logs } = sheet;

  function handleDownloadPdf() {
    generateH1Pdf(logs);
  }

  const recordLabel = logs.length === 1 ? "1 record" : `${logs.length} records`;

  return (
    <ModalOverlay
      onClose={onClose}
      contentClassName="h1-preview-modal"
      titleId="h1-preview-modal-title"
      contentStyle={{
        width: "min(1140px, 98vw)",
        maxHeight: "calc(100vh - 2rem)",
        overflowY: "auto",
        background: "#fff",
        border: "1px solid #ccc",
        borderRadius: "10px",
        boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
      }}
    >
        {/* Modal header — hidden on print */}
        <div
          className="h1-preview-header"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            padding: "0.85rem 1.25rem 0.75rem",
            borderBottom: "1px solid #e0e0e0",
            background: "#fafafa",
            borderRadius: "10px 10px 0 0",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 auto" }}>
            <h2 id="h1-preview-modal-title" style={{ margin: 0, fontSize: "1rem", fontWeight: 700, color: "#111" }}>
              H1 Agronomic Inputs
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "0.78rem", color: "#666" }}>{recordLabel}</p>
          </div>
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
            <button type="button" className="secondary" style={{ fontSize: "0.84rem" }} onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="secondary" style={{ fontSize: "0.84rem" }} onClick={handleDownloadPdf}>
              Download PDF
            </button>
            <button type="button" className="secondary" style={{ fontSize: "0.84rem" }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {/* Preview body — rows have inline Edit buttons */}
        <div style={{ padding: "1rem 1.25rem", overflowX: "auto" }}>
          <H1SheetPreview logs={logs} onEditLog={onEditLog} />
        </div>
    </ModalOverlay>
  );
}

// ── H1 Sheet Modal ────────────────────────────────────────────────────────────

function H1Modal({
  log,
  onClose,
  onSaved,
}: {
  log: H1Log;
  onClose: () => void;
  onSaved: (updated: H1Log) => void;
}) {
  const [draft, setDraft] = useState<H1Draft>(() => logToDraft(log));
  const savedRef = useRef<H1Draft>(logToDraft(log));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  function set(field: keyof H1Draft, value: string | boolean) {
    setDraft((prev) => {
      const next = { ...prev, [field]: value };
      setDirty(JSON.stringify(next) !== JSON.stringify(savedRef.current));
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/records/h1/${log.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToPayload(draft)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save");
      }
      const updated = (await res.json()) as H1Log;
      savedRef.current = logToDraft(updated);
      setDraft(savedRef.current);
      setDirty(false);
      onSaved(updated);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleExportPdf() {
    setExporting(true);
    // Build an H1Log from current draft values so the PDF uses edited data
    const logFromDraft: H1Log = {
      ...log,
      operation_name:                  draft.operation_name || null,
      current_crop:                    draft.current_crop || null,
      previous_year_crops:             draft.previous_year_crops || null,
      variety:                         draft.variety || null,
      production_site_information:     draft.production_site_information || null,
      production_site_area:            draft.production_site_area || null,
      date_planted:                    draft.date_planted || null,
      application_date:                draft.application_date,
      product_name:                    draft.product_name,
      pcp_number:                      draft.pcp_number || null,
      actual_quantity_used:            parseFloat(draft.actual_quantity_used) || null,
      actual_quantity_unit:            draft.actual_quantity_unit || null,
      rate_applied_per_unit:           draft.rate_applied_per_unit || null,
      label_instructions_followed:     draft.label_instructions_followed,
      area_quantity_treated_m2:        parseFloat(draft.area_quantity_treated_m2) || null,
      method_of_application:           draft.method_of_application || null,
      row_house_zones:                 draft.row_house_zones || null,
      earliest_allowable_harvest_date: draft.earliest_allowable_harvest_date || null,
      phi_daa:                         parseInt(draft.phi_daa, 10) || null,
      applicator_name:                 draft.applicator_name || null,
      confirmation_signature:          draft.confirmation_signature || null,
      confirmation_date:               draft.confirmation_date || null,
      version_label:                   draft.version_label || "Version 11.0",
    };
    try {
      generateH1Pdf([logFromDraft]);
    } finally {
      setExporting(false);
    }
  }

  // ── Shared styles for form-cell layout ────────────────────────────────────
  // Each field is rendered as a bordered cell (like the CanadaGAP form columns)
  // with a small uppercase label on top and a plain input below.

  const cell: React.CSSProperties = {
    border: "1px solid #ccc",
    padding: "4px 6px 5px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    background: "#fff",
  };

  const cellLabel: React.CSSProperties = {
    fontSize: "0.6rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#555",
    lineHeight: 1.2,
    userSelect: "none",
  };

  const cellInput: React.CSSProperties = {
    border: "none",
    background: "transparent",
    width: "100%",
    padding: "1px 0",
    fontSize: "0.84rem",
    color: "var(--text, #111)",
    fontFamily: "inherit",
    lineHeight: 1.4,
    minWidth: 0,
  };

  const cellSelect: React.CSSProperties = {
    ...cellInput,
    appearance: "auto" as React.CSSProperties["appearance"],
    cursor: "pointer",
  };

  // Section divider: thin green accent bar + uppercase label
  function SectionHeader({ title }: { title: string }) {
    return (
      <div style={{ marginTop: "1rem", marginBottom: "0" }}>
        <div style={{ height: "2px", background: "#1a5c3a", marginBottom: "4px" }} />
        <span style={{
          fontSize: "0.65rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "#1a5c3a",
        }}>
          {title}
        </span>
      </div>
    );
  }

  // Wrapper for a bordered table-like grid of cells
  const grid4: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    // Collapse adjacent cell borders so each shared edge is 1px, not 2px
    borderTop: "1px solid #ccc",
    borderLeft: "1px solid #ccc",
    marginTop: "3px",
  };

  // Individual cell inside the collapsed-border grid
  const gridCell: React.CSSProperties = {
    ...cell,
    border: "none",
    borderRight: "1px solid #ccc",
    borderBottom: "1px solid #ccc",
  };

  return (
    <ModalOverlay
      onClose={onClose}
      titleId="h1-row-editor-title"
      contentStyle={{
        width: "min(1000px, 98vw)",
        maxHeight: "calc(100vh - 2rem)",
        overflowY: "auto",
        background: "#fff",
        border: "1px solid #ccc",
        borderRadius: "10px",
        boxShadow: "0 6px 32px rgba(0,0,0,0.15)",
        padding: "1.25rem 1.5rem 1.5rem",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
        {/* ── Modal header ────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "4px" }}>
          <h2 id="h1-row-editor-title" style={{ margin: 0, fontSize: "1rem", fontWeight: 700, color: "#111" }}>
            H1 Sheet Row Editor
          </h2>
          {dirty ? (
            <span style={{ fontSize: "0.75rem", color: "#888", fontStyle: "italic" }}>
              Unsaved changes
            </span>
          ) : null}
        </div>
        <p style={{ margin: "0 0 4px", fontSize: "0.72rem", color: "#666" }}>
          CanadaGAP Food Safety &amp; Traceability — {draft.version_label}
        </p>

        {saveError ? (
          <p className="form-error" style={{ marginTop: "0.5rem" }}>{saveError}</p>
        ) : null}

        {/* ════════════════════════════════════════════════════════════════
            SITE INFORMATION
            ════════════════════════════════════════════════════════════════ */}
        <SectionHeader title="Site Information" />

        {/* Row 1: 4 equal columns */}
        <div style={{ ...grid4, gridTemplateColumns: "3fr 2fr 3fr 2fr" }}>
          <div style={gridCell}>
            <span style={cellLabel}>Operation Name</span>
            <input style={cellInput} value={draft.operation_name}
              onChange={(e) => set("operation_name", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Current Crop</span>
            <input style={cellInput} value={draft.current_crop}
              onChange={(e) => set("current_crop", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Previous Year Crop(s)</span>
            <input style={cellInput} value={draft.previous_year_crops}
              onChange={(e) => set("previous_year_crops", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Variety</span>
            <input style={cellInput} value={draft.variety}
              onChange={(e) => set("variety", e.target.value)} />
          </div>
        </div>

        {/* Row 2: Production Site Info | Production Site Area | Date Planted */}
        <div style={{ ...grid4, gridTemplateColumns: "4fr 3fr 2fr", borderTop: "none" }}>
          <div style={gridCell}>
            <span style={cellLabel}>Production Site Information <span style={{ fontWeight: 400 }}>(e.g., Row/House/Zone #)</span></span>
            <input style={cellInput} value={draft.production_site_information}
              onChange={(e) => set("production_site_information", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Production Site Area <span style={{ fontWeight: 400 }}>(e.g., # of acres/hectares)</span></span>
            <input style={cellInput} value={draft.production_site_area}
              onChange={(e) => set("production_site_area", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Date Planted</span>
            <input style={cellInput} type="date" value={draft.date_planted}
              onChange={(e) => set("date_planted", e.target.value)} />
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════════
            APPLICATION DETAILS
            ════════════════════════════════════════════════════════════════ */}
        <SectionHeader title="Application Details" />

        {/* Row 1: Application Date | Product/Trade Name | PCP # | Rate Applied Per Unit */}
        <div style={grid4}>
          <div style={gridCell}>
            <span style={cellLabel}>Application Date</span>
            <input style={cellInput} type="date" value={draft.application_date}
              onChange={(e) => set("application_date", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Product / Trade Name</span>
            <input style={cellInput} value={draft.product_name}
              onChange={(e) => set("product_name", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>PCP #</span>
            <input style={cellInput} value={draft.pcp_number}
              onChange={(e) => set("pcp_number", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Rate Applied Per Unit</span>
            <input style={cellInput} value={draft.rate_applied_per_unit}
              onChange={(e) => set("rate_applied_per_unit", e.target.value)} />
          </div>
        </div>

        {/* Row 2: Actual Qty Used | Unit | Label Instructions | Area Treated */}
        <div style={{ ...grid4, borderTop: "none" }}>
          <div style={gridCell}>
            <span style={cellLabel}>Actual Quantity Used</span>
            <input style={cellInput} type="number" step="any" value={draft.actual_quantity_used}
              onChange={(e) => set("actual_quantity_used", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Quantity Unit</span>
            <input style={cellInput} value={draft.actual_quantity_unit}
              onChange={(e) => set("actual_quantity_unit", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Label Instructions Followed</span>
            <select style={cellSelect}
              value={draft.label_instructions_followed ? "yes" : "no"}
              onChange={(e) => set("label_instructions_followed", e.target.value === "yes")}
            >
              <option value="yes">Yes (✓)</option>
              <option value="no">No</option>
            </select>
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Area / Quantity Treated (m²)</span>
            <input style={cellInput} type="number" step="any" value={draft.area_quantity_treated_m2}
              onChange={(e) => set("area_quantity_treated_m2", e.target.value)} />
          </div>
        </div>

        {/* Row 3: Method | Row/House/Zone (span 2) | Earliest Harvest Date */}
        <div style={{ ...grid4, borderTop: "none" }}>
          <div style={gridCell}>
            <span style={cellLabel}>Method of Application</span>
            <input style={cellInput} value={draft.method_of_application}
              onChange={(e) => set("method_of_application", e.target.value)} />
          </div>
          <div style={{ ...gridCell, gridColumn: "span 2" }}>
            <span style={cellLabel}>Row / House / Zone # / Pallet / Bin Tag / Lot ID</span>
            <input style={cellInput} value={draft.row_house_zones}
              onChange={(e) => set("row_house_zones", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Earliest Allowable Harvest Date (EAHD)</span>
            <input style={cellInput} type="date" value={draft.earliest_allowable_harvest_date}
              onChange={(e) => set("earliest_allowable_harvest_date", e.target.value)} />
          </div>
        </div>

        {/* Row 4: PHI/DAA | Signature of Applicator (span 3) */}
        <div style={{ ...grid4, borderTop: "none" }}>
          <div style={gridCell}>
            <span style={cellLabel}>PHI / DAA (days)</span>
            <input style={cellInput} type="number" step="1" value={draft.phi_daa}
              onChange={(e) => set("phi_daa", e.target.value)} />
          </div>
          <div style={{ ...gridCell, gridColumn: "span 3" }}>
            <span style={cellLabel}>Signature of Applicator or if Custom Application Invoice is Attached</span>
            <input style={cellInput} value={draft.applicator_name}
              onChange={(e) => set("applicator_name", e.target.value)} />
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════════
            CONFIRMATION
            ════════════════════════════════════════════════════════════════ */}
        <SectionHeader title="Confirmation" />

        <div style={{ ...grid4, gridTemplateColumns: "1fr 1fr", borderTop: "1px solid #ccc" }}>
          <div style={gridCell}>
            <span style={cellLabel}>Confirmation Signature</span>
            <input style={cellInput} value={draft.confirmation_signature}
              onChange={(e) => set("confirmation_signature", e.target.value)} />
          </div>
          <div style={gridCell}>
            <span style={cellLabel}>Date</span>
            <input style={cellInput} type="date" value={draft.confirmation_date}
              onChange={(e) => set("confirmation_date", e.target.value)} />
          </div>
        </div>

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: "0.6rem", marginTop: "1rem", flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => void handleSave()}
            style={{ opacity: !dirty ? 0.5 : 1 }}
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={exporting}
            onClick={handleExportPdf}
          >
            {exporting ? "Generating…" : "Export PDF"}
          </button>
          <button
            type="button"
            className="secondary"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
    </ModalOverlay>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

type Tab = "records" | "h1";

export function PestControlRecordsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("records");

  // ── Pest records state
  const [records, setRecords]         = useState<PestRecord[]>([]);
  const [recordsLoading, setRLoading] = useState(true);
  const [recordsError, setRError]     = useState<string | null>(null);
  const [expandedId, setExpandedId]   = useState<string | null>(null);

  // ── H1 logs state
  const [h1Logs, setH1Logs]           = useState<H1Log[]>([]);
  const [h1Loading, setH1Loading]     = useState(false);
  const [h1Error, setH1Error]         = useState<string | null>(null);
  const [previewSheet, setPreviewSheet] = useState<H1Sheet | null>(null);
  const [openLog, setOpenLog]         = useState<H1Log | null>(null);
  // Tracks whether the initial H1 fetch has been attempted so the effect
  // never fires more than once per tab-open even if loading/error state changes.
  const h1FetchedRef = useRef(false);

  // Derived: flat logs → grouped sheets
  const h1Sheets = groupIntoSheets(h1Logs);

  const loadH1Logs = useCallback(async () => {
    setH1Loading(true);
    setH1Error(null);
    try {
      const res = await apiFetch("/api/records/h1");
      if (!res.ok) throw new Error(`Failed to load H1 logs (${res.status})`);
      setH1Logs((await res.json()) as H1Log[]);
    } catch (err) {
      setH1Error(err instanceof Error ? err.message : "Failed to load H1 logs");
    } finally {
      setH1Loading(false);
    }
  }, []);

  useEffect(() => {
    async function fetchRecords() {
      setRLoading(true);
      setRError(null);
      try {
        const res = await apiFetch("/api/pest/records");
        if (!res.ok) throw new Error("Failed to load records");
        setRecords((await res.json()) as PestRecord[]);
      } catch (err) {
        setRError(err instanceof Error ? err.message : "Failed to load records");
      } finally {
        setRLoading(false);
      }
    }
    void fetchRecords();
  }, []);

  useEffect(() => {
    if (activeTab !== "h1" || h1FetchedRef.current) return;
    h1FetchedRef.current = true;
    void loadH1Logs();
  }, [activeTab, loadH1Logs]);

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function handleLogSaved(updated: H1Log) {
    setH1Logs((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
    setOpenLog(updated);
  }

  function handleEditorClose() {
    // Return to the preview after editing, refreshing the sheet from current logs state.
    // openLog at close time holds the latest saved version (handleLogSaved keeps it fresh).
    if (openLog) {
      const sheetGroupId = openLog.sheet_group_id ?? openLog.id;
      // Rebuild the sheet from the updated logs list
      const updatedLogs = h1Logs.map((l) => (l.id === openLog.id ? openLog : l));
      const updatedSheets = groupIntoSheets(updatedLogs);
      const refreshedSheet = updatedSheets.find((s) => s.sheet_group_id === sheetGroupId);
      setPreviewSheet(refreshedSheet ?? null);
    }
    setOpenLog(null);
  }

  function handleOpenSheet(sheet: H1Sheet) {
    setPreviewSheet(sheet);
  }

  function handleEditLog(log: H1Log) {
    setOpenLog(log);
    setPreviewSheet(null);
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "0.5rem 1rem",
    border: "none",
    borderBottom: active ? "2px solid var(--accent, #2a7f2a)" : "2px solid transparent",
    background: "transparent",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    color: active ? "var(--accent, #2a7f2a)" : "var(--text-muted)",
    fontSize: "0.9rem",
  });

  return (
    <section className="page-shell">
      <header>
        <h1>Pest Control Records</h1>
        <p>Completed spray and drench application records.</p>
      </header>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: "0.25rem", marginBottom: "1.25rem", borderBottom: "1px solid var(--border)" }}>
        <button type="button" style={tabStyle(activeTab === "records")} onClick={() => setActiveTab("records")}>
          Spray / Drench Records
        </button>
        <button type="button" style={tabStyle(activeTab === "h1")} onClick={() => setActiveTab("h1")}>
          H1 Sheets
        </button>
      </div>

      {/* ── Records tab ──────────────────────────────────────────────────────── */}
      {activeTab === "records" ? (
        <>
          {recordsError ? <p className="form-error">{recordsError}</p> : null}
          <div className="coming-soon-card">
            {recordsLoading ? (
              <p>Loading records…</p>
            ) : records.length === 0 ? (
              <p style={{ color: "var(--text-muted)" }}>No pest control records yet.</p>
            ) : (
              <div className="varieties-table-wrapper">
                <table className="varieties-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Chemical</th>
                      <th>Target</th>
                      <th>Product used</th>
                      <th>Area</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((rec) => {
                      const chem     = rec.chemical_snapshot;
                      const calc     = rec.calculation_snapshot;
                      const target   = rec.target_snapshot;
                      const prog     = rec.progress_snapshot;
                      const isExp    = expandedId === rec.id;
                      const isValve  = prog.type === "valve_drench" && Array.isArray(prog.valves);
                      return (
                        <Fragment key={rec.id}>
                          <tr>
                            <td style={{ whiteSpace: "nowrap" }}>{formatDate(rec.completed_at)}</td>
                            <td>
                              <span className="pest-todo-type-badge" data-type={rec.type}>
                                {rec.type === "spray" ? "Spray" : "Drench"}
                              </span>
                            </td>
                            <td>
                              <strong>{chem.name ?? "—"}</strong>
                              {chem.chemical_type ? (
                                <span style={{ display: "block", fontSize: "0.78em", color: "var(--text-muted)" }}>
                                  {chem.chemical_type.charAt(0).toUpperCase() + chem.chemical_type.slice(1)}
                                </span>
                              ) : null}
                            </td>
                            <td style={{ maxWidth: "180px" }}>
                              <span style={{ fontSize: "0.88em" }}>{targetSummary(target)}</span>
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              <strong>{formatProductTotal(calc)}</strong>
                              {calc.rate_value != null && calc.rate_unit ? (
                                <span style={{ display: "block", fontSize: "0.78em", color: "var(--text-muted)" }}>
                                  @ {calc.rate_value} {RATE_UNIT_LABELS[calc.rate_unit] ?? calc.rate_unit}
                                </span>
                              ) : null}
                            </td>
                            <td style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                              {calc.area_label ?? (target.total_m2 != null ? `${target.total_m2.toFixed(1)} m²` : "—")}
                            </td>
                            <td>
                              {isValve || rec.notes ? (
                                <button
                                  type="button"
                                  className="secondary"
                                  style={{ fontSize: "0.8em", padding: "0.2rem 0.5rem", whiteSpace: "nowrap" }}
                                  onClick={() => toggleExpand(rec.id)}
                                >
                                  {isExp ? "▾ Hide" : "▸ Details"}
                                </button>
                              ) : null}
                            </td>
                          </tr>
                          {isExp ? (
                            <tr key={`${rec.id}-detail`}>
                              <td colSpan={7} style={{ background: "var(--surface-alt, var(--border))", padding: "0.75rem 1rem" }}>
                                {isValve ? (
                                  <div>
                                    <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "0.85em" }}>Valve breakdown</p>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                                      <thead>
                                        <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                                          <th style={{ padding: "0.2rem 0.6rem 0.2rem 0", fontWeight: 600 }}>Valve</th>
                                          <th style={{ padding: "0.2rem 0.6rem", fontWeight: 600 }}>Area</th>
                                          <th style={{ padding: "0.2rem 0.6rem", fontWeight: 600 }}>Amount</th>
                                          <th style={{ padding: "0.2rem 0", fontWeight: 600 }}>Completed</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {prog.valves!.map((v) => (
                                          <tr key={v.valveId} style={{ borderTop: "1px solid var(--border)" }}>
                                            <td style={{ padding: "0.25rem 0.6rem 0.25rem 0" }}>{v.valveName}</td>
                                            <td style={{ padding: "0.25rem 0.6rem" }}>{v.areaM2.toFixed(1)} m²</td>
                                            <td style={{ padding: "0.25rem 0.6rem" }}>{formatValveAmount(v)}</td>
                                            <td style={{ padding: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.9em" }}>
                                              {v.completedAt ? formatTime(v.completedAt) : "—"}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : null}
                                {rec.notes ? (
                                  <p style={{ margin: isValve ? "0.6rem 0 0" : "0", fontSize: "0.85em" }}>
                                    <strong>Notes:</strong> {rec.notes}
                                  </p>
                                ) : null}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* ── H1 Sheets tab ────────────────────────────────────────────────────── */}
      {activeTab === "h1" ? (
        <>
          {h1Error ? <p className="form-error">{h1Error}</p> : null}
          <div className="coming-soon-card">
            {h1Loading ? (
              <p>Loading H1 sheets…</p>
            ) : h1Sheets.length === 0 ? (
              <p style={{ color: "var(--text-muted)" }}>
                No H1 sheets yet. H1 sheets are generated automatically when a spray or drench job is completed.
              </p>
            ) : (
              <div className="varieties-table-wrapper">
                <table className="varieties-table">
                  <thead>
                    <tr>
                      <th>Sheet</th>
                      <th>Date range</th>
                      <th>Records</th>
                      <th>Products</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {h1Sheets.map((sheet, idx) => {
                      const first = sheet.logs[0];
                      const last  = sheet.logs[sheet.logs.length - 1];
                      const products = Array.from(new Set(sheet.logs.map((l) => l.product_name))).join(", ");
                      const dateRange = first.application_date === last.application_date
                        ? formatDate(first.application_date)
                        : `${formatDate(first.application_date)} – ${formatDate(last.application_date)}`;
                      const rowCount = sheet.logs.length;
                      const capacity = 8;

                      return (
                        <tr
                          key={sheet.sheet_group_id}
                          style={{ cursor: "pointer" }}
                          onClick={() => handleOpenSheet(sheet)}
                        >
                          <td>
                            <strong>H1 Sheet #{h1Sheets.length - idx}</strong>
                          </td>
                          <td style={{ whiteSpace: "nowrap", fontSize: "0.9em" }}>{dateRange}</td>
                          <td style={{ fontSize: "0.9em" }}>
                            <span style={{
                              display: "inline-block",
                              padding: "0.1rem 0.45rem",
                              borderRadius: "10px",
                              background: rowCount >= capacity ? "var(--brand-soft, #e6f4ef)" : "var(--surface-soft, #f5f5f5)",
                              fontSize: "0.8em",
                              fontWeight: 600,
                            }}>
                              {rowCount} / {capacity}
                            </span>
                          </td>
                          <td style={{ fontSize: "0.85em", color: "var(--text-muted)", maxWidth: "220px" }}>
                            {products || "—"}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="secondary"
                              style={{ fontSize: "0.8em", padding: "0.2rem 0.6rem", whiteSpace: "nowrap" }}
                              onClick={() => handleOpenSheet(sheet)}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* Preview modal — shown when a sheet is opened from the list */}
      {previewSheet && !openLog ? (
        <H1PreviewModal
          sheet={previewSheet}
          onClose={() => setPreviewSheet(null)}
          onEditLog={handleEditLog}
        />
      ) : null}

      {/* Editor modal — shown when a row's Edit button is clicked from the preview */}
      {openLog ? (
        <H1Modal
          log={openLog}
          onClose={handleEditorClose}
          onSaved={handleLogSaved}
        />
      ) : null}
    </section>
  );
}
