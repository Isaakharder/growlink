import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

type ProjectionLevel = "variety" | "color";
type ProjectionUnit = "kg" | "cases";
type VarietyColor = "red" | "orange" | "yellow" | "green";

type Variety = { id: string; name: string; color: string };

type ApiProjection = {
  id: string;
  target_year: number;
  target_week: number;
  forecast_year: number;
  forecast_week: number;
  weeks_out: number;
  projection_level: ProjectionLevel;
  variety_id: string | null;
  variety_name: string | null;
  variety_color: string | null;
  color: string | null;
  unit: ProjectionUnit;
  projected_amount: number;
  actual_amount: number | null;
  difference: number | null;
  accuracy_percent: number | null;
  label: "short" | "over" | "exact" | null;
  notes: string | null;
};

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECTION_URL = "/api/yield/projections";
const OPTIONS_URL = "/api/yield-entry-options";
const COLORS: { value: VarietyColor; label: string }[] = [
  { value: "red", label: "Red" },
  { value: "orange", label: "Orange" },
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
];

// ── ISO week helpers ─────────────────────────────────────────────────────────

function getCurrentIsoWeekYear(): { year: number; week: number } {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: utc.getUTCFullYear(), week };
}

function isoWeekMonday(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  return jan4 - (dow - 1) * 86400000 + (week - 1) * 7 * 86400000;
}

function computeWeeksOut(fY: number, fW: number, tY: number, tW: number): number {
  return Math.round((isoWeekMonday(tY, tW) - isoWeekMonday(fY, fW)) / (7 * 86400000));
}

function weeksOutLabel(n: number): string {
  if (n === 0) return "same week";
  if (n < 0) return `${Math.abs(n)}w retroactive`;
  return `${n} week${n !== 1 ? "s" : ""} out`;
}

const currentIso = getCurrentIsoWeekYear();
const defaultNextWeek = currentIso.week < 53 ? currentIso.week + 1 : 1;
const defaultNextYear = currentIso.week < 53 ? currentIso.year : currentIso.year + 1;

// ── Display helpers ───────────────────────────────────────────────────────────

function fmtNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtDiff(d: number): string {
  return (d >= 0 ? "+" : "") + fmtNumber(d);
}
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function diffClass(d: number | null): string {
  if (d === null) return "";
  return d < 0 ? "projection-diff-negative" : d > 0 ? "projection-diff-positive" : "";
}
function seriesLabel(p: ApiProjection): string {
  return p.projection_level === "variety"
    ? `${p.variety_name ?? "—"} · ${p.unit}`
    : `${capitalize(p.color ?? "")} · ${p.unit}`;
}

// ── Forecast Accuracy by Lead Time card ──────────────────────────────────────

function ForecastAccuracyCard({ projections }: { projections: ApiProjection[] }) {
  const withActual = projections.filter(
    (p) => p.actual_amount !== null && p.accuracy_percent !== null && p.weeks_out > 0
  );
  if (withActual.length === 0) return null;

  const grouped = new Map<number, number[]>();
  for (const p of withActual) {
    const g = grouped.get(p.weeks_out) ?? [];
    g.push(p.accuracy_percent!);
    grouped.set(p.weeks_out, g);
  }

  const summaries = [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weeks_out, vals]) => ({
      weeks_out,
      avg: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10,
      count: vals.length,
    }));

  return (
    <div className="forecast-accuracy-card coming-soon-card">
      <h3 className="forecast-accuracy-heading">Forecast Accuracy by Lead Time</h3>
      <p className="projection-note">
        Average accuracy for projections that have actual data, by weeks in advance.
      </p>
      <div className="forecast-accuracy-rows">
        {summaries.map(({ weeks_out, avg, count }) => (
          <div key={weeks_out} className="forecast-accuracy-row">
            <span className="forecast-accuracy-label">
              {weeks_out} week{weeks_out !== 1 ? "s" : ""} out
            </span>
            <span className={`forecast-accuracy-pct ${avg >= 90 ? "forecast-accuracy-good" : avg >= 70 ? "forecast-accuracy-ok" : "forecast-accuracy-low"}`}>
              {avg}%
            </span>
            <span className="forecast-accuracy-count">{count} projection{count !== 1 ? "s" : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────

type ModalProps = {
  editing: ApiProjection | null;
  varieties: Variety[];
  onSave: (payload: Record<string, unknown>) => Promise<string | null>;
  onClose: () => void;
};

function ProjectionModal({ editing, varieties, onSave, onClose }: ModalProps) {
  const [forecastYear, setForecastYear] = useState(
    editing ? String(editing.forecast_year) : String(currentIso.year)
  );
  const [forecastWeek, setForecastWeek] = useState(
    editing ? String(editing.forecast_week) : String(currentIso.week)
  );
  const [targetYear, setTargetYear] = useState(
    editing ? String(editing.target_year) : String(defaultNextYear)
  );
  const [targetWeek, setTargetWeek] = useState(
    editing ? String(editing.target_week) : String(defaultNextWeek)
  );
  const [level, setLevel] = useState<ProjectionLevel>(
    editing ? editing.projection_level : "variety"
  );
  const [varietyId, setVarietyId] = useState(
    editing?.variety_id ?? varieties[0]?.id ?? ""
  );
  const [color, setColor] = useState<VarietyColor>(
    (editing?.color as VarietyColor) ?? "red"
  );
  const [unit, setUnit] = useState<ProjectionUnit>(editing?.unit ?? "kg");
  const [amount, setAmount] = useState(
    editing ? String(editing.projected_amount) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live weeks-out preview
  const fY = parseInt(forecastYear, 10);
  const fW = parseInt(forecastWeek, 10);
  const tY = parseInt(targetYear, 10);
  const tW = parseInt(targetWeek, 10);
  const weeksOutPreview =
    Number.isInteger(fY) && Number.isInteger(fW) &&
    Number.isInteger(tY) && Number.isInteger(tW)
      ? computeWeeksOut(fY, fW, tY, tW)
      : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!Number.isInteger(fY) || fY < 2000 || fY > 2100) { setError("Invalid forecast year."); return; }
    if (!Number.isInteger(fW) || fW < 1 || fW > 53)      { setError("Forecast week must be 1–53."); return; }
    if (!Number.isInteger(tY) || tY < 2000 || tY > 2100) { setError("Invalid target year."); return; }
    if (!Number.isInteger(tW) || tW < 1 || tW > 53)      { setError("Target week must be 1–53."); return; }
    if (level === "variety" && !varietyId) { setError("Select a variety."); return; }

    const parsed = Number(amount.trim());
    if (!Number.isFinite(parsed) || parsed < 0) { setError("Projected amount must be a number ≥ 0."); return; }

    const payload: Record<string, unknown> = {
      target_year: tY,
      target_week: tW,
      forecast_year: fY,
      forecast_week: fW,
      projection_level: level,
      unit,
      projected_amount: parsed,
    };
    if (editing) payload.id = editing.id;
    if (level === "variety") payload.variety_id = varietyId;
    else payload.color = color;

    setSaving(true);
    setError(null);
    const err = await onSave(payload);
    setSaving(false);
    if (err) setError(err);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="variety-modal projection-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="projection-modal-title">
          {editing ? "Edit Projection" : "Add Projection"}
        </h2>

        <form onSubmit={handleSubmit}>
          {/* ── Forecast coordinates ── */}
          <fieldset className="projection-modal-fieldset">
            <legend>Forecast week (when projecting from)</legend>
            <div className="projection-modal-row">
              <label className="projection-control-label">
                Year
                <input
                  type="number"
                  className="projection-control-input"
                  value={forecastYear}
                  min={2000}
                  max={2100}
                  onChange={(e) => setForecastYear(e.target.value)}
                />
              </label>
              <label className="projection-control-label">
                Week
                <input
                  type="number"
                  className="projection-control-input"
                  value={forecastWeek}
                  min={1}
                  max={53}
                  onChange={(e) => setForecastWeek(e.target.value)}
                />
              </label>
            </div>
          </fieldset>

          {/* ── Target coordinates ── */}
          <fieldset className="projection-modal-fieldset">
            <legend>Target week (harvest week being projected)</legend>
            <div className="projection-modal-row">
              <label className="projection-control-label">
                Year
                <input
                  type="number"
                  className="projection-control-input"
                  value={targetYear}
                  min={2000}
                  max={2100}
                  onChange={(e) => setTargetYear(e.target.value)}
                />
              </label>
              <label className="projection-control-label">
                Week
                <input
                  type="number"
                  className="projection-control-input"
                  value={targetWeek}
                  min={1}
                  max={53}
                  onChange={(e) => setTargetWeek(e.target.value)}
                />
              </label>
            </div>
            {weeksOutPreview !== null ? (
              <p className="projection-modal-lead-preview">
                {weeksOutPreview === 0
                  ? "Same week as forecast"
                  : weeksOutPreview > 0
                    ? `${weeksOutPreview} week${weeksOutPreview !== 1 ? "s" : ""} ahead`
                    : `${Math.abs(weeksOutPreview)} week${Math.abs(weeksOutPreview) !== 1 ? "s" : ""} in the past`}
              </p>
            ) : null}
          </fieldset>

          {/* ── Series ── */}
          <div className="projection-modal-row">
            <label className="projection-control-label">
              Level
              <select
                className="projection-control-input"
                value={level}
                onChange={(e) => setLevel(e.target.value as ProjectionLevel)}
              >
                <option value="variety">Variety</option>
                <option value="color">Color</option>
              </select>
            </label>

            {level === "variety" ? (
              <label className="projection-control-label">
                Variety
                <select
                  className="projection-control-input"
                  value={varietyId}
                  onChange={(e) => setVarietyId(e.target.value)}
                >
                  {varieties.length === 0 ? (
                    <option value="">No active varieties</option>
                  ) : (
                    varieties.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))
                  )}
                </select>
              </label>
            ) : (
              <label className="projection-control-label">
                Color
                <select
                  className="projection-control-input"
                  value={color}
                  onChange={(e) => setColor(e.target.value as VarietyColor)}
                >
                  {COLORS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="projection-control-label">
              Unit
              <select
                className="projection-control-input"
                value={unit}
                onChange={(e) => setUnit(e.target.value as ProjectionUnit)}
              >
                <option value="kg">kg</option>
                <option value="cases">cases</option>
              </select>
            </label>
          </div>

          {/* ── Amount ── */}
          <label className="projection-control-label" style={{ marginTop: "0.5rem" }}>
            Projected amount ({unit})
            <input
              type="number"
              className="projection-control-input"
              value={amount}
              min={0}
              step="any"
              placeholder="e.g. 10000"
              onChange={(e) => setAmount(e.target.value)}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </label>

          {error ? <p className="form-error" style={{ marginTop: "0.5rem" }}>{error}</p> : null}

          {level === "variety" && unit === "cases" ? (
            <p className="projection-note" style={{ marginTop: "0.4rem" }}>
              Variety case actuals come from Kg Entries (total cases via case weight).
            </p>
          ) : null}

          <div className="form-actions" style={{ marginTop: "1rem" }}>
            <button type="button" className="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProjectedTab() {
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Primary data filter — determines the API call
  const [targetYear, setTargetYear] = useState(String(currentIso.year));

  // All projections for the target year (unfiltered)
  const [allProjections, setAllProjections] = useState<ApiProjection[]>([]);
  const [projLoading, setProjLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  // Client-side list filters (narrow allProjections for display)
  const [filterForecastKey, setFilterForecastKey] = useState("");  // "year:week" or ""
  const [filterLevel, setFilterLevel] = useState("");
  const [filterVarietyId, setFilterVarietyId] = useState("");
  const [filterColor, setFilterColor] = useState("");
  const [filterUnit, setFilterUnit] = useState("");

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProjection, setEditingProjection] = useState<ApiProjection | null>(null);

  // In-flight delete tracking (to disable delete button while pending)
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Load variety options once ──────────────────────────────────────────────

  useEffect(() => {
    apiFetch(OPTIONS_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load varieties (${res.status})`);
        const data = (await res.json()) as { varieties: Variety[] };
        setVarieties(data.varieties ?? []);
      })
      .catch((e: unknown) =>
        setOptionsError(e instanceof Error ? e.message : "Failed to load varieties")
      )
      .finally(() => setOptionsLoading(false));
  }, []);

  // ── Load projections whenever target year changes ──────────────────────────

  const loadProjections = useCallback(async () => {
    const yearInt = parseInt(targetYear, 10);
    if (!Number.isInteger(yearInt) || yearInt < 2000 || yearInt > 2100) return;

    setProjLoading(true);
    setPageError(null);

    try {
      const res = await apiFetch(`${PROJECTION_URL}?year=${targetYear}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load projections (${res.status})`);
      }
      setAllProjections((await res.json()) as ApiProjection[]);
    } catch (e: unknown) {
      setPageError(e instanceof Error ? e.message : "Failed to load projections");
    } finally {
      setProjLoading(false);
    }
  }, [targetYear]);

  useEffect(() => { void loadProjections(); }, [loadProjections]);

  // ── Filter options derived from loaded data ────────────────────────────────

  const forecastKeyOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: { key: string; label: string }[] = [];
    for (const p of allProjections) {
      const k = `${p.forecast_year}:${p.forecast_week}`;
      if (!seen.has(k)) {
        seen.add(k);
        result.push({ key: k, label: `Y${p.forecast_year} W${p.forecast_week}` });
      }
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }, [allProjections]);

  const varietyOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: { id: string; name: string }[] = [];
    for (const p of allProjections) {
      if (p.variety_id && p.variety_name && !seen.has(p.variety_id)) {
        seen.add(p.variety_id);
        result.push({ id: p.variety_id, name: p.variety_name });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, [allProjections]);

  const colorOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of allProjections) {
      if (p.color && !seen.has(p.color)) { seen.add(p.color); result.push(p.color); }
    }
    return result.sort();
  }, [allProjections]);

  // ── Filtered + grouped projections for display ─────────────────────────────

  const filtered = useMemo(() => {
    return allProjections.filter((p) => {
      if (filterForecastKey && `${p.forecast_year}:${p.forecast_week}` !== filterForecastKey) return false;
      if (filterLevel && p.projection_level !== filterLevel) return false;
      if (filterVarietyId && p.variety_id !== filterVarietyId) return false;
      if (filterColor && p.color !== filterColor) return false;
      if (filterUnit && p.unit !== filterUnit) return false;
      return true;
    });
  }, [allProjections, filterForecastKey, filterLevel, filterVarietyId, filterColor, filterUnit]);

  const groupedByTargetWeek = useMemo(() => {
    const byWeek = new Map<number, ApiProjection[]>();
    for (const p of filtered) {
      const g = byWeek.get(p.target_week) ?? [];
      g.push(p);
      byWeek.set(p.target_week, g);
    }
    return [...byWeek.keys()]
      .sort((a, b) => a - b)
      .map((week) => ({
        week,
        items: (byWeek.get(week) ?? []).sort((a, b) => {
          // Most recent forecast week first
          if (b.forecast_week !== a.forecast_week) return b.forecast_week - a.forecast_week;
          const aLbl = a.projection_level === "variety" ? (a.variety_name ?? "") : (a.color ?? "");
          const bLbl = b.projection_level === "variety" ? (b.variety_name ?? "") : (b.color ?? "");
          return aLbl.localeCompare(bLbl) || a.unit.localeCompare(b.unit);
        }),
      }));
  }, [filtered]);

  // ── Modal handlers ─────────────────────────────────────────────────────────

  function openAdd() {
    setEditingProjection(null);
    setModalOpen(true);
  }
  function openEdit(p: ApiProjection) {
    setEditingProjection(p);
    setModalOpen(true);
  }
  function closeModal() {
    setModalOpen(false);
    setEditingProjection(null);
  }

  async function handleModalSave(payload: Record<string, unknown>): Promise<string | null> {
    try {
      const saveRes = await apiFetch(`${PROJECTION_URL}/bulk`, {
        method: "POST",
        body: JSON.stringify({ projections: [payload] }),
      });
      if (!saveRes.ok) {
        const body = (await saveRes.json().catch(() => null)) as { message?: string } | null;
        const msg = body?.message ?? "Failed to save projection";
        if (msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) {
          return "A projection for this exact combination already exists. Use the Edit button to update it.";
        }
        return msg;
      }
      await loadProjections();
      closeModal();
      return null;
    } catch (e: unknown) {
      return e instanceof Error ? e.message : "Failed to save projection";
    }
  }

  async function handleDelete(p: ApiProjection) {
    if (!window.confirm(`Delete this projection?\n\nTarget W${p.target_week} · Forecast W${p.forecast_week} · ${seriesLabel(p)} · ${fmtNumber(p.projected_amount)}`)) return;
    setDeletingId(p.id);
    try {
      const res = await apiFetch(`${PROJECTION_URL}/${p.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        setPageError("Failed to delete projection.");
      } else {
        setAllProjections((prev) => prev.filter((x) => x.id !== p.id));
      }
    } catch {
      setPageError("Failed to delete projection.");
    } finally {
      setDeletingId(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (optionsLoading) return <p>Loading...</p>;
  if (optionsError) return <p className="form-error">{optionsError}</p>;

  return (
    <div>
      {/* ── Top controls: year + filters + Add button ── */}
      <div className="projection-controls">
        <div className="projection-controls-row">
          <label className="projection-control-label">
            Target year
            <input
              type="number"
              className="projection-control-input"
              value={targetYear}
              min={2000}
              max={2100}
              onChange={(e) => setTargetYear(e.target.value)}
            />
          </label>

          {forecastKeyOptions.length > 0 ? (
            <label className="projection-control-label">
              Forecast week
              <select
                className="projection-control-input"
                value={filterForecastKey}
                onChange={(e) => setFilterForecastKey(e.target.value)}
              >
                <option value="">All</option>
                {forecastKeyOptions.map(({ key, label }) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </label>
          ) : null}

          {(varietyOptions.length > 0 || colorOptions.length > 0) ? (
            <label className="projection-control-label">
              Level
              <select
                className="projection-control-input"
                value={filterLevel}
                onChange={(e) => { setFilterLevel(e.target.value); setFilterVarietyId(""); setFilterColor(""); }}
              >
                <option value="">All</option>
                <option value="variety">Variety</option>
                <option value="color">Color</option>
              </select>
            </label>
          ) : null}

          {filterLevel !== "color" && varietyOptions.length > 0 ? (
            <label className="projection-control-label">
              Variety
              <select
                className="projection-control-input"
                value={filterVarietyId}
                onChange={(e) => setFilterVarietyId(e.target.value)}
              >
                <option value="">All</option>
                {varietyOptions.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </label>
          ) : null}

          {filterLevel !== "variety" && colorOptions.length > 0 ? (
            <label className="projection-control-label">
              Color
              <select
                className="projection-control-input"
                value={filterColor}
                onChange={(e) => setFilterColor(e.target.value)}
              >
                <option value="">All</option>
                {colorOptions.map((c) => (
                  <option key={c} value={c}>{capitalize(c)}</option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="projection-control-label">
            Unit
            <select
              className="projection-control-input"
              value={filterUnit}
              onChange={(e) => setFilterUnit(e.target.value)}
            >
              <option value="">All</option>
              <option value="kg">kg</option>
              <option value="cases">cases</option>
            </select>
          </label>

          <button
            type="button"
            className="projection-add-btn"
            onClick={openAdd}
          >
            + Add projection
          </button>
        </div>
      </div>

      {pageError ? <p className="form-error">{pageError}</p> : null}

      {/* ── Projection log ── */}
      {projLoading ? (
        <p>Loading projections…</p>
      ) : groupedByTargetWeek.length === 0 ? (
        <div className="projection-log-empty">
          <p>No projections saved for {targetYear} yet.</p>
          <button type="button" onClick={openAdd}>+ Add projection</button>
        </div>
      ) : (
        <div className="projection-log">
          {groupedByTargetWeek.map(({ week, items }) => (
            <div key={week} className="projection-log-group">
              <div className="projection-log-group-header">Week {week}</div>
              {items.map((p) => (
                <div key={p.id} className="projection-log-item">
                  <div className="projection-log-meta">
                    <span className="projection-log-forecast-tag">
                      Forecast W{p.forecast_week} · {weeksOutLabel(p.weeks_out)}
                    </span>
                    <span className="projection-log-series">{seriesLabel(p)}</span>
                  </div>
                  <div className="projection-log-stats">
                    <span className="projection-log-stat">
                      <span className="projection-history-key">Projected</span>
                      <strong>{fmtNumber(p.projected_amount)}</strong>
                    </span>
                    <span className="projection-log-stat">
                      <span className="projection-history-key">Actual</span>
                      <span>
                        {p.actual_amount !== null ? fmtNumber(p.actual_amount) : <em>pending</em>}
                      </span>
                    </span>
                    {p.actual_amount !== null ? (
                      <>
                        <span className="projection-log-stat">
                          <span className="projection-history-key">Accuracy</span>
                          {/* accuracy_percent null when projected=0 — no divide-by-zero */}
                          <span>{p.accuracy_percent !== null ? `${p.accuracy_percent}%` : "—"}</span>
                        </span>
                        <span className="projection-log-stat">
                          <span className="projection-history-key">Diff</span>
                          <span className={diffClass(p.difference)}>
                            {p.difference !== null ? fmtDiff(p.difference) : "—"}
                          </span>
                        </span>
                      </>
                    ) : null}
                  </div>
                  <div className="projection-log-actions">
                    <button
                      type="button"
                      className="secondary projection-log-edit-btn"
                      onClick={() => openEdit(p)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="sample-delete-btn"
                      onClick={() => handleDelete(p)}
                      disabled={deletingId === p.id}
                      aria-label="Delete projection"
                    >
                      {deletingId === p.id ? "…" : "✕"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ── Forecast Accuracy by Lead Time ── */}
      {!projLoading ? <ForecastAccuracyCard projections={allProjections} /> : null}

      {/* ── Add / Edit modal ── */}
      {modalOpen ? (
        <ProjectionModal
          key={editingProjection?.id ?? "new"}
          editing={editingProjection}
          varieties={varieties}
          onSave={handleModalSave}
          onClose={closeModal}
        />
      ) : null}
    </div>
  );
}
