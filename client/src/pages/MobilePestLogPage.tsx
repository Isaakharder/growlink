import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

// ── Snapshot types (mirrors what PestPlannerPage saves) ──────────────────────

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

type ChemicalSnapshot = {
  id?: string;
  name?: string;
  chemical_type?: string | null;
  phi?: string | null;
  chemical_group?: string | null;
  rate_value?: number | null;
  rate_unit?: string | null;
};

type TargetSnapshot = {
  group_ids?: string[];
  group_names?: string[];
  total_m2?: number | null;
  total_row_length_meters?: number | null;
};

type SprayerSnapshot = {
  name?: string;
  nozzle_count?: number | null;
  nozzle_volume_l_per_min?: number | null;
  nozzle_psi?: number | null;
  speed_m_per_min?: number | null;
  nozzles_open?: number | null;
};

type TankSnapshot = {
  name?: string;
  volume_liters?: number | null;
  is_builtin?: boolean;
};

type CalcSnapshot = {
  type?: string;
  total_chemical_ml?: number | null;
  total_chemical_l?: number | null;
  rate_value?: number | null;
  rate_unit?: string | null;
  area_label?: string | null;
  total_volume_l?: number | null;
  spray_time_minutes?: number | null;
  spray_time_hours?: number | null;
  total_flow_l_per_min?: number | null;
  tank_volume_l?: number | null;
  tank_count?: number | null;
  chem_per_liter_ml?: number | null;
  chem_per_full_tank_ml?: number | null;
  final_tank_volume_l?: number | null;
  chem_for_final_tank_ml?: number | null;
  is_last_full?: boolean | null;
};

// ── Progress tracking types ───────────────────────────────────────────────────

type ProgressRow = {
  rowId: string;
  rowNumber: number;
  completed: boolean;
  completedAt: string | null;
};

type ProgressPhase = {
  phaseId: string;
  phaseName: string;
  completed: boolean;
  completedAt: string | null;
  rows: ProgressRow[];
};

type ProgressSnapshot = {
  phases: ProgressPhase[];
};

type PestTodo = {
  id: string;
  type: "spray" | "drench";
  status: TodoStatus;
  chemical_snapshot: ChemicalSnapshot;
  target_snapshot: TargetSnapshot;
  sprayer_snapshot: SprayerSnapshot;
  tank_snapshot: TankSnapshot;
  calculation_snapshot: CalcSnapshot;
  progress_snapshot: Record<string, unknown>;
  instructions: string | null;
  created_at: string;
  completed_at: string | null;
};

type SetupRow = {
  id: string;
  group_id: string;
  row_number: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const RATE_UNIT_LABELS: Record<string, string> = {
  ml_per_acre: "ml/acre",
  L_per_acre: "L/acre",
  ml_per_hectare: "ml/hectare",
  L_per_hectare: "L/hectare"
};

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MobilePestLogPage() {
  // List view state
  const [todos, setTodos] = useState<PestTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);

  // Detail / progress state
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [selectedPhaseIdx, setSelectedPhaseIdx] = useState(0);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [savingProgress, setSavingProgress] = useState(false);
  const [showCompleteSection, setShowCompleteSection] = useState(false);
  const [sectionFrom, setSectionFrom] = useState("");
  const [sectionTo, setSectionTo] = useState("");

  // ── Data fetching ──────────────────────────────────────────────────────────

  async function fetchTodos() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/pest/todos");
      if (!res.ok) throw new Error("Failed to load pest log");
      setTodos((await res.json()) as PestTodo[]);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load pest log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchTodos();
  }, []);

  // ── Progress initialization (runs when selectedId changes) ─────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Reset detail state
    setProgress(null);
    setSelectedPhaseIdx(0);
    setShowCompleteSection(false);
    setSectionFrom("");
    setSectionTo("");
    setError(null);

    if (!selectedId) return;

    // Find the todo using the closure value of todos at effect time
    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    // Use existing progress if already initialized
    const snap = todo.progress_snapshot as Partial<ProgressSnapshot>;
    if (snap.phases && snap.phases.length > 0) {
      setProgress(snap as ProgressSnapshot);
      const firstIncomplete = snap.phases.findIndex((p) => !p.completed);
      setSelectedPhaseIdx(firstIncomplete >= 0 ? firstIncomplete : 0);
      return;
    }

    // No progress yet — build from greenhouse rows
    const groupIds: string[] = todo.target_snapshot.group_ids ?? [];
    const groupNames: string[] = todo.target_snapshot.group_names ?? [];

    if (groupIds.length === 0) {
      setProgress({ phases: [] });
      return;
    }

    setLoadingProgress(true);

    apiFetch("/api/greenhouse-setup")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load greenhouse rows");
        return res.json() as Promise<{ rows: SetupRow[] }>;
      })
      .then((setupData) => {
        const phases: ProgressPhase[] = groupIds.map((groupId, idx) => {
          const groupRows = (setupData.rows ?? [])
            .filter((r) => r.group_id === groupId)
            .sort((a, b) => (a.row_number ?? 0) - (b.row_number ?? 0));

          return {
            phaseId: groupId,
            phaseName: groupNames[idx] ?? `Group ${idx + 1}`,
            completed: false,
            completedAt: null,
            rows: groupRows.map((r) => ({
              rowId: r.id,
              rowNumber: r.row_number,
              completed: false,
              completedAt: null
            }))
          };
        });

        const newSnap: ProgressSnapshot = { phases };
        setProgress(newSnap);
        setLoadingProgress(false);
        void patchProgress(todo.id, newSnap, false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load rows");
        setLoadingProgress(false);
      });
  }, [selectedId]); // deliberately not including `todos` — initialization only needs the snapshot once

  // ── Progress persistence ───────────────────────────────────────────────────

  async function patchProgress(todoId: string, snap: ProgressSnapshot, showSaving = true) {
    if (showSaving) setSavingProgress(true);
    try {
      const res = await apiFetch(`/api/pest/todos/${todoId}/progress`, {
        method: "PATCH",
        body: JSON.stringify({ progress_snapshot: snap })
      });
      if (res.ok) {
        setTodos((prev) =>
          prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap } : t))
        );
      }
    } catch {
      // non-fatal — local state stays correct
    } finally {
      if (showSaving) setSavingProgress(false);
    }
  }

  // ── Mark todo status complete ──────────────────────────────────────────────

  async function completeJob(todoId: string) {
    setCompleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/pest/todos/${todoId}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save record");
      }
      setCompletedMessage("Spray record saved.");
      await fetchTodos();
      setSelectedId(null);
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "Failed to save record");
    } finally {
      setCompleting(false);
    }
  }

  function markInProgress(todoId: string) {
    void apiFetch(`/api/pest/todos/${todoId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress" })
    })
      .then((res) => {
        if (res.ok) {
          setTodos((prev) =>
            prev.map((t) => (t.id === todoId ? { ...t, status: "in_progress" as TodoStatus } : t))
          );
        }
      })
      .catch(() => {
        /* non-fatal */
      });
  }

  // ── Phase / row completion logic ───────────────────────────────────────────

  function confirmJobComplete(todoId: string) {
    const todo = todos.find((t) => t.id === todoId);
    const label = todo?.type === "drench" ? "drench" : "spray";
    if (!window.confirm(`All phases complete. Save this ${label} record?`)) return;
    void completeJob(todoId);
  }

  function confirmPhaseComplete(
    phaseIdx: number,
    currentProgress: ProgressSnapshot,
    todoId: string
  ) {
    const phase = currentProgress.phases[phaseIdx];
    if (!phase) return;
    if (!window.confirm(`${phase.phaseName} complete?`)) return;

    const now = new Date().toISOString();
    const newProgress: ProgressSnapshot = {
      ...currentProgress,
      phases: currentProgress.phases.map((p, i) =>
        i === phaseIdx ? { ...p, completed: true, completedAt: now } : p
      )
    };

    setProgress(newProgress);
    void patchProgress(todoId, newProgress);

    // Move to next incomplete phase
    const nextIncomplete = newProgress.phases.findIndex((p, i) => i > phaseIdx && !p.completed);
    if (nextIncomplete >= 0) setSelectedPhaseIdx(nextIncomplete);

    // Check if all phases are done
    if (newProgress.phases.every((p) => p.completed)) {
      setTimeout(() => confirmJobComplete(todoId), 150);
    }
  }

  function toggleRow(phaseIdx: number, rowIdx: number) {
    if (!progress || !selectedId) return;
    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    if (todo.status === "pending") markInProgress(todo.id);

    const now = new Date().toISOString();
    const newProgress: ProgressSnapshot = {
      ...progress,
      phases: progress.phases.map((phase, pi) => {
        if (pi !== phaseIdx) return phase;
        const newRows = phase.rows.map((row, ri) => {
          if (ri !== rowIdx) return row;
          const wasDone = row.completed;
          return { ...row, completed: !wasDone, completedAt: wasDone ? null : now };
        });
        return { ...phase, rows: newRows };
      })
    };

    setProgress(newProgress);
    void patchProgress(todo.id, newProgress);

    const phase = newProgress.phases[phaseIdx];
    if (phase && phase.rows.length > 0 && phase.rows.every((r) => r.completed) && !phase.completed) {
      confirmPhaseComplete(phaseIdx, newProgress, todo.id);
    }
  }

  function applyCompleteSection() {
    if (!progress || !selectedId) return;
    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    if (todo.status === "pending") markInProgress(todo.id);

    const fromNum = Number(sectionFrom);
    const toNum = Number(sectionTo);

    if (!Number.isFinite(fromNum) || !Number.isFinite(toNum) || !sectionFrom || !sectionTo) {
      setError("Select a from and to row.");
      return;
    }
    if (fromNum > toNum) {
      setError("From row must be ≤ to row.");
      return;
    }

    const now = new Date().toISOString();
    const newProgress: ProgressSnapshot = {
      ...progress,
      phases: progress.phases.map((phase, pi) => {
        if (pi !== selectedPhaseIdx) return phase;
        const newRows = phase.rows.map((row) => {
          if (row.rowNumber >= fromNum && row.rowNumber <= toNum) {
            return { ...row, completed: true, completedAt: row.completedAt ?? now };
          }
          return row;
        });
        return { ...phase, rows: newRows };
      })
    };

    setProgress(newProgress);
    setShowCompleteSection(false);
    setSectionFrom("");
    setSectionTo("");
    setError(null);
    void patchProgress(todo.id, newProgress);

    const phase = newProgress.phases[selectedPhaseIdx];
    if (phase && phase.rows.length > 0 && phase.rows.every((r) => r.completed) && !phase.completed) {
      confirmPhaseComplete(selectedPhaseIdx, newProgress, todo.id);
    }
  }

  // ── Derived values (for selected todo detail) ──────────────────────────────

  const selectedTodo = todos.find((t) => t.id === selectedId) ?? null;
  const pendingTodos = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
  const completedTodos = todos.filter((t) => t.status === "completed" || t.status === "cancelled");

  // Total progress across all phases
  const totalRows = progress?.phases.reduce((s, p) => s + p.rows.length, 0) ?? 0;
  const doneRows = progress?.phases.reduce((s, p) => s + p.rows.filter((r) => r.completed).length, 0) ?? 0;
  const selectedPhase = progress?.phases[selectedPhaseIdx] ?? null;
  const phaseRowNums = selectedPhase?.rows.map((r) => r.rowNumber) ?? [];

  // ── Detail view ─────────────────────────────────────────────────────────────

  if (selectedTodo) {
    const chem = selectedTodo.chemical_snapshot;
    const calc = selectedTodo.calculation_snapshot;
    const tank = selectedTodo.tank_snapshot;
    const isSpray = selectedTodo.type === "spray";

    const hasTankMix =
      isSpray &&
      calc.tank_count != null &&
      calc.tank_count > 0 &&
      calc.chem_per_full_tank_ml != null &&
      calc.tank_volume_l != null;

    const tankRows: { label: string; water: string; chemical: string }[] = [];
    if (hasTankMix && calc.tank_count != null && calc.chem_per_full_tank_ml != null && calc.tank_volume_l != null) {
      const fullTanks = calc.is_last_full ? calc.tank_count : calc.tank_count - 1;
      for (let i = 1; i <= fullTanks; i++) {
        tankRows.push({
          label: `Tank ${i}`,
          water: `${calc.tank_volume_l} L`,
          chemical: `${roundTo(calc.chem_per_full_tank_ml, 1)} ml`
        });
      }
      if (!calc.is_last_full && calc.final_tank_volume_l != null && calc.chem_for_final_tank_ml != null) {
        tankRows.push({
          label: `Tank ${calc.tank_count}`,
          water: `${roundTo(calc.final_tank_volume_l, 1)} L`,
          chemical: `${roundTo(calc.chem_for_final_tank_ml, 1)} ml`
        });
      }
    }

    return (
      <section className="mobile-page">
        {/* Back */}
        <button
          type="button"
          className="secondary"
          style={{ marginBottom: "1rem", fontSize: "0.9em" }}
          onClick={() => setSelectedId(null)}
        >
          ← Back
        </button>

        {/* Header */}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span className="pest-todo-type-badge" data-type={selectedTodo.type}>
            {selectedTodo.type === "spray" ? "Spray" : "Drench"}
          </span>
          {selectedTodo.status !== "pending" && (
            <span className="pest-todo-status-badge" data-status={selectedTodo.status}>
              {selectedTodo.status === "in_progress"
                ? "In Progress"
                : selectedTodo.status.charAt(0).toUpperCase() + selectedTodo.status.slice(1)}
            </span>
          )}
        </div>

        <h2 style={{ marginTop: "0.4rem", marginBottom: "0.1rem" }}>
          {chem.name ?? "Untitled plan"}
        </h2>
        <p style={{ fontSize: "0.82em", color: "var(--text-muted)", margin: 0 }}>
          Saved {formatDate(selectedTodo.created_at)}
          {savingProgress ? " · Saving…" : ""}
        </p>

        {error ? <p className="form-error" style={{ marginTop: "0.75rem" }}>{error}</p> : null}

        {/* ── Mix reminder card (shown at top so operator sees it immediately) */}
        {calc.total_chemical_ml != null && Number.isFinite(calc.total_chemical_ml) ? (
          <div
            className="mobile-yield-card"
            style={{
              marginTop: "0.85rem",
              background: "var(--brand-soft)",
              border: "1px solid var(--brand)"
            }}
          >
            <p style={{ margin: 0, fontWeight: 700, color: "var(--brand)" }}>
              Mix: {roundTo(calc.total_chemical_ml, 0).toLocaleString()} ml chemical total
            </p>
            {tankRows.length > 0 && tank.volume_liters != null ? (
              <>
                <p style={{ margin: "0.25rem 0 0.4rem", fontSize: "0.82em", color: "var(--brand)" }}>
                  {tank.name ?? "Tank"}: {tank.volume_liters} L — {tankRows.length} tank{tankRows.length !== 1 ? "s" : ""}
                </p>
                <div className="pest-tank-mix-list">
                  {tankRows.map((row, i) => (
                    <div key={i} className="pest-tank-mix-row">
                      <span className="pest-tank-mix-label">{row.label}</span>
                      <span className="pest-tank-mix-water">{row.water} water</span>
                      <span className="pest-tank-mix-chem">{row.chemical} chemical</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {calc.rate_value != null && calc.rate_unit ? (
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.78em", color: "var(--brand)" }}>
                @ {calc.rate_value} {RATE_UNIT_LABELS[calc.rate_unit] ?? calc.rate_unit}
                {calc.area_label ? ` · ${calc.area_label}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── Phase / Row tracking ─────────────────────────────────────────── */}
        {loadingProgress ? (
          <p style={{ marginTop: "1rem" }}>Loading rows…</p>
        ) : progress && progress.phases.length > 0 ? (
          <div style={{ marginTop: "1rem" }}>
            {/* Overall progress */}
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", margin: "0 0 0.65rem" }}>
              <strong>{doneRows}</strong> of <strong>{totalRows}</strong> rows complete
              {progress.phases.length > 1 ? ` across ${progress.phases.length} phases` : ""}
            </p>

            {/* Phase tabs */}
            <div className="pest-phase-tabs">
              {progress.phases.map((phase, idx) => {
                const phaseDone = phase.rows.filter((r) => r.completed).length;
                const phaseTotal = phase.rows.length;
                return (
                  <button
                    key={phase.phaseId}
                    type="button"
                    className={[
                      "pest-phase-tab",
                      idx === selectedPhaseIdx ? "pest-phase-tab--active" : "",
                      phase.completed ? "pest-phase-tab--done" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      setSelectedPhaseIdx(idx);
                      setShowCompleteSection(false);
                    }}
                  >
                    {phase.completed ? "✓ " : ""}
                    {phase.phaseName}
                    {phaseTotal > 0 ? (
                      <span style={{ display: "block", fontSize: "0.72em", opacity: 0.8 }}>
                        {phaseDone}/{phaseTotal}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* Selected phase rows */}
            {selectedPhase ? (
              <div style={{ marginTop: "0.75rem" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: "0.4rem"
                  }}
                >
                  <p style={{ margin: 0, fontWeight: 600 }}>{selectedPhase.phaseName}</p>
                  <p style={{ margin: 0, fontSize: "0.82em", color: "var(--text-muted)" }}>
                    {selectedPhase.rows.filter((r) => r.completed).length}/{selectedPhase.rows.length} rows
                  </p>
                </div>

                {selectedPhase.rows.length === 0 ? (
                  <div className="mobile-yield-card">
                    <p style={{ margin: 0, fontSize: "0.85em", color: "var(--text-muted)" }}>
                      No rows configured for this phase.
                    </p>
                    {!selectedPhase.completed ? (
                      <button
                        type="button"
                        style={{ marginTop: "0.65rem", width: "100%" }}
                        onClick={() => {
                          if (!selectedId) return;
                          const todo = todos.find((t) => t.id === selectedId);
                          if (todo && progress) confirmPhaseComplete(selectedPhaseIdx, progress, todo.id);
                        }}
                      >
                        Mark Phase Complete
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {/* Row list */}
                    <div className="pest-row-list">
                      {selectedPhase.rows.map((row, rowIdx) => (
                        <button
                          key={row.rowId}
                          type="button"
                          className={`pest-row-btn${row.completed ? " pest-row-btn--done" : ""}`}
                          onClick={() => toggleRow(selectedPhaseIdx, rowIdx)}
                        >
                          <span className="pest-row-btn-check">
                            {row.completed ? "✓" : ""}
                          </span>
                          <span className="pest-row-btn-label">Row {row.rowNumber}</span>
                          {row.completed ? (
                            <span className="pest-row-btn-time">
                              {row.completedAt ? formatDate(row.completedAt) : "done"}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>

                    {/* Complete Section */}
                    {!selectedPhase.completed ? (
                      <div style={{ marginTop: "0.75rem" }}>
                        {!showCompleteSection ? (
                          <button
                            type="button"
                            className="secondary"
                            style={{ width: "100%" }}
                            onClick={() => {
                              setShowCompleteSection(true);
                              setError(null);
                            }}
                          >
                            Complete Section
                          </button>
                        ) : (
                          <div className="pest-section-form">
                            <p style={{ margin: "0 0 0.6rem", fontWeight: 600 }}>
                              Mark a range of rows complete
                            </p>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                              <label>
                                From row
                                <select
                                  value={sectionFrom}
                                  onChange={(e) => setSectionFrom(e.target.value)}
                                >
                                  <option value="">—</option>
                                  {phaseRowNums.map((n) => (
                                    <option key={n} value={String(n)}>
                                      Row {n}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                To row
                                <select
                                  value={sectionTo}
                                  onChange={(e) => setSectionTo(e.target.value)}
                                >
                                  <option value="">—</option>
                                  {phaseRowNums
                                    .filter((n) => !sectionFrom || n >= Number(sectionFrom))
                                    .map((n) => (
                                      <option key={n} value={String(n)}>
                                        Row {n}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: "0.5rem",
                                marginTop: "0.65rem"
                              }}
                            >
                              <button
                                type="button"
                                disabled={!sectionFrom || !sectionTo}
                                onClick={applyCompleteSection}
                                style={{ flex: 1 }}
                              >
                                Mark Rows Complete
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => {
                                  setShowCompleteSection(false);
                                  setSectionFrom("");
                                  setSectionTo("");
                                  setError(null);
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        style={{
                          marginTop: "0.65rem",
                          padding: "0.5rem 0.75rem",
                          background: "var(--brand-soft)",
                          borderRadius: "8px",
                          fontSize: "0.85em",
                          color: "var(--brand)",
                          fontWeight: 600
                        }}
                      >
                        ✓ Phase complete
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : progress && progress.phases.length === 0 ? (
          <div className="mobile-yield-card" style={{ marginTop: "1rem" }}>
            <p style={{ margin: 0, fontSize: "0.85em", color: "var(--text-muted)" }}>
              No greenhouse rows found for the selected phases. You can mark the job complete manually below.
            </p>
          </div>
        ) : null}

        {/* ── Instructions ─────────────────────────────────────────────────── */}
        {selectedTodo.instructions ? (
          <div className="mobile-yield-card" style={{ marginTop: "1rem" }}>
            <h3 style={{ margin: "0 0 0.4rem" }}>Instructions</h3>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.9em" }}>
              {selectedTodo.instructions}
            </p>
          </div>
        ) : null}

        {/* ── Job status actions ────────────────────────────────────────────── */}
        {(selectedTodo.status === "pending" || selectedTodo.status === "in_progress") ? (
          // Manual complete only when no rows exist — row/phase flow handles the normal path
          progress && progress.phases.length === 0 ? (
            <div style={{ marginTop: "1.25rem" }}>
              <button
                type="button"
                disabled={completing}
                style={{ width: "100%" }}
                onClick={() => void completeJob(selectedTodo.id)}
              >
                {completing ? "Saving…" : "Mark Complete"}
              </button>
            </div>
          ) : null
        ) : (
          <div
            className="mobile-yield-card"
            style={{
              marginTop: "1rem",
              background: "var(--brand-soft)",
              border: "1px solid var(--brand)"
            }}
          >
            <p style={{ margin: 0, fontWeight: 600, color: "var(--brand)" }}>
              Completed{" "}
              {selectedTodo.completed_at ? formatDate(selectedTodo.completed_at) : ""}
            </p>
          </div>
        )}

        {/* ── Spray run details (secondary, below the action area) ─────────── */}
        {isSpray && (calc.total_volume_l != null || selectedTodo.sprayer_snapshot.name) ? (
          <div className="mobile-yield-card" style={{ marginTop: "1rem" }}>
            <h3 style={{ margin: "0 0 0.4rem" }}>Spray Run</h3>
            {calc.total_volume_l != null ? (
              <p style={{ margin: 0 }}>Water volume: <strong>{roundTo(calc.total_volume_l, 1)} L</strong></p>
            ) : null}
            {calc.spray_time_minutes != null ? (
              <p style={{ margin: "0.15rem 0 0", fontSize: "0.85em" }}>
                Est. time: {roundTo(calc.spray_time_minutes, 1)} min
              </p>
            ) : null}
            {selectedTodo.sprayer_snapshot.name ? (
              <p style={{ margin: "0.15rem 0 0", fontSize: "0.85em" }}>
                Sprayer: {selectedTodo.sprayer_snapshot.name}
                {selectedTodo.sprayer_snapshot.speed_m_per_min != null
                  ? ` @ ${selectedTodo.sprayer_snapshot.speed_m_per_min} m/min`
                  : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────

  return (
    <section className="mobile-page">
      <h2>Pest Log</h2>
      <p>Planned spray and drench applications for your team.</p>

      {error ? <p className="form-error">{error}</p> : null}
      {completedMessage ? (
        <p style={{ color: "var(--brand)", fontWeight: 600, marginTop: "0.5rem" }}>
          ✓ {completedMessage}
        </p>
      ) : null}
      {loading ? <p>Loading…</p> : null}

      <h3 style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
        To Do ({pendingTodos.length})
      </h3>

      {!loading && pendingTodos.length === 0 ? (
        <div className="mobile-yield-card">
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.88em" }}>
            No pending plans. Use the Pest Control Planner on desktop to create one.
          </p>
        </div>
      ) : null}

      {pendingTodos.map((todo) => {
        const chem = todo.chemical_snapshot;
        const target = todo.target_snapshot;
        const calc = todo.calculation_snapshot;
        const snap = todo.progress_snapshot as Partial<ProgressSnapshot>;
        const totalR = snap.phases?.reduce((s, p) => s + p.rows.length, 0) ?? 0;
        const doneR = snap.phases?.reduce((s, p) => s + p.rows.filter((r) => r.completed).length, 0) ?? 0;

        return (
          <button
            key={todo.id}
            type="button"
            className="pest-todo-card"
            onClick={() => setSelectedId(todo.id)}
          >
            <div className="pest-todo-card-header">
              <span className="pest-todo-type-badge" data-type={todo.type}>
                {todo.type === "spray" ? "Spray" : "Drench"}
              </span>
              {totalR > 0 ? (
                <span style={{ fontSize: "0.75em", color: "var(--text-muted)" }}>
                  {doneR}/{totalR} rows
                </span>
              ) : (
                <span className="pest-todo-status-badge" data-status={todo.status}>
                  {todo.status === "in_progress" ? "In Progress" : "Pending"}
                </span>
              )}
            </div>
            <p className="pest-todo-card-chemical">{chem.name ?? "—"}</p>
            {target.group_names && target.group_names.length > 0 ? (
              <p className="pest-todo-card-target">{target.group_names.join(", ")}</p>
            ) : null}
            <div className="pest-todo-card-stats">
              {calc.total_chemical_ml != null && Number.isFinite(calc.total_chemical_ml) ? (
                <span>{roundTo(calc.total_chemical_ml, 0)} ml chemical</span>
              ) : null}
              {todo.type === "spray" && calc.total_volume_l != null ? (
                <span>{roundTo(calc.total_volume_l, 1)} L water</span>
              ) : null}
              {todo.type === "spray" && calc.spray_time_minutes != null ? (
                <span>~{roundTo(calc.spray_time_minutes, 0)} min</span>
              ) : null}
            </div>
            {totalR > 0 ? (
              <div style={{ marginTop: "0.4rem" }}>
                <div
                  style={{
                    height: "4px",
                    background: "var(--border)",
                    borderRadius: "2px",
                    overflow: "hidden"
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${totalR > 0 ? (doneR / totalR) * 100 : 0}%`,
                      background: "var(--brand)",
                      borderRadius: "2px",
                      transition: "width 0.3s"
                    }}
                  />
                </div>
              </div>
            ) : null}
          </button>
        );
      })}

      {/* Completed plans toggle */}
      {completedTodos.length > 0 ? (
        <div style={{ marginTop: "1.5rem" }}>
          <button
            type="button"
            className="secondary"
            style={{ fontSize: "0.85em" }}
            onClick={() => setShowCompleted((prev) => !prev)}
          >
            {showCompleted ? "Hide" : "Show"} completed ({completedTodos.length})
          </button>

          {showCompleted ? (
            <div style={{ marginTop: "0.75rem" }}>
              {completedTodos.map((todo) => {
                const chem = todo.chemical_snapshot;
                const target = todo.target_snapshot;

                return (
                  <button
                    key={todo.id}
                    type="button"
                    className="pest-todo-card pest-todo-card--done"
                    onClick={() => setSelectedId(todo.id)}
                  >
                    <div className="pest-todo-card-header">
                      <span className="pest-todo-type-badge" data-type={todo.type}>
                        {todo.type === "spray" ? "Spray" : "Drench"}
                      </span>
                      <span className="pest-todo-status-badge" data-status={todo.status}>
                        {todo.status.charAt(0).toUpperCase() + todo.status.slice(1)}
                      </span>
                    </div>
                    <p className="pest-todo-card-chemical">{chem.name ?? "—"}</p>
                    {target.group_names && target.group_names.length > 0 ? (
                      <p className="pest-todo-card-target">{target.group_names.join(", ")}</p>
                    ) : null}
                    <p style={{ fontSize: "0.78em", color: "var(--text-muted)", margin: "0.2rem 0 0" }}>
                      Completed {todo.completed_at ? formatDate(todo.completed_at) : ""}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
