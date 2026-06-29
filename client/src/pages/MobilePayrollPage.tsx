import { type CSSProperties, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

// ── types ─────────────────────────────────────────────────────────────────────

type Employee = {
  id: string;
  name: string;
  active: boolean;
  activeShiftId: string | null;
};

// ── component ─────────────────────────────────────────────────────────────────

export function MobilePayrollPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    void loadEmployees();
  }, []);

  async function loadEmployees() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/payroll/employees");
      const body = (await res.json().catch(() => ({}))) as { employees?: Employee[]; message?: string };
      if (!res.ok) {
        setError(body.message ?? "Failed to load employees.");
        return;
      }
      setEmployees((body.employees ?? []).filter((e) => e.active));
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleClockAction() {
    if (!selectedEmployee || acting) return;
    setActing(true);

    const isClockingIn = selectedEmployee.activeShiftId === null;
    const endpoint = isClockingIn ? "/api/payroll/clock-in" : "/api/payroll/clock-out";

    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ employee_id: selectedEmployee.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? "Action failed. Please try again.");
        setActing(false);
        return;
      }
      // Return to list and refresh so activeShiftId is up to date
      setActing(false);
      setSelectedEmployee(null);
      void loadEmployees();
    } catch {
      setError("Network error. Please try again.");
      setActing(false);
    }
  }

  // ── employee detail screen ────────────────────────────────────────────────
  if (selectedEmployee) {
    const isClockedIn = selectedEmployee.activeShiftId !== null;
    return (
      <section className="mobile-page">
        <button
          type="button"
          onClick={() => { setSelectedEmployee(null); setError(null); }}
          style={backBtnStyle}
        >
          ← Back
        </button>

        <h2 style={employeeNameStyle}>{selectedEmployee.name}</h2>

        {error && <p style={errorStyle}>{error}</p>}

        <button
          type="button"
          onClick={() => void handleClockAction()}
          disabled={acting}
          style={isClockedIn ? endWorkBtnStyle : startWorkBtnStyle}
        >
          {acting ? "Please wait…" : isClockedIn ? "End Work" : "Start Work"}
        </button>
      </section>
    );
  }

  // ── employee list screen ──────────────────────────────────────────────────
  return (
    <section className="mobile-page">
      <h2>Clock In / Out</h2>
      <p>Tap your name to start or end your shift.</p>

      {error && <p style={errorStyle}>{error}</p>}

      {loading ? (
        <p style={mutedStyle}>Loading…</p>
      ) : employees.length === 0 ? (
        <p style={mutedStyle}>No active employees found. Ask your manager to add you in the Payroll settings.</p>
      ) : (
        <div style={listStyle}>
          {employees.map((emp) => (
            <button
              key={emp.id}
              type="button"
              onClick={() => { setError(null); setSelectedEmployee(emp); }}
              style={empBtnStyle}
            >
              <span style={empNameStyle}>{emp.name}</span>
              {emp.activeShiftId !== null && (
                <span style={clockedInPillStyle}>Working</span>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const backBtnStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "var(--brand)",
  fontSize: "0.9rem",
  fontWeight: 500,
  padding: "0 0 0.5rem",
  marginBottom: "0.5rem",
};

const employeeNameStyle: CSSProperties = {
  fontSize: "1.4rem",
  fontWeight: 700,
  color: "var(--text)",
  marginBottom: "2rem",
  textAlign: "center",
};

const actionBtnBase: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "1.5rem",
  border: "none",
  borderRadius: 12,
  cursor: "pointer",
  fontSize: "1.4rem",
  fontWeight: 700,
  textAlign: "center",
};

const startWorkBtnStyle: CSSProperties = {
  ...actionBtnBase,
  background: "#1f7a42",
  color: "#fff",
};

const endWorkBtnStyle: CSSProperties = {
  ...actionBtnBase,
  background: "#c0392b",
  color: "#fff",
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
  marginTop: "0.5rem",
};

const empBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: "1rem 1.1rem",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  cursor: "pointer",
  textAlign: "left",
};

const empNameStyle: CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--text)",
};

const clockedInPillStyle: CSSProperties = {
  display: "inline-block",
  padding: "0.2rem 0.55rem",
  background: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fde68a",
  borderRadius: 999,
  fontSize: "0.75rem",
  fontWeight: 600,
};

const errorStyle: CSSProperties = {
  padding: "0.5rem 0.65rem",
  background: "#fdf2f2",
  border: "1px solid #f5c6c6",
  borderRadius: 6,
  fontSize: "0.85rem",
  color: "#c0392b",
  marginBottom: "1rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.875rem",
};
