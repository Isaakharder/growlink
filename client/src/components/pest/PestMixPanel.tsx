// Mobile Pest Log — mixes as they were actually made.
//
// The plan's tank count is a baseline, never a limit: "Start Mix #n" is
// always available while the job is open, and mixes beyond the plan are
// marked "Extra". Each mix records the water and chemical actually put in the
// tank (prefilled from the plan) and its leftover; corrections keep their
// history.
//
// Nothing unknown is shown as exact:
//   - a leftover that wasn't recorded is "not recorded", never 0, and while
//     any tank's leftover is unknown the applied total shows as "at most …"
//   - per-row figures are averages from each tank's use and the rows it
//     covered; a row split across two tanks counts ½ to each (estimated)
//   - mixes carried over from before tank tracking show the plan's amounts
//     as a "Planned estimate" until an operator confirms them
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
  /** null = not recorded. */
  leftover_l: number | null;
  amount_source?: "recorded" | "planned_estimate";
  started_at: string;
  ended_at: string | null;
  revision: number;
  /** Saved on this device but not yet on the server (offline). */
  pending?: boolean;
};

export type MixRevision = {
  mix_id: string;
  revision: number;
  action: "created" | "corrected" | "confirmed" | "leftover" | "closed" | "imported";
  before: Partial<JobMix> | null;
  after: Partial<JobMix>;
  reason: string | null;
  changed_at: string;
};

export type MixFormValues = { water_l: number; chemical_amount: number; leftover_l: number | null; reason: string };

const fmt = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });

const tankList = (nums: number[]) => nums.map((x) => `#${x}`).join(", ");

function diffText(c: Comparison, unit: string): string {
  if (c.diff == null) return "—";
  const sign = c.diff > 0 ? "+" : c.diff < 0 ? "−" : "±";
  const pct = c.pct == null ? "" : ` (${sign}${fmt(Math.abs(c.pct), 1)}%)`;
  const word = c.diff > 0 ? "over" : c.diff < 0 ? "under" : "on plan";
  return `${sign}${fmt(Math.abs(c.diff))} ${unit}${pct} ${word}`;
}

/** Why the applied total isn't known (or "" when it is). */
function appliedUnknownReason(s: MixSummary): string {
  const reasons: string[] = [];
  if (s.applied_pending && s.active_mix_number != null) reasons.push(`Mix #${s.active_mix_number} is still in the tank`);
  if (s.unknown_leftover_mixes.length) reasons.push(`leftover not recorded for Mix ${tankList(s.unknown_leftover_mixes)}`);
  return reasons.join("; ");
}

// ── Progress card ────────────────────────────────────────────────────────────

export function MixProgressCard({ summary, totalRows }: { summary: MixSummary; totalRows: number }) {
  const lines = [
    { key: "water", name: "Water", unit: "L", t: summary.water },
    ...summary.chemicals.map((c) => ({ key: c.chemical_id, name: c.name || "Chemical", unit: c.unit, t: c }))
  ];
  const unknown = appliedUnknownReason(summary);
  const est = summary.per_row_estimated ? " (est.)" : "";
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
          {lines.map((l) => (
            <tr key={l.key}>
              <th>{l.name}</th>
              <td>{fmt(l.t.mixed)} {l.unit}</td>
              <td>{l.t.applied != null ? `${fmt(l.t.applied)} ${l.unit}` : <span title="Not known yet">≤ {fmt(l.t.applied_max)} {l.unit}*</span>}</td>
              <td>{l.t.per_row == null ? "—" : `~${fmt(l.t.per_row)} ${l.unit}${est}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pest-mix-progress-note">
        Applied = mixed − leftovers.
        {unknown ? ` *Not known yet: ${unknown}, so applied shows the most it can be.` : ""}
        {" "}Avg / row is the tanks' applied use ÷ the rows they covered
        {summary.per_row_basis_rows > 0 ? ` (${fmt(summary.per_row_basis_rows)} rows)` : ""} — an average, not a measured row.
        {summary.split_rows > 0 ? ` ${summary.split_rows} row${summary.split_rows === 1 ? " was" : "s were"} sprayed by two tanks and counted ½ to each (estimated).` : ""}
        {summary.estimated_mixes.length ? ` Mix ${tankList(summary.estimated_mixes)}: planned estimates, not confirmed.` : ""}
        {summary.rows_without_mix > 0 ? ` ${summary.rows_without_mix} row${summary.rows_without_mix === 1 ? " has" : "s have"} no tank linked.` : ""}
      </p>
    </div>
  );
}

// ── Planned vs actual ────────────────────────────────────────────────────────

export function PlannedVsActual({ summary }: { summary: MixSummary }) {
  const lines = [
    { key: "water", name: "Water", unit: "L", t: summary.water },
    ...summary.chemicals.map((c) => ({ key: c.chemical_id, name: c.name || "Chemical", unit: c.unit, t: c }))
  ];
  const unknown = appliedUnknownReason(summary);
  return (
    <div className="pest-plan-vs-actual" data-testid="planned-vs-actual">
      <h3>Planned vs actual</h3>
      <p className="pest-mix-progress-note" style={{ marginTop: 0 }}>
        {summary.mixes_made} mix{summary.mixes_made === 1 ? "" : "es"} made
        {summary.planned_mixes != null ? ` · ${summary.planned_mixes} planned` : ""}
        {summary.extra_mixes > 0 ? ` · ${summary.extra_mixes} extra` : ""}
        {summary.water.leftover > 0 ? ` · ${fmt(summary.water.leftover)} L left over${summary.unknown_leftover_mixes.length ? " (recorded)" : ""}` : ""}
      </p>
      {lines.map((l) => (
        <div key={l.key} className="pest-plan-vs-actual-line">
          <p className="pest-plan-vs-actual-name">{l.name}</p>
          <dl>
            <div><dt>Planned</dt><dd>{l.t.planned == null ? "—" : `${fmt(l.t.planned)} ${l.unit}`}</dd></div>
            <div><dt>Mixed</dt><dd>{fmt(l.t.mixed)} {l.unit}</dd></div>
            <div><dt>Applied</dt><dd>{l.t.applied != null ? `${fmt(l.t.applied)} ${l.unit}` : "Not known"}</dd></div>
          </dl>
          {l.t.applied != null ? (
            <p className={`pest-plan-vs-actual-diff${l.t.applied_vs_plan.diff != null && Math.abs(l.t.applied_vs_plan.diff) > 1e-9 ? (l.t.applied_vs_plan.diff > 0 ? " is-over" : " is-under") : ""}`}>
              Applied vs plan: {diffText(l.t.applied_vs_plan, l.unit)}
            </p>
          ) : (
            <p className="pest-plan-vs-actual-diff is-unknown">
              Applied vs plan: not known — {unknown}. At most {fmt(l.t.applied_max)} {l.unit}.
            </p>
          )}
          <p className="pest-plan-vs-actual-sub">Mixed vs plan: {diffText(l.t.mixed_vs_plan, l.unit)}</p>
        </div>
      ))}
      {summary.estimated_mixes.length || summary.split_rows > 0 ? (
        <p className="pest-mix-progress-note" data-testid="planned-vs-actual-estimates">
          {summary.estimated_mixes.length ? `Includes Mix ${tankList(summary.estimated_mixes)} at the plan's amounts (carried over, not confirmed). ` : ""}
          {summary.split_rows > 0 ? `${summary.split_rows} row${summary.split_rows === 1 ? "" : "s"} split ½/½ between two tanks for per-row averages (estimated).` : ""}
        </p>
      ) : null}
    </div>
  );
}

// ── Leftover input (number, or explicitly not known) ─────────────────────────

function LeftoverInput({
  label,
  value,
  unknown,
  onValue,
  onUnknown
}: {
  label: string;
  value: string;
  unknown: boolean;
  onValue: (v: string) => void;
  onUnknown: (v: boolean) => void;
}) {
  return (
    <div className="pest-leftover-input" style={{ gridColumn: "1 / -1" }}>
      <label>
        {label}
        <input type="number" inputMode="decimal" min={0} step="any" value={unknown ? "" : value} disabled={unknown} placeholder={unknown ? "Not known" : "0 if the tank is empty"} onChange={(e) => onValue(e.target.value)} />
      </label>
      <label className="pest-leftover-unknown">
        <input type="checkbox" checked={unknown} onChange={(e) => onUnknown(e.target.checked)} /> Not known
      </label>
    </div>
  );
}

function parseLeftover(value: string, unknown: boolean, max: number | null): { ok: true; value: number | null } | { ok: false; error: string } {
  if (unknown) return { ok: true, value: null };
  if (!value.trim()) return { ok: false, error: "Enter the leftover (0 if the tank is empty), or tick Not known." };
  const l = Number(value);
  if (!Number.isFinite(l) || l < 0 || (max != null && l > max)) {
    return { ok: false, error: `Leftover must be between 0 and ${fmt(max)} L.` };
  }
  return { ok: true, value: l };
}

// ── Mix form (start, correct or confirm) ─────────────────────────────────────

export function MixForm({
  title,
  hint,
  chemicalName,
  chemicalUnit,
  initial,
  maxLeftover,
  leftoverLabel,
  leftoverInitiallyUnknown,
  requireReason,
  reasonOptional,
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
  /** Leftover input shown when set (a tank volume bounds it; null = bounded by the water entered). */
  maxLeftover?: number | null;
  leftoverLabel?: string;
  /** Start with "Not known" ticked (the mix's leftover was never recorded). */
  leftoverInitiallyUnknown?: boolean;
  requireReason?: boolean;
  reasonOptional?: boolean;
  busy?: boolean;
  submitLabel: string;
  onSubmit: (v: MixFormValues) => void;
  onCancel: () => void;
}) {
  const [water, setWater] = useState(String(initial.water_l));
  const [amount, setAmount] = useState(String(initial.chemical_amount));
  const [leftover, setLeftover] = useState(initial.leftover_l == null ? "" : String(initial.leftover_l));
  const [leftoverUnknown, setLeftoverUnknown] = useState(Boolean(leftoverInitiallyUnknown));
  const [reason, setReason] = useState(initial.reason);
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    const w = Number(water);
    const a = Number(amount);
    if (!water.trim() || !Number.isFinite(w) || w < 0) return setErr("Enter the water put in the tank (0 L or more).");
    if (!amount.trim() || !Number.isFinite(a) || a < 0) return setErr(`Enter the ${chemicalName || "chemical"} added (0 ${chemicalUnit} or more).`);
    let l: number | null = initial.leftover_l;
    if (maxLeftover !== undefined) {
      const parsed = parseLeftover(leftover, leftoverUnknown, maxLeftover ?? w);
      if (!parsed.ok) return setErr(parsed.error);
      l = parsed.value;
    }
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
          <LeftoverInput
            label={leftoverLabel ?? "Leftover (L)"}
            value={leftover}
            unknown={leftoverUnknown}
            onValue={setLeftover}
            onUnknown={setLeftoverUnknown}
          />
        ) : null}
        {requireReason || reasonOptional ? (
          <label style={{ gridColumn: "1 / -1" }}>
            {requireReason ? "Reason for correction" : "Note (optional)"}
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={requireReason ? "e.g. tank gauge read 560 L" : "e.g. checked against the mixing sheet"} />
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

// ── Leftover (closing a tank, or recording one that was missed) ──────────────

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
  onSubmit: (leftoverL: number | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="pest-section-form pest-mix-form" data-testid="leftover-form">
      <p style={{ margin: "0 0 0.3rem", fontWeight: 600 }}>{title}</p>
      <p className="pest-mix-progress-note" style={{ margin: "0 0 0.55rem" }}>{hint}</p>
      <LeftoverInput label="Leftover (L)" value={value} unknown={unknown} onValue={setValue} onUnknown={setUnknown} />
      {err ? <p className="form-error" style={{ margin: "0.5rem 0 0" }}>{err}</p> : null}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.65rem" }}>
        <button
          type="button"
          disabled={busy}
          style={{ flex: 1 }}
          onClick={() => {
            const parsed = parseLeftover(value, unknown, maxLeftover);
            if (!parsed.ok) return setErr(parsed.error);
            setErr(null);
            onSubmit(parsed.value);
          }}
        >
          {submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<MixRevision["action"], string> = {
  created: "Recorded",
  corrected: "Corrected",
  confirmed: "Amounts confirmed",
  leftover: "Leftover recorded",
  closed: "Closed",
  imported: "Carried over (planned estimate)"
};

const leftoverText = (v: number | null | undefined) => (v == null ? "not recorded" : `${fmt(v)} L`);

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
        if (b && (b.leftover_l ?? null) !== (a.leftover_l ?? null)) changes.push(`leftover ${leftoverText(b.leftover_l)} → ${leftoverText(a.leftover_l)}`);
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
