import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { apiFetch } from "../lib/api";

type QualityEmployee = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
};

type QualityMetric = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
};

type QualityThreshold = {
  id?: string;
  allowed_issues: number;
  stems_checked: number;
};

type QualityCheck = {
  id: string;
  employee_id: string;
  phase_name: string;
  row_number: number;
  stems_checked: number;
  total_issues: number;
  checked_at: string;
};

type EmployeeReport = {
  employee_id: string;
  name: string;
  totalIssues: number;
  totalStems: number;
  issueRate: number;
  checkCount: number;
};

type ActiveTab = "reports" | "setup";

function safeRate(issues: number, stems: number): number {
  if (!Number.isFinite(stems) || stems <= 0) return 0;
  const r = issues / stems;
  return Number.isFinite(r) ? r : 0;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function QualityCheckPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("reports");

  const [employees, setEmployees] = useState<QualityEmployee[]>([]);
  const [metrics, setMetrics] = useState<QualityMetric[]>([]);
  const [threshold, setThreshold] = useState<QualityThreshold>({ allowed_issues: 10, stems_checked: 100 });
  const [checks, setChecks] = useState<QualityCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Setup form state
  const [newEmployeeName, setNewEmployeeName] = useState("");
  const [employeeSaving, setEmployeeSaving] = useState(false);
  const [newMetricName, setNewMetricName] = useState("");
  const [metricSaving, setMetricSaving] = useState(false);
  const [thresholdAllowed, setThresholdAllowed] = useState("10");
  const [thresholdStems, setThresholdStems] = useState("100");
  const [thresholdSaving, setThresholdSaving] = useState(false);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [empRes, metRes, thrRes, chkRes] = await Promise.all([
        apiFetch("/api/quality/employees"),
        apiFetch("/api/quality/metrics"),
        apiFetch("/api/quality/threshold"),
        apiFetch("/api/quality/checks")
      ]);
      if (!empRes.ok || !metRes.ok || !thrRes.ok || !chkRes.ok) {
        throw new Error("Failed to load quality data");
      }
      const [empData, metData, thrData, chkData] = await Promise.all([
        empRes.json() as Promise<QualityEmployee[]>,
        metRes.json() as Promise<QualityMetric[]>,
        thrRes.json() as Promise<QualityThreshold>,
        chkRes.json() as Promise<QualityCheck[]>
      ]);
      setEmployees(empData);
      setMetrics(metData);
      setThreshold(thrData);
      setThresholdAllowed(String(thrData.allowed_issues));
      setThresholdStems(String(thrData.stems_checked));
      setChecks(chkData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quality data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // ── Reports derivations ──────────────────────────────────────────────────

  const thresholdRate = useMemo(
    () => safeRate(threshold.allowed_issues, threshold.stems_checked),
    [threshold]
  );

  const employeeReports = useMemo((): EmployeeReport[] => {
    const map = new Map<string, { totalIssues: number; totalStems: number; checkCount: number }>();
    for (const chk of checks) {
      const existing = map.get(chk.employee_id) ?? { totalIssues: 0, totalStems: 0, checkCount: 0 };
      map.set(chk.employee_id, {
        totalIssues: existing.totalIssues + chk.total_issues,
        totalStems: existing.totalStems + chk.stems_checked,
        checkCount: existing.checkCount + 1
      });
    }
    const results: EmployeeReport[] = [];
    for (const [employee_id, agg] of map.entries()) {
      const emp = employees.find((e) => e.id === employee_id);
      results.push({
        employee_id,
        name: emp?.name ?? "Unknown",
        totalIssues: agg.totalIssues,
        totalStems: agg.totalStems,
        issueRate: safeRate(agg.totalIssues, agg.totalStems),
        checkCount: agg.checkCount
      });
    }
    return results.sort((a, b) => b.issueRate - a.issueRate);
  }, [checks, employees]);

  const chartData = useMemo(
    () =>
      employeeReports.map((r) => ({
        name: r.name,
        rate: parseFloat((r.issueRate * 100).toFixed(2)),
        isOver: r.issueRate >= thresholdRate,
        totalIssues: r.totalIssues,
        totalStems: r.totalStems
      })),
    [employeeReports, thresholdRate]
  );

  // ── Setup handlers ────────────────────────────────────────────────────────

  async function addEmployee(e: FormEvent) {
    e.preventDefault();
    const name = newEmployeeName.trim();
    if (!name) return;
    setEmployeeSaving(true);
    setSetupError(null);
    try {
      const res = await apiFetch("/api/quality/employees", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to add employee");
      }
      setNewEmployeeName("");
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to add employee");
    } finally {
      setEmployeeSaving(false);
    }
  }

  async function toggleEmployee(emp: QualityEmployee) {
    setSetupError(null);
    try {
      const res = await apiFetch(`/api/quality/employees/${emp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !emp.active })
      });
      if (!res.ok) throw new Error("Failed to update employee");
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to update employee");
    }
  }

  async function addMetric(e: FormEvent) {
    e.preventDefault();
    const name = newMetricName.trim();
    if (!name) return;
    setMetricSaving(true);
    setSetupError(null);
    try {
      const res = await apiFetch("/api/quality/metrics", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to add metric");
      }
      setNewMetricName("");
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to add metric");
    } finally {
      setMetricSaving(false);
    }
  }

  async function toggleMetric(metric: QualityMetric) {
    setSetupError(null);
    try {
      const res = await apiFetch(`/api/quality/metrics/${metric.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !metric.active })
      });
      if (!res.ok) throw new Error("Failed to update metric");
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to update metric");
    }
  }

  async function saveThreshold(e: FormEvent) {
    e.preventDefault();
    const allowed_issues = Number(thresholdAllowed);
    const stems_checked = Number(thresholdStems);
    if (!Number.isInteger(allowed_issues) || allowed_issues < 1) {
      setSetupError("Allowed issues must be 1 or greater.");
      return;
    }
    if (!Number.isInteger(stems_checked) || stems_checked < 1) {
      setSetupError("Stems checked must be 1 or greater.");
      return;
    }
    setThresholdSaving(true);
    setSetupError(null);
    setThresholdSaved(false);
    try {
      const res = await apiFetch("/api/quality/threshold", {
        method: "PUT",
        body: JSON.stringify({ allowed_issues, stems_checked })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save threshold");
      }
      setThresholdSaved(true);
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to save threshold");
    } finally {
      setThresholdSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="page-shell">
        <header><h1>Quality Check</h1></header>
        <p>Loading…</p>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Quality Check</h1>
        <p>Track employee quality inspections and monitor issue rates against thresholds.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="tab-navigation">
        <button
          type="button"
          className={`tab-button${activeTab === "reports" ? " active" : ""}`}
          onClick={() => setActiveTab("reports")}
        >
          Reports
        </button>
        <button
          type="button"
          className={`tab-button${activeTab === "setup" ? " active" : ""}`}
          onClick={() => setActiveTab("setup")}
        >
          Setup
        </button>
      </div>

      {/* ── Reports tab ───────────────────────────────────────────────── */}
      {activeTab === "reports" ? (
        <div style={{ marginTop: "1.25rem" }}>
          {checks.length === 0 ? (
            <div className="coming-soon-card">
              <p style={{ fontSize: "0.9em", color: "var(--text-muted)" }}>
                No quality checks recorded yet. Use the mobile Quality Check page to start logging.
              </p>
            </div>
          ) : (
            <>
              {/* Bar chart */}
              <div className="coming-soon-card" style={{ marginBottom: "1rem" }}>
                <h2 style={{ marginBottom: "0.25rem" }}>Issue Rate by Employee</h2>
                <p style={{ fontSize: "0.8em", color: "var(--text-muted)", marginBottom: "0.85rem" }}>
                  Threshold: {threshold.allowed_issues} issues per {threshold.stems_checked} stems
                  ({formatPct(thresholdRate)}). Red bars are at or above threshold.
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis
                      tickFormatter={(v: number) => `${v}%`}
                      tick={{ fontSize: 12 }}
                      domain={[0, "auto"]}
                    />
                    <Tooltip
                      formatter={(value) => {
                        const n = typeof value === "number" ? value : 0;
                        return `${n}%`;
                      }}
                      labelFormatter={(label) => `Employee: ${String(label ?? "")}`}
                    />
                    <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, index) => (
                        <Cell
                          key={index}
                          fill={entry.isOver ? "#dc3545" : "#198754"}
                          fillOpacity={0.85}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Detail table */}
              <div className="coming-soon-card">
                <h2 style={{ marginBottom: "0.75rem" }}>Employee Summary</h2>
                <div className="varieties-table-wrapper">
                  <table className="varieties-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th style={{ textAlign: "right" }}>Checks</th>
                        <th style={{ textAlign: "right" }}>Total Issues</th>
                        <th style={{ textAlign: "right" }}>Stems Checked</th>
                        <th style={{ textAlign: "right" }}>Issue Rate</th>
                        <th style={{ textAlign: "center" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employeeReports.map((r) => {
                        const isOver = r.issueRate >= thresholdRate;
                        return (
                          <tr key={r.employee_id}>
                            <td>{r.name}</td>
                            <td style={{ textAlign: "right" }}>{r.checkCount}</td>
                            <td style={{ textAlign: "right" }}>{r.totalIssues}</td>
                            <td style={{ textAlign: "right" }}>{r.totalStems}</td>
                            <td style={{ textAlign: "right" }}>{formatPct(r.issueRate)}</td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.2rem 0.6rem",
                                  borderRadius: "999px",
                                  fontSize: "0.75rem",
                                  fontWeight: 700,
                                  background: isOver ? "#f8d7da" : "#d1e7dd",
                                  color: isOver ? "#842029" : "#0a3622"
                                }}
                              >
                                {isOver ? "Over threshold" : "Good"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ── Setup tab ─────────────────────────────────────────────────── */}
      {activeTab === "setup" ? (
        <div style={{ marginTop: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          {setupError ? <p className="form-error">{setupError}</p> : null}

          {/* Card 1: Employees */}
          <div className="coming-soon-card">
            <h2>Employees</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Employees who perform quality checks.
            </p>

            {employees.length > 0 ? (
              <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {employees.map((emp) => (
                  <div
                    key={emp.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.45rem 0.65rem",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      background: emp.active ? "var(--surface)" : "var(--surface-soft)"
                    }}
                  >
                    <span style={{ fontSize: "0.9em", color: emp.active ? "var(--text)" : "var(--text-muted)" }}>
                      {emp.name}
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                      onClick={() => void toggleEmployee(emp)}
                    >
                      {emp.active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ marginTop: "0.65rem", fontSize: "0.85em", color: "var(--text-muted)" }}>
                No employees added yet.
              </p>
            )}

            <form onSubmit={(e) => void addEmployee(e)} style={{ marginTop: "0.85rem" }}>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="Employee name"
                  value={newEmployeeName}
                  onChange={(e) => setNewEmployeeName(e.target.value)}
                  style={{ flex: "1 1 160px", minWidth: 0 }}
                />
                <button
                  type="submit"
                  className="primary-action-button"
                  disabled={employeeSaving || !newEmployeeName.trim()}
                  style={{ flexShrink: 0 }}
                >
                  {employeeSaving ? "Adding…" : "Add Employee"}
                </button>
              </div>
            </form>
          </div>

          {/* Card 2: Quality Metrics */}
          <div className="coming-soon-card">
            <h2>Quality Metrics</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Issues to check for on plants (e.g. Double peppers, Missed side shoot, Bad winding).
            </p>

            {metrics.length > 0 ? (
              <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {metrics.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.45rem 0.65rem",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      background: m.active ? "var(--surface)" : "var(--surface-soft)"
                    }}
                  >
                    <span style={{ fontSize: "0.9em", color: m.active ? "var(--text)" : "var(--text-muted)" }}>
                      {m.name}
                      {!m.active ? (
                        <span style={{ marginLeft: "0.4rem", fontSize: "0.8em", color: "var(--text-muted)" }}>
                          (inactive)
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                      onClick={() => void toggleMetric(m)}
                    >
                      {m.active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ marginTop: "0.65rem", fontSize: "0.85em", color: "var(--text-muted)" }}>
                No metrics added yet.
              </p>
            )}

            <form onSubmit={(e) => void addMetric(e)} style={{ marginTop: "0.85rem" }}>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="Metric name (e.g. Double peppers)"
                  value={newMetricName}
                  onChange={(e) => setNewMetricName(e.target.value)}
                  style={{ flex: "1 1 200px", minWidth: 0 }}
                />
                <button
                  type="submit"
                  className="primary-action-button"
                  disabled={metricSaving || !newMetricName.trim()}
                  style={{ flexShrink: 0 }}
                >
                  {metricSaving ? "Adding…" : "Add Metric"}
                </button>
              </div>
            </form>
          </div>

          {/* Card 3: Thresholds */}
          <div className="coming-soon-card">
            <h2>Thresholds</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Set the pass/fail threshold. If an employee's issue count per stems checked is at or above
              this rate, their bar turns red on the Reports tab.
            </p>

            <form onSubmit={(e) => void saveThreshold(e)}>
              <div
                className="varieties-form"
                style={{ marginTop: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}
              >
                <label>
                  Allowed issues
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={thresholdAllowed}
                    onChange={(e) => { setThresholdAllowed(e.target.value); setThresholdSaved(false); }}
                  />
                </label>
                <label>
                  Per stems checked
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={thresholdStems}
                    onChange={(e) => { setThresholdStems(e.target.value); setThresholdSaved(false); }}
                  />
                </label>
              </div>

              {Number(thresholdAllowed) > 0 && Number(thresholdStems) > 0 ? (
                <p style={{ fontSize: "0.82em", color: "var(--text-muted)", marginTop: "0.45rem" }}>
                  Red if {thresholdAllowed} or more issues found per {thresholdStems} stems (
                  {formatPct(safeRate(Number(thresholdAllowed), Number(thresholdStems)))}).
                </p>
              ) : null}

              <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
                <button
                  type="submit"
                  className="primary-action-button"
                  disabled={thresholdSaving}
                >
                  {thresholdSaving ? "Saving…" : "Save Threshold"}
                </button>
                {thresholdSaved ? (
                  <span style={{ fontSize: "0.85em", color: "var(--brand)" }}>Saved.</span>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
