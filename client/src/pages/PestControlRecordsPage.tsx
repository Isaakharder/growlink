import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { apiFetch } from "../lib/api";

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
// Uses saved/edited values from the H1Log. The Signature of Applicator column
// is always left blank for handwriting.

function generateH1Pdf(log: H1Log): void {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.width;   // 297
  const marginL = 14;
  const marginR = 14;
  const contentW = pageW - marginL - marginR;  // 269

  // ── Title
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("H1 – Spray/Drench Application Record", marginL, 13);

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.text(
    `CanadaGAP Food Safety & Traceability  ·  ${log.version_label ?? "Version 11.0"}`,
    marginL, 19
  );

  // ── Top info block (two-column, borderless table)
  const half = contentW / 2 - 2;
  const topRows: [string, string][] = [
    ["Operation Name", log.operation_name ?? ""],
    ["Current Crop", log.current_crop ?? ""],
    ["Variety", log.variety ?? ""],
    ["Previous Year Crop(s)", log.previous_year_crops ?? ""],
    ["Production Site Information", log.production_site_information ?? ""],
    ["Production Site Area", log.production_site_area ?? ""],
    ["Date Planted", formatDate(log.date_planted)],
  ];

  // Split into two columns of the table: left 3 rows, right 4 rows
  const leftRows = topRows.slice(0, 4);
  const rightRows = topRows.slice(4);

  const infoTable: string[][] = [];
  const maxLen = Math.max(leftRows.length, rightRows.length);
  for (let i = 0; i < maxLen; i++) {
    const l = leftRows[i] ?? ["", ""];
    const r = rightRows[i] ?? ["", ""];
    infoTable.push([l[0], l[1], r[0], r[1]]);
  }

  autoTable(doc, {
    startY: 23,
    head: [],
    body: infoTable,
    styles: { fontSize: 8, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 }, overflow: "linebreak" },
    columnStyles: {
      0: { cellWidth: half * 0.32, fontStyle: "bold", textColor: [80, 80, 80] },
      1: { cellWidth: half * 0.68 },
      2: { cellWidth: half * 0.38, fontStyle: "bold", textColor: [80, 80, 80] },
      3: { cellWidth: half * 0.62 },
    },
    theme: "plain",
    margin: { left: marginL, right: marginR },
  });

  // ── Divider
  const afterInfo: number = (doc as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 55;
  doc.setDrawColor(180, 200, 190);
  doc.setLineWidth(0.3);
  doc.line(marginL, afterInfo + 2, pageW - marginR, afterInfo + 2);

  // ── Application table
  const qty =
    log.actual_quantity_used != null
      ? `${log.actual_quantity_used} ${log.actual_quantity_unit ?? ""}`.trim()
      : "—";

  const appRow = [
    formatDate(log.application_date),
    log.product_name,
    log.pcp_number ?? "—",
    qty,
    log.rate_applied_per_unit ?? "—",
    log.label_instructions_followed ? "Yes" : "No",
    log.area_quantity_treated_m2 != null ? `${log.area_quantity_treated_m2.toFixed(1)} m²` : "—",
    log.method_of_application ?? "—",
    log.row_house_zones ?? "—",
    formatDate(log.earliest_allowable_harvest_date),
    log.phi_daa != null ? String(log.phi_daa) : "—",
    "", // Signature of Applicator — blank for handwriting
  ];

  autoTable(doc, {
    startY: afterInfo + 5,
    head: [[
      "Application Date", "Product Name", "PCP#", "Actual Qty Used",
      "Rate Applied / Unit", "Label Instr. Followed", "Area / Qty Treated",
      "Method", "Row / House / Zones", "Earliest Harvest Date", "PHI / DAA",
      "Signature of Applicator",
    ]],
    body: [appRow],
    styles: { fontSize: 7.5, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [34, 85, 34], textColor: 255, fontStyle: "bold", fontSize: 7 },
    columnStyles: {
      0:  { cellWidth: 20 },
      1:  { cellWidth: 27 },
      2:  { cellWidth: 15 },
      3:  { cellWidth: 20 },
      4:  { cellWidth: 22 },
      5:  { cellWidth: 15 },
      6:  { cellWidth: 18 },
      7:  { cellWidth: 15 },
      8:  { cellWidth: 33 },
      9:  { cellWidth: 22 },
      10: { cellWidth: 14 },
      11: { cellWidth: 28 }, // blank for handwriting
    },
    didDrawCell: (data) => {
      if (data.section === "body" && data.column.index === 11) {
        const { x, y, width, height } = data.cell;
        doc.setDrawColor(160, 160, 160);
        doc.setLineWidth(0.3);
        doc.line(x + 3, y + height - 4, x + width - 3, y + height - 4);
      }
    },
    margin: { left: marginL, right: marginR },
  });

  // ── Confirmation footer
  const afterApp: number = (doc as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 150;

  autoTable(doc, {
    startY: afterApp + 6,
    head: [],
    body: [[
      `Confirmation Signature: ${log.confirmation_signature ?? ""}`,
      `Confirmation Date: ${formatDate(log.confirmation_date)}`,
      log.version_label ?? "Version 11.0",
    ]],
    styles: { fontSize: 8, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 } },
    columnStyles: {
      0: { cellWidth: contentW * 0.5 },
      1: { cellWidth: contentW * 0.3 },
      2: { cellWidth: contentW * 0.2, textColor: [100, 100, 100] },
    },
    theme: "plain",
    margin: { left: marginL, right: marginR },
  });

  // ── Page footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.text(
      `Generated ${new Date().toLocaleDateString()} — GrowLink`,
      marginL,
      doc.internal.pageSize.height - 6
    );
  }

  const safeDate = (log.application_date ?? "").replace(/-/g, "");
  const safeName = (log.product_name ?? "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
  doc.save(`H1_${safeDate}_${safeName}.pdf`);
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
      confirmation_signature:          draft.confirmation_signature || null,
      confirmation_date:               draft.confirmation_date || null,
      version_label:                   draft.version_label || "Version 11.0",
    };
    try {
      generateH1Pdf(logFromDraft);
    } finally {
      setExporting(false);
    }
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fieldStyle: React.CSSProperties = {
    display: "grid", gap: "0.28rem", fontSize: "0.88rem", color: "var(--text-muted)",
  };
  const inputStyle: React.CSSProperties = {
    border: "1px solid var(--border)", borderRadius: "8px",
    background: "var(--surface)", color: "var(--text)",
    font: "inherit", padding: "0.45rem 0.6rem", width: "100%",
  };
  const sectionHead: React.CSSProperties = {
    margin: "1rem 0 0.5rem", fontSize: "0.78rem", fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)", paddingBottom: "0.3rem",
  };
  const grid2: React.CSSProperties = {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem",
  };
  const grid3: React.CSSProperties = {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.65rem",
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="H1 Sheet"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: "min(860px, 100%)",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "14px",
          boxShadow: "var(--shadow)",
          padding: "1.25rem 1.5rem",
        }}
      >
        {/* Modal header */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "0.25rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.05rem" }}>H1 Sheet</h2>
          {dirty ? (
            <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontStyle: "italic" }}>
              Unsaved changes
            </span>
          ) : null}
        </div>
        <p style={{ margin: "0 0 0.25rem", fontSize: "0.82rem", color: "var(--text-muted)" }}>
          CanadaGAP Food Safety &amp; Traceability — {draft.version_label}
        </p>

        {saveError ? (
          <p className="form-error" style={{ marginTop: "0.5rem" }}>{saveError}</p>
        ) : null}

        {/* ── Top form fields */}
        <p style={sectionHead}>Site Information</p>
        <div style={grid2}>
          <label style={fieldStyle}>
            Operation Name
            <input style={inputStyle} value={draft.operation_name}
              onChange={(e) => set("operation_name", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Current Crop
            <input style={inputStyle} value={draft.current_crop}
              onChange={(e) => set("current_crop", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Variety
            <input style={inputStyle} value={draft.variety}
              onChange={(e) => set("variety", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Previous Year Crop(s)
            <input style={inputStyle} value={draft.previous_year_crops}
              onChange={(e) => set("previous_year_crops", e.target.value)} />
          </label>
          <label style={{ ...fieldStyle, gridColumn: "1 / -1" }}>
            Production Site Information
            <input style={inputStyle} value={draft.production_site_information}
              onChange={(e) => set("production_site_information", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Production Site Area
            <input style={inputStyle} value={draft.production_site_area}
              onChange={(e) => set("production_site_area", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Date Planted
            <input style={inputStyle} type="date" value={draft.date_planted}
              onChange={(e) => set("date_planted", e.target.value)} />
          </label>
        </div>

        {/* ── Application row fields */}
        <p style={sectionHead}>Application Details</p>
        <div style={grid3}>
          <label style={fieldStyle}>
            Application Date
            <input style={inputStyle} type="date" value={draft.application_date}
              onChange={(e) => set("application_date", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Product Name
            <input style={inputStyle} value={draft.product_name}
              onChange={(e) => set("product_name", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            PCP #
            <input style={inputStyle} value={draft.pcp_number}
              onChange={(e) => set("pcp_number", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Actual Quantity Used
            <input style={inputStyle} type="number" step="any" value={draft.actual_quantity_used}
              onChange={(e) => set("actual_quantity_used", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Quantity Unit
            <input style={inputStyle} value={draft.actual_quantity_unit}
              onChange={(e) => set("actual_quantity_unit", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Rate Applied Per Unit
            <input style={inputStyle} value={draft.rate_applied_per_unit}
              onChange={(e) => set("rate_applied_per_unit", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Area / Qty Treated (m²)
            <input style={inputStyle} type="number" step="any" value={draft.area_quantity_treated_m2}
              onChange={(e) => set("area_quantity_treated_m2", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Method of Application
            <input style={inputStyle} value={draft.method_of_application}
              onChange={(e) => set("method_of_application", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            PHI / DAA
            <input style={inputStyle} type="number" step="1" value={draft.phi_daa}
              onChange={(e) => set("phi_daa", e.target.value)} />
          </label>
          <label style={{ ...fieldStyle, gridColumn: "1 / -1" }}>
            Row / House / Zones
            <input style={inputStyle} value={draft.row_house_zones}
              onChange={(e) => set("row_house_zones", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Earliest Allowable Harvest Date
            <input style={inputStyle} type="date" value={draft.earliest_allowable_harvest_date}
              onChange={(e) => set("earliest_allowable_harvest_date", e.target.value)} />
          </label>
          <label style={{ ...fieldStyle, gridColumn: "2 / 4" }}>
            Label Instructions Followed
            <select
              style={{ ...inputStyle }}
              value={draft.label_instructions_followed ? "yes" : "no"}
              onChange={(e) => set("label_instructions_followed", e.target.value === "yes")}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>

        {/* ── Confirmation fields */}
        <p style={sectionHead}>Confirmation</p>
        <div style={grid2}>
          <label style={fieldStyle}>
            Confirmation Signature
            <input style={inputStyle} value={draft.confirmation_signature}
              onChange={(e) => set("confirmation_signature", e.target.value)} />
          </label>
          <label style={fieldStyle}>
            Confirmation Date
            <input style={inputStyle} type="date" value={draft.confirmation_date}
              onChange={(e) => set("confirmation_date", e.target.value)} />
          </label>
        </div>

        {/* ── Actions */}
        <div style={{ display: "flex", gap: "0.6rem", marginTop: "1.25rem", flexWrap: "wrap", alignItems: "center" }}>
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
      </div>
    </div>
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
  const [h1Logs, setH1Logs]         = useState<H1Log[]>([]);
  const [h1Loading, setH1Loading]   = useState(false);
  const [h1Error, setH1Error]       = useState<string | null>(null);
  const [openLog, setOpenLog]       = useState<H1Log | null>(null);
  const [exporting, setExporting]   = useState<string | null>(null);
  // Tracks whether the initial H1 fetch has been attempted so the effect
  // never fires more than once per tab-open even if loading/error state changes.
  const h1FetchedRef = useRef(false);

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

  async function handleExportPdf(log: H1Log) {
    setExporting(log.id);
    try {
      const res = await apiFetch(`/api/records/h1/${log.id}/pdf`);
      if (!res.ok) throw new Error("Failed to load log data");
      generateH1Pdf((await res.json()) as H1Log);
    } catch {
      generateH1Pdf(log);
    } finally {
      setExporting(null);
    }
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
              <p>Loading H1 logs…</p>
            ) : h1Logs.length === 0 ? (
              <p style={{ color: "var(--text-muted)" }}>
                No H1 logs yet. H1 sheets are generated automatically when a spray or drench job is completed.
              </p>
            ) : (
              <div className="varieties-table-wrapper">
                <table className="varieties-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Product</th>
                      <th>Method</th>
                      <th>Area (m²)</th>
                      <th>PHI (days)</th>
                      <th>Earliest Harvest</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {h1Logs.map((log) => (
                      <tr
                        key={log.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => setOpenLog(log)}
                      >
                        <td style={{ whiteSpace: "nowrap" }}>{formatDate(log.application_date)}</td>
                        <td>
                          <strong>{log.product_name}</strong>
                          {log.pcp_number ? (
                            <span style={{ display: "block", fontSize: "0.78em", color: "var(--text-muted)" }}>
                              PCP# {log.pcp_number}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {log.method_of_application ? (
                            <span className="pest-todo-type-badge" data-type={log.method_of_application.toLowerCase()}>
                              {log.method_of_application}
                            </span>
                          ) : "—"}
                        </td>
                        <td style={{ fontSize: "0.9em" }}>
                          {log.area_quantity_treated_m2 != null ? log.area_quantity_treated_m2.toFixed(1) : "—"}
                        </td>
                        <td style={{ fontSize: "0.9em" }}>{log.phi_daa != null ? log.phi_daa : "—"}</td>
                        <td style={{ whiteSpace: "nowrap", fontSize: "0.9em" }}>
                          {formatDate(log.earliest_allowable_harvest_date)}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: "flex", gap: "0.4rem" }}>
                            <button
                              type="button"
                              className="secondary"
                              style={{ fontSize: "0.8em", padding: "0.2rem 0.6rem", whiteSpace: "nowrap" }}
                              onClick={() => setOpenLog(log)}
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              style={{ fontSize: "0.8em", padding: "0.2rem 0.6rem", whiteSpace: "nowrap" }}
                              disabled={exporting === log.id}
                              onClick={() => void handleExportPdf(log)}
                            >
                              {exporting === log.id ? "Generating…" : "Export PDF"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* ── H1 Sheet modal */}
      {openLog ? (
        <H1Modal
          log={openLog}
          onClose={() => setOpenLog(null)}
          onSaved={handleLogSaved}
        />
      ) : null}
    </section>
  );
}
