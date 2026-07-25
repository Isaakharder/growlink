import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { enqueue } from "../services/offlineQueue";
import { useMembership } from "../contexts/MembershipContext";
import { getDefaultRoute } from "../utils/getDefaultRoute";

type CheckType = "winding_pruning" | "picking_peppers";

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
  plants_per_slab: number;
  stems_per_plant: number;
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
  check_type: CheckType;
};

type QualityCheck = {
  employee_id: string;
  checked_at: string;
  check_type: CheckType;
};

function getISOWeekYear(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return {
    year: d.getUTCFullYear(),
    week: Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  };
}

function isSameISOWeek(a: Date, b: Date): boolean {
  const wa = getISOWeekYear(a);
  const wb = getISOWeekYear(b);
  return wa.year === wb.year && wa.week === wb.week;
}

function formatCheckedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function MobileQualityCheckPage() {
  const { isOnline } = useOnlineStatus();
  const navigate = useNavigate();
  const { role, permissions } = useMembership();
  const [groups, setGroups] = useState<SetupGroup[]>([]);
  const [allRows, setAllRows] = useState<SetupRow[]>([]);
  const [employees, setEmployees] = useState<QualityEmployee[]>([]);
  const [metrics, setMetrics] = useState<QualityMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error` (used by handleSave below) -- specifically
  // whether the initial setup/employees/metrics/checks load failed, so
  // "No active phases"/"No active employees"/etc. are never shown as if
  // they were a genuine empty result when the request actually failed.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selection state
  const [checkType, setCheckType] = useState<CheckType | "">("");
  const [phaseId, setPhaseId] = useState("");
  const [rowId, setRowId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [slabsChecked, setSlabsChecked] = useState("");
  const [manualStemsPerSlab, setManualStemsPerSlab] = useState("");
  const [notes, setNotes] = useState("");

  // Metric counts keyed by metric id
  const [counts, setCounts] = useState<Record<string, number>>({});

  const [weekChecks, setWeekChecks] = useState<QualityCheck[]>([]);
  const [duplicateWarning, setDuplicateWarning] = useState<{ pendingEmployeeId: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");

  // Session expired or permissions changed while this page was open -- leave
  // immediately for the user's normal authorized landing page rather than
  // get stuck showing a load error. Same pattern as
  // MobileIrrigationLogPage.tsx's fetchLogData().
  function redirectUnauthorized() {
    navigate(getDefaultRoute(role, permissions), { replace: true });
  }

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [setupRes, empRes, metRes, chkRes] = await Promise.all([
        apiFetch("/api/greenhouse-setup"),
        apiFetch("/api/quality/employees"),
        apiFetch("/api/quality/metrics"),
        apiFetch("/api/quality/checks")
      ]);

      const unauthorizedRes = [setupRes, empRes, metRes, chkRes].find(
        (res) => res.status === 401 || res.status === 403
      );
      if (unauthorizedRes) {
        redirectUnauthorized();
        return;
      }

      if (!setupRes.ok || !empRes.ok || !metRes.ok || !chkRes.ok) {
        throw new Error("Failed to load data");
      }
      const setupData = (await setupRes.json()) as { groups: SetupGroup[]; rows: SetupRow[] };
      const empData = (await empRes.json()) as QualityEmployee[];
      const metData = (await metRes.json()) as QualityMetric[];
      const chkData = (await chkRes.json()) as QualityCheck[];

      setGroups(setupData.groups ?? []);
      setAllRows(setupData.rows ?? []);
      setEmployees(empData);
      setMetrics(metData.filter((m) => m.active));

      const now = new Date();
      setWeekChecks(chkData.filter((c) => isSameISOWeek(new Date(c.checked_at), now)));
    } catch {
      setLoadError("Unable to load quality check data. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Derived stems_per_slab from row data; 0 means not configured — fall back to manual
  const derivedStemsPerSlab = useMemo(() => {
    if (!selectedRow) return 0;
    const val = selectedRow.plants_per_slab * selectedRow.stems_per_plant;
    return Number.isFinite(val) && val > 0 ? val : 0;
  }, [selectedRow]);

  const effectiveStemsPerSlab = derivedStemsPerSlab > 0 ? derivedStemsPerSlab : safeNum(manualStemsPerSlab);

  // Metrics filtered by the selected check type
  const visibleMetrics = useMemo(
    () => (checkType ? metrics.filter((m) => m.check_type === checkType) : []),
    [metrics, checkType]
  );

  const totalIssues = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + safeNum(n), 0),
    [counts]
  );

  const empMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of employees) m[e.id] = e.name;
    return m;
  }, [employees]);

  const weekCheckedList = useMemo(() => {
    const relevant = checkType
      ? weekChecks.filter((c) => c.check_type === checkType)
      : weekChecks;
    const byEmp = new Map<string, string>();
    for (const c of relevant) {
      const existing = byEmp.get(c.employee_id);
      if (!existing || c.checked_at > existing) byEmp.set(c.employee_id, c.checked_at);
    }
    return Array.from(byEmp.entries())
      .map(([empId, checkedAt]) => ({ empId, name: empMap[empId] ?? "Unknown employee", checkedAt }))
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  }, [weekChecks, empMap, checkType]);

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
    setManualStemsPerSlab("");
    setSavedMessage("");
  }

  function handleRowChange(id: string) {
    setRowId(id);
    setManualStemsPerSlab("");
    setSavedMessage("");
  }

  function handleCheckTypeChange(ct: CheckType) {
    setCheckType(ct);
    setCounts({});
    setSavedMessage("");
  }

  const slabsNum = safeNum(slabsChecked);

  const canSave =
    checkType !== "" &&
    phaseId !== "" &&
    rowId !== "" &&
    employeeId !== "" &&
    slabsNum > 0 &&
    effectiveStemsPerSlab > 0;

  async function handleSave() {
    if (!canSave || saving || !checkType) return;
    setSaving(true);
    setError(null);
    setSavedMessage("");

    const metricCounts: Record<string, number> = {};
    for (const m of visibleMetrics) {
      metricCounts[m.id] = safeNum(counts[m.id]);
    }

    const postBody = JSON.stringify({
      check_type: checkType,
      employee_id: employeeId,
      phase_id: phaseId || null,
      phase_name: selectedPhase?.name ?? "",
      row_id: rowId || null,
      row_number: selectedRow?.row_number ?? 0,
      slabs_checked: slabsNum,
      stems_per_slab_snapshot: effectiveStemsPerSlab,
      metric_counts: metricCounts,
      total_issues: totalIssues,
      notes: notes.trim() || null
    });

    try {
      if (!isOnline) {
        await enqueue({ module: "quality", url: "/api/quality/checks", method: "POST", body: postBody });
        setSavedMessage("Saved offline — will sync when connected.");
        setPhaseId("");
        setRowId("");
        setSlabsChecked("");
        setManualStemsPerSlab("");
        setNotes("");
        setCounts({});
        return;
      }

      const res = await apiFetch("/api/quality/checks", { method: "POST", body: postBody });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save");
      }
      setSavedMessage("Quality check saved.");
      setPhaseId("");
      setRowId("");
      setSlabsChecked("");
      setManualStemsPerSlab("");
      setNotes("");
      setCounts({});
      // Refresh week checks so the duplicate warning stays accurate
      apiFetch("/api/quality/checks").then(async (r) => {
        if (r.ok) {
          const all = (await r.json()) as QualityCheck[];
          const now = new Date();
          setWeekChecks(all.filter((c) => isSameISOWeek(new Date(c.checked_at), now)));
        }
      }).catch(() => undefined);
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

  if (loadError) {
    return (
      <section className="mobile-page">
        <h2>Quality Check</h2>
        <div className="mobile-yield-card">
          <p className="form-error" style={{ margin: 0 }}>{loadError}</p>
          <button type="button" style={{ marginTop: "0.6rem" }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const checkTypeLabel = checkType === "winding_pruning" ? "Winding/Pruning"
    : checkType === "picking_peppers" ? "Picking Peppers"
    : "";

  return (
    <section className="mobile-page">
      <h2>Quality Check</h2>

      {error ? <p className="form-error" style={{ marginBottom: "0.75rem" }}>{error}</p> : null}

      {/* Step 0: Check Type */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
          0. Check Type <span style={{ color: "#dc3545" }}>*</span>
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {(["winding_pruning", "picking_peppers"] as const).map((ct) => {
            const label = ct === "winding_pruning" ? "Winding/Pruning" : "Picking Peppers";
            const isSelected = checkType === ct;
            return (
              <button
                key={ct}
                type="button"
                onClick={() => handleCheckTypeChange(ct)}
                style={{
                  flex: 1,
                  padding: "0.65rem 0.5rem",
                  borderRadius: "10px",
                  border: `2px solid ${isSelected ? "var(--brand)" : "var(--border)"}`,
                  background: isSelected ? "var(--brand-soft)" : "var(--surface)",
                  color: isSelected ? "var(--brand)" : "var(--text)",
                  fontWeight: isSelected ? 700 : 400,
                  fontSize: "0.88rem",
                  cursor: "pointer",
                  transition: "all 0.15s"
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

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
            onChange={(e) => handleRowChange(e.target.value)}
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
        {employees.filter((e) => e.active).length === 0 ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>
            No active employees. Add employees in Quality Check Setup.
          </p>
        ) : (
          <select
            className="quality-select"
            value={employeeId}
            onChange={(e) => {
              const id = e.target.value;
              setSavedMessage("");
              if (id && checkType && weekChecks.some((c) => c.employee_id === id && c.check_type === checkType)) {
                setDuplicateWarning({ pendingEmployeeId: id });
              } else {
                setEmployeeId(id);
              }
            }}
          >
            <option value="">Select employee…</option>
            {employees.filter((e) => e.active).map((emp) => (
              <option key={emp.id} value={emp.id}>{emp.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Step 4: Issues Found */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.6rem" }}>
          4. Issues Found{checkTypeLabel ? ` — ${checkTypeLabel}` : ""}
        </p>

        {!checkType ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>
            Select a check type above to see metrics.
          </p>
        ) : visibleMetrics.length === 0 ? (
          <p style={{ fontSize: "0.88em", color: "var(--text-muted)" }}>
            No active {checkTypeLabel} metrics. Add metrics in Quality Check Setup.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {visibleMetrics.map((m) => {
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
        {visibleMetrics.length > 0 ? (
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

      {/* Slabs, Stems + Notes */}
      <div className="pest-section-form" style={{ marginBottom: "0.75rem" }}>
        <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
          5. Slabs, Stems & Notes
        </p>

        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.4rem" }}>
          <label style={{ flex: 1 }}>
            <span style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.25rem" }}>
              Slabs checked <span style={{ color: "#dc3545" }}>*</span>
            </span>
            <input
              className="quality-input"
              type="number"
              min="1"
              step="1"
              value={slabsChecked}
              placeholder="e.g. 10"
              onChange={(e) => { setSlabsChecked(e.target.value); setSavedMessage(""); }}
            />
          </label>
          <label style={{ flex: 1 }}>
            <span style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.25rem" }}>
              Stems per slab <span style={{ color: "#dc3545" }}>*</span>
            </span>
            {derivedStemsPerSlab > 0 ? (
              <div
                style={{
                  padding: "0.55rem 0.65rem",
                  borderRadius: "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface-soft)",
                  fontSize: "0.95rem",
                  color: "var(--text)",
                  fontWeight: 600
                }}
              >
                {derivedStemsPerSlab}
                <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--text-muted)", marginLeft: "0.35rem" }}>
                  (from row)
                </span>
              </div>
            ) : (
              <input
                className="quality-input"
                type="number"
                min="0.1"
                step="0.1"
                value={manualStemsPerSlab}
                placeholder="Enter manually"
                onChange={(e) => { setManualStemsPerSlab(e.target.value); setSavedMessage(""); }}
              />
            )}
          </label>
        </div>

        {slabsNum > 0 && effectiveStemsPerSlab > 0 ? (
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0 0 0.6rem" }}>
            Calculated stems checked: <strong>{Math.round(slabsNum * effectiveStemsPerSlab)}</strong>
          </p>
        ) : (
          <div style={{ marginBottom: "0.6rem" }} />
        )}

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
          {!checkType
            ? "Select a check type to continue."
            : !phaseId
            ? "Select a phase to continue."
            : !rowId
            ? "Select a row to continue."
            : !employeeId
            ? "Select an employee to continue."
            : effectiveStemsPerSlab <= 0
            ? "Enter stems per slab to save."
            : "Enter slabs checked to save."}
        </p>
      ) : null}

      {savedMessage ? (
        <p style={{ fontSize: "0.9rem", color: "var(--brand)", textAlign: "center", fontWeight: 600, marginTop: "0.5rem" }}>
          {savedMessage}
        </p>
      ) : null}

      {/* Already checked this week */}
      {weekCheckedList.length > 0 ? (
        <div className="pest-section-form" style={{ marginTop: "1.5rem" }}>
          <p style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", margin: "0 0 0.5rem" }}>
            Already Checked This Week
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {weekCheckedList.map((entry) => (
              <div
                key={entry.empId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0.6rem",
                  borderRadius: "8px",
                  background: "var(--surface-soft)",
                  border: "1px solid var(--border)"
                }}
              >
                <span style={{ fontSize: "0.9rem", fontWeight: 500 }}>{entry.name}</span>
                <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{formatCheckedAt(entry.checkedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Duplicate employee warning modal */}
      {duplicateWarning ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1.5rem"
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              borderRadius: "12px",
              padding: "1.75rem 1.5rem",
              maxWidth: "320px",
              width: "100%",
              textAlign: "center",
              boxShadow: "0 8px 32px rgba(0,0,0,0.22)"
            }}
          >
            <p style={{ fontSize: "1.6rem", margin: "0 0 0.5rem" }}>⚠️</p>
            <p style={{ margin: "0 0 1.25rem", fontSize: "0.95rem" }}>
              This person's quality has already been checked this week. Do you want to check again?
            </p>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button
                type="button"
                style={{ flex: 1 }}
                onClick={() => {
                  setDuplicateWarning(null);
                  setEmployeeId("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-action-button"
                style={{ flex: 1 }}
                onClick={() => {
                  setEmployeeId(duplicateWarning.pendingEmployeeId);
                  setDuplicateWarning(null);
                }}
              >
                Yes, check again
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
