import { Fragment, FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { BONUS_PRINT_CSS, BonusPrintStatements } from "./BonusPrintStatements";
import { BonusPdfImport } from "./BonusPdfImport";
import { BonusLinearAdjustmentSetup } from "./BonusLinearAdjustmentSetup";
import {
  BonusPrintEmployeeGroup,
  buildDateRangeLabel,
  buildJobFilterLabel,
  buildPrintGroups,
  formatWeekLabel,
  formatWeekRangeLabel,
  getWeekEndISO,
  getWeekStartISO,
  groupByEmployeeWeek,
  round2
} from "./bonusWeeks";

export type CheckType = "winding_pruning" | "picking_peppers";

export type BonusEmployee = {
  id: string;
  name: string;
  active: boolean;
};

type BonusTier = {
  id: string;
  check_type: CheckType;
  min_speed: number;
  bonus_rate_per_hour: number;
};

export type BonusEntry = {
  id: string;
  employee_id: string;
  employee_name: string;
  entry_date: string;
  check_type: CheckType;
  entered_speed: number;
  speed_unit: string;
  hours_worked: number;
  applied_threshold: number | null;
  applied_rate: number;
  base_threshold: number | null;
  raw_adjustment: number | null;
  final_adjustment: number | null;
  weekly_crop_load: number | null; // picking_peppers: weekly harvested kg/m^2
  weekly_sets_per_plant: number | null; // winding_pruning: weekly fruit sets/m^2
  standard_value_used: number | null;
  value_step_used: number | null;
  speed_change_per_step_used: number | null;
  min_adjustment_used: number | null;
  max_adjustment_used: number | null;
  total_bonus: number;
  created_at: string;
  updated_at?: string | null;
};

type BonusesTabProps = {
  employees: BonusEmployee[];
  canEdit: boolean;
};

type BonusSubTab = "entry" | "setup";

export const JOB_LABEL: Record<CheckType, string> = {
  picking_peppers: "Picking",
  winding_pruning: "Winding/Pruning"
};

const SPEED_LABEL: Record<CheckType, string> = {
  picking_peppers: "Picking speed — kg/hr",
  winding_pruning: "Speed — heads/hr"
};

const SPEED_UNIT: Record<CheckType, string> = {
  picking_peppers: "kg/hr",
  winding_pruning: "heads/hr"
};

export function formatCAD(n: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(
    Number.isFinite(n) ? n : 0
  );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentWeekStartISO(): string {
  return getWeekStartISO(todayISO());
}

function computeApplied(tiers: BonusTier[], checkType: CheckType, enteredSpeed: number) {
  const candidates = tiers.filter((t) => t.check_type === checkType && t.min_speed <= enteredSpeed);
  if (candidates.length === 0) return { applied_threshold: null as number | null, applied_rate: 0 };
  const best = candidates.reduce((a, b) => (b.min_speed > a.min_speed ? b : a));
  return { applied_threshold: best.min_speed, applied_rate: best.bonus_rate_per_hour };
}

export function BonusesTab({ employees, canEdit }: BonusesTabProps) {
  const [subTab, setSubTab] = useState<BonusSubTab>("entry");

  const [tiers, setTiers] = useState<BonusTier[]>([]);
  const [entries, setEntries] = useState<BonusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Entry form state
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [formEmployeeId, setFormEmployeeId] = useState("");
  const [formDate, setFormDate] = useState(currentWeekStartISO());
  const [formJob, setFormJob] = useState<CheckType>("picking_peppers");
  const [formSpeed, setFormSpeed] = useState("");
  const [formHours, setFormHours] = useState("");
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);

  // History filters
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [filterEmployee, setFilterEmployee] = useState("");
  const [filterJob, setFilterJob] = useState("");

  // Setup form state
  const [newTierSpeed, setNewTierSpeed] = useState<Record<CheckType, string>>({
    picking_peppers: "",
    winding_pruning: ""
  });
  const [newTierRate, setNewTierRate] = useState<Record<CheckType, string>>({
    picking_peppers: "",
    winding_pruning: ""
  });
  const [tierSaving, setTierSaving] = useState<CheckType | null>(null);
  const [editingTierId, setEditingTierId] = useState<string | null>(null);
  const [editingTierSpeed, setEditingTierSpeed] = useState("");
  const [editingTierRate, setEditingTierRate] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);

  // Print state
  const [printJob, setPrintJob] = useState<{ groups: BonusPrintEmployeeGroup[]; dateRangeLabel: string; jobLabel: string } | null>(null);

  useEffect(() => {
    if (!printJob) return;

    const style = document.createElement("style");
    style.setAttribute("data-bonus-print", "true");
    style.textContent = BONUS_PRINT_CSS;
    document.head.appendChild(style);

    function finishPrint() {
      window.removeEventListener("afterprint", finishPrint);
      setPrintJob(null);
    }
    window.addEventListener("afterprint", finishPrint);

    const raf = window.requestAnimationFrame(() => window.print());

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("afterprint", finishPrint);
      style.remove();
    };
  }, [printJob]);

  function printStatements(source: BonusEntry[]) {
    const groups = buildPrintGroups(source);
    if (groups.length === 0) return;
    setPrintJob({
      groups,
      dateRangeLabel: buildDateRangeLabel(filterStart, filterEnd),
      jobLabel: buildJobFilterLabel(filterJob)
    });
  }

  async function loadTiers() {
    const res = await apiFetch("/api/quality/bonus-tiers");
    if (!res.ok) throw new Error("Failed to load bonus tiers");
    setTiers((await res.json()) as BonusTier[]);
  }

  async function loadEntries() {
    const params = new URLSearchParams();
    if (filterStart) params.set("start_date", filterStart);
    if (filterEnd) params.set("end_date", filterEnd);
    if (filterEmployee) params.set("employee_id", filterEmployee);
    if (filterJob) params.set("check_type", filterJob);
    const res = await apiFetch(`/api/quality/bonus-entries?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to load bonus entries");
    setEntries((await res.json()) as BonusEntry[]);
  }

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadTiers(), loadEntries()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bonus data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading) return;
    void loadEntries().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load bonus entries");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStart, filterEnd, filterEmployee, filterJob]);

  const tiersForJob = useMemo(
    () => (job: CheckType) => tiers.filter((t) => t.check_type === job).sort((a, b) => a.min_speed - b.min_speed),
    [tiers]
  );

  const preview = useMemo(() => {
    const speed = Number(formSpeed);
    if (!Number.isFinite(speed) || formSpeed.trim() === "") return { applied_rate: 0, total: 0 };
    const applied = computeApplied(tiers, formJob, speed);
    const hours = Number(formHours);
    const total = Number.isFinite(hours) && hours > 0 ? applied.applied_rate * hours : 0;
    return { applied_rate: applied.applied_rate, total };
  }, [tiers, formJob, formSpeed, formHours]);

  function resetForm() {
    setEditingEntryId(null);
    setFormEmployeeId("");
    setFormDate(currentWeekStartISO());
    setFormJob("picking_peppers");
    setFormSpeed("");
    setFormHours("");
  }

  function startEditEntry(entry: BonusEntry) {
    setEditingEntryId(entry.id);
    setFormEmployeeId(entry.employee_id);
    setFormDate(getWeekStartISO(entry.entry_date));
    setFormJob(entry.check_type);
    setFormSpeed(String(entry.entered_speed));
    setFormHours(String(entry.hours_worked));
    setEntryError(null);
    setSubTab("entry");
  }

  async function saveEntry(e: FormEvent) {
    e.preventDefault();
    setEntryError(null);

    if (!formEmployeeId) return setEntryError("Employee is required.");
    if (!formDate) return setEntryError("Week is required.");
    const speed = Number(formSpeed);
    const hours = Number(formHours);
    if (!Number.isFinite(speed) || speed < 0) return setEntryError("Speed cannot be negative.");
    if (!Number.isFinite(hours) || hours <= 0) return setEntryError("Hours worked must be greater than 0.");

    setEntrySaving(true);
    try {
      const body = JSON.stringify({
        employee_id: formEmployeeId,
        entry_date: formDate,
        check_type: formJob,
        entered_speed: speed,
        hours_worked: hours
      });
      const res = editingEntryId
        ? await apiFetch(`/api/quality/bonus-entries/${editingEntryId}`, { method: "PATCH", body })
        : await apiFetch("/api/quality/bonus-entries", { method: "POST", body });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(b?.message ?? "Failed to save bonus entry");
      }
      resetForm();
      await loadEntries();
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : "Failed to save bonus entry");
    } finally {
      setEntrySaving(false);
    }
  }

  async function deleteEntry(entry: BonusEntry) {
    if (!window.confirm(`Delete the bonus entry for "${entry.employee_name}" (${formatWeekLabel(getWeekStartISO(entry.entry_date))})? This cannot be undone.`)) {
      return;
    }
    setEntryError(null);
    try {
      const res = await apiFetch(`/api/quality/bonus-entries/${entry.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete bonus entry");
      if (editingEntryId === entry.id) resetForm();
      await loadEntries();
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : "Failed to delete bonus entry");
    }
  }

  async function addTier(e: FormEvent, job: CheckType) {
    e.preventDefault();
    setSetupError(null);
    const min_speed = Number(newTierSpeed[job]);
    const bonus_rate_per_hour = Number(newTierRate[job]);
    if (!Number.isFinite(min_speed) || min_speed <= 0) return setSetupError("Minimum speed must be greater than 0.");
    if (!Number.isFinite(bonus_rate_per_hour) || bonus_rate_per_hour < 0) return setSetupError("Bonus rate cannot be negative.");

    setTierSaving(job);
    try {
      const res = await apiFetch("/api/quality/bonus-tiers", {
        method: "POST",
        body: JSON.stringify({ check_type: job, min_speed, bonus_rate_per_hour })
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(b?.message ?? "Failed to add tier");
      }
      setNewTierSpeed((s) => ({ ...s, [job]: "" }));
      setNewTierRate((r) => ({ ...r, [job]: "" }));
      await loadTiers();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to add tier");
    } finally {
      setTierSaving(null);
    }
  }

  function startEditTier(tier: BonusTier) {
    setEditingTierId(tier.id);
    setEditingTierSpeed(String(tier.min_speed));
    setEditingTierRate(String(tier.bonus_rate_per_hour));
  }

  function cancelEditTier() {
    setEditingTierId(null);
    setEditingTierSpeed("");
    setEditingTierRate("");
  }

  async function saveEditTier(tierId: string) {
    setSetupError(null);
    const min_speed = Number(editingTierSpeed);
    const bonus_rate_per_hour = Number(editingTierRate);
    if (!Number.isFinite(min_speed) || min_speed <= 0) return setSetupError("Minimum speed must be greater than 0.");
    if (!Number.isFinite(bonus_rate_per_hour) || bonus_rate_per_hour < 0) return setSetupError("Bonus rate cannot be negative.");
    try {
      const res = await apiFetch(`/api/quality/bonus-tiers/${tierId}`, {
        method: "PATCH",
        body: JSON.stringify({ min_speed, bonus_rate_per_hour })
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(b?.message ?? "Failed to update tier");
      }
      cancelEditTier();
      await loadTiers();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to update tier");
    }
  }

  async function deleteTier(tier: BonusTier) {
    if (!window.confirm(`Delete the ${tier.min_speed} ${SPEED_UNIT[tier.check_type]} tier for ${JOB_LABEL[tier.check_type]}? Saved bonus entries will keep their originally applied rate. This cannot be undone.`)) {
      return;
    }
    setSetupError(null);
    try {
      const res = await apiFetch(`/api/quality/bonus-tiers/${tier.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete tier");
      await loadTiers();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Failed to delete tier");
    }
  }

  const filteredTotals = useMemo(() => {
    const totalHours = round2(entries.reduce((s, e) => s + e.hours_worked, 0));
    const totalBonus = round2(entries.reduce((s, e) => s + e.total_bonus, 0));
    return { totalHours, totalBonus };
  }, [entries]);

  const weekGroups = useMemo(() => groupByEmployeeWeek(entries), [entries]);
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());

  function toggleWeekExpanded(key: string) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (loading) {
    return <p>Loading bonuses…</p>;
  }

  return (
    <div style={{ marginTop: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      {error ? <p className="form-error">{error}</p> : null}

      <div className="tab-navigation">
        <button
          type="button"
          className={`tab-button${subTab === "entry" ? " active" : ""}`}
          onClick={() => setSubTab("entry")}
        >
          Bonus Entry
        </button>
        <button
          type="button"
          className={`tab-button${subTab === "setup" ? " active" : ""}`}
          onClick={() => setSubTab("setup")}
        >
          Bonus Setup
        </button>
      </div>

      {subTab === "entry" ? (
        <>
          {canEdit && !editingEntryId ? (
            <BonusPdfImport employees={employees} onImported={() => void loadEntries()} />
          ) : null}

          {canEdit && editingEntryId ? (
            <div className="coming-soon-card">
              <h2>Edit Bonus Entry</h2>
              {entryError ? <p className="form-error">{entryError}</p> : null}
              <form onSubmit={(e) => void saveEntry(e)}>
                <div className="bonus-form">
                  <label>
                    Employee
                    <select value={formEmployeeId} onChange={(e) => setFormEmployeeId(e.target.value)}>
                      <option value="">Select employee…</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id} disabled={!emp.active}>
                          {emp.name}{!emp.active ? " (inactive)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Week
                    <input
                      type="date"
                      value={formDate}
                      onChange={(e) => {
                        if (e.target.value) setFormDate(getWeekStartISO(e.target.value));
                      }}
                    />
                    {formDate ? (
                      <span className="bonus-week-caption">Week of {formatWeekRangeLabel(formDate)}</span>
                    ) : null}
                  </label>
                  <label>
                    Job
                    <select value={formJob} onChange={(e) => setFormJob(e.target.value as CheckType)}>
                      <option value="picking_peppers">Picking</option>
                      <option value="winding_pruning">Winding/Pruning</option>
                    </select>
                  </label>
                  <label>
                    {SPEED_LABEL[formJob]}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formSpeed}
                      onChange={(e) => setFormSpeed(e.target.value)}
                    />
                  </label>
                  <label>
                    Hours worked
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={formHours}
                      onChange={(e) => setFormHours(e.target.value)}
                    />
                  </label>
                  <label>
                    Bonus rate per hour
                    <input type="text" value={formatCAD(preview.applied_rate)} readOnly disabled />
                  </label>
                  <label>
                    Total bonus
                    <input type="text" value={formatCAD(preview.total)} readOnly disabled />
                  </label>

                  <div className="form-actions">
                    <button type="submit" className="primary-action-button" disabled={entrySaving}>
                      {entrySaving ? "Saving…" : "Save Changes"}
                    </button>
                    <button type="button" className="secondary" onClick={resetForm}>
                      Cancel
                    </button>
                  </div>
                </div>
              </form>
            </div>
          ) : null}

          <div className="coming-soon-card">
            <div className="bonus-history-header">
              <h2>Bonus History</h2>
              <div className="row-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => printStatements(entries)}
                  disabled={entries.length === 0}
                >
                  Print
                </button>
                {filterEmployee ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => printStatements(entries)}
                    disabled={entries.length === 0}
                  >
                    Print Single Employee
                  </button>
                ) : null}
              </div>
            </div>

            <div className="bonus-filter-bar">
              <label className="bonus-filter-label">
                From week
                <input
                  type="date"
                  value={filterStart}
                  onChange={(e) => setFilterStart(e.target.value ? getWeekStartISO(e.target.value) : "")}
                />
              </label>
              <label className="bonus-filter-label">
                To week
                <input
                  type="date"
                  value={filterEnd}
                  onChange={(e) => setFilterEnd(e.target.value ? getWeekEndISO(getWeekStartISO(e.target.value)) : "")}
                />
              </label>
              <label className="bonus-filter-label">
                Employee
                <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
                  <option value="">All employees</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                </select>
              </label>
              <label className="bonus-filter-label">
                Job
                <select value={filterJob} onChange={(e) => setFilterJob(e.target.value)}>
                  <option value="">All jobs</option>
                  <option value="picking_peppers">Picking</option>
                  <option value="winding_pruning">Winding/Pruning</option>
                </select>
              </label>
            </div>

            {entries.length === 0 ? (
              <p style={{ marginTop: "0.75rem", fontSize: "0.85em", color: "var(--text-muted)" }}>
                No bonus entries recorded yet.
              </p>
            ) : (
              <div className="varieties-table-wrapper" style={{ marginTop: "0.85rem" }}>
                <table className="varieties-table bonus-history-table">
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th>Employee</th>
                      <th>Job</th>
                      <th style={{ textAlign: "right" }}>Speed</th>
                      <th style={{ textAlign: "right" }}>Hours</th>
                      <th style={{ textAlign: "right" }}>Bonus rate</th>
                      <th style={{ textAlign: "right" }}>Total bonus</th>
                      {canEdit ? <th>Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {weekGroups.map((group) => {
                      const isMulti = group.entries.length > 1;
                      const isExpanded = expandedWeeks.has(group.key);
                      return (
                        <Fragment key={group.key}>
                          <tr>
                            <td>{formatWeekLabel(group.weekStart)}</td>
                            <td>{group.employeeName}</td>
                            <td>{JOB_LABEL[group.checkType]}</td>
                            <td style={{ textAlign: "right" }}>
                              {Math.round(group.avgSpeed * 100) / 100} {group.speedUnit}
                              {isMulti ? " (avg)" : ""}
                            </td>
                            <td style={{ textAlign: "right" }}>{group.totalHours}</td>
                            <td style={{ textAlign: "right" }}>
                              {formatCAD(isMulti ? group.blendedRate : group.entries[0].applied_rate)}
                            </td>
                            <td style={{ textAlign: "right" }}>{formatCAD(group.totalBonus)}</td>
                            {canEdit ? (
                              <td>
                                <div className="row-actions">
                                  {isMulti ? (
                                    <button
                                      type="button"
                                      className="secondary"
                                      style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                      onClick={() => toggleWeekExpanded(group.key)}
                                    >
                                      {isExpanded ? "Hide" : `${group.entries.length} entries`}
                                    </button>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        className="secondary"
                                        style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                        onClick={() => startEditEntry(group.entries[0])}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        className="danger"
                                        style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                        onClick={() => void deleteEntry(group.entries[0])}
                                      >
                                        Delete
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            ) : null}
                          </tr>
                          {isMulti && isExpanded
                            ? group.entries.map((entry) => (
                                <tr key={entry.id} className="bonus-history-subrow">
                                  <td>{entry.entry_date}</td>
                                  <td colSpan={2}>Individual entry</td>
                                  <td style={{ textAlign: "right" }}>{entry.entered_speed} {entry.speed_unit}</td>
                                  <td style={{ textAlign: "right" }}>{entry.hours_worked}</td>
                                  <td style={{ textAlign: "right" }}>{formatCAD(entry.applied_rate)}</td>
                                  <td style={{ textAlign: "right" }}>{formatCAD(entry.total_bonus)}</td>
                                  {canEdit ? (
                                    <td>
                                      <div className="row-actions">
                                        <button
                                          type="button"
                                          className="secondary"
                                          style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                          onClick={() => startEditEntry(entry)}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          className="danger"
                                          style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                          onClick={() => void deleteEntry(entry)}
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </td>
                                  ) : null}
                                </tr>
                              ))
                            : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} style={{ fontWeight: 700 }}>Total (filtered)</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{filteredTotals.totalHours}</td>
                      <td></td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCAD(filteredTotals.totalBonus)}</td>
                      {canEdit ? <td></td> : null}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {subTab === "setup" ? (
        <>
          {setupError ? <p className="form-error">{setupError}</p> : null}
          {(["picking_peppers", "winding_pruning"] as CheckType[]).map((job) => (
            <Fragment key={job}>
            <div className="coming-soon-card">
              <h2>{JOB_LABEL[job]} Bonus Tiers</h2>
              <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                Minimum {SPEED_UNIT[job]} required to earn each bonus rate. The employee qualifies for the
                highest threshold at or below their entered speed.
              </p>

              {tiersForJob(job).length > 0 ? (
                <div className="varieties-table-wrapper" style={{ marginTop: "0.75rem" }}>
                  <table className="varieties-table">
                    <thead>
                      <tr>
                        <th style={{ textAlign: "right" }}>Minimum {SPEED_UNIT[job]}</th>
                        <th style={{ textAlign: "right" }}>Bonus per hour</th>
                        {canEdit ? <th>Actions</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {tiersForJob(job).map((tier) => (
                        <tr key={tier.id}>
                          {editingTierId === tier.id ? (
                            <>
                              <td style={{ textAlign: "right" }}>
                                <input
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  value={editingTierSpeed}
                                  onChange={(e) => setEditingTierSpeed(e.target.value)}
                                  className="bonus-tier-input"
                                  style={{ textAlign: "right" }}
                                />
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={editingTierRate}
                                  onChange={(e) => setEditingTierRate(e.target.value)}
                                  className="bonus-tier-input"
                                  style={{ textAlign: "right" }}
                                />
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    className="secondary"
                                    style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                    onClick={() => void saveEditTier(tier.id)}
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                    onClick={cancelEditTier}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td style={{ textAlign: "right" }}>{tier.min_speed}</td>
                              <td style={{ textAlign: "right" }}>{formatCAD(tier.bonus_rate_per_hour)}</td>
                              {canEdit ? (
                                <td>
                                  <div className="row-actions">
                                    <button
                                      type="button"
                                      className="secondary"
                                      style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                      onClick={() => startEditTier(tier)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      className="danger"
                                      style={{ fontSize: "0.75em", padding: "0.2rem 0.55rem" }}
                                      onClick={() => void deleteTier(tier)}
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              ) : null}
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p style={{ marginTop: "0.65rem", fontSize: "0.85em", color: "var(--text-muted)" }}>
                  No tiers set up yet.
                </p>
              )}

              {canEdit ? (
                <form onSubmit={(e) => void addTier(e, job)} className="bonus-tier-form">
                  <label>
                    Minimum {SPEED_UNIT[job]}
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={newTierSpeed[job]}
                      onChange={(e) => setNewTierSpeed((s) => ({ ...s, [job]: e.target.value }))}
                    />
                  </label>
                  <label>
                    Bonus per hour ($)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={newTierRate[job]}
                      onChange={(e) => setNewTierRate((r) => ({ ...r, [job]: e.target.value }))}
                    />
                  </label>
                  <button
                    type="submit"
                    className="primary-action-button"
                    disabled={tierSaving === job || !newTierSpeed[job] || !newTierRate[job]}
                    style={{ flexShrink: 0 }}
                  >
                    {tierSaving === job ? "Adding…" : "Add Tier"}
                  </button>
                </form>
              ) : null}
            </div>

            <BonusLinearAdjustmentSetup job={job} canEdit={canEdit} />
            </Fragment>
          ))}
        </>
      ) : null}

      {printJob ? (
        <BonusPrintStatements
          groups={printJob.groups}
          dateRangeLabel={printJob.dateRangeLabel}
          jobLabel={printJob.jobLabel}
        />
      ) : null}
    </div>
  );
}
