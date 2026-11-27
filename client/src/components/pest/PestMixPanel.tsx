// Mobile Pest Log — mixes as they were actually made.
//
// The plan's tank count is a baseline, never a limit: "Start Mix #n" is
// always available while the job is open, and mixes beyond the plan are
// marked "Extra". Each mix records the water and chemical actually put in the
// tank (prefilled from the plan) and any leftover; corrections keep their
// history. Per-row figures are averages from each tank's use and the rows it
// covered, never a measurement of a single row.
import { useState } from "react";
import type { MixChemicalLine, MixSummary, Comparison } from "../../lib/pestMixSummary";

export type JobMix = {
  id: string;
  client_key: string;
  mix_number: number;
  status: "active" | "completed";
  is_extra: boolean;
  planned_water_l: number | null;
  planned_chemicals: MixChemicalLine[];
  water_l: number;
  chemicals: MixChemicalLine[];
  leftover_l: number;
  started_at: string;
  ended_at: string | null;
  revision: number;
  /** Saved on this device but not yet on the server (offline). */
  pending?: boolean;
};

export type MixRevision = {
  mix_id: string;
  revision: number;
  action: "created" | "corrected" | "leftover" | "closed" | "imported";
  before: Partial<JobMix> | null;
  after: Partial<JobMix>;
  reason: string | null;
  changed_at: string;
};

export type MixPlanDefaults = { water_l: number; chemical_amount: number };

export type MixFormValues = { water_l: number; chemical_amount: number; leftover_l: number; reason: string };

const fmt = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });

function diffText(c: Comparison, unit: string): string {
  if (c.diff == null) return "—";
  const sign = c.diff > 0 ? "+" : c.diff < 0 ? "−" : "±";
  const pct = c.pct == null ? "" : ` (${sign}${fmt(Math.abs(c.pct), 1)}%)`;
  const word = c.diff > 0 ? "over" : c.diff < 0 ? "under" : "on plan";
  return `${sign}${fmt(Math.abs(c.diff))} ${unit}${pct} ${word}`;
}

// ── Progress card ────────────────────────────────────────────────────────────

export function MixProgressCard({ summary, totalRows }: { summary: MixSummary; totalRows: number }) {
  const chem = summary.chemicals;
  return (
    <div className="pest-mix-progress" data-testid="mix-progress">
      <div className="pest-mix-progress-grid">
        <div>
          <span className="pest-mix-progress-label">Rows done</span>
          <span className="pest-mix-progress-value">{summary.completed_rows}/{totalRows}</span>
        </div>
        <div>
          <span className="pest-mix-progress-label">Mixes made</span>
          <span className="pest-mix-progress-value">
            {summary.mixes_made}
            {summary.planned_mixes != null ? <small> of {summary.planned_mixes} planned</small> : null}
          </span>
          {summary.extra_mixes > 0 ? <span className="pest-mix-extra-tag">+{summary.extra_mixes} extra</span> : null}
        </div>
      </div>
      <table className="pest-mix-progress-table">
        <thead>
          <tr><th /><th>Mixed</th><th>Applied</th><th>Avg / row</th></tr>
        </thead>
        <tbody>
          <tr>
            <th>Water</th>
            <td>{fmt(summary.water.mixed)} L</td>
            <td>{fmt(summary.water.applied)} L</td>
            <td>{summary.water.per_row == null ? "—" : `~${fmt(summary.water.per_row)} L`}</td>
          </tr>
          {chem.map((c) => (
            <tr key={c.chemical_id}>
              <th>{c.name || "Chemical"}</th>
              <td>{fmt(c.mixed)} {c.unit}</td>
              <td>{fmt(c.applied)} {c.unit}</td>
              <td>{c.per_row == null ? "—" : `~${fmt(c.per_row)} ${c.unit}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pest-mix-progress-note">
        Applied = mixed − leftovers.{" "}
        {summary.applied_pending ? `Mix #${summary.active_mix_number} is still in the tank, so it counts once it's closed. ` : ""}
        Avg / row is the tanks' applied use ÷ the rows they covered
        {summary.per_row_basis_rows > 0 ? ` (${fmt(summary.per_row_basis_rows)} rows)` : ""} — an average, not a measured row.
        {summary.rows_without_mix > 0 ? ` ${summary.rows_without_mix} row${summary.rows_without_mix === 1 ? " has" : "s have"} no tank linked.` : ""}
      </p>
    </div>
  );
}

// ── Planned vs actual ────────────────────────────────────────────────────────

export function PlannedVsActual({ summary }: { summary: MixSummary }) {
  const lines = [
    { key: "water", name: "Water", unit: "L", planned: summary.water.planned, mixed: summary.water.mixed, applied: summary.water.applied, vs: summary.water.applied_vs_plan, mixedVs: summary.water.mixed_vs_plan },
    ...summary.chemicals.map((c) => ({ key: c.chemical_id, name: c.name || "Chemical", unit: c.unit, planned: c.planned, mixed: c.mixed, applied: c.applied, vs: c.applied_vs_plan, mixedVs: c.mixed_vs_plan }))
  ];
  return (
    <div className="pest-plan-vs-actual" data-testid="planned-vs-actual">
      <h3>Planned vs actual</h3>
      <p className="pest-mix-progress-note" style={{ marginTop: 0 }}>
        {summary.mixes_made} mix{summary.mixes_made === 1 ? "" : "es"} made
        {summary.planned_mixes != null ? ` · ${summary.planned_mixes} planned` : ""}
        {summary.extra_mixes > 0 ? ` · ${summary.extra_mixes} extra` : ""}
        {summary.water.leftover > 0 ? ` · ${fmt(summary.water.leftover)} L left over` : ""}
      </p>
      {lines.map((l) => (
        <div key={l.key} className="pest-plan-vs-actual-line">
          <p className="pest-plan-vs-actual-name">{l.name}</p>
          <dl>
            <div><dt>Planned</dt><dd>{l.planned == null ? "—" : `${fmt(l.planned)} ${l.unit}`}</dd></div>
            <div><dt>Mixed</dt><dd>{fmt(l.mixed)} {l.unit}</dd></div>
            <div><dt>Applied</dt><dd>{fmt(l.applied)} {l.unit}</dd></div>
          </dl>
          <p className={`pest-plan-vs-actual-diff${l.vs.diff != null && Math.abs(l.vs.diff) > 1e-9 ? (l.vs.diff > 0 ? " is-over" : " is-under") : ""}`}>
            Applied vs plan: {diffText(l.vs, l.unit)}
          </p>
          <p className="pest-plan-vs-actual-sub">Mixed vs plan: {diffText(l.mixedVs, l.unit)}</p>
        </div>
      ))}
    </div>
  );
}

// ── Mix form (start or correct) ──────────────────────────────────────────────

export function MixForm({
  title,
  hint,
  chemicalName,
  chemicalUnit,
  initial,
  maxLeftover,
  leftoverLabel,
  requireReason,
  busy,
  submitLabel,
  onSubmit,
  onCancel
}: {
  title: string;
  hint?: string;
  chemicalName: string;
  chemicalUnit: string;
  initial: MixFormValues;
  /** Leftover input shown when set; bounded by this tank volume. */
  maxLeftover?: number | null;
  leftoverLabel?: string;
  requireReason?: boolean;
  busy?: boolean;
  submitLabel: string;
  onSubmit: (v: MixFormValues) => void;
  onCancel: () => void;
}) {
  const [water, setWater] = useState(String(initial.water_l));
  const [amount, setAmount] = useState(String(initial.chemical_amount));
  const [leftover, setLeftover] = useState(String(initial.leftover_l));
  const [reason, setReason] = useState(initial.reason);
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    const w = Number(water);
    const a = Number(amount);
    const l = leftover.trim() === "" ? 0 : Number(leftover);
    if (!water.trim() || !Number.isFinite(w) || w < 0) return setErr("Enter the water put in the tank (0 L or more).");
    if (!amount.trim() || !Number.isFinite(a) || a < 0) return setErr(`Enter the ${chemicalName || "chemical"} added (0 ${chemicalUnit} or more).`);
    if (maxLeftover != null && (!Number.isFinite(l) || l < 0 || l > maxLeftover)) return setErr(`Leftover must be between 0 and ${fmt(maxLeftover)} L.`);
    if (requireReason && !reason.trim()) return setErr("Say why this entry is being corrected.");
    setErr(null);
    onSubmit({ water_l: w, chemical_amount: a, leftover_l: l, reason: reason.trim() });
  }

  return (
    <div className="pest-section-form pest-mix-form" data-testid="mix-form">
      <p style={{ margin: "0 0 0.3rem", fontWeight: 600 }}>{title}</p>
      {hint ? <p className="pest-mix-progress-note" style={{ margin: "0 0 0.55rem" }}>{hint}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
        <label>
          Water (L)
          <input type="number" inputMode="decimal" min={0} step="any" value={water} onChange={(e) => setWater(e.target.value)} />
        </label>
        <label>
          {chemicalName || "Chemical"} ({chemicalUnit})
          <input type="number" inputMode="decimal" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {maxLeftover !== undefined ? (
          <label style={{ gridColumn: "1 / -1" }}>
            {leftoverLabel ?? "Leftover (L)"}
            <input type="number" inputMode="decimal" min={0} step="any" value={leftover} onChange={(e) => setLeftover(e.target.value)} />
          </label>
        ) : null}
        {requireReason ? (
          <label style={{ gridColumn: "1 / -1" }}>
            Reason for correction
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. tank gauge read 560 L" />
          </label>
        ) : null}
      </div>
      {err ? <p className="form-error" style={{ margin: "0.5rem 0 0" }}>{err}</p> : null}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.65rem" }}>
        <button type="button" disabled={busy} style={{ flex: 1 }} onClick={submit}>{submitLabel}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Leftover (closing the last tank) ─────────────────────────────────────────

export function LeftoverForm({
  title,
  hint,
  maxLeftover,
  busy,
  submitLabel,
  onSubmit,
  onCancel
}: {
  title: string;
  hint: string;
  maxLeftover: number;
  busy?: boolean;
  submitLabel: string;
  onSubmit: (leftoverL: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("0");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="pest-section-form pest-mix-form" data-testid="leftover-form">
      <p style={{ margin: "0 0 0.3rem", fontWeight: 600 }}>{title}</p>
      <p className="pest-mix-progress-note" style={{ margin: "0 0 0.55rem" }}>{hint}</p>
      <label>
        Leftover (L)
        <input type="number" inputMode="decimal" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      {err ? <p className="form-error" style={{ margin: "0.5rem 0 0" }}>{err}</p> : null}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.65rem" }}>
        <button
          type="button"
          disabled={busy}
          style={{ flex: 1 }}
          onClick={() => {
            const l = value.trim() === "" ? 0 : Number(value);
            if (!Number.isFinite(l) || l < 0 || l > maxLeftover) return setErr(`Leftover must be between 0 and ${fmt(maxLeftover)} L.`);
            setErr(null);
            onSubmit(l);
          }}
        >
          {submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Previous mix card ────────────────────────────────────────────────────────

const ACTION_LABEL: Record<MixRevision["action"], string> = {
  created: "Recorded",
  corrected: "Corrected",
  leftover: "Leftover recorded",
  closed: "Closed",
  imported: "Carried over (planned amounts)"
};

export function MixHistory({ revisions, unit }: { revisions: MixRevision[]; unit: string }) {
  return (
    <ol className="pest-mix-history">
      {revisions.map((r) => {
        const b = r.before;
        const a = r.after;
        const changes: string[] = [];
        if (b && b.water_l !== a.water_l) changes.push(`water ${fmt(b.water_l)} → ${fmt(a.water_l)} L`);
        const ba = b?.chemicals?.[0]?.amount;
        const aa = a.chemicals?.[0]?.amount;
        if (b && ba !== aa) changes.push(`chemical ${fmt(ba)} → ${fmt(aa)} ${unit}`);
        if (b && b.leftover_l !== a.leftover_l) changes.push(`leftover ${fmt(b.leftover_l)} → ${fmt(a.leftover_l)} L`);
        if (!b) changes.push(`${fmt(a.water_l)} L · ${fmt(aa)} ${unit}`);
        return (
          <li key={`${r.mix_id}-${r.revision}`}>
            <strong>{ACTION_LABEL[r.action]}</strong> {new Date(r.changed_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            {changes.length ? ` — ${changes.join(", ")}` : ""}
            {r.reason ? <em> “{r.reason}”</em> : null}
          </li>
        );
      })}
    </ol>
  );
}
