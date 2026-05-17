import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type TodoStatus = "pending" | "completed" | "cancelled";

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

type PestTodo = {
  id: string;
  type: "spray" | "drench";
  status: TodoStatus;
  chemical_snapshot: ChemicalSnapshot;
  target_snapshot: TargetSnapshot;
  sprayer_snapshot: SprayerSnapshot;
  tank_snapshot: TankSnapshot;
  calculation_snapshot: CalcSnapshot;
  instructions: string | null;
  created_at: string;
  completed_at: string | null;
};

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

function safeNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return String(v);
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

export function MobilePestLogPage() {
  const [todos, setTodos] = useState<PestTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

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

  const selectedTodo = todos.find((t) => t.id === selectedId) ?? null;

  const pendingTodos = todos.filter((t) => t.status === "pending");
  const completedTodos = todos.filter((t) => t.status === "completed" || t.status === "cancelled");

  async function markComplete(id: string) {
    setCompleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/pest/todos/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "completed" })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to mark complete");
      }
      await fetchTodos();
      setSelectedId(null);
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "Failed to mark complete");
    } finally {
      setCompleting(false);
    }
  }

  // ── Detail view ─────────────────────────────────────────────────────────────

  if (selectedTodo) {
    const c = selectedTodo.calculation_snapshot;
    const chem = selectedTodo.chemical_snapshot;
    const target = selectedTodo.target_snapshot;
    const sprayer = selectedTodo.sprayer_snapshot;
    const tank = selectedTodo.tank_snapshot;
    const isSpray = selectedTodo.type === "spray";

    const tankRows: { label: string; water: string; chemical: string }[] = [];
    if (
      isSpray &&
      c.tank_count != null &&
      c.tank_count > 0 &&
      c.chem_per_full_tank_ml != null &&
      c.tank_volume_l != null
    ) {
      const fullTanks = c.is_last_full ? c.tank_count : c.tank_count - 1;
      for (let i = 1; i <= fullTanks; i++) {
        tankRows.push({
          label: `Tank ${i}`,
          water: `${c.tank_volume_l} L`,
          chemical: `${roundTo(c.chem_per_full_tank_ml, 1)} ml`
        });
      }
      if (!c.is_last_full && c.final_tank_volume_l != null && c.chem_for_final_tank_ml != null) {
        tankRows.push({
          label: `Tank ${c.tank_count}`,
          water: `${roundTo(c.final_tank_volume_l, 1)} L`,
          chemical: `${roundTo(c.chem_for_final_tank_ml, 1)} ml`
        });
      }
    }

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

        <div className="pest-todo-type-badge" data-type={selectedTodo.type}>
          {selectedTodo.type === "spray" ? "Spray" : "Drench"}
        </div>

        <h2 style={{ marginTop: "0.4rem" }}>
          {chem.name ?? "Untitled plan"}
        </h2>

        <p style={{ fontSize: "0.82em", color: "var(--text-muted)", marginTop: "0.1rem" }}>
          Saved {formatDate(selectedTodo.created_at)}
        </p>

        {error ? <p className="form-error">{error}</p> : null}

        {/* Target area */}
        <div className="mobile-yield-card" style={{ marginTop: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem" }}>Target Area</h3>
          {target.group_names && target.group_names.length > 0 ? (
            <p style={{ margin: 0 }}>{target.group_names.join(", ")}</p>
          ) : (
            <p style={{ margin: 0, color: "var(--text-muted)" }}>—</p>
          )}
          {target.total_m2 != null && Number.isFinite(target.total_m2) ? (
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85em", color: "var(--text-muted)" }}>
              {roundTo(target.total_m2, 1).toLocaleString()} m²
            </p>
          ) : null}
          {isSpray && target.total_row_length_meters != null ? (
            <p style={{ margin: "0.2rem 0 0", fontSize: "0.85em", color: "var(--text-muted)" }}>
              Total row length: {roundTo(target.total_row_length_meters, 1)} m
            </p>
          ) : null}
        </div>

        {/* Chemical */}
        <div className="mobile-yield-card" style={{ marginTop: "0.75rem" }}>
          <h3 style={{ margin: "0 0 0.5rem" }}>Chemical</h3>
          <p style={{ margin: 0, fontWeight: 600 }}>{chem.name ?? "—"}</p>
          {chem.chemical_type ? (
            <p style={{ margin: "0.15rem 0 0", fontSize: "0.82em", color: "var(--text-muted)" }}>
              {chem.chemical_type.charAt(0).toUpperCase() + chem.chemical_type.slice(1)}
              {chem.chemical_group ? ` · ${chem.chemical_group}` : ""}
            </p>
          ) : null}
          {chem.phi ? (
            <p style={{ margin: "0.15rem 0 0", fontSize: "0.82em" }}>PHI: {chem.phi}</p>
          ) : null}
          {c.total_chemical_ml != null && Number.isFinite(c.total_chemical_ml) ? (
            <p style={{ margin: "0.5rem 0 0", fontWeight: 700, fontSize: "1.05rem" }}>
              Total needed: {roundTo(c.total_chemical_ml, 1)} ml ({roundTo(c.total_chemical_ml / 1000, 3)} L)
            </p>
          ) : null}
          {c.rate_value != null && c.rate_unit ? (
            <p style={{ margin: "0.15rem 0 0", fontSize: "0.82em", color: "var(--text-muted)" }}>
              @ {c.rate_value} {RATE_UNIT_LABELS[c.rate_unit] ?? c.rate_unit}
              {c.area_label ? ` · ${c.area_label}` : ""}
            </p>
          ) : null}
        </div>

        {/* Spray run */}
        {isSpray && (
          <div className="mobile-yield-card" style={{ marginTop: "0.75rem" }}>
            <h3 style={{ margin: "0 0 0.5rem" }}>Spray Run</h3>
            {c.total_volume_l != null ? (
              <p style={{ margin: 0, fontWeight: 700 }}>
                Water volume: {roundTo(c.total_volume_l, 1)} L
              </p>
            ) : null}
            {c.spray_time_minutes != null ? (
              <p style={{ margin: "0.15rem 0 0", fontSize: "0.85em" }}>
                Est. time: {roundTo(c.spray_time_minutes, 1)} min ({roundTo((c.spray_time_minutes ?? 0) / 60, 2)} hr)
              </p>
            ) : null}
            {c.total_flow_l_per_min != null ? (
              <p style={{ margin: "0.15rem 0 0", fontSize: "0.85em" }}>
                Flow rate: {roundTo(c.total_flow_l_per_min, 2)} L/min
              </p>
            ) : null}
            {sprayer.name ? (
              <div style={{ marginTop: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border)" }}>
                <p style={{ margin: 0, fontSize: "0.85em" }}>
                  Sprayer: <strong>{sprayer.name}</strong>
                </p>
                {sprayer.speed_m_per_min != null ? (
                  <p style={{ margin: "0.1rem 0 0", fontSize: "0.82em", color: "var(--text-muted)" }}>
                    Speed: {sprayer.speed_m_per_min} m/min
                  </p>
                ) : null}
                {sprayer.nozzles_open != null ? (
                  <p style={{ margin: "0.1rem 0 0", fontSize: "0.82em", color: "var(--text-muted)" }}>
                    Nozzles open: {sprayer.nozzles_open}
                    {sprayer.nozzle_count != null ? ` of ${sprayer.nozzle_count}` : ""}
                  </p>
                ) : null}
                {sprayer.nozzle_psi != null ? (
                  <p style={{ margin: "0.1rem 0 0", fontSize: "0.82em", color: "var(--text-muted)" }}>
                    PSI: {sprayer.nozzle_psi}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {/* Tank mix */}
        {isSpray && tank.volume_liters != null && (
          <div className="mobile-yield-card" style={{ marginTop: "0.75rem" }}>
            <h3 style={{ margin: "0 0 0.5rem" }}>Tank Mix Plan</h3>
            <p style={{ margin: "0 0 0.4rem", fontSize: "0.85em" }}>
              {tank.name ?? "Tank"}: {tank.volume_liters} L
              {tank.is_builtin ? " (built-in)" : ""}
            </p>

            {tankRows.length > 0 ? (
              <div className="pest-tank-mix-list">
                {tankRows.map((row, i) => (
                  <div key={i} className="pest-tank-mix-row">
                    <span className="pest-tank-mix-label">{row.label}</span>
                    <span className="pest-tank-mix-water">{row.water} water</span>
                    <span className="pest-tank-mix-chem">{row.chemical} chemical</span>
                  </div>
                ))}
              </div>
            ) : c.tank_count != null ? (
              <p style={{ fontSize: "0.85em" }}>
                {c.tank_count} tank{c.tank_count !== 1 ? "s" : ""}
              </p>
            ) : null}

            {c.chem_per_liter_ml != null ? (
              <p style={{ margin: "0.5rem 0 0", fontSize: "0.78em", color: "var(--text-muted)" }}>
                {roundTo(c.chem_per_liter_ml, 3)} ml chemical per litre of water
              </p>
            ) : null}
          </div>
        )}

        {/* Instructions */}
        {selectedTodo.instructions ? (
          <div className="mobile-yield-card" style={{ marginTop: "0.75rem" }}>
            <h3 style={{ margin: "0 0 0.4rem" }}>Instructions</h3>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.9em" }}>
              {selectedTodo.instructions}
            </p>
          </div>
        ) : null}

        {/* Mark complete */}
        {selectedTodo.status === "pending" ? (
          <div style={{ marginTop: "1.25rem" }}>
            <button
              type="button"
              disabled={completing}
              style={{ width: "100%" }}
              onClick={() => void markComplete(selectedTodo.id)}
            >
              {completing ? "Saving…" : "Mark Complete"}
            </button>
          </div>
        ) : (
          <div className="mobile-yield-card" style={{ marginTop: "1rem", background: "var(--brand-soft)", border: "1px solid var(--brand)" }}>
            <p style={{ margin: 0, fontWeight: 600, color: "var(--brand)" }}>
              Completed {selectedTodo.completed_at ? formatDate(selectedTodo.completed_at) : ""}
            </p>
          </div>
        )}
      </section>
    );
  }

  // ── List view ───────────────────────────────────────────────────────────────

  return (
    <section className="mobile-page">
      <h2>Pest Log</h2>
      <p>Planned spray and drench applications for your team.</p>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading…</p> : null}

      {/* Pending plans */}
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
              <span className="pest-todo-status-badge" data-status={todo.status}>
                Pending
              </span>
            </div>

            <p className="pest-todo-card-chemical">{chem.name ?? "—"}</p>

            {target.group_names && target.group_names.length > 0 ? (
              <p className="pest-todo-card-target">
                {target.group_names.join(", ")}
              </p>
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
