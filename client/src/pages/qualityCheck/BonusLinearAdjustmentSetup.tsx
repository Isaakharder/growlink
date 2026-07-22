import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { CheckType, JOB_LABEL, formatCAD } from "./BonusesTab";

type ThresholdMode = "fixed" | "auto";

type AdjustmentSettings = {
  threshold_mode: ThresholdMode;
  standard_value: number | null;
  value_step: number | null;
  speed_change_per_step: number | null;
  min_adjustment: number | null;
  max_adjustment: number | null;
};

type Tier = { id: string; min_speed: number; bonus_rate_per_hour: number };

type JobConfig = {
  speedUnit: string;
  conditionUnit: string;
  standardLabel: string;
  stepLabel: string;
  speedChangeLabel: string;
  defaults: { standardValue: number; valueStep: number; speedChangePerStep: number; minAdjustment: number; maxAdjustment: number };
};

const CONFIG: Record<CheckType, JobConfig> = {
  picking_peppers: {
    speedUnit: "kg/hr",
    conditionUnit: "kg/m²",
    standardLabel: "Standard crop load (kg/m²)",
    stepLabel: "Crop load step (kg/m²)",
    speedChangeLabel: "Speed change per step (kg/hr)",
    defaults: { standardValue: 1.2, valueStep: 0.2, speedChangePerStep: 10, minAdjustment: -50, maxAdjustment: 75 }
  },
  winding_pruning: {
    speedUnit: "heads/hr",
    conditionUnit: "fruit sets/m²",
    standardLabel: "Standard fruit sets per m²",
    stepLabel: "Fruit-set step",
    speedChangeLabel: "Heads/hr change per step",
    defaults: { standardValue: 5, valueStep: 1, speedChangePerStep: 10, minAdjustment: -100, maxAdjustment: 100 }
  }
};

function computeAdjustment(
  standardValue: number,
  valueStep: number,
  speedChangePerStep: number,
  minAdjustment: number,
  maxAdjustment: number,
  weeklyValue: number
): number {
  if (!Number.isFinite(valueStep) || valueStep === 0) return 0;
  const raw = ((weeklyValue - standardValue) / valueStep) * speedChangePerStep;
  return Math.max(minAdjustment, Math.min(raw, maxAdjustment));
}

export function BonusLinearAdjustmentSetup({ job, canEdit }: { job: CheckType; canEdit: boolean }) {
  const config = CONFIG[job];

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);

  const [modeDraft, setModeDraft] = useState<ThresholdMode>("fixed");
  const [standardValue, setStandardValue] = useState(String(config.defaults.standardValue));
  const [valueStep, setValueStep] = useState(String(config.defaults.valueStep));
  const [speedChangePerStep, setSpeedChangePerStep] = useState(String(config.defaults.speedChangePerStep));
  const [minAdjustment, setMinAdjustment] = useState(String(config.defaults.minAdjustment));
  const [maxAdjustment, setMaxAdjustment] = useState(String(config.defaults.maxAdjustment));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, tiersRes] = await Promise.all([
        apiFetch(`/api/quality/bonus-adjustment-settings?check_type=${job}`),
        apiFetch(`/api/quality/bonus-tiers?check_type=${job}`)
      ]);
      if (!settingsRes.ok || !tiersRes.ok) throw new Error("Failed to load adjustment settings");
      const settingsData = (await settingsRes.json()) as AdjustmentSettings;
      const tiersData = (await tiersRes.json()) as Tier[];
      setModeDraft(settingsData.threshold_mode);
      setStandardValue(String(settingsData.standard_value ?? config.defaults.standardValue));
      setValueStep(String(settingsData.value_step ?? config.defaults.valueStep));
      setSpeedChangePerStep(String(settingsData.speed_change_per_step ?? config.defaults.speedChangePerStep));
      setMinAdjustment(String(settingsData.min_adjustment ?? config.defaults.minAdjustment));
      setMaxAdjustment(String(settingsData.max_adjustment ?? config.defaults.maxAdjustment));
      setTiers([...tiersData].sort((a, b) => a.min_speed - b.min_speed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load adjustment settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  function markDirty() {
    setSaved(false);
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const standard = Number(standardValue);
    const step = Number(valueStep);
    const speedChange = Number(speedChangePerStep);
    const min = Number(minAdjustment);
    const max = Number(maxAdjustment);

    if (!Number.isFinite(standard) || standard <= 0) return setError(`${config.standardLabel} must be greater than 0.`);
    if (!Number.isFinite(step) || step <= 0) return setError(`${config.stepLabel} must be greater than 0.`);
    if (!Number.isInteger(speedChange) || speedChange <= 0) {
      return setError(`${config.speedChangeLabel} must be a whole number greater than 0.`);
    }
    if (!Number.isInteger(min) || min > 0) return setError("Minimum adjustment must be a whole number less than or equal to 0.");
    if (!Number.isInteger(max) || max < 0) return setError("Maximum adjustment must be a whole number greater than or equal to 0.");

    if (
      !window.confirm(
        `Saving changes here affects how future ${JOB_LABEL[job]} PDF imports calculate bonuses. Existing saved bonus entries are not affected. Continue?`
      )
    ) {
      return;
    }

    setSaving(true);
    setSaved(false);
    try {
      const res = await apiFetch("/api/quality/bonus-adjustment-settings", {
        method: "PUT",
        body: JSON.stringify({
          check_type: job,
          threshold_mode: modeDraft,
          standard_value: standard,
          value_step: step,
          speed_change_per_step: speedChange,
          min_adjustment: min,
          max_adjustment: max
        })
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(b?.message ?? "Failed to save settings");
      }
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const sampleValues = useMemo(() => {
    const standard = Number(standardValue);
    const step = Number(valueStep);
    if (!Number.isFinite(standard) || !Number.isFinite(step) || step <= 0) return [];
    const offsets = [-2, -1, 0, 1, 2];
    return offsets.map((m) => Math.round((standard + m * step) * 100) / 100).filter((v) => v >= 0);
  }, [standardValue, valueStep]);

  if (loading) {
    return (
      <div className="coming-soon-card">
        <h2>{JOB_LABEL[job]} — Threshold Adjustment</h2>
        <p style={{ marginTop: "0.5rem", fontSize: "0.85em", color: "var(--text-muted)" }}>Loading…</p>
      </div>
    );
  }

  return (
    <div className="coming-soon-card">
      <h2>{JOB_LABEL[job]} — Threshold Adjustment</h2>
      <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.25rem" }}>
        Auto-adjusting thresholds shift every tier above by the same absolute {config.speedUnit} amount, based
        on the week's {config.conditionUnit} (entered during PDF import). Bonus dollar amounts never change —
        only the speed required to reach each tier.
      </p>

      {error ? <p className="form-error">{error}</p> : null}

      <form onSubmit={(e) => void saveSettings(e)} className="bonus-tier-form">
        <label>
          Mode
          <select
            value={modeDraft}
            onChange={(e) => {
              setModeDraft(e.target.value as ThresholdMode);
              markDirty();
            }}
            disabled={!canEdit}
          >
            <option value="fixed">Fixed thresholds</option>
            <option value="auto">Auto-adjusting thresholds</option>
          </select>
        </label>

        {modeDraft === "auto" ? (
          <>
            <label>
              {config.standardLabel}
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={standardValue}
                onChange={(e) => { setStandardValue(e.target.value); markDirty(); }}
                disabled={!canEdit}
              />
            </label>
            <label>
              {config.stepLabel}
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={valueStep}
                onChange={(e) => { setValueStep(e.target.value); markDirty(); }}
                disabled={!canEdit}
              />
            </label>
            <label>
              {config.speedChangeLabel}
              <input
                type="number"
                min="1"
                step="1"
                value={speedChangePerStep}
                onChange={(e) => { setSpeedChangePerStep(e.target.value); markDirty(); }}
                disabled={!canEdit}
              />
            </label>
            <label>
              Minimum adjustment ({config.speedUnit})
              <input
                type="number"
                max="0"
                step="1"
                value={minAdjustment}
                onChange={(e) => { setMinAdjustment(e.target.value); markDirty(); }}
                disabled={!canEdit}
              />
            </label>
            <label>
              Maximum adjustment ({config.speedUnit})
              <input
                type="number"
                min="0"
                step="1"
                value={maxAdjustment}
                onChange={(e) => { setMaxAdjustment(e.target.value); markDirty(); }}
                disabled={!canEdit}
              />
            </label>
          </>
        ) : null}

        {canEdit ? (
          <div className="form-actions">
            <button type="submit" className="primary-action-button" disabled={saving}>
              {saving ? "Saving…" : "Save Settings"}
            </button>
            {saved ? <span style={{ fontSize: "0.85em", color: "var(--brand)", alignSelf: "center" }}>Saved.</span> : null}
          </div>
        ) : null}
      </form>

      {modeDraft === "auto" && tiers.length > 0 && sampleValues.length > 0 ? (
        <>
          <h3 style={{ marginTop: "1.1rem", marginBottom: "0.25rem", fontSize: "0.92rem" }}>
            Preview: how current tiers adjust at sample {config.conditionUnit} values
          </h3>
          <p style={{ fontSize: "0.8em", color: "var(--text-muted)" }}>
            Based on the values above (not yet saved if you haven't clicked Save Settings).
          </p>
          <div className="varieties-table-wrapper" style={{ marginTop: "0.65rem" }}>
            <table className="varieties-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "right" }}>{config.conditionUnit}</th>
                  <th style={{ textAlign: "right" }}>Adjustment</th>
                  {tiers.map((t) => (
                    <th key={t.id} style={{ textAlign: "right" }}>
                      {t.min_speed} {config.speedUnit} ({formatCAD(t.bonus_rate_per_hour)}/hr)
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleValues.map((value) => {
                  const adjustment = computeAdjustment(
                    Number(standardValue),
                    Number(valueStep),
                    Number(speedChangePerStep) || 0,
                    Number(minAdjustment) || 0,
                    Number(maxAdjustment) || 0,
                    value
                  );
                  return (
                    <tr key={value}>
                      <td style={{ textAlign: "right" }}>{value}</td>
                      <td style={{ textAlign: "right" }}>
                        {adjustment >= 0 ? "+" : ""}
                        {Math.round(adjustment * 100) / 100} {config.speedUnit}
                      </td>
                      {tiers.map((t) => (
                        <td key={t.id} style={{ textAlign: "right" }}>
                          {Math.round(t.min_speed + adjustment)} {config.speedUnit}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
