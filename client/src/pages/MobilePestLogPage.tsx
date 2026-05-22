import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

// ── Snapshot types ────────────────────────────────────────────────────────────

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
  target_mode?: string;
  group_ids?: string[];
  group_names?: string[];
  valve_ids?: string[];
  valve_names?: string[];
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
  rowLengthM?: number | null;         // populated at init; null for old snapshots
  completed: boolean;
  completedAt: string | null;
  completedByMixNumber?: number | null; // which mix completed this row
};

type ProgressPhase = {
  phaseId: string;
  phaseName: string;
  completed: boolean;
  completedAt: string | null;
  rows: ProgressRow[];
};

type MixRecord = {
  mixNumber: number;
  status: "active" | "completed";
  startedAt: string;
  endedAt: string | null;
  waterVolumeL: number;
  chemicalAmountMl: number;
  completedRowIds: string[];
  completedRowCount: number;
  completedRowLengthM: number;
  estimatedAppliedWaterL: number | null;
  estimatedAppliedChemicalMl: number | null;
};

type ProgressSnapshot = {
  phases: ProgressPhase[];
  mixes?: MixRecord[];
  activeMixNumber?: number | null;
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

type ValveDrenchSnapshot = {
  type: "valve_drench";
  valves: ValveEntry[];
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
  length_meters: number | null;
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

function safeNum(v: number | null | undefined): number {
  return v != null && Number.isFinite(v) ? v : 0;
}

function formatDate(iso: string): string {
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

// ── Component ─────────────────────────────────────────────────────────────────

export function MobilePestLogPage() {
  const [todos, setTodos] = useState<PestTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);

  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [selectedPhaseIdx, setSelectedPhaseIdx] = useState(0);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [savingProgress, setSavingProgress] = useState(false);
  const [showCompleteSection, setShowCompleteSection] = useState(false);
  const [sectionFrom, setSectionFrom] = useState("");
  const [sectionTo, setSectionTo] = useState("");
  const [showPrevMixes, setShowPrevMixes] = useState(false);
  const [valveDrenchProgress, setValveDrenchProgress] = useState<ValveDrenchSnapshot | null>(null);
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  // ── Long-press delete state ────────────────────────────────────────────────
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  async function fetchTodos() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/pest/todos");
      if (!res.ok) throw new Error("Failed to load pest log");
      setTodos((await res.json()) as PestTodo[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pest log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void fetchTodos(); }, []);

  // ── Progress initialization ────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setProgress(null);
    setValveDrenchProgress(null);
    setSelectedPhaseIdx(0);
    setShowCompleteSection(false);
    setShowPrevMixes(false);
    setSectionFrom("");
    setSectionTo("");
    setError(null);

    if (!selectedId) return;

    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    const snapRaw = todo.progress_snapshot as Record<string, unknown>;

    // Valve-drench: progress snapshot already has valve breakdown
    if (snapRaw.type === "valve_drench" && Array.isArray(snapRaw.valves)) {
      setValveDrenchProgress(snapRaw as ValveDrenchSnapshot);
      return;
    }

    const snap = snapRaw as Partial<ProgressSnapshot>;
    if (snap.phases && snap.phases.length > 0) {
      setProgress(snap as ProgressSnapshot);
      const firstIncomplete = snap.phases.findIndex((p) => !p.completed);
      setSelectedPhaseIdx(firstIncomplete >= 0 ? firstIncomplete : 0);
      return;
    }

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
              rowLengthM: r.length_meters ?? null,
              completed: false,
              completedAt: null,
              completedByMixNumber: null
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
  }, [selectedId]);

  // ── Progress persistence ───────────────────────────────────────────────────

  async function patchProgress(todoId: string, snap: ProgressSnapshot, showSaving = true) {
    if (showSaving) setSavingProgress(true);
    try {
      const res = await apiFetch(`/api/pest/todos/${todoId}/progress`, {
        method: "PATCH",
        body: JSON.stringify({ progress_snapshot: snap })
      });
      if (res.ok) {
        setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap } : t)));
      }
    } catch {
      // non-fatal
    } finally {
      if (showSaving) setSavingProgress(false);
    }
  }

  // ── Long-press delete helpers ─────────────────────────────────────────────

  function startLongPress(todoId: string) {
    longPressTimer.current = setTimeout(() => {
      setDeleteTargetId(todoId);
    }, 5000);
  }

  function cancelLongPress() {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  async function confirmDelete() {
    if (!deleteTargetId) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/pest/todos/${deleteTargetId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to delete plan");
      }
      setTodos((prev) => prev.filter((t) => t.id !== deleteTargetId));
      setDeleteTargetId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete plan");
      setDeleteTargetId(null);
    } finally {
      setDeleting(false);
    }
  }

  // ── Valve-drench progress ──────────────────────────────────────────────────

  async function patchValveDrenchProgress(todoId: string, snap: ValveDrenchSnapshot) {
    setSavingProgress(true);
    try {
      const res = await apiFetch(`/api/pest/todos/${todoId}/progress`, {
        method: "PATCH",
        body: JSON.stringify({ progress_snapshot: snap })
      });
      if (res.ok) {
        setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap as unknown as Record<string, unknown> } : t)));
      }
    } catch {
      // non-fatal
    } finally {
      setSavingProgress(false);
    }
  }

  async function completeValve(todoId: string, valveId: string) {
    if (!valveDrenchProgress) return;
    const todo = todos.find((t) => t.id === todoId);
    if (!todo) return;

    if (todo.status === "pending") markInProgress(todo.id);

    const now = new Date().toISOString();
    const newSnap: ValveDrenchSnapshot = {
      ...valveDrenchProgress,
      valves: valveDrenchProgress.valves.map((v) =>
        v.valveId === valveId ? { ...v, completed: true, completedAt: now } : v
      )
    };
    setValveDrenchProgress(newSnap);
    await patchValveDrenchProgress(todoId, newSnap);

    if (newSnap.valves.every((v) => v.completed)) {
      await completeValveDrenchJob(todoId);
    }
  }

  async function completeValveDrenchJob(todoId: string) {
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
      setShowCompletionModal(true);
      await fetchTodos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save record");
    } finally {
      setCompleting(false);
    }
  }

  // ── Job completion ─────────────────────────────────────────────────────────

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save record");
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
      .catch(() => { /* non-fatal */ });
  }

  // ── Mix tracking ───────────────────────────────────────────────────────────

  function startNewMix() {
    if (!progress || !selectedId) return;
    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    const calc = todo.calculation_snapshot;
    const totalMixesRequired = safeNum(calc.tank_count);
    const mixes = (progress.mixes ?? []) as MixRecord[];

    if (totalMixesRequired > 0 && mixes.length >= totalMixesRequired) return;

    const now = new Date().toISOString();
    const newMixNumber = mixes.length + 1;
    const isLastMix = totalMixesRequired > 0 && newMixNumber === totalMixesRequired;
    const isLastFull = calc.is_last_full ?? false;

    const waterVolumeL = roundTo(
      isLastMix && !isLastFull
        ? safeNum(calc.final_tank_volume_l ?? calc.tank_volume_l)
        : safeNum(calc.tank_volume_l),
      1
    );
    const chemicalAmountMl = roundTo(
      isLastMix && !isLastFull
        ? safeNum(calc.chem_for_final_tank_ml ?? calc.chem_per_full_tank_ml)
        : safeNum(calc.chem_per_full_tank_ml),
      1
    );

    const totalRowLengthM = safeNum(todo.target_snapshot.total_row_length_meters);
    const totalWaterL = safeNum(calc.total_volume_l);
    const totalChemMl = safeNum(calc.total_chemical_ml);
    const allRows = progress.phases.flatMap((p) => p.rows);

    // Close out any active mix
    const updatedMixes: MixRecord[] = mixes.map((m) => {
      if (m.status !== "active") return m;
      const mixRows = allRows.filter((r) => (r.completedByMixNumber ?? null) === m.mixNumber && r.completed);
      const completedRowLengthM = mixRows.reduce((s, r) => s + safeNum(r.rowLengthM), 0);
      const hasLength = mixRows.some((r) => safeNum(r.rowLengthM) > 0);
      const ratio = hasLength && totalRowLengthM > 0 ? completedRowLengthM / totalRowLengthM : null;
      return {
        ...m,
        status: "completed" as const,
        endedAt: now,
        completedRowIds: mixRows.map((r) => r.rowId),
        completedRowCount: mixRows.length,
        completedRowLengthM,
        estimatedAppliedWaterL: ratio != null ? roundTo(totalWaterL * ratio, 1) : null,
        estimatedAppliedChemicalMl: ratio != null ? roundTo(totalChemMl * ratio, 1) : null
      };
    });

    const newMix: MixRecord = {
      mixNumber: newMixNumber,
      status: "active",
      startedAt: now,
      endedAt: null,
      waterVolumeL,
      chemicalAmountMl,
      completedRowIds: [],
      completedRowCount: 0,
      completedRowLengthM: 0,
      estimatedAppliedWaterL: null,
      estimatedAppliedChemicalMl: null
    };

    const newProgress: ProgressSnapshot = {
      ...progress,
      mixes: [...updatedMixes, newMix],
      activeMixNumber: newMixNumber
    };

    if (todo.status === "pending") markInProgress(todo.id);
    setProgress(newProgress);
    void patchProgress(todo.id, newProgress);
  }

  // ── Phase / row completion ─────────────────────────────────────────────────

  function confirmJobComplete(todoId: string) {
    const todo = todos.find((t) => t.id === todoId);
    const label = todo?.type === "drench" ? "drench" : "spray";
    const hasTankPlan = todo?.type === "spray" && safeNum(todo.calculation_snapshot.tank_count) > 0;

    if (hasTankPlan && progress) {
      const withoutMix = progress.phases
        .flatMap((p) => p.rows)
        .filter((r) => r.completed && (r.completedByMixNumber ?? null) == null);
      if (withoutMix.length > 0) {
        const proceed = window.confirm(
          `${withoutMix.length} row${withoutMix.length !== 1 ? "s" : ""} completed without mix tracking. Save ${label} record anyway?`
        );
        if (!proceed) return;
        void completeJob(todoId);
        return;
      }
    }

    if (!window.confirm(`All phases complete. Save this ${label} record?`)) return;
    void completeJob(todoId);
  }

  function confirmPhaseComplete(phaseIdx: number, currentProgress: ProgressSnapshot, todoId: string) {
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

    const nextIncomplete = newProgress.phases.findIndex((p, i) => i > phaseIdx && !p.completed);
    if (nextIncomplete >= 0) setSelectedPhaseIdx(nextIncomplete);

    if (newProgress.phases.every((p) => p.completed)) {
      setTimeout(() => confirmJobComplete(todoId), 150);
    }
  }

  function toggleRow(phaseIdx: number, rowIdx: number) {
    if (!progress || !selectedId) return;
    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    const calc = todo.calculation_snapshot;
    const hasTankMix = todo.type === "spray" && safeNum(calc.tank_count) > 0 && calc.chem_per_full_tank_ml != null;
    const activeMix = (progress.mixes ?? []).find((m) => m.status === "active") as MixRecord | undefined;
    const row = progress.phases[phaseIdx]?.rows[rowIdx];
    const isMarkingComplete = row != null && !row.completed;

    if (hasTankMix && isMarkingComplete && activeMix == null) {
      setError("Start a new mix before marking rows complete.");
      return;
    }

    if (todo.status === "pending") markInProgress(todo.id);
    if (error) setError(null);

    const now = new Date().toISOString();
    const activeMixNumber = activeMix?.mixNumber ?? null;

    const newProgress: ProgressSnapshot = {
      ...progress,
      phases: progress.phases.map((phase, pi) => {
        if (pi !== phaseIdx) return phase;
        const newRows = phase.rows.map((r, ri) => {
          if (ri !== rowIdx) return r;
          const wasDone = r.completed;
          return {
            ...r,
            completed: !wasDone,
            completedAt: wasDone ? null : now,
            completedByMixNumber: wasDone ? null : activeMixNumber
          };
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

    const calc = todo.calculation_snapshot;
    const hasTankMix = todo.type === "spray" && safeNum(calc.tank_count) > 0 && calc.chem_per_full_tank_ml != null;
    const activeMix = (progress.mixes ?? []).find((m) => m.status === "active") as MixRecord | undefined;

    if (hasTankMix && activeMix == null) {
      setError("Start a new mix before marking rows complete.");
      return;
    }

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
    const activeMixNumber = activeMix?.mixNumber ?? null;

    const newProgress: ProgressSnapshot = {
      ...progress,
      phases: progress.phases.map((phase, pi) => {
        if (pi !== selectedPhaseIdx) return phase;
        const newRows = phase.rows.map((r) => {
          if (r.rowNumber >= fromNum && r.rowNumber <= toNum) {
            return {
              ...r,
              completed: true,
              completedAt: r.completedAt ?? now,
              completedByMixNumber: r.completedByMixNumber ?? activeMixNumber
            };
          }
          return r;
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

  // ── Derived values ─────────────────────────────────────────────────────────

  const selectedTodo = todos.find((t) => t.id === selectedId) ?? null;
  const pendingTodos = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
  const completedTodos = todos.filter((t) => t.status === "completed" || t.status === "cancelled");

  const totalRows = progress?.phases.reduce((s, p) => s + p.rows.length, 0) ?? 0;
  const doneRows = progress?.phases.reduce((s, p) => s + p.rows.filter((r) => r.completed).length, 0) ?? 0;
  const selectedPhase = progress?.phases[selectedPhaseIdx] ?? null;
  const phaseRowNums = selectedPhase?.rows.map((r) => r.rowNumber) ?? [];

  // ── Detail view ─────────────────────────────────────────────────────────────

  if (selectedTodo) {
    const chem = selectedTodo.chemical_snapshot;
    const calc = selectedTodo.calculation_snapshot;
    const isSpray = selectedTodo.type === "spray";

    const hasTankMix =
      isSpray &&
      safeNum(calc.tank_count) > 0 &&
      calc.chem_per_full_tank_ml != null &&
      calc.tank_volume_l != null;

    const mixes = (progress?.mixes ?? []) as MixRecord[];
    const activeMix = mixes.find((m) => m.status === "active") ?? null;
    const completedMixes = mixes.filter((m) => m.status === "completed");
    const totalMixesRequired = safeNum(calc.tank_count);
    const remainingMixes = Math.max(0, totalMixesRequired - mixes.length);
    const activeMixRowCount = activeMix
      ? progress!.phases.flatMap((p) => p.rows).filter(
          (r) => (r.completedByMixNumber ?? null) === activeMix.mixNumber && r.completed
        ).length
      : 0;

    return (
      <section className="mobile-page">
        <button
          type="button"
          className="secondary"
          style={{ marginBottom: "1rem", fontSize: "0.9em" }}
          onClick={() => setSelectedId(null)}
        >
          ← Back
        </button>

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

        {/* ── Mix tracking (spray jobs with tank plan) ─────────────────────── */}
        {hasTankMix ? (
          <div style={{ marginTop: "0.85rem" }}>
            {/* Summary strip */}
            <div className="pest-mix-summary">
              <span className="pest-mix-summary-stat">
                <strong>{totalMixesRequired}</strong> mix{totalMixesRequired !== 1 ? "es" : ""}
              </span>
              <span className="pest-mix-summary-sep">·</span>
              <span className="pest-mix-summary-stat">
                <strong>{remainingMixes}</strong> remaining
              </span>
              <span className="pest-mix-summary-sep">·</span>
              <span className="pest-mix-summary-stat">
                {safeNum(calc.tank_volume_l)} L / {roundTo(safeNum(calc.chem_per_full_tank_ml), 1)} ml ea.
              </span>
              {!calc.is_last_full && calc.final_tank_volume_l != null && calc.chem_for_final_tank_ml != null ? (
                <>
                  <span className="pest-mix-summary-sep">·</span>
                  <span className="pest-mix-summary-stat">
                    Last: {roundTo(safeNum(calc.final_tank_volume_l), 1)} L / {roundTo(safeNum(calc.chem_for_final_tank_ml), 1)} ml
                  </span>
                </>
              ) : null}
            </div>

            {/* Active mix card */}
            {activeMix ? (
              <div className="pest-mix-card pest-mix-card--active" style={{ marginTop: "0.6rem" }}>
                <div className="pest-mix-card-header">
                  <span className="pest-mix-card-number">Mix #{activeMix.mixNumber}</span>
                  <span className="pest-mix-card-status">In Use</span>
                </div>
                <div className="pest-mix-card-amounts">
                  <span>{activeMix.waterVolumeL} L water</span>
                  <span className="pest-mix-summary-sep">·</span>
                  <span>{roundTo(activeMix.chemicalAmountMl, 1)} ml chemical</span>
                </div>
                <p style={{ margin: "0.2rem 0 0", fontSize: "0.78em", color: "var(--text-muted)" }}>
                  Started {formatTime(activeMix.startedAt)}
                  {activeMixRowCount > 0 ? ` · ${activeMixRowCount} row${activeMixRowCount !== 1 ? "s" : ""} done` : ""}
                </p>
                {remainingMixes > 0 ? (
                  <button
                    type="button"
                    className="mobile-action-button mobile-action-button--next"
                    onClick={startNewMix}
                  >
                    New Mix → Mix #{activeMix.mixNumber + 1}
                  </button>
                ) : (
                  <p style={{ margin: "0.5rem 0 0", fontSize: "0.82em", color: "var(--text-muted)" }}>
                    All planned mixes started
                  </p>
                )}
              </div>
            ) : (
              /* No active mix */
              <div className="pest-mix-card" style={{ marginTop: "0.6rem" }}>
                {mixes.length === 0 ? (
                  <>
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.88em" }}>
                      No mix started. Fill your first tank to begin.
                    </p>
                    <button
                      type="button"
                      className="mobile-action-button"
                      onClick={startNewMix}
                    >
                      Start New Mix #1
                    </button>
                  </>
                ) : (
                  <p style={{ margin: 0, fontSize: "0.88em", color: "var(--brand)", fontWeight: 600 }}>
                    ✓ All planned mixes started
                  </p>
                )}
              </div>
            )}

            {/* Completed mixes */}
            {completedMixes.length > 0 ? (
              <div style={{ marginTop: "0.45rem" }}>
                <button
                  type="button"
                  className="secondary"
                  style={{ fontSize: "0.8em", padding: "0.3rem 0.6rem" }}
                  onClick={() => setShowPrevMixes((v) => !v)}
                >
                  {showPrevMixes ? "▾" : "▸"} Previous mixes ({completedMixes.length})
                </button>
                {showPrevMixes ? (
                  <div style={{ marginTop: "0.4rem", display: "grid", gap: "0.3rem" }}>
                    {completedMixes.map((mix) => (
                      <div key={mix.mixNumber} className="pest-mix-card pest-mix-card--done">
                        <div className="pest-mix-card-header">
                          <span className="pest-mix-card-number">Mix #{mix.mixNumber}</span>
                          <span className="pest-mix-card-status pest-mix-card-status--done">Done</span>
                        </div>
                        <div className="pest-mix-card-amounts" style={{ flexWrap: "wrap", fontSize: "0.82em" }}>
                          <span>{mix.completedRowCount} row{mix.completedRowCount !== 1 ? "s" : ""}</span>
                          {mix.completedRowLengthM > 0 ? (
                            <><span className="pest-mix-summary-sep">·</span><span>{mix.completedRowLengthM} m</span></>
                          ) : null}
                          {mix.estimatedAppliedWaterL != null ? (
                            <><span className="pest-mix-summary-sep">·</span><span>~{mix.estimatedAppliedWaterL} L water</span></>
                          ) : null}
                          {mix.estimatedAppliedChemicalMl != null ? (
                            <><span className="pest-mix-summary-sep">·</span><span>~{mix.estimatedAppliedChemicalMl} ml chemical</span></>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : !valveDrenchProgress && calc.total_chemical_ml != null && Number.isFinite(calc.total_chemical_ml) ? (
          /* Fallback: drench or spray with no tank plan (not shown for valve drench — each valve card shows its own amount) */
          <div
            className="mobile-yield-card"
            style={{ marginTop: "0.85rem", background: "var(--brand-soft)", border: "1px solid var(--brand)" }}
          >
            <p style={{ margin: 0, fontWeight: 700, color: "var(--brand)" }}>
              Mix: {roundTo(safeNum(calc.total_chemical_ml), 0).toLocaleString()} ml chemical total
            </p>
            {calc.rate_value != null && calc.rate_unit ? (
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.78em", color: "var(--brand)" }}>
                @ {calc.rate_value} {RATE_UNIT_LABELS[calc.rate_unit] ?? calc.rate_unit}
                {calc.area_label ? ` · ${calc.area_label}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── Valve drench tracking ────────────────────────────────────────── */}
        {valveDrenchProgress ? (
          <div style={{ marginTop: "1rem" }}>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", margin: "0 0 0.65rem" }}>
              <strong>{valveDrenchProgress.valves.filter((v) => v.completed).length}</strong>
              {" "}of{" "}
              <strong>{valveDrenchProgress.valves.length}</strong> valves complete
            </p>
            <div style={{ display: "grid", gap: "0.55rem" }}>
              {valveDrenchProgress.valves.map((valve) => (
                <div
                  key={valve.valveId}
                  className="mobile-yield-card"
                  style={{
                    padding: "0.65rem 0.85rem",
                    opacity: valve.completed ? 0.7 : 1,
                    border: valve.completed ? "1px solid var(--brand)" : "1px solid var(--border)"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: "0.95em" }}>
                        {valve.completed ? "✓ " : ""}{valve.valveName}
                      </p>
                      <p style={{ margin: "0.15rem 0 0", fontSize: "0.78em", color: "var(--text-muted)" }}>
                        {roundTo(valve.areaM2, 1).toLocaleString()} m²
                      </p>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: "1em", color: "var(--brand)" }}>
                        {valve.productUnit === "g"
                          ? (Math.round(valve.productAmount / 5) * 5).toLocaleString()
                          : roundTo(valve.productAmount, 1).toLocaleString()}{" "}
                        {valve.productUnit}
                      </p>
                      {valve.completed && valve.completedAt ? (
                        <p style={{ margin: "0.1rem 0 0", fontSize: "0.72em", color: "var(--text-muted)" }}>
                          Done {formatTime(valve.completedAt)}
                        </p>
                      ) : (
                        (selectedTodo.status === "pending" || selectedTodo.status === "in_progress") ? (
                          <button
                            type="button"
                            disabled={completing || savingProgress}
                            style={{ marginTop: "0.4rem", fontSize: "0.8em", padding: "0.3rem 0.7rem" }}
                            onClick={() => void completeValve(selectedTodo.id, valve.valveId)}
                          >
                            {completing ? "…" : "Complete"}
                          </button>
                        ) : null
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {savingProgress ? (
              <p style={{ fontSize: "0.78em", color: "var(--text-muted)", marginTop: "0.4rem" }}>Saving…</p>
            ) : null}
          </div>
        ) : null}

        {/* ── Phase / Row tracking ─────────────────────────────────────────── */}
        {!valveDrenchProgress && loadingProgress ? (
          <p style={{ marginTop: "1rem" }}>Loading rows…</p>
        ) : !valveDrenchProgress && progress && progress.phases.length > 0 ? (
          <div style={{ marginTop: "1rem" }}>
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", margin: "0 0 0.65rem" }}>
              <strong>{doneRows}</strong> of <strong>{totalRows}</strong> rows complete
              {progress.phases.length > 1 ? ` across ${progress.phases.length} phases` : ""}
            </p>

            <div className="pest-phase-tabs">
              {progress.phases.map((phase, idx) => {
                const phaseDone = phase.rows.filter((r) => r.completed).length;
                const phaseTotal = phase.rows.length;
                return (
                  <button
                    key={phase.phaseId}
                    type="button"
                    className={["pest-phase-tab", idx === selectedPhaseIdx ? "pest-phase-tab--active" : "", phase.completed ? "pest-phase-tab--done" : ""].filter(Boolean).join(" ")}
                    onClick={() => { setSelectedPhaseIdx(idx); setShowCompleteSection(false); }}
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

            {selectedPhase ? (
              <div style={{ marginTop: "0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.4rem" }}>
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
                    <div className="pest-row-list">
                      {selectedPhase.rows.map((row, rowIdx) => (
                        <button
                          key={row.rowId}
                          type="button"
                          className={`pest-row-btn${row.completed ? " pest-row-btn--done" : ""}`}
                          onClick={() => toggleRow(selectedPhaseIdx, rowIdx)}
                        >
                          <span className="pest-row-btn-check">{row.completed ? "✓" : ""}</span>
                          <span className="pest-row-btn-label">Row {row.rowNumber}</span>
                          {row.completed ? (
                            <span className="pest-row-btn-time">
                              {row.completedByMixNumber != null
                                ? `Mix #${row.completedByMixNumber}`
                                : row.completedAt ? formatDate(row.completedAt) : "done"}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>

                    {!selectedPhase.completed ? (
                      <div style={{ marginTop: "0.75rem" }}>
                        {!showCompleteSection ? (
                          <button
                            type="button"
                            className="secondary"
                            style={{ width: "100%" }}
                            onClick={() => { setShowCompleteSection(true); setError(null); }}
                          >
                            Complete Section
                          </button>
                        ) : (
                          <div className="pest-section-form">
                            <p style={{ margin: "0 0 0.6rem", fontWeight: 600 }}>Mark a range of rows complete</p>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                              <label>
                                From row
                                <select value={sectionFrom} onChange={(e) => setSectionFrom(e.target.value)}>
                                  <option value="">—</option>
                                  {phaseRowNums.map((n) => (
                                    <option key={n} value={String(n)}>Row {n}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                To row
                                <select value={sectionTo} onChange={(e) => setSectionTo(e.target.value)}>
                                  <option value="">—</option>
                                  {phaseRowNums
                                    .filter((n) => !sectionFrom || n >= Number(sectionFrom))
                                    .map((n) => (
                                      <option key={n} value={String(n)}>Row {n}</option>
                                    ))}
                                </select>
                              </label>
                            </div>
                            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.65rem" }}>
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
                                onClick={() => { setShowCompleteSection(false); setSectionFrom(""); setSectionTo(""); setError(null); }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginTop: "0.65rem", padding: "0.5rem 0.75rem", background: "var(--brand-soft)", borderRadius: "8px", fontSize: "0.85em", color: "var(--brand)", fontWeight: 600 }}>
                        ✓ Phase complete
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : !valveDrenchProgress && progress && progress.phases.length === 0 ? (
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
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.9em" }}>{selectedTodo.instructions}</p>
          </div>
        ) : null}

        {/* ── Job status actions ────────────────────────────────────────────── */}
        {(selectedTodo.status === "pending" || selectedTodo.status === "in_progress") ? (
          !valveDrenchProgress && progress && progress.phases.length === 0 ? (
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
            style={{ marginTop: "1rem", background: "var(--brand-soft)", border: "1px solid var(--brand)" }}
          >
            <p style={{ margin: 0, fontWeight: 600, color: "var(--brand)" }}>
              Completed {selectedTodo.completed_at ? formatDate(selectedTodo.completed_at) : ""}
            </p>
          </div>
        )}

        {/* ── Spray run details ─────────────────────────────────────────────── */}
        {isSpray && (calc.total_volume_l != null || selectedTodo.sprayer_snapshot.name) ? (
          <div className="mobile-yield-card" style={{ marginTop: "1rem" }}>
            <h3 style={{ margin: "0 0 0.4rem" }}>Spray Run</h3>
            {calc.total_volume_l != null ? (
              <p style={{ margin: 0 }}>Water volume: <strong>{roundTo(safeNum(calc.total_volume_l), 1)} L</strong></p>
            ) : null}
            {calc.spray_time_minutes != null ? (
              <p style={{ margin: "0.15rem 0 0", fontSize: "0.85em" }}>
                Est. time: {roundTo(safeNum(calc.spray_time_minutes), 1)} min
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

        {/* ── Valve drench completion modal ─────────────────────────────────── */}
        {showCompletionModal ? (
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
                maxWidth: "340px",
                width: "100%",
                textAlign: "center",
                boxShadow: "0 8px 32px rgba(0,0,0,0.22)"
              }}
            >
              <p style={{ fontSize: "2rem", margin: "0 0 0.5rem" }}>✓</p>
              <h2 style={{ margin: "0 0 0.5rem" }}>Plan Complete</h2>
              <p style={{ margin: "0 0 0.25rem", color: "var(--text-muted)", fontSize: "0.9em" }}>
                Saved to Records
              </p>
              <p style={{ margin: "0 0 1.25rem", color: "var(--text-muted)", fontSize: "0.9em" }}>
                Inventory has been updated
              </p>
              <button
                type="button"
                style={{ width: "100%" }}
                onClick={() => {
                  setShowCompletionModal(false);
                  setSelectedId(null);
                }}
              >
                Done
              </button>
            </div>
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
        <p style={{ color: "var(--brand)", fontWeight: 600, marginTop: "0.5rem" }}>✓ {completedMessage}</p>
      ) : null}
      {loading ? <p>Loading…</p> : null}

      <h3 style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>To Do ({pendingTodos.length})</h3>

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
        const snapRaw = todo.progress_snapshot as Record<string, unknown>;
        const isValveDrench = snapRaw.type === "valve_drench" && Array.isArray(snapRaw.valves);
        const vdSnap = isValveDrench ? (snapRaw as ValveDrenchSnapshot) : null;
        const totalV = vdSnap ? vdSnap.valves.length : 0;
        const doneV = vdSnap ? vdSnap.valves.filter((v) => v.completed).length : 0;
        const snap = snapRaw as Partial<ProgressSnapshot>;
        const totalR = !isValveDrench ? (snap.phases?.reduce((s, p) => s + p.rows.length, 0) ?? 0) : 0;
        const doneR = !isValveDrench ? (snap.phases?.reduce((s, p) => s + p.rows.filter((r) => r.completed).length, 0) ?? 0) : 0;
        const totalProg = isValveDrench ? totalV : totalR;
        const doneProg = isValveDrench ? doneV : doneR;
        const progLabel = isValveDrench ? "valves" : "rows";

        return (
          <button
            key={todo.id}
            type="button"
            className="pest-todo-card"
            onClick={() => setSelectedId(todo.id)}
            onMouseDown={() => startLongPress(todo.id)}
            onMouseUp={cancelLongPress}
            onMouseLeave={cancelLongPress}
            onTouchStart={() => startLongPress(todo.id)}
            onTouchEnd={cancelLongPress}
            onTouchCancel={cancelLongPress}
          >
            <div className="pest-todo-card-header">
              <span className="pest-todo-type-badge" data-type={todo.type}>
                {todo.type === "spray" ? "Spray" : "Drench"}
              </span>
              {totalProg > 0 ? (
                <span style={{ fontSize: "0.75em", color: "var(--text-muted)" }}>
                  {doneProg}/{totalProg} {progLabel}
                </span>
              ) : (
                <span className="pest-todo-status-badge" data-status={todo.status}>
                  {todo.status === "in_progress" ? "In Progress" : "Pending"}
                </span>
              )}
            </div>
            <p className="pest-todo-card-chemical">{chem.name ?? "—"}</p>
            {isValveDrench && target.valve_names && target.valve_names.length > 0 ? (
              <p className="pest-todo-card-target">{target.valve_names.join(", ")}</p>
            ) : !isValveDrench && target.group_names && target.group_names.length > 0 ? (
              <p className="pest-todo-card-target">{target.group_names.join(", ")}</p>
            ) : null}
            <div className="pest-todo-card-stats">
              {calc.total_chemical_ml != null && Number.isFinite(calc.total_chemical_ml) ? (
                <span>{roundTo(safeNum(calc.total_chemical_ml), 0)} ml chemical</span>
              ) : null}
              {todo.type === "spray" && calc.total_volume_l != null ? (
                <span>{roundTo(safeNum(calc.total_volume_l), 1)} L water</span>
              ) : null}
              {todo.type === "spray" && calc.spray_time_minutes != null ? (
                <span>~{roundTo(safeNum(calc.spray_time_minutes), 0)} min</span>
              ) : null}
            </div>
            {totalProg > 0 ? (
              <div style={{ marginTop: "0.4rem" }}>
                <div style={{ height: "4px", background: "var(--border)", borderRadius: "2px", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${(doneProg / totalProg) * 100}%`,
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

      {/* ── Delete confirm modal ──────────────────────────────────────────── */}
      {deleteTargetId ? (
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
              boxShadow: "0 8px 32px rgba(0,0,0,0.22)"
            }}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>Delete this plan?</h2>
            <p style={{ margin: "0 0 1.25rem", fontSize: "0.9em", color: "var(--text-muted)" }}>
              This will remove the plan from the mobile list. This cannot be undone.
            </p>
            {error ? <p className="form-error" style={{ marginBottom: "0.75rem" }}>{error}</p> : null}
            <div style={{ display: "flex", gap: "0.65rem" }}>
              <button
                type="button"
                className="secondary"
                style={{ flex: 1 }}
                disabled={deleting}
                onClick={() => { setDeleteTargetId(null); setError(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ flex: 1, background: "var(--error, #d32f2f)", borderColor: "var(--error, #d32f2f)" }}
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? "Deleting…" : "Yes, delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
