// Read-only visual representation of a CanadaGAP H1 Agronomic Inputs sheet.
// Styled to match the official printed form — white background, black borders,
// table layout. No GrowLink brand colours.
//
// Accepts an array of logs so one sheet can display multiple application rows.
// The sheet header (Operation Name, Current Crop, etc.) is read from logs[0].
// Blank filler rows are added to reach the SHEET_ROWS visual capacity.

export type H1SheetLog = {
  id: string;
  sheet_group_id: string | null;
  // sheet header fields (live on the representative/first log)
  operation_name: string | null;
  current_crop: string | null;
  previous_year_crops: string | null;
  variety: string | null;
  production_site_information: string | null;
  production_site_area: string | null;
  date_planted: string | null;
  // application row fields
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
  // confirmation fields (on the representative log)
  confirmation_signature: string | null;
  confirmation_date: string | null;
  version_label: string;
};

// Total visible rows in the application table (matches the CanadaGAP form).
const SHEET_ROWS = 8;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: string | null | undefined): string {
  return v && v.trim() ? v.trim() : "";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso || !iso.trim()) return "";
  try {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtQuantity(qty: number | null, unit: string | null): string {
  if (qty == null) return "";
  const u = unit && unit.trim() ? ` ${unit.trim()}` : "";
  return `${qty}${u}`;
}

// Returns the Rate Applied Per Unit string for display.
// Priority: use the stored field if non-empty; otherwise calculate from qty/area.
function fmtRate(log: H1SheetLog): string {
  const stored = log.rate_applied_per_unit?.trim();
  if (stored) return stored;

  const qty = log.actual_quantity_used;
  const areaM2 = log.area_quantity_treated_m2;
  const unit = log.actual_quantity_unit?.trim() ?? "";

  if (qty == null || areaM2 == null || areaM2 <= 0 || !unit) return "";

  // Convert to hectares (standard metric for CanadaGAP)
  const ha = areaM2 / 10000;
  if (ha <= 0) return "";

  const rate = qty / ha;

  // Round to 2 decimal places; avoid excessive precision
  const rounded = Math.round(rate * 100) / 100;
  return `${rounded} ${unit}/ha`;
}

// ── Style constants ───────────────────────────────────────────────────────────

const BORDER = "1px solid #000";

const cell: React.CSSProperties = {
  border: BORDER,
  padding: "2px 4px",
  verticalAlign: "top",
  fontSize: "0.72rem",
  lineHeight: 1.3,
};

const cellLabel: React.CSSProperties = {
  ...cell,
  fontWeight: 600,
  whiteSpace: "nowrap",
  fontSize: "0.66rem",
  color: "#222",
};

const thCell: React.CSSProperties = {
  border: BORDER,
  padding: "3px 4px",
  verticalAlign: "middle",
  textAlign: "center",
  fontSize: "0.62rem",
  fontWeight: 700,
  lineHeight: 1.25,
  background: "#fff",
};

const dataCell: React.CSSProperties = {
  border: BORDER,
  padding: "4px 4px",
  verticalAlign: "top",
  fontSize: "0.72rem",
  lineHeight: 1.3,
  minHeight: "22px",
  background: "#fff",
};

const blankRow: React.CSSProperties = {
  height: "22px",
};

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  logs: H1SheetLog[];
  // Optional: called when user clicks the edit icon on a specific row.
  // If omitted, rows are not interactive.
  onEditLog?: (log: H1SheetLog) => void;
};

export function H1SheetPreview({ logs, onEditLog }: Props) {
  if (logs.length === 0) return null;

  const header = logs[0]; // sheet header data lives on the first (oldest) log
  const blankCount = Math.max(0, SHEET_ROWS - logs.length);

  return (
    <div
      className="h1-sheet-preview"
      data-print-root="true"
      style={{
        background: "#fff",
        color: "#000",
        fontFamily: "Arial, Helvetica, sans-serif",
        padding: "10px 14px 14px",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {/* ── Document header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "1rem", fontWeight: 700, lineHeight: 1.2 }}>
            H1.&nbsp;&nbsp;
            <span style={{ fontWeight: 700 }}>Agronomic Inputs</span>
            <span style={{ fontWeight: 400 }}> (Agricultural Chemicals)</span>
          </div>
          <div style={{ height: "3px", background: "#1a5c3a", marginTop: "3px", marginBottom: "5px", width: "100%" }} />
        </div>
        <div
          style={{
            border: BORDER,
            padding: "2px 8px",
            fontWeight: 700,
            fontSize: "0.78rem",
            marginLeft: "12px",
            whiteSpace: "nowrap",
            alignSelf: "flex-start",
          }}
        >
          ONGOING
        </div>
      </div>

      {/* ── Instructions ────────────────────────────────────────────────── */}
      <p style={{ fontStyle: "italic", fontSize: "0.62rem", margin: "0 0 5px", color: "#800000", lineHeight: 1.4 }}>
        <strong>Instructions:</strong> Includes all applications from pre-planting, through harvest, and including
        post-harvest applications (e.g., during packing, before, during or after storage, before holding, etc.).
        One Form must be completed for <strong>EACH PRODUCTION SITE.</strong>
      </p>

      {/* ── Top info block ───────────────────────────────────────────────── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "4px", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "32%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: "20%" }} />
        </colgroup>
        <tbody>
          <tr>
            <td style={cell}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>Operation Name:</span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmt(header.operation_name)}</div>
            </td>
            <td style={cell}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>Current Crop:</span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmt(header.current_crop)}</div>
            </td>
            <td style={cell}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>Previous Year Crop(s):</span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmt(header.previous_year_crops)}</div>
            </td>
            <td style={cell}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>Variety:</span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmt(header.variety)}</div>
            </td>
          </tr>
          <tr>
            <td style={cell}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>
                Production Site Information{" "}
                <span style={{ fontWeight: 400 }}>(e.g., Row/House/Zone #):</span>
              </span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmt(header.production_site_information)}</div>
            </td>
            <td style={cell} colSpan={2}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>
                Production Site Area{" "}
                <span style={{ fontWeight: 400 }}>(e.g., # of acres/hectares per Row/House/Zone #):</span>
              </span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmt(header.production_site_area)}</div>
            </td>
            <td style={cell}>
              <span style={{ fontWeight: 700, fontSize: "0.65rem" }}>Date Planted:</span>
              <div style={{ marginTop: "2px", minHeight: "14px" }}>{fmtDate(header.date_planted)}</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Application table ────────────────────────────────────────────── */}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginBottom: "6px" }}>
        <colgroup>
          <col style={{ width: "7%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "6%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "6%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "5%" }} />
          {/* Signature column: shrinks a little when edit buttons present */}
          <col style={{ width: onEditLog ? "13%" : "18%" }} />
          {onEditLog ? <col style={{ width: "5%" }} /> : null}
        </colgroup>
        <thead>
          <tr>
            <th style={thCell}>Application Date</th>
            <th style={thCell}>Product/Trade Name</th>
            <th style={thCell}>PCP #</th>
            <th style={thCell}>Actual Quantity Used <span style={{ fontWeight: 400 }}>(e.g., 22.28 kg)</span></th>
            <th style={thCell}>Rate Applied Per Unit</th>
            <th style={thCell}>Label Instructions Followed (✓)</th>
            <th style={thCell}>Area/Quantity Treated</th>
            <th style={thCell}>Method of Application</th>
            <th style={thCell}>Row/House/ Zone#/ Pallet/Bin Tag/Lot ID</th>
            <th style={thCell}>Earliest Allowable Harvest Date (EAHD)</th>
            <th style={thCell}>PHI/DAA</th>
            <th style={thCell}>Signature of Applicator or if Custom Application Invoice is Attached</th>
            {onEditLog ? <th style={thCell}></th> : null}
          </tr>
        </thead>
        <tbody>
          {/* ── Data rows */}
          {logs.map((log) => (
            <tr key={log.id}>
              <td style={dataCell}>{fmtDate(log.application_date)}</td>
              <td style={dataCell}>{fmt(log.product_name)}</td>
              <td style={dataCell}>{fmt(log.pcp_number)}</td>
              <td style={dataCell}>{fmtQuantity(log.actual_quantity_used, log.actual_quantity_unit)}</td>
              <td style={dataCell}>{fmtRate(log)}</td>
              <td style={{ ...dataCell, textAlign: "center", fontWeight: 700 }}>
                {log.label_instructions_followed ? "✓" : "No"}
              </td>
              <td style={dataCell}>
                {log.area_quantity_treated_m2 != null ? `${log.area_quantity_treated_m2} m²` : ""}
              </td>
              <td style={dataCell}>{fmt(log.method_of_application)}</td>
              <td style={dataCell}>{fmt(log.row_house_zones)}</td>
              <td style={dataCell}>{fmtDate(log.earliest_allowable_harvest_date)}</td>
              <td style={{ ...dataCell, textAlign: "center" }}>
                {log.phi_daa != null ? String(log.phi_daa) : ""}
              </td>
              <td style={dataCell}>{fmt(log.applicator_name)}</td>
              {onEditLog ? (
                <td style={{ ...dataCell, textAlign: "center", padding: "2px" }}>
                  <button
                    type="button"
                    onClick={() => onEditLog(log)}
                    style={{
                      background: "none",
                      border: "1px solid #bbb",
                      borderRadius: "3px",
                      cursor: "pointer",
                      fontSize: "0.6rem",
                      padding: "1px 4px",
                      color: "#333",
                      lineHeight: 1.4,
                    }}
                    title="Edit this row"
                  >
                    Edit
                  </button>
                </td>
              ) : null}
            </tr>
          ))}

          {/* ── Blank filler rows */}
          {Array.from({ length: blankCount }).map((_, i) => (
            <tr key={`blank-${i}`}>
              {Array.from({ length: onEditLog ? 13 : 12 }).map((_, j) => (
                <td key={j} style={{ ...dataCell, ...blankRow }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── Confirmation row ─────────────────────────────────────────────── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "30%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "20%" }} />
        </colgroup>
        <tbody>
          <tr>
            <td style={cellLabel}><em>Confirmation Signature:</em></td>
            <td style={{ ...cell, borderBottom: BORDER, borderTop: "none", borderLeft: "none", borderRight: "none" }}>
              <span style={{ fontSize: "0.8rem" }}>{fmt(header.confirmation_signature)}</span>
            </td>
            <td style={{ border: "none", padding: "0 8px" }} />
            <td style={cellLabel}><em>Date:</em></td>
            <td style={{ ...cell, borderBottom: BORDER, borderTop: "none", borderLeft: "none", borderRight: "none" }}>
              <span style={{ fontSize: "0.8rem" }}>{fmtDate(header.confirmation_date)}</span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: "4px", fontSize: "0.62rem", color: "#000" }}>
        <span style={{ fontWeight: 700 }}>{fmt(header.version_label) || "Version 11.0"}</span>
        <span style={{ textAlign: "right", fontStyle: "italic" }}>
          CanadaGAP Food Safety Manual for<br />Greenhouse Product 2026
        </span>
      </div>
    </div>
  );
}
