import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { enqueue } from "../services/offlineQueue";
import { useMembership } from "../contexts/MembershipContext";
import { getDefaultRoute } from "../utils/getDefaultRoute";
import { planFromTodo, summarizeMixes, type MixChemicalLine } from "../lib/pestMixSummary";
import {
  LeftoverForm,
  MixForm,
  MixHistory,
  MixProgressCard,
  PlannedVsActual,
  type JobMix,
  type MixFormValues,
  type MixRevision
} from "../components/pest/PestMixPanel";

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
  mixNumbers?: number[];               // every tank that sprayed it (two when a tank ran out mid-row)
  partial?: boolean;                   // started on a tank that ran out; not finished yet
};

type ProgressPhase = {
  phaseId: string;
  phaseName: string;
  completed: boolean;
  completedAt: string | null;
  rows: ProgressRow[];
};

// Pre-0158 shape of progress_snapshot.mixes (read only; imported server-side).
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
  application_date: string | null;
  chemical_id?: string | null;
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
  L_per_hectare: "L/hectare",
  g_per_acre: "g/acre",
  kg_per_acre: "kg/acre",
  g_per_hectare: "g/hectare",
  kg_per_hectare: "kg/hectare"
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


// ── Mix helpers ───────────────────────────────────────────────────────────────

type MixData = { available: boolean; mixes: JobMix[]; revisions: MixRevision[]; loadFailed?: boolean };

type MixFormState =
  | { kind: "start"; clientKey: string }
  | { kind: "correct"; mix: JobMix }
  | { kind: "finish" };

function normalizeMix(m: JobMix): JobMix {
  return {
    ...m,
    mix_number: Number(m.mix_number),
    water_l: Number(m.water_l),
    leftover_l: Number(m.leftover_l),
    planned_water_l: m.planned_water_l == null ? null : Number(m.planned_water_l),
    chemicals: (m.chemicals ?? []).map((c) => ({ ...c, amount: Number(c.amount) }))
  };
}

function tankPlanFor(todo: PestTodo): { count: number; hasPlan: boolean } {
  const calc = todo.calculation_snapshot;
  const count = safeNum(calc.tank_count);
  return {
    count,
    hasPlan: todo.type === "spray" && count > 0 && calc.chem_per_full_tank_ml != null && calc.tank_volume_l != null
  };
}

/** Planned water/chemical for mix #n: a full tank, the plan's final partial tank for the last planned mix, a full tank for extras. */
function plannedMixDefaults(todo: PestTodo, mixNumber: number): { water_l: number; chemical_amount: number } {
  const calc = todo.calculation_snapshot;
  const count = safeNum(calc.tank_count);
  const isFinalPartial = count > 0 && mixNumber === count && !(calc.is_last_full ?? false);
  return {
    water_l: safeNum(isFinalPartial ? calc.final_tank_volume_l ?? calc.tank_volume_l : calc.tank_volume_l),
    chemical_amount: safeNum(isFinalPartial ? calc.chem_for_final_tank_ml ?? calc.chem_per_full_tank_ml : calc.chem_per_full_tank_ml)
  };
}

function chemicalUnitFor(todo: PestTodo): "ml" | "g" {
  const unit = todo.calculation_snapshot.rate_unit ?? todo.chemical_snapshot.rate_unit ?? "";
  return /^(g|kg)_/.test(unit) ? "g" : "ml";
}

/** The plan's chemical with the amount actually added (only the planned chemical can be recorded). */
function chemicalLines(todo: PestTodo, amount: number): MixChemicalLine[] {
  if (!todo.chemical_id) return [];
  return [{ chemical_id: todo.chemical_id, name: todo.chemical_snapshot.name ?? "", amount, unit: chemicalUnitFor(todo) }];
}

function addMixNumber(list: number[] | undefined, n: number | null): number[] {
  const out = [...(list ?? [])];
  if (n != null && !out.includes(n)) out.push(n);
  return out;
}

function newClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MobilePestLogPage() {
  const { isOnline } = useOnlineStatus();
  const navigate = useNavigate();
  const { role, permissions } = useMembership();
  const [todos, setTodos] = useState<PestTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error` (shared by progress/delete/complete actions below)
  // -- specifically whether the initial todo list load failed, so "No
  // pending plans" is never shown as if it were a genuine empty result when
  // the request actually failed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [completedTodos, setCompletedTodos] = useState<PestTodo[]>([]);
  const [loadingCompleted, setLoadingCompleted] = useState(false);
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
  const [mixData, setMixData] = useState<MixData | null>(null);
  const [mixForm, setMixForm] = useState<MixFormState | null>(null);
  const [splitRowOpen, setSplitRowOpen] = useState(false);
  const [splitRowId, setSplitRowId] = useState("");
  const [completionSummary, setCompletionSummary] = useState<ReturnType<typeof summarizeMixes> | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  // ── Long-press delete state ────────────────────────────────────────────────
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (longPressTimer.current !== null) clearTimeout(longPressTimer.current);
    };
  }, []);

  // ── Data fetching ──────────────────────────────────────────────────────────

  // Session expired or permissions changed while this page was open -- leave
  // immediately for the user's normal authorized landing page rather than
  // get stuck showing a load error. Same pattern as
  // MobileIrrigationLogPage.tsx's fetchLogData().
  function redirectUnauthorized() {
    navigate(getDefaultRoute(role, permissions), { replace: true });
  }

  async function fetchTodos() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/pest/todos?status=active");
      if (res.status === 401 || res.status === 403) {
        redirectUnauthorized();
        return;
      }
      if (!res.ok) throw new Error("Failed to load pest log");
      setTodos((await res.json()) as PestTodo[]);
    } catch {
      setLoadError("Unable to load the pest log. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function fetchCompletedTodos() {
    setLoadingCompleted(true);
    try {
      const res = await apiFetch("/api/pest/todos?status=completed");
      if (!res.ok) throw new Error("Failed to load completed");
      setCompletedTodos((await res.json()) as PestTodo[]);
    } catch {
      // non-fatal; completed list stays empty
    } finally {
      setLoadingCompleted(false);
    }
  }

  useEffect(() => { void fetchTodos(); }, []);

  useEffect(() => {
    if (showCompleted && completedTodos.length === 0) void fetchCompletedTodos();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCompleted]);

  // ── Progress initialization ────────────────────────────────────────────────
  // Intentional: reset detail state whenever the selected plan changes; no deps needed.
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
    setMixData(null);
    setMixForm(null);
    setSplitRowOpen(false);
    setSplitRowId("");
    selectedIdRef.current = selectedId;

    if (!selectedId) return;

    const todo = [...todos, ...completedTodos].find((t) => t.id === selectedId);
    if (!todo) return;

    if (tankPlanFor(todo).hasPlan) void reloadMixes(todo.id);

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

    // Cancelled below whenever selectedId changes again (a newer plan was
    // opened) or this page unmounts -- without this, quickly switching
    // between two never-yet-opened plans could let an older response land
    // after a newer plan's progress has already been initialized, silently
    // overwriting it. Same pattern as MobileFoodSafetyLocationPage.tsx.
    const controller = new AbortController();

    apiFetch("/api/greenhouse-setup", { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return null;
        if (res.status === 401 || res.status === 403) {
          redirectUnauthorized();
          return null;
        }
        if (!res.ok) throw new Error("Failed to load greenhouse rows");
        return res.json() as Promise<{ rows: SetupRow[] }>;
      })
      .then((setupData) => {
        if (controller.signal.aborted || !setupData) return;

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
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load rows");
        setLoadingProgress(false);
      });

    return () => {
      controller.abort();
    };
  }, [selectedId]);

  // ── Progress persistence ───────────────────────────────────────────────────

  async function patchProgress(todoId: string, snap: ProgressSnapshot, showSaving = true): Promise<boolean> {
    if (showSaving) setSavingProgress(true);
    try {
      const body = JSON.stringify({ progress_snapshot: snap });

      if (!isOnline) {
        await enqueue({ module: "pest", url: `/api/pest/todos/${todoId}/progress`, method: "PATCH", body });
        setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap } : t)));
        return true;
      }

      const res = await apiFetch(`/api/pest/todos/${todoId}/progress`, { method: "PATCH", body });
      if (res.ok) {
        setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap } : t)));
        return true;
      }
      const resBody = await res.json().catch(() => null) as { message?: string } | null;
      setError(resBody?.message ?? "Failed to save progress. Please try again.");
      return false;
    } catch {
      setError("Failed to save progress. Check your connection and try again.");
      return false;
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

  async function patchValveDrenchProgress(todoId: string, snap: ValveDrenchSnapshot): Promise<boolean> {
    setSavingProgress(true);
    try {
      const body = JSON.stringify({ progress_snapshot: snap });

      if (!isOnline) {
        await enqueue({ module: "pest", url: `/api/pest/todos/${todoId}/progress`, method: "PATCH", body });
        setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap as unknown as Record<string, unknown> } : t)));
        return true;
      }

      const res = await apiFetch(`/api/pest/todos/${todoId}/progress`, { method: "PATCH", body });
      if (res.ok) {
        setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, progress_snapshot: snap as unknown as Record<string, unknown> } : t)));
        return true;
      }
      const resBody = await res.json().catch(() => null) as { message?: string } | null;
      setError(resBody?.message ?? "Failed to save progress. Please try again.");
      return false;
    } catch {
      setError("Failed to save progress. Check your connection and try again.");
      return false;
    } finally {
      setSavingProgress(false);
    }
  }

  async function completeValve(todoId: string, valveId: string) {
    if (!valveDrenchProgress) return;
    const todo = todos.find((t) => t.id === todoId);
    if (!todo) return;

    if (todo.status === "pending") markInProgress(todo.id);

    const previousSnap = valveDrenchProgress;
    const now = new Date().toISOString();
    const newSnap: ValveDrenchSnapshot = {
      ...valveDrenchProgress,
      valves: valveDrenchProgress.valves.map((v) =>
        v.valveId === valveId ? { ...v, completed: true, completedAt: now } : v
      )
    };
    setValveDrenchProgress(newSnap);
    const ok = await patchValveDrenchProgress(todoId, newSnap);

    if (!ok) {
      setValveDrenchProgress(previousSnap);
      return;
    }

    if (newSnap.valves.every((v) => v.completed)) {
      if (window.confirm("All valves complete. Save drench record?")) {
        await completeValveDrenchJob(todoId);
      }
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
      const done = (await res.json().catch(() => null)) as { mix_summary?: ReturnType<typeof summarizeMixes> | null } | null;
      setCompletionSummary(done?.mix_summary ?? null);
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
    const body = JSON.stringify({ status: "in_progress" });
    if (!isOnline) {
      void enqueue({ module: "pest", url: `/api/pest/todos/${todoId}/status`, method: "PATCH", body });
      setTodos((prev) => prev.map((t) => (t.id === todoId ? { ...t, status: "in_progress" as TodoStatus } : t)));
      return;
    }
    void apiFetch(`/api/pest/todos/${todoId}/status`, {
      method: "PATCH",
      body,
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
  // Mixes are their own records (POST /pest/todos/:id/mixes). The plan's tank
  // count is the comparison baseline only — another mix can always be
  // started. Every request carries a client_key generated when the form
  // opened, so a retry (or an offline replay) never adds a second mix.

  async function reloadMixes(todoId: string) {
    try {
      const res = await apiFetch(`/api/pest/todos/${todoId}/mixes`);
      if (!res.ok) throw new Error("Failed to load mixes");
      const body = (await res.json()) as { available: boolean; mixes: JobMix[]; revisions: MixRevision[] };
      if (selectedIdRef.current !== todoId) return;
      setMixData({ available: body.available, mixes: body.mixes.map(normalizeMix), revisions: body.revisions ?? [] });
    } catch {
      if (selectedIdRef.current !== todoId) return;
      setMixData((prev) => prev ?? { available: true, mixes: [], revisions: [], loadFailed: true });
    }
  }

  async function postMix(todo: PestTodo, payload: Record<string, unknown>, optimistic: (prev: MixData) => MixData): Promise<boolean> {
    setSavingProgress(true);
    setError(null);
    const body = JSON.stringify(payload);
    try {
      if (!isOnline) {
        await enqueue({ module: "pest", url: `/api/pest/todos/${todo.id}/mixes`, method: "POST", body });
        setMixData((prev) => (prev ? optimistic(prev) : prev));
        return true;
      }
      const res = await apiFetch(`/api/pest/todos/${todo.id}/mixes`, { method: "POST", body });
      if (!res.ok) {
        const resBody = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(resBody?.message ?? "Failed to save the mix. Please try again.");
        return false;
      }
      await reloadMixes(todo.id);
      return true;
    } catch {
      setError("Failed to save the mix. Check your connection and try again — the same entry is kept, so retrying won't add a second mix.");
      return false;
    } finally {
      setSavingProgress(false);
    }
  }

  async function submitStartMix(todo: PestTodo, values: MixFormValues, clientKey: string) {
    if (!mixData) return;
    const mixes = mixData.mixes;
    const active = mixes.find((m) => m.status === "active") ?? null;
    const mixNumber = mixes.reduce((mx, m) => Math.max(mx, m.mix_number), 0) + 1;
    const plan = tankPlanFor(todo);
    const defaults = plannedMixDefaults(todo, mixNumber);
    const chemicals = chemicalLines(todo, values.chemical_amount);
    const payload: Record<string, unknown> = { client_key: clientKey, mix_number: mixNumber, water_l: values.water_l, chemicals };
    if (active) payload.previous_leftover_l = values.leftover_l;
    const now = new Date().toISOString();
    const ok = await postMix(todo, payload, (prev) => ({
      ...prev,
      mixes: [
        ...prev.mixes.map((m) => (m.status === "active" ? { ...m, status: "completed" as const, ended_at: now, leftover_l: values.leftover_l, pending: true } : m)),
        {
          id: clientKey, client_key: clientKey, mix_number: mixNumber, status: "active", pending: true,
          is_extra: plan.count > 0 && mixNumber > plan.count,
          planned_water_l: defaults.water_l, planned_chemicals: chemicalLines(todo, defaults.chemical_amount),
          water_l: values.water_l, chemicals, leftover_l: 0, started_at: now, ended_at: null, revision: 1
        }
      ]
    }));
    if (ok) {
      setMixForm(null);
      if (todo.status === "pending") {
        setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, status: "in_progress" as TodoStatus } : t)));
      }
    }
  }

  async function submitCorrection(todo: PestTodo, mix: JobMix, values: MixFormValues) {
    const chemicals = chemicalLines(todo, values.chemical_amount);
    const payload: Record<string, unknown> = {
      client_key: mix.client_key,
      water_l: values.water_l,
      chemicals,
      reason: values.reason
    };
    if (mix.status === "completed") payload.leftover_l = values.leftover_l;
    const ok = await postMix(todo, payload, (prev) => ({
      ...prev,
      mixes: prev.mixes.map((m) =>
        m.client_key === mix.client_key
          ? { ...m, water_l: values.water_l, chemicals, leftover_l: mix.status === "completed" ? values.leftover_l : m.leftover_l, pending: true }
          : m
      )
    }));
    if (ok) setMixForm(null);
  }

  // Tank ran out part-way along a row: the row is linked to the tank in use
  // now and stays open; whichever tank finishes it is linked too, and the
  // row's coverage is shared between them instead of counted twice.
  function markRowPartlySprayed(rowId: string) {
    if (!progress || !selectedId) return;
    const todo = todos.find((t) => t.id === selectedId);
    const active = mixData?.mixes.find((m) => m.status === "active");
    if (!todo || !active) return;
    const newProgress: ProgressSnapshot = {
      ...progress,
      phases: progress.phases.map((phase) => ({
        ...phase,
        rows: phase.rows.map((r) =>
          r.rowId === rowId && !r.completed
            ? { ...r, partial: true, mixNumbers: addMixNumber(r.mixNumbers, active.mix_number) }
            : r
        )
      }))
    };
    const previousProgress = progress;
    setProgress(newProgress);
    setSplitRowOpen(false);
    setSplitRowId("");
    void patchProgress(todo.id, newProgress).then((ok) => {
      if (!ok) {
        setProgress(previousProgress);
        return;
      }
      setMixForm({ kind: "start", clientKey: newClientKey() });
    });
  }

  async function finishWithLeftover(todo: PestTodo, active: JobMix, leftoverL: number) {
    const ok = await postMix(
      todo,
      { client_key: active.client_key, water_l: active.water_l, chemicals: active.chemicals, leftover_l: leftoverL, status: "completed" },
      (prev) => prev
    );
    if (!ok) return;
    setMixForm(null);
    await completeJob(todo.id);
  }

  // ── Phase / row completion ─────────────────────────────────────────────────

  function confirmJobComplete(todoId: string) {
    const todo = todos.find((t) => t.id === todoId);
    const label = todo?.type === "drench" ? "drench" : "spray";
    const hasTankPlan = todo != null && tankPlanFor(todo).hasPlan && mixData?.available === true;
    const activeMix = mixData?.mixes.find((m) => m.status === "active") ?? null;

    if (hasTankPlan && progress) {
      const withoutMix = progress.phases
        .flatMap((p) => p.rows)
        .filter((r) => r.completed && (r.completedByMixNumber ?? null) === null);
      if (withoutMix.length > 0) {
        const proceed = window.confirm(
          `${withoutMix.length} row${withoutMix.length !== 1 ? "s" : ""} completed without mix tracking. Save ${label} record anyway?`
        );
        if (!proceed) return;
      }
      // Last tank: ask what was left before the record is saved.
      if (activeMix) {
        setMixForm({ kind: "finish" });
        return;
      }
      if (withoutMix.length > 0) {
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

    const hasTankMix = tankPlanFor(todo).hasPlan && mixData?.available === true;
    const activeMix = mixData?.mixes.find((m) => m.status === "active");
    const row = progress.phases[phaseIdx]?.rows[rowIdx];
    const isMarkingComplete = row != null && !row.completed;

    if (hasTankMix && isMarkingComplete && activeMix == null) {
      setError("Start a new mix before marking rows complete.");
      return;
    }

    if (todo.status === "pending") markInProgress(todo.id);
    if (error) setError(null);

    const now = new Date().toISOString();
    const activeMixNumber = activeMix?.mix_number ?? null;

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
            completedByMixNumber: wasDone ? null : activeMixNumber,
            mixNumbers: wasDone ? [] : addMixNumber(r.mixNumbers, activeMixNumber),
            partial: false
          };
        });
        return { ...phase, rows: newRows };
      })
    };

    const previousProgress = progress;
    setProgress(newProgress);
    void patchProgress(todo.id, newProgress).then((ok) => {
      if (!ok) {
        setProgress(previousProgress);
        return;
      }
      const phase = newProgress.phases[phaseIdx];
      if (phase && phase.rows.length > 0 && phase.rows.every((r) => r.completed) && !phase.completed) {
        confirmPhaseComplete(phaseIdx, newProgress, todo.id);
      }
    });
  }

  function applyCompleteSection() {
    if (!progress || !selectedId) return;
    const todo = todos.find((t) => t.id === selectedId);
    if (!todo) return;

    const hasTankMix = tankPlanFor(todo).hasPlan && mixData?.available === true;
    const activeMix = mixData?.mixes.find((m) => m.status === "active");

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
    const activeMixNumber = activeMix?.mix_number ?? null;

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
              completedByMixNumber: r.completed ? r.completedByMixNumber ?? activeMixNumber : activeMixNumber,
              mixNumbers: r.completed ? r.mixNumbers : addMixNumber(r.mixNumbers, activeMixNumber),
              partial: false
            };
          }
          return r;
        });
        return { ...phase, rows: newRows };
      })
    };

    const previousProgress = progress;
    setProgress(newProgress);
    setShowCompleteSection(false);
    setSectionFrom("");
    setSectionTo("");
    setError(null);
    void patchProgress(todo.id, newProgress).then((ok) => {
      if (!ok) {
        setProgress(previousProgress);
        return;
      }
      const phase = newProgress.phases[selectedPhaseIdx];
      if (phase && phase.rows.length > 0 && phase.rows.every((r) => r.completed) && !phase.completed) {
        confirmPhaseComplete(selectedPhaseIdx, newProgress, todo.id);
      }
    });
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const allTodos = [...todos, ...completedTodos];
  const selectedTodo = allTodos.find((t) => t.id === selectedId) ?? null;
  const pendingTodos = todos.filter((t) => t.status === "pending" || t.status === "in_progress");

  const totalRows = progress?.phases.reduce((s, p) => s + p.rows.length, 0) ?? 0;
  const doneRows = progress?.phases.reduce((s, p) => s + p.rows.filter((r) => r.completed).length, 0) ?? 0;
  const selectedPhase = progress?.phases[selectedPhaseIdx] ?? null;
  const phaseRowNums = selectedPhase?.rows.map((r) => r.rowNumber) ?? [];

  // ── Detail view ─────────────────────────────────────────────────────────────

  if (selectedTodo) {
    const chem = selectedTodo.chemical_snapshot;
    const calc = selectedTodo.calculation_snapshot;
    const isSpray = selectedTodo.type === "spray";
    const isDry = !!(calc.rate_unit?.startsWith("g_") || calc.rate_unit?.startsWith("kg_"));

    const tankPlan = tankPlanFor(selectedTodo);
    const hasTankMix = isSpray && tankPlan.hasPlan && mixData?.available !== false;
    const isOpenJob = selectedTodo.status === "pending" || selectedTodo.status === "in_progress";
    const chemUnit = chemicalUnitFor(selectedTodo);

    const mixes = mixData?.mixes ?? [];
    const activeMix = mixes.find((m) => m.status === "active") ?? null;
    const completedMixes = mixes.filter((m) => m.status === "completed");
    const nextMixNumber = mixes.reduce((mx, m) => Math.max(mx, m.mix_number), 0) + 1;
    const nextDefaults = plannedMixDefaults(selectedTodo, nextMixNumber);
    const allProgressRows = progress?.phases.flatMap((p) => p.rows) ?? [];
    const mixSummary = mixData
      ? summarizeMixes(
          planFromTodo({
            chemical_id: selectedTodo.chemical_id ?? null,
            chemical_snapshot: selectedTodo.chemical_snapshot as Record<string, unknown>,
            calculation_snapshot: selectedTodo.calculation_snapshot as Record<string, unknown>
          }),
          mixes,
          allProgressRows,
          { assumeClosed: selectedTodo.status === "completed" }
        )
      : null;
    const activeMixRowCount = activeMix
      ? allProgressRows.filter((r) => r.completed && (r.mixNumbers ?? [r.completedByMixNumber]).includes(activeMix.mix_number)).length
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
        {hasTankMix && mixData ? (
          <div style={{ marginTop: "0.85rem" }}>
            {/* Plan strip — the baseline, not a limit */}
            <div className="pest-mix-summary">
              <span className="pest-mix-summary-stat">
                Plan: <strong>{tankPlan.count}</strong> mix{tankPlan.count !== 1 ? "es" : ""}
              </span>
              <span className="pest-mix-summary-sep">·</span>
              <span className="pest-mix-summary-stat">
                {safeNum(calc.tank_volume_l)} L / {roundTo(safeNum(calc.chem_per_full_tank_ml), 1)} {chemUnit} ea.
              </span>
              {!calc.is_last_full && calc.final_tank_volume_l != null && calc.chem_for_final_tank_ml != null ? (
                <>
                  <span className="pest-mix-summary-sep">·</span>
                  <span className="pest-mix-summary-stat">
                    Last: {roundTo(safeNum(calc.final_tank_volume_l), 1)} L / {roundTo(safeNum(calc.chem_for_final_tank_ml), 1)} {chemUnit}
                  </span>
                </>
              ) : null}
            </div>

            {mixData.loadFailed ? (
              <p className="form-error" style={{ marginTop: "0.5rem" }}>
                Couldn't load this job's mixes. Reconnect and reopen the job before starting a mix.
              </p>
            ) : null}

            {mixSummary ? <MixProgressCard summary={mixSummary} totalRows={totalRows} /> : null}

            {/* Active mix card */}
            {activeMix ? (
              <div className="pest-mix-card pest-mix-card--active" style={{ marginTop: "0.6rem" }}>
                <div className="pest-mix-card-header">
                  <span className="pest-mix-card-number">Mix #{activeMix.mix_number}</span>
                  <span className="pest-mix-card-status">In Use</span>
                  {activeMix.is_extra ? <span className="pest-mix-extra-tag">Extra</span> : null}
                  {activeMix.pending ? <span className="pest-mix-pending-tag">Not synced</span> : null}
                </div>
                <div className="pest-mix-card-amounts">
                  <span>{roundTo(activeMix.water_l, 1)} L water</span>
                  {activeMix.chemicals.map((c) => (
                    <span key={c.chemical_id}><span className="pest-mix-summary-sep">·</span> {roundTo(c.amount, 1)} {c.unit} {c.name}</span>
                  ))}
                </div>
                <p style={{ margin: "0.2rem 0 0", fontSize: "0.78em", color: "var(--text-muted)" }}>
                  Started {formatTime(activeMix.started_at)}
                  {activeMixRowCount > 0 ? ` · ${activeMixRowCount} row${activeMixRowCount !== 1 ? "s" : ""} done` : ""}
                  {activeMix.planned_water_l != null ? ` · plan ${roundTo(activeMix.planned_water_l, 1)} L` : ""}
                </p>
                {isOpenJob && !mixForm ? (
                  <div className="pest-mix-actions">
                    <button
                      type="button"
                      className="mobile-action-button mobile-action-button--next"
                      disabled={savingProgress || mixData.loadFailed}
                      onClick={() => setMixForm({ kind: "start", clientKey: newClientKey() })}
                    >
                      Start Mix #{nextMixNumber}
                    </button>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button type="button" className="secondary" disabled={savingProgress} onClick={() => { setSplitRowOpen((v) => !v); setSplitRowId(""); }}>
                        Tank ran out mid-row
                      </button>
                      <button type="button" className="secondary" aria-label={`Correct Mix #${activeMix.mix_number}`} disabled={savingProgress} onClick={() => setMixForm({ kind: "correct", mix: activeMix })}>
                        Correct
                      </button>
                    </div>
                  </div>
                ) : null}
                {splitRowOpen && !mixForm && selectedPhase ? (
                  <div className="pest-section-form" style={{ marginTop: "0.5rem" }}>
                    <label>
                      Row where Mix #{activeMix.mix_number} ran out
                      <select value={splitRowId} onChange={(e) => setSplitRowId(e.target.value)}>
                        <option value="">—</option>
                        {selectedPhase.rows.filter((r) => !r.completed).map((r) => (
                          <option key={r.rowId} value={r.rowId}>Row {r.rowNumber}</option>
                        ))}
                      </select>
                    </label>
                    <p className="pest-mix-progress-note" style={{ margin: "0.4rem 0 0" }}>
                      The row stays open and is linked to both tanks; its coverage is split between them.
                    </p>
                    <button type="button" style={{ marginTop: "0.5rem", width: "100%" }} disabled={!splitRowId || savingProgress} onClick={() => markRowPartlySprayed(splitRowId)}>
                      Link row and start Mix #{nextMixNumber}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : isOpenJob && !mixForm ? (
              <div className="pest-mix-card" style={{ marginTop: "0.6rem" }}>
                <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.88em" }}>
                  {mixData.mixes.length === 0 ? "No mix started. Fill your first tank to begin." : "No tank in use."}
                </p>
                <button
                  type="button"
                  className="mobile-action-button"
                  disabled={savingProgress || mixData.loadFailed}
                  onClick={() => setMixForm({ kind: "start", clientKey: newClientKey() })}
                >
                  Start Mix #{nextMixNumber}
                </button>
              </div>
            ) : null}

            {/* Start / correct / finish forms */}
            {mixForm?.kind === "start" ? (
              <MixForm
                key={mixForm.clientKey}
                title={`Mix #${nextMixNumber}${tankPlan.count > 0 && nextMixNumber > tankPlan.count ? " — extra mix" : ""}`}
                hint={
                  (tankPlan.count > 0 && nextMixNumber > tankPlan.count
                    ? `Beyond the ${tankPlan.count} planned mixes. `
                    : `Planned: ${roundTo(nextDefaults.water_l, 1)} L / ${roundTo(nextDefaults.chemical_amount, 1)} ${chemUnit}. `) +
                  "Enter what actually goes in the tank."
                }
                chemicalName={chem.name ?? "Chemical"}
                chemicalUnit={chemUnit}
                initial={{ water_l: roundTo(nextDefaults.water_l, 1), chemical_amount: roundTo(nextDefaults.chemical_amount, 1), leftover_l: 0, reason: "" }}
                maxLeftover={activeMix ? activeMix.water_l : undefined}
                leftoverLabel={activeMix ? `Left over in Mix #${activeMix.mix_number} (L, drained or not sprayed)` : undefined}
                busy={savingProgress}
                submitLabel={`Save Mix #${nextMixNumber}`}
                onSubmit={(v) => void submitStartMix(selectedTodo, v, mixForm.clientKey)}
                onCancel={() => setMixForm(null)}
              />
            ) : mixForm?.kind === "correct" ? (
              <MixForm
                key={`${mixForm.mix.client_key}-${mixForm.mix.revision}`}
                title={`Correct Mix #${mixForm.mix.mix_number}`}
                hint="The original entry stays in the history."
                chemicalName={chem.name ?? "Chemical"}
                chemicalUnit={chemUnit}
                initial={{
                  water_l: mixForm.mix.water_l,
                  chemical_amount: mixForm.mix.chemicals[0]?.amount ?? 0,
                  leftover_l: mixForm.mix.leftover_l,
                  reason: ""
                }}
                maxLeftover={mixForm.mix.status === "completed" ? null : undefined}
                leftoverLabel="Leftover (L)"
                requireReason
                busy={savingProgress}
                submitLabel="Save correction"
                onSubmit={(v) => {
                  if (mixForm.mix.status === "completed" && v.leftover_l > v.water_l) {
                    setError("Leftover can't be more than the water in the tank.");
                    return;
                  }
                  void submitCorrection(selectedTodo, mixForm.mix, v);
                }}
                onCancel={() => setMixForm(null)}
              />
            ) : mixForm?.kind === "finish" && activeMix ? (
              <LeftoverForm
                title={`Close Mix #${activeMix.mix_number} and save the record`}
                hint="How much mixture is left in the tank (or was drained) and won't be sprayed? Enter 0 if the tank is empty."
                maxLeftover={activeMix.water_l}
                busy={savingProgress || completing}
                submitLabel={completing ? "Saving…" : "Save record"}
                onSubmit={(l) => void finishWithLeftover(selectedTodo, activeMix, l)}
                onCancel={() => setMixForm(null)}
              />
            ) : null}

            {/* Previous mixes */}
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
                    {completedMixes.map((mix) => {
                      const share = mixSummary?.mixes.find((s) => s.mix_number === mix.mix_number);
                      const history = mixData.revisions.filter((r) => r.mix_id === mix.id);
                      const corrections = history.filter((r) => r.action === "corrected").length;
                      return (
                        <div key={mix.client_key} className="pest-mix-card pest-mix-card--done">
                          <div className="pest-mix-card-header">
                            <span className="pest-mix-card-number">Mix #{mix.mix_number}</span>
                            <span className="pest-mix-card-status pest-mix-card-status--done">Done</span>
                            {mix.is_extra ? <span className="pest-mix-extra-tag">Extra</span> : null}
                            {mix.pending ? <span className="pest-mix-pending-tag">Not synced</span> : null}
                            {corrections > 0 ? <span className="pest-mix-pending-tag">Corrected {corrections}×</span> : null}
                          </div>
                          <div className="pest-mix-card-amounts" style={{ flexWrap: "wrap", fontSize: "0.82em" }}>
                            <span>{roundTo(mix.water_l, 1)} L</span>
                            {mix.chemicals.map((c) => (
                              <span key={c.chemical_id}><span className="pest-mix-summary-sep">·</span> {roundTo(c.amount, 1)} {c.unit}</span>
                            ))}
                            {mix.leftover_l > 0 ? <span><span className="pest-mix-summary-sep">·</span> {roundTo(mix.leftover_l, 1)} L left over</span> : null}
                            {share ? <span><span className="pest-mix-summary-sep">·</span> {roundTo(share.rows, 1)} row{share.rows === 1 ? "" : "s"}</span> : null}
                            {share?.avg_water_per_row != null ? (
                              <span><span className="pest-mix-summary-sep">·</span> ~{roundTo(share.avg_water_per_row, 1)} L/row avg</span>
                            ) : null}
                          </div>
                          {isOpenJob ? (
                            <button type="button" className="secondary" style={{ fontSize: "0.78em", padding: "0.25rem 0.55rem", marginTop: "0.35rem" }} aria-label={`Correct Mix #${mix.mix_number}`} disabled={savingProgress} onClick={() => setMixForm({ kind: "correct", mix })}>
                              Correct
                            </button>
                          ) : null}
                          {history.some((r) => r.action === "corrected" || r.action === "leftover" || r.action === "imported") ? <MixHistory revisions={history} unit={chemUnit} /> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedTodo.status === "completed" && mixSummary && mixData.mixes.length > 0 ? <PlannedVsActual summary={mixSummary} /> : null}
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
                          // Round grams to nearest 5 g for practical field accuracy
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
                        disabled={savingProgress}
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
                          disabled={savingProgress}
                          onClick={() => toggleRow(selectedPhaseIdx, rowIdx)}
                        >
                          <span className="pest-row-btn-check">{row.completed ? "✓" : ""}</span>
                          <span className="pest-row-btn-label">Row {row.rowNumber}</span>
                          {row.completed ? (
                            <span className="pest-row-btn-time">
                              {(row.mixNumbers?.length ?? 0) > 1
                                ? `Mix ${row.mixNumbers!.map((n) => `#${n}`).join(" → ")}`
                                : row.completedByMixNumber != null
                                  ? `Mix #${row.completedByMixNumber}`
                                  : row.completedAt ? formatDate(row.completedAt) : "done"}
                            </span>
                          ) : row.partial && row.mixNumbers?.length ? (
                            <span className="pest-row-btn-time">Part · Mix #{row.mixNumbers[row.mixNumbers.length - 1]}</span>
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
                                disabled={!sectionFrom || !sectionTo || savingProgress}
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
                disabled={!isOnline || completing}
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
      {completionSummary ? (
        <div style={{ marginTop: "0.5rem" }}>
          <PlannedVsActual summary={completionSummary} />
          <button type="button" className="secondary" style={{ marginTop: "0.5rem", width: "100%" }} onClick={() => setCompletionSummary(null)}>
            Close summary
          </button>
        </div>
      ) : null}
      {loading ? <p>Loading…</p> : null}

      {!loading && loadError ? (
        <div className="mobile-yield-card">
          <p className="form-error" style={{ margin: 0 }}>{loadError}</p>
          <button type="button" style={{ marginTop: "0.6rem" }} onClick={() => void fetchTodos()}>
            Retry
          </button>
        </div>
      ) : null}

      <h3 style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>To Do ({pendingTodos.length})</h3>

      {!loading && !loadError && pendingTodos.length === 0 ? (
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
            {todo.application_date ? (
              <p style={{ fontSize: "0.78em", color: "var(--text-muted)", margin: "0.1rem 0 0" }}>
                Apply {formatDate(todo.application_date)}
              </p>
            ) : null}
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

      <div style={{ marginTop: "1.5rem" }}>
          <button
            type="button"
            className="secondary"
            style={{ fontSize: "0.85em" }}
            onClick={() => setShowCompleted((prev) => !prev)}
          >
            {showCompleted ? "Hide" : "Show"} completed{completedTodos.length > 0 ? ` (${completedTodos.length})` : ""}
          </button>
          {showCompleted ? (
            loadingCompleted ? (
              <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.5rem" }}>Loading…</p>
            ) : completedTodos.length === 0 ? (
              <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.5rem" }}>No completed jobs.</p>
            ) : (
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
          )
        ) : null}
      </div>

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
