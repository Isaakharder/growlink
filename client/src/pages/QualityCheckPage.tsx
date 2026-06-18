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

type CheckType = "winding_pruning" | "picking_peppers";

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
  check_type: CheckType;
  created_at: string;
};

type QualityThreshold = {
  id?: string;
  allowed_issues: number;
  stems_checked: number;
  check_type?: CheckType;
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

type EmployeeTrend = {
  employee_id: string;
  name: string;
  checkCount: number;
  earlierPct: number;
  recentPct: number;
  diffPct: number;
  status: "improving" | "worsening" | "stable" | "insufficient";
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
  const [thresholdWP, setThresholdWP] = useState<QualityThreshold>({ allowed_issues: 10, stems_checked: 100 });
  const [thresholdPP, setThresholdPP] = useState<QualityThreshold>({ allowed_issues: 10, stems_checked: 100 });
  const [checks, setChecks] = useState<QualityCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Setup form state
  const [newEmployeeName, setNewEmployeeName] = useState("");
  const [employeeSaving, setEmployeeSaving] = useState(false);
  const [newMetricNameWP, setNewMetricNameWP] = useState("");
  const [metricSavingWP, setMetricSavingWP] = useState(false);
  const [newMetricNamePP, setNewMetricNamePP] = useState("");
  const [metricSavingPP, setMetricSavingPP] = useState(false);

  // Threshold WP
  const [thresholdAllowedWP, setThresholdAllowedWP] = useState("10");
  const [thresholdStemsWP, setThresholdStemsWP] = useState("100");
  const [thresholdSavingWP, setThresholdSavingWP] = useState(false);
  const [thresholdSavedWP, setThresholdSavedWP] = useState(false);

  // Threshold PP
  const [thresholdAllowedPP, setThresholdAllowedPP] = useState("10");
  const [thresholdStemsPP, setThresholdStemsPP] = useState("100");
  const [thresholdSavingPP, setThresholdSavingPP] = useState(false);
  const [thresholdSavedPP, setThresholdSavedPP] = useState(false);

  const [setupError, setSetupError] = useState<string | null>(null);

  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [editingEmployeeName, setEditingEmployeeName] = useState("");
  const [editingSaving, setEditingSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [empRes, metRes, thrWPRes, thrPPRes, chkRes] = await Promise.all([
        apiFetch("/api/quality/employees"),
        apiFetch("/api/quality/metrics"),
        apiFetch("/api/quality/threshold?check_type=winding_pruning"),
        apiFetch("/api/quality/threshold?check_type=picking_peppers"),
        apiFetch("/api/quality/checks")
      ]);
      if (!empRes.ok || !metRes.ok || !thrWPRes.ok || !thrPPRes.ok || !chkRes.ok) {
        throw new Error("Failed to load quality data");
      }
      const [empData, metData, thrWPData, thrPPData, chkData] = await Promise.all([
        empRes.json() as Promise<QualityEmployee[]>,
        metRes.json() as Promise<QualityMetric[]>,
        thrWPRes.json() as Promise<QualityThreshold>,
        thrPPRes.json() as Promise<QualityThreshold>,
        chkRes.json() as Promise<QualityCheck[]>
      ]);
      setEmployees(empData);
      setMetrics(metData);
      setThresholdWP(thrWPData);
      setThresholdPP(thrPPData);
      setThresholdAllowedWP(String(thrWPData.allowed_issues));
      setThresholdStemsWP(String(thrWPData.stems_checked));
      setThresholdAllowedPP(String(thrPPData.allowed_issues));
      setThresholdStemsPP(String(thrPPData.stems_checked));
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
    () => safeRate(thresholdWP.allowed_issues, thresholdWP.stems_checked),
    [thresholdWP]
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

  const trendData = useMemo((): EmployeeTrend[] => {
    const byEmployee = new Map<string, typeof checks>();
    for (const chk of checks) {
      if (!byEmployee.has(chk.employee_id)) byEmployee.set(chk.employee_id, []);
      byEmployee.get(chk.employee_id)!.push(chk);
    }
    for (const arr of byEmployee.values()) {
      arr.sort((a, b) => a.checked_at.localeCompare(b.checked_at));
    }

    const results: EmployeeTrend[] = [];
    for (const [employee_id, empChecks] of byEmployee.entries()) {
      const emp = employees.find((e) => e.id === employee_id);
      const name = emp?.name ?? "Unknown";
      const n = empChecks.length;

      if (n < 2) {
        results.push({ employee_id, name, checkCount: n, earlierPct: 0, recentPct: 0, diffPct: 0, status: "insufficient" });
        continue;
      }

      const splitIdx = Math.ceil(n / 2);
      const earlier = empChecks.slice(0, splitIdx);
      const recent = empChecks.slice(splitIdx);

      const earlierRate = safeRate(
        earlier.reduce((s, c) => s + c.total_issues, 0),
        earlier.reduce((s, c) => s + c.stems_checked, 0)
      );
      const recentRate = safeRate(
        recent.reduce((s, c) => s + c.total_issues, 0),
        recent.reduce((s, c) => s + c.stems_checked, 0)
      );

      const earlierPct = earlierRate * 100;
      const recentPct = recentRate * 100;
      const diffPct = recentPct - earlierPct;

      let status: EmployeeTrend["status"];
      if (Math.abs(diffPct) < 0.5) status = "stable";
      else if (diffPct < 0) status = "improving";
      else status = "worsening";

      results.push({ employee_id, name, checkCount: n, earlierPct, recentPct, diffPct, status });
    }

    const order = { worsening: 0, stable: 1, improving: 2, insufficient: 3 };
    return results.sort((a, b) => order[a.status] - order[b.status]);
  }, [checks, employees]);

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

  function startEditEmployee(emp: QualityEmployee) {
    setEditingEmployeeId(emp.id);
    setEditingEmployeeName(emp.name);
  }

  function cancelEditEmployee() {
    setEditingEmployeeId(null);
    setEditingEmployeeName("");
  }

  async function saveEditEmployee(empId: string) {
    const name = editingEmployeeName.trim();
    if (!name) return;
    setEditingSaving(true);
    setSetupError(null);
    try {
      const res = await apiFetch(`/api/quality/employees/${empId}`, {
        method: "PATCH",
        body: JSON.stringify({ name })
      });
      if (!res.ok) throw new Error("Failed to rename employee");
      cancelEditEmployee();
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to rename employee");
    } finally {
      setEditingSaving(false);
    }
  }

  async function deleteEmployee(emp: QualityEmployee) {
    const hasRecords = checks.some((c) => c.employee_id === emp.id);
    const msg = hasRecords
      ? `"${emp.name}" has quality check records and will be archived (deactivated). Continue?`
      : `Delete "${emp.name}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setSetupError(null);
    try {
      const res = await apiFetch(`/api/quality/employees/${emp.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to remove employee");
      }
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to remove employee");
    }
  }

  async function permanentDeleteEmployee(emp: QualityEmployee) {
    const checkCount = checks.filter((c) => c.employee_id === emp.id).length;
    const msg =
      `This will permanently delete "${emp.name}"` +
      (checkCount > 0 ? ` and all ${checkCount} quality check record${checkCount !== 1 ? "s" : ""} for them` : "") +
      `. This cannot be undone. Continue?`;
    if (!window.confirm(msg)) return;
    setSetupError(null);
    try {
      const res = await apiFetch(`/api/quality/employees/${emp.id}/permanent`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to permanently delete employee");
      }
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to permanently delete employee");
    }
  }

  async function addMetric(e: FormEvent, checkType: CheckType) {
    e.preventDefault();
    const isWP = checkType === "winding_pruning";
    const name = (isWP ? newMetricNameWP : newMetricNamePP).trim();
    if (!name) return;
    if (isWP) setMetricSavingWP(true); else setMetricSavingPP(true);
    setSetupError(null);
    try {
      const res = await apiFetch("/api/quality/metrics", {
        method: "POST",
        body: JSON.stringify({ name, check_type: checkType })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to add metric");
      }
      if (isWP) setNewMetricNameWP(""); else setNewMetricNamePP("");
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to add metric");
    } finally {
      if (isWP) setMetricSavingWP(false); else setMetricSavingPP(false);
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

  async function saveThreshold(e: FormEvent, checkType: CheckType) {
    e.preventDefault();
    const isWP = checkType === "winding_pruning";
    const allowed_issues = Number(isWP ? thresholdAllowedWP : thresholdAllowedPP);
    const stems_checked = Number(isWP ? thresholdStemsWP : thresholdStemsPP);
    if (!Number.isInteger(allowed_issues) || allowed_issues < 1) {
      setSetupError("Allowed issues must be 1 or greater.");
      return;
    }
    if (!Number.isInteger(stems_checked) || stems_checked < 1) {
      setSetupError("Stems checked must be 1 or greater.");
      return;
    }
    if (isWP) { setThresholdSavingWP(true); setThresholdSavedWP(false); }
    else { setThresholdSavingPP(true); setThresholdSavedPP(false); }
    setSetupError(null);
    try {
      const res = await apiFetch("/api/quality/threshold", {
        method: "PUT",
        body: JSON.stringify({ allowed_issues, stems_checked, check_type: checkType })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save threshold");
      }
      if (isWP) setThresholdSavedWP(true); else setThresholdSavedPP(true);
      await load();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to save threshold");
    } finally {
      if (isWP) setThresholdSavingWP(false); else setThresholdSavingPP(false);
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

  const metricsWP = metrics.filter((m) => m.check_type === "winding_pruning");
  const metricsPP = metrics.filter((m) => m.check_type === "picking_peppers");

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
                  Threshold: {thresholdWP.allowed_issues} issues per {thresholdWP.stems_checked} stems
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

              {/* Trend card */}
              <div className="coming-soon-card" style={{ marginBottom: "1rem" }}>
                <h2 style={{ marginBottom: "0.25rem" }}>Quality Trend by Employee</h2>
                <p style={{ fontSize: "0.8em", color: "var(--text-muted)", marginBottom: "0.85rem" }}>
                  Compares each employee's earlier checks against their recent checks. Lower issue rate is better.
                </p>
                <div className="varieties-table-wrapper">
                  <table className="varieties-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th style={{ textAlign: "right" }}>Checks</th>
                        <th style={{ textAlign: "right" }}>Earlier rate</th>
                        <th style={{ textAlign: "right" }}>Recent rate</th>
                        <th style={{ textAlign: "right" }}>Change</th>
                        <th style={{ textAlign: "center" }}>Trend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trendData.map((t) => {
                        const badgeStyle: React.CSSProperties = {
                          display: "inline-block",
                          padding: "0.2rem 0.6rem",
                          borderRadius: "999px",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          background:
                            t.status === "improving" ? "#d1e7dd"
                            : t.status === "worsening" ? "#f8d7da"
                            : "#e9ecef",
                          color:
                            t.status === "improving" ? "#0a3622"
                            : t.status === "worsening" ? "#842029"
                            : "#495057"
                        };
                        const label =
                          t.status === "improving" ? "Improving ↓"
                          : t.status === "worsening" ? "Getting worse ↑"
                          : t.status === "stable" ? "Stable"
                          : "Need more checks";
                        const diffSign = t.diffPct > 0 ? "+" : "";
                        return (
                          <tr key={t.employee_id}>
                            <td>{t.name}</td>
                            <td style={{ textAlign: "right" }}>{t.checkCount}</td>
                            <td style={{ textAlign: "right" }}>
                              {t.status === "insufficient" ? "–" : `${t.earlierPct.toFixed(1)}%`}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {t.status === "insufficient" ? "–" : `${t.recentPct.toFixed(1)}%`}
                            </td>
                            <td style={{ textAlign: "right", color: t.status === "improving" ? "#0a3622" : t.status === "worsening" ? "#842029" : "var(--text-muted)" }}>
                              {t.status === "insufficient" ? "–" : `${diffSign}${t.diffPct.toFixed(1)}%`}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span style={badgeStyle}>{label}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employeeReports.map((r) => {
                        const isOver = r.issueRate >= thresholdRate;
                        const emp = employees.find((e) => e.id === r.employee_id);
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
                            <td>
                              {emp ? (
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    className="secondary"
                                    style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                    onClick={() => startEditEmployee(emp)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="danger"
                                    style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                    onClick={() => void deleteEmployee(emp)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              ) : null}
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
                      gap: "0.5rem",
                      padding: "0.45rem 0.65rem",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      background: emp.active ? "var(--surface)" : "var(--surface-soft)"
                    }}
                  >
                    {editingEmployeeId === emp.id ? (
                      <>
                        <input
                          type="text"
                          value={editingEmployeeName}
                          onChange={(e) => setEditingEmployeeName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveEditEmployee(emp.id);
                            if (e.key === "Escape") cancelEditEmployee();
                          }}
                          style={{ flex: 1, fontSize: "0.9em" }}
                          autoFocus
                        />
                        <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
                          <button
                            type="button"
                            className="secondary"
                            style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                            onClick={() => void saveEditEmployee(emp.id)}
                            disabled={editingSaving || !editingEmployeeName.trim()}
                          >
                            {editingSaving ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                            onClick={cancelEditEmployee}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span style={{ fontSize: "0.9em", color: emp.active ? "var(--text)" : "var(--text-muted)", flex: 1 }}>
                          {emp.name}
                          {!emp.active ? (
                            <span style={{ marginLeft: "0.4rem", fontSize: "0.8em", color: "var(--text-muted)" }}>
                              (inactive)
                            </span>
                          ) : null}
                        </span>
                        <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
                          <button
                            type="button"
                            className="secondary"
                            style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                            onClick={() => startEditEmployee(emp)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                            onClick={() => void deleteEmployee(emp)}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            className="danger"
                            style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem", opacity: 0.75 }}
                            onClick={() => void permanentDeleteEmployee(emp)}
                          >
                            Delete permanently
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                            onClick={() => void toggleEmployee(emp)}
                          >
                            {emp.active ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      </>
                    )}
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

          {/* Card 2: Quality Metrics – Winding/Pruning */}
          <div className="coming-soon-card">
            <h2>Quality Metrics – Winding/Pruning</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Issues to check during winding and pruning (e.g. Missed side shoot, Bad winding).
            </p>

            {metricsWP.length > 0 ? (
              <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {metricsWP.map((m) => (
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
                No winding/pruning metrics added yet.
              </p>
            )}

            <form onSubmit={(e) => void addMetric(e, "winding_pruning")} style={{ marginTop: "0.85rem" }}>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="Metric name (e.g. Missed side shoot)"
                  value={newMetricNameWP}
                  onChange={(e) => setNewMetricNameWP(e.target.value)}
                  style={{ flex: "1 1 200px", minWidth: 0 }}
                />
                <button
                  type="submit"
                  className="primary-action-button"
                  disabled={metricSavingWP || !newMetricNameWP.trim()}
                  style={{ flexShrink: 0 }}
                >
                  {metricSavingWP ? "Adding…" : "Add Metric"}
                </button>
              </div>
            </form>
          </div>

          {/* Card 3: Quality Metrics – Picking Peppers */}
          <div className="coming-soon-card">
            <h2>Quality Metrics – Picking Peppers</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Issues to check during pepper picking (e.g. Double peppers, Missed pepper).
            </p>

            {metricsPP.length > 0 ? (
              <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {metricsPP.map((m) => (
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
                No picking peppers metrics added yet.
              </p>
            )}

            <form onSubmit={(e) => void addMetric(e, "picking_peppers")} style={{ marginTop: "0.85rem" }}>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="Metric name (e.g. Double peppers)"
                  value={newMetricNamePP}
                  onChange={(e) => setNewMetricNamePP(e.target.value)}
                  style={{ flex: "1 1 200px", minWidth: 0 }}
                />
                <button
                  type="submit"
                  className="primary-action-button"
                  disabled={metricSavingPP || !newMetricNamePP.trim()}
                  style={{ flexShrink: 0 }}
                >
                  {metricSavingPP ? "Adding…" : "Add Metric"}
                </button>
              </div>
            </form>
          </div>

          {/* Card 4: Threshold – Winding/Pruning */}
          <div className="coming-soon-card">
            <h2>Threshold – Winding/Pruning</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Pass/fail threshold for winding and pruning checks. If an employee's issue count per stems checked
              is at or above this rate, their bar turns red on the Reports tab.
            </p>

            <form onSubmit={(e) => void saveThreshold(e, "winding_pruning")}>
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
                    value={thresholdAllowedWP}
                    onChange={(e) => { setThresholdAllowedWP(e.target.value); setThresholdSavedWP(false); }}
                  />
                </label>
                <label>
                  Per stems checked
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={thresholdStemsWP}
                    onChange={(e) => { setThresholdStemsWP(e.target.value); setThresholdSavedWP(false); }}
                  />
                </label>
              </div>

              {Number(thresholdAllowedWP) > 0 && Number(thresholdStemsWP) > 0 ? (
                <p style={{ fontSize: "0.82em", color: "var(--text-muted)", marginTop: "0.45rem" }}>
                  Red if {thresholdAllowedWP} or more issues found per {thresholdStemsWP} stems (
                  {formatPct(safeRate(Number(thresholdAllowedWP), Number(thresholdStemsWP)))}).
                </p>
              ) : null}

              <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
                <button type="submit" className="primary-action-button" disabled={thresholdSavingWP}>
                  {thresholdSavingWP ? "Saving…" : "Save Threshold"}
                </button>
                {thresholdSavedWP ? (
                  <span style={{ fontSize: "0.85em", color: "var(--brand)" }}>Saved.</span>
                ) : null}
              </div>
            </form>
          </div>

          {/* Card 5: Threshold – Picking Peppers */}
          <div className="coming-soon-card">
            <h2>Threshold – Picking Peppers</h2>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Pass/fail threshold for picking peppers checks.
            </p>

            <form onSubmit={(e) => void saveThreshold(e, "picking_peppers")}>
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
                    value={thresholdAllowedPP}
                    onChange={(e) => { setThresholdAllowedPP(e.target.value); setThresholdSavedPP(false); }}
                  />
                </label>
                <label>
                  Per stems checked
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={thresholdStemsPP}
                    onChange={(e) => { setThresholdStemsPP(e.target.value); setThresholdSavedPP(false); }}
                  />
                </label>
              </div>

              {Number(thresholdAllowedPP) > 0 && Number(thresholdStemsPP) > 0 ? (
                <p style={{ fontSize: "0.82em", color: "var(--text-muted)", marginTop: "0.45rem" }}>
                  Red if {thresholdAllowedPP} or more issues found per {thresholdStemsPP} stems (
                  {formatPct(safeRate(Number(thresholdAllowedPP), Number(thresholdStemsPP)))}).
                </p>
              ) : null}

              <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
                <button type="submit" className="primary-action-button" disabled={thresholdSavingPP}>
                  {thresholdSavingPP ? "Saving…" : "Save Threshold"}
                </button>
                {thresholdSavedPP ? (
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
