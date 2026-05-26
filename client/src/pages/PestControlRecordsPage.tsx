import { Fragment, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type ChemicalSnapshot = {
  name?: string;
  chemical_type?: string | null;
  rate_value?: number | null;
  rate_unit?: string | null;
};

type TargetSnapshot = {
  target_mode?: string;
  valve_names?: string[];
  group_names?: string[];
  total_m2?: number | null;
};

type CalcSnapshot = {
  total_chemical_ml?: number | null;
  rate_value?: number | null;
  rate_unit?: string | null;
  area_label?: string | null;
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

type ProgressSnapshot = {
  type?: string;
  valves?: ValveEntry[];
};

type PestRecord = {
  id: string;
  type: "spray" | "drench";
  chemical_snapshot: ChemicalSnapshot;
  target_snapshot: TargetSnapshot;
  calculation_snapshot: CalcSnapshot;
  progress_snapshot: ProgressSnapshot;
  completed_at: string;
  notes: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const RATE_UNIT_LABELS: Record<string, string> = {
  ml_per_acre:    "ml/acre",
  L_per_acre:     "L/acre",
  ml_per_hectare: "ml/hectare",
  L_per_hectare:  "L/hectare",
  g_per_acre:     "g/acre",
  kg_per_acre:    "kg/acre",
  g_per_hectare:  "g/hectare",
  kg_per_hectare: "kg/hectare",
};

function isDryUnit(rateUnit: string | null | undefined): boolean {
  return !!(rateUnit?.startsWith("g_") || rateUnit?.startsWith("kg_"));
}

function formatProductTotal(calc: CalcSnapshot): string {
  const raw = calc.total_chemical_ml;
  if (raw == null || !Number.isFinite(raw)) return "—";
  const dry = isDryUnit(calc.rate_unit);
  if (dry) {
    return raw >= 1000
      ? `${(raw / 1000).toFixed(2)} kg`
      : `${Math.round(raw)} g`;
  }
  return raw >= 1000
    ? `${(raw / 1000).toFixed(2)} L`
    : `${raw.toFixed(1)} ml`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric"
    });
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

function targetSummary(target: TargetSnapshot): string {
  if (target.target_mode === "valve" && target.valve_names?.length) {
    return target.valve_names.join(", ");
  }
  if (target.group_names?.length) {
    return target.group_names.join(", ");
  }
  return "—";
}

function formatValveAmount(v: ValveEntry): string {
  const rounded =
    v.productUnit === "g"
      ? Math.round(v.productAmount / 5) * 5
      : Math.round(v.productAmount * 10) / 10;
  return `${rounded.toLocaleString()} ${v.productUnit}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PestControlRecordsPage() {
  const [records, setRecords] = useState<PestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRecords() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch("/api/pest/records");
        if (!res.ok) throw new Error("Failed to load records");
        setRecords((await res.json()) as PestRecord[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load records");
      } finally {
        setLoading(false);
      }
    }
    void fetchRecords();
  }, []);

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Pest Control Records</h1>
        <p>Completed spray and drench application records.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        {loading ? (
          <p>Loading records…</p>
        ) : records.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>No pest control records yet.</p>
        ) : (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Chemical</th>
                  <th>Target</th>
                  <th>Product used</th>
                  <th>Area</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {records.map((rec) => {
                  const chem = rec.chemical_snapshot;
                  const calc = rec.calculation_snapshot;
                  const target = rec.target_snapshot;
                  const prog = rec.progress_snapshot;
                  const isExpanded = expandedId === rec.id;
                  const isValveDrench = prog.type === "valve_drench" && Array.isArray(prog.valves);

                  return (
                    <Fragment key={rec.id}>
                      <tr>
                        <td style={{ whiteSpace: "nowrap" }}>{formatDate(rec.completed_at)}</td>
                        <td>
                          <span className="pest-todo-type-badge" data-type={rec.type}>
                            {rec.type === "spray" ? "Spray" : "Drench"}
                          </span>
                        </td>
                        <td>
                          <strong>{chem.name ?? "—"}</strong>
                          {chem.chemical_type ? (
                            <span style={{ display: "block", fontSize: "0.78em", color: "var(--text-muted)" }}>
                              {chem.chemical_type.charAt(0).toUpperCase() + chem.chemical_type.slice(1)}
                            </span>
                          ) : null}
                        </td>
                        <td style={{ maxWidth: "180px" }}>
                          <span style={{ fontSize: "0.88em" }}>{targetSummary(target)}</span>
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <strong>{formatProductTotal(calc)}</strong>
                          {calc.rate_value != null && calc.rate_unit ? (
                            <span style={{ display: "block", fontSize: "0.78em", color: "var(--text-muted)" }}>
                              @ {calc.rate_value} {RATE_UNIT_LABELS[calc.rate_unit] ?? calc.rate_unit}
                            </span>
                          ) : null}
                        </td>
                        <td style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                          {calc.area_label ?? (target.total_m2 != null ? `${target.total_m2.toFixed(1)} m²` : "—")}
                        </td>
                        <td>
                          {isValveDrench || rec.notes ? (
                            <button
                              type="button"
                              className="secondary"
                              style={{ fontSize: "0.8em", padding: "0.2rem 0.5rem", whiteSpace: "nowrap" }}
                              onClick={() => toggleExpand(rec.id)}
                            >
                              {isExpanded ? "▾ Hide" : "▸ Details"}
                            </button>
                          ) : null}
                        </td>
                      </tr>

                      {isExpanded ? (
                        <tr key={`${rec.id}-detail`}>
                          <td
                            colSpan={7}
                            style={{ background: "var(--surface-alt, var(--border))", padding: "0.75rem 1rem" }}
                          >
                            {isValveDrench ? (
                              <div>
                                <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "0.85em" }}>
                                  Valve breakdown
                                </p>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                                  <thead>
                                    <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                                      <th style={{ padding: "0.2rem 0.6rem 0.2rem 0", fontWeight: 600 }}>Valve</th>
                                      <th style={{ padding: "0.2rem 0.6rem", fontWeight: 600 }}>Area</th>
                                      <th style={{ padding: "0.2rem 0.6rem", fontWeight: 600 }}>Amount</th>
                                      <th style={{ padding: "0.2rem 0", fontWeight: 600 }}>Completed</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {prog.valves!.map((v) => (
                                      <tr key={v.valveId} style={{ borderTop: "1px solid var(--border)" }}>
                                        <td style={{ padding: "0.25rem 0.6rem 0.25rem 0" }}>{v.valveName}</td>
                                        <td style={{ padding: "0.25rem 0.6rem" }}>{v.areaM2.toFixed(1)} m²</td>
                                        <td style={{ padding: "0.25rem 0.6rem" }}>{formatValveAmount(v)}</td>
                                        <td style={{ padding: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.9em" }}>
                                          {v.completedAt ? formatTime(v.completedAt) : "—"}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : null}

                            {rec.notes ? (
                              <p style={{ margin: isValveDrench ? "0.6rem 0 0" : "0", fontSize: "0.85em" }}>
                                <strong>Notes:</strong> {rec.notes}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
