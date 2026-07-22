import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { BonusEmployee, CheckType, JOB_LABEL, formatCAD } from "./BonusesTab";
import { formatWeekRangeLabel } from "./bonusWeeks";

type MatchStatus = "matched" | "ambiguous" | "unmatched";
type ThresholdMode = "fixed" | "auto";

type ParsedRow = {
  rawName: string;
  enteredSpeed: number;
  speedUnit: string;
  hoursWorked: number;
  matchStatus: MatchStatus;
  employeeId: string | null;
  suggestions: { id: string; name: string }[];
};

type PreviewResponse = {
  sourceFile: string;
  periodStart: string | null;
  periodEnd: string | null;
  company: string | null;
  checkType: CheckType;
  speedUnit: string;
  warnings: string[];
  grandTotal: { enteredSpeed: number; hoursWorked: number } | null;
  thresholdMode: ThresholdMode;
  rows: ParsedRow[];
};

type CalcRow = { baseThreshold: number | null; appliedThreshold: number | null; appliedRate: number; totalBonus: number };

type LinearSettings = {
  standardValue: number;
  valueStep: number;
  speedChangePerStep: number;
  minAdjustment: number;
  maxAdjustment: number;
};

type EditableRow = ParsedRow & { selectedEmployeeId: string; skip: boolean; calc: CalcRow | null };

type ImportResult = { importedCount: number; results: { rawName: string; status: "imported" | "failed"; message?: string }[] };

type BonusPdfImportProps = {
  employees: BonusEmployee[];
  onImported: () => void;
};

// Weekly Bonus Conditions input, per job: Picking's weekly value maps to the
// server's `cropLoad` condition (kg/m^2); Winding/Pruning's maps to
// `setsPerPlant` (repurposed to mean weekly fruit sets/m^2, not the old
// per-plant multiplier-curve input).
const WEEKLY_VALUE_LABEL: Record<CheckType, string> = {
  picking_peppers: "Weekly harvested load (kg/m²)",
  winding_pruning: "Weekly fruit sets per m²"
};

const CONDITION_UNIT: Record<CheckType, string> = {
  picking_peppers: "kg/m²",
  winding_pruning: "fruit sets/m²"
};

export function BonusPdfImport({ employees, onImported }: BonusPdfImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);

  // Weekly Bonus Conditions
  const [weeklyValue, setWeeklyValue] = useState("");
  const [finalAdjustment, setFinalAdjustment] = useState<number | null>(null);
  const [linearSettings, setLinearSettings] = useState<LinearSettings | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [calculated, setCalculated] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setRows([]);
    setPreviewError(null);
    setWeeklyValue("");
    setFinalAdjustment(null);
    setLinearSettings(null);
    setCalculated(false);
    setCalcError(null);
    setImportError(null);
    setImportResult(null);
  }

  function buildWeeklyConditions(checkType: CheckType) {
    const value = weeklyValue !== "" ? Number(weeklyValue) : null;
    return checkType === "picking_peppers" ? { cropLoad: value } : { setsPerPlant: value };
  }

  async function calculate(source: EditableRow[], checkType: CheckType) {
    setCalculating(true);
    setCalcError(null);
    try {
      const res = await apiFetch("/api/quality/bonus-pdf-import/calculate", {
        method: "POST",
        body: JSON.stringify({
          checkType,
          rows: source.map((r) => ({ enteredSpeed: r.enteredSpeed, hoursWorked: r.hoursWorked })),
          weeklyConditions: buildWeeklyConditions(checkType)
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to calculate bonus");
      }
      const data = (await res.json()) as {
        mode: ThresholdMode;
        rawAdjustment: number | null;
        finalAdjustment: number | null;
        linearSettings: LinearSettings | null;
        rows: CalcRow[];
      };
      setFinalAdjustment(data.finalAdjustment);
      setLinearSettings(data.linearSettings);
      setRows((prev) => prev.map((r, i) => ({ ...r, calc: data.rows[i] ?? null })));
      setCalculated(true);
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : "Failed to calculate bonus");
    } finally {
      setCalculating(false);
    }
  }

  async function handlePreview() {
    if (!file) return;
    setUploading(true);
    setPreviewError(null);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiFetch("/api/quality/bonus-pdf-import/preview", { method: "POST", body: formData });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to read the PDF");
      }
      const data = (await res.json()) as PreviewResponse;
      setPreview(data);
      const editable = data.rows.map((r) => ({
        ...r,
        selectedEmployeeId: r.matchStatus === "matched" && r.employeeId ? r.employeeId : "",
        skip: false,
        calc: null as CalcRow | null
      }));
      setRows(editable);
      // Fixed-mode jobs need no weekly input — calculate immediately.
      if (data.thresholdMode === "fixed") {
        await calculate(editable, data.checkType);
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to read the PDF");
    } finally {
      setUploading(false);
    }
  }

  function updateRow(index: number, patch: Partial<EditableRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  const includedRows = rows.filter((r) => !r.skip);
  const unresolvedCount = includedRows.filter((r) => !r.selectedEmployeeId).length;
  const includedHours = includedRows.reduce((s, r) => s + r.hoursWorked, 0);

  async function handleImport() {
    if (!preview || !preview.periodStart) return;
    if (includedRows.length === 0 || unresolvedCount > 0) return;

    setImporting(true);
    setImportError(null);
    try {
      const res = await apiFetch("/api/quality/bonus-pdf-import/import", {
        method: "POST",
        body: JSON.stringify({
          checkType: preview.checkType,
          entryDate: preview.periodStart,
          weeklyConditions: buildWeeklyConditions(preview.checkType),
          rows: includedRows.map((r) => ({
            rawName: r.rawName,
            employeeId: r.selectedEmployeeId,
            enteredSpeed: r.enteredSpeed,
            hoursWorked: r.hoursWorked
          }))
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to import bonus entries");
      }
      const result = (await res.json()) as ImportResult;
      setImportResult(result);
      onImported();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import bonus entries");
    } finally {
      setImporting(false);
    }
  }

  const isAuto = preview?.thresholdMode === "auto";

  return (
    <div className="coming-soon-card">
      <h2>Bonus Entry — Import from PDF</h2>
      <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
        Upload the weekly production report PDF. The job is detected automatically from the report's unit
        (Kg/Hr = Picking, Plants/Hr = Winding/Pruning), and the bonus rate is calculated from your existing
        Bonus Setup tiers.
      </p>

      {previewError ? <p className="form-error">{previewError}</p> : null}

      {!preview ? (
        <div style={{ marginTop: "0.85rem", display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="primary-action-button"
            onClick={() => void handlePreview()}
            disabled={!file || uploading}
          >
            {uploading ? "Reading…" : "Preview Import"}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: "0.85rem" }}>
          <div className="bonus-pdf-meta">
            <div><span>File</span><strong>{preview.sourceFile}</strong></div>
            <div>
              <span>Period</span>
              <strong>{preview.periodStart ? formatWeekRangeLabel(preview.periodStart) : "Unknown"}</strong>
            </div>
            <div><span>Job detected</span><strong>{JOB_LABEL[preview.checkType]}</strong></div>
            <div><span>Rows found</span><strong>{preview.rows.length}</strong></div>
          </div>

          {preview.warnings.length > 0 ? (
            <div style={{ marginTop: "0.75rem" }}>
              {preview.warnings.map((w, i) => (
                <p key={i} className="form-error" style={{ marginTop: i === 0 ? 0 : "0.3rem" }}>{w}</p>
              ))}
            </div>
          ) : null}

          {preview.grandTotal ? (
            <p style={{ marginTop: "0.6rem", fontSize: "0.85em", color: "var(--text-muted)" }}>
              PDF Grand Total: {preview.grandTotal.hoursWorked} hrs — currently included rows total{" "}
              {Math.round(includedHours * 100) / 100} hrs.
            </p>
          ) : null}

          {isAuto ? (
            <div className="coming-soon-card" style={{ marginTop: "0.85rem", background: "var(--surface-soft)" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Weekly Bonus Conditions</h3>
              <p style={{ fontSize: "0.8em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                These apply to every {JOB_LABEL[preview.checkType]} row in this import.
              </p>

              <div className="bonus-tier-form" style={{ marginTop: "0.65rem" }}>
                <label>
                  Week
                  <input
                    type="text"
                    value={preview.periodStart ? formatWeekRangeLabel(preview.periodStart) : "Unknown"}
                    readOnly
                    disabled
                  />
                </label>
                <label>
                  Standard {CONDITION_UNIT[preview.checkType]}
                  <input
                    type="text"
                    value={calculated && linearSettings ? `${linearSettings.standardValue} ${CONDITION_UNIT[preview.checkType]}` : "—"}
                    readOnly
                    disabled
                  />
                </label>
                <label>
                  {WEEKLY_VALUE_LABEL[preview.checkType]}
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={weeklyValue}
                    onChange={(e) => setWeeklyValue(e.target.value)}
                  />
                </label>
                <label>
                  Calculated {preview.speedUnit} adjustment
                  <input
                    type="text"
                    value={
                      calculated && finalAdjustment !== null
                        ? `${finalAdjustment >= 0 ? "+" : ""}${finalAdjustment} ${preview.speedUnit}`
                        : "—"
                    }
                    readOnly
                    disabled
                  />
                </label>

                <div className="form-actions">
                  <button
                    type="button"
                    className="primary-action-button"
                    onClick={() => void calculate(rows, preview.checkType)}
                    disabled={calculating}
                  >
                    {calculating ? "Calculating…" : "Calculate Bonuses"}
                  </button>
                </div>
              </div>
              {calcError ? <p className="form-error" style={{ marginTop: "0.5rem" }}>{calcError}</p> : null}
            </div>
          ) : null}

          <div className="varieties-table-wrapper" style={{ marginTop: "0.85rem" }}>
            <table className="varieties-table bonus-pdf-table">
              <thead>
                <tr>
                  <th>Parsed name</th>
                  <th>Employee</th>
                  <th style={{ textAlign: "right" }}>Speed</th>
                  <th style={{ textAlign: "right" }}>Hours</th>
                  {isAuto ? <th style={{ textAlign: "right" }}>Base threshold</th> : null}
                  <th style={{ textAlign: "right" }}>{isAuto ? "Adjusted threshold" : "Threshold"}</th>
                  <th style={{ textAlign: "right" }}>Rate</th>
                  <th style={{ textAlign: "right" }}>Total bonus</th>
                  <th>Skip</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={row.skip ? "bonus-pdf-row-skipped" : undefined}>
                    <td>
                      {row.rawName}
                      {row.matchStatus !== "matched" ? (
                        <span className={`bonus-pdf-match-badge bonus-pdf-match-${row.matchStatus}`}>
                          {row.matchStatus === "ambiguous" ? "Multiple matches" : "No match"}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <select
                        value={row.selectedEmployeeId}
                        onChange={(e) => updateRow(i, { selectedEmployeeId: e.target.value })}
                        disabled={row.skip}
                      >
                        <option value="">Select employee…</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id} disabled={!emp.active}>
                            {emp.name}{!emp.active ? " (inactive)" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ textAlign: "right" }}>{row.enteredSpeed} {row.speedUnit}</td>
                    <td style={{ textAlign: "right" }}>{row.hoursWorked}</td>
                    {isAuto ? (
                      <td style={{ textAlign: "right" }}>
                        {row.calc?.baseThreshold !== null && row.calc?.baseThreshold !== undefined
                          ? `${row.calc.baseThreshold} ${row.speedUnit}`
                          : "—"}
                      </td>
                    ) : null}
                    <td style={{ textAlign: "right" }}>
                      {!row.calc
                        ? "—"
                        : row.calc.appliedThreshold !== null
                          ? `${row.calc.appliedThreshold} ${row.speedUnit}`
                          : "Below minimum"}
                    </td>
                    <td style={{ textAlign: "right" }}>{row.calc ? formatCAD(row.calc.appliedRate) : "—"}</td>
                    <td style={{ textAlign: "right" }}>{row.calc ? formatCAD(row.calc.totalBonus) : "—"}</td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={row.skip}
                        onChange={(e) => updateRow(i, { skip: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {importError ? <p className="form-error" style={{ marginTop: "0.75rem" }}>{importError}</p> : null}

          {importResult ? (
            <div style={{ marginTop: "0.75rem" }}>
              <p style={{ fontSize: "0.9em" }}>
                Imported {importResult.importedCount} of {importResult.results.length} rows.
              </p>
              {importResult.results.filter((r) => r.status === "failed").length > 0 ? (
                <ul style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.35rem" }}>
                  {importResult.results
                    .filter((r) => r.status === "failed")
                    .map((r, i) => (
                      <li key={i}>{r.rawName}: {r.message}</li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginTop: "0.85rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            {!importResult ? (
              <button
                type="button"
                className="primary-action-button"
                onClick={() => void handleImport()}
                disabled={importing || includedRows.length === 0 || unresolvedCount > 0 || !calculated}
              >
                {importing
                  ? "Importing…"
                  : !calculated
                    ? "Calculate bonuses to continue"
                    : unresolvedCount > 0
                      ? `Resolve ${unresolvedCount} employee${unresolvedCount === 1 ? "" : "s"} to continue`
                      : `Import ${includedRows.length} Row${includedRows.length === 1 ? "" : "s"}`}
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={reset}>
              {importResult ? "Import Another File" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
