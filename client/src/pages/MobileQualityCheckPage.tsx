import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type SetupGroup = {
  id: string;
  type: string;
  name: string;
  status: string;
};

type SetupRow = {
  id: string;
  group_id: string;
  row_number: number;
  length_meters: number | null;
};

type QualityEmployee = {
  id: string;
  name: string;
  active: boolean;
};

type QualityMetric = {
  id: string;
  name: string;
  active: boolean;
};

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function MobileQualityCheckPage() {
  const [groups, setGroups] = useState<SetupGroup[]>([]);
  const [allRows, setAllRows] = useState<SetupRow[]>([]);
  const [employees, setEmployees] = useState<QualityEmployee[]>([]);
  const [metrics, setMetrics] = useState<QualityMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection state
  const [phaseId, setPhaseId] = useState("");
  const [rowId, setRowId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [stemsChecked, setStemsChecked] = useState("");
  const [notes, setNotes] = useState("");

  // Metric counts keyed by metric id
  const [counts, setCounts] = useState<Record<string, number>>({});

  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [setupRes, empRes, metRes] = await Promise.all([
          apiFetch("/api/greenhouse-setup"),
          apiFetch("/api/quality/employees"),
          apiFetch("/api/quality/metrics")
        ]);
        if (!setupRes.ok || !empRes.ok || !metRes.ok) {
          throw new Error("Failed to load data");
        }
        const setupData = (await setupRes.json()) as { groups: SetupGroup[]; rows: SetupRow[] };
        const empData = (await empRes.json()) as QualityEmployee[];
        const metData = (await metRes.json()) as QualityMetric[];

        setGroups(setupData.groups ?? []);
        setAllRows(setupData.rows ?? []);
        setEmployees(empData.filter((e) => e.active));
        setMetrics(metData.filter((m) => m.active));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const phases = useMemo(
    () => groups.filter((g) => g.type === "phase" && g.status === "active"),
    [groups]
  );

  const phaseRows = useMemo(
    () => allRows.filter((r) => r.group_id === phaseId).sort((a, b) => a.row_number - b.row_number),
    [allRows, phaseId]
  );

  const selectedRow = useMemo(
    () => phaseRows.find((r) => r.id === rowId) ?? null,
    [phaseRows, rowId]
  );

  const selectedPhase = useMemo(
    () => groups.find((g) => g.id === phaseId) ?? null,
    [groups, phaseId]
  );

  const totalIssues = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + safeNum(n), 0),
    [counts]
  );

  function increment(metricId: string) {
    setCounts((prev) => ({ ...prev, [metricId]: safeNum(prev[metricId]) + 1 }));
    setSavedMessage("");
  }

  function decrement(metricId: string) {
    setCounts((prev) => ({ ...prev, [metricId]: Math.max(0, safeNum(prev[metricId]) - 1) }));
    setSavedMessage("");
  }

  function handlePhaseChange(id: string) {
    setPhaseId(id);
    setRowId("");
    setSavedMessage("");
  }

  const stemsNum = safeNum(stemsChecked);
  const canSave =
    phaseId !== "" &&
    rowId !== "" &&
    employeeId !== "" &&
    stemsNum > 0;

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    setSavedMessage("");

    const metricCounts: Record<string, number> = {};
    for (const m of metrics) {
      metricCounts[m.id] = safeNum(counts[m.id]);
    }

    try {
      const res = await apiFetch("/api/quality/checks", {
        method: "POST",
        body: JSON.stringify({
          employee_id: employeeId,
          phase_id: phaseId || null,
          phase_name: selectedPhase?.name ?? "",
          row_id: rowId || null,
          row_number: selectedRow?.row_number ?? 0,
          stems_checked: stemsNum,
          metric_counts: metricCounts,
          total_issues: totalIssues,
          notes: notes.trim() || null
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save");
      }
      setSavedMessage("Quality check saved.");
      setRowId("");
      setStemsChecked("");
      setNotes("");
      setCounts({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="mobile-page">
        <h2>Quality Check</h2>
        <p>Loading…</p>
      </section>
    );
  }

  return (
    <section className="mobile-page">
      <h2>Quality Check</h2>

      {error ? <p className="form-error" style={{ marginBottom: "0.75rem" }}>{error}</p> : null}

      {/* Step 1: Phase */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
          1. Phase
        </p>
        {phases.length === 0 ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>
            No active phases in Greenhouse Setup.
          </p>
        ) : (
          <select
            className="quality-select"
            value={phaseId}
            onChange={(e) => handlePhaseChange(e.target.value)}
          >
            <option value="">Select phase…</option>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Step 2: Row */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
          2. Row
        </p>
        {!phaseId ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>Select a phase first.</p>
        ) : phaseRows.length === 0 ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>No rows in this phase.</p>
        ) : (
          <select
            className="quality-select"
            value={rowId}
            onChange={(e) => { setRowId(e.target.value); setSavedMessage(""); }}
          >
            <option value="">Select row…</option>
            {phaseRows.map((r) => (
              <option key={r.id} value={r.id}>Row {r.row_number}</option>
            ))}
          </select>
        )}
      </div>

      {/* Step 3: Employee */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
          3. Employee
        </p>
        {employees.length === 0 ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>
            No active employees. Add employees in Quality Check Setup.
          </p>
        ) : (
          <select
            className="quality-select"
            value={employeeId}
            onChange={(e) => { setEmployeeId(e.target.value); setSavedMessage(""); }}
          >
            <option value="">Select employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>{emp.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Step 4: Metrics */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.6rem" }}>
          4. Issues Found
        </p>

        {metrics.length === 0 ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>
            No active metrics. Add metrics in Quality Check Setup.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {metrics.map((m) => {
              const count = safeNum(counts[m.id]);
              return (
                <div
                  key={m.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto auto",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.5rem 0.6rem",
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    background: count > 0 ? "var(--brand-soft)" : "var(--surface)"
                  }}
                >
                  <span style={{ fontSize: "0.9rem", fontWeight: count > 0 ? 600 : 400 }}>
                    {m.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => decrement(m.id)}
                    disabled={count === 0}
                    style={{
                      width: "2.6rem",
                      height: "2.6rem",
                      borderRadius: "50%",
                      border: "2px solid var(--border)",
                      background: "var(--surface)",
                      fontSize: "1.3rem",
                      fontWeight: 700,
                      cursor: count === 0 ? "not-allowed" : "pointer",
                      opacity: count === 0 ? 0.4 : 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1
                    }}
                    aria-label={`Decrease ${m.name}`}
                  >
                    −
                  </button>
                  <span
                    style={{
                      minWidth: "2rem",
                      textAlign: "center",
                      fontSize: "1.2rem",
                      fontWeight: 700,
                      color: count > 0 ? "var(--brand)" : "var(--text-muted)"
                    }}
                  >
                    {count}
                  </span>
                  <button
                    type="button"
                    onClick={() => increment(m.id)}
                    style={{
                      width: "2.6rem",
                      height: "2.6rem",
                      borderRadius: "50%",
                      border: "2px solid var(--brand)",
                      background: "var(--brand)",
                      color: "#fff",
                      fontSize: "1.3rem",
                      fontWeight: 700,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1
                    }}
                    aria-label={`Increase ${m.name}`}
                  >
                    +
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Total issues summary */}
        {metrics.length > 0 ? (
          <div
            style={{
              marginTop: "0.75rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "8px",
              background: totalIssues > 0 ? "var(--brand-soft)" : "var(--surface-soft)",
              border: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}
          >
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Total issues</span>
            <span style={{ fontSize: "1.2rem", fontWeight: 700, color: totalIssues > 0 ? "var(--brand)" : "var(--text-muted)" }}>
              {totalIssues}
            </span>
          </div>
        ) : null}
      </div>

      {/* Stems + Notes */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
          5. Stems &amp; Notes
        </p>

        <label style={{ display: "block", marginBottom: "0.6rem" }}>
          <span style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.25rem" }}>
            Stems checked <span style={{ color: "#dc3545" }}>*</span>
          </span>
          <input
            className="quality-input"
            type="number"
            min="1"
            step="1"
            value={stemsChecked}
            placeholder="e.g. 100"
            onChange={(e) => { setStemsChecked(e.target.value); setSavedMessage(""); }}
          />
        </label>

        <label style={{ display: "block" }}>
          <span style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.25rem" }}>Notes (optional)</span>
          <textarea
            rows={2}
            value={notes}
            placeholder="Any observations…"
            onChange={(e) => { setNotes(e.target.value); setSavedMessage(""); }}
            style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
          />
        </label>
      </div>

      {/* Save */}
      <button
        type="button"
        className="primary-action-button"
        style={{ width: "100%", fontSize: "1rem", padding: "0.9rem", marginBottom: "0.5rem" }}
        disabled={!canSave || saving}
        onClick={() => void handleSave()}
      >
        {saving ? "Saving…" : "Save Quality Check"}
      </button>

      {!canSave && !saving ? (
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center" }}>
          {!phaseId
            ? "Select a phase to continue."
            : !rowId
            ? "Select a row to continue."
            : !employeeId
            ? "Select an employee to continue."
            : "Enter stems checked to save."}
        </p>
      ) : null}

      {savedMessage ? (
        <p style={{ fontSize: "0.9rem", color: "var(--brand)", textAlign: "center", fontWeight: 600, marginTop: "0.5rem" }}>
          {savedMessage}
        </p>
      ) : null}
    </section>
  );
}
