import { supabase } from "../config/supabase";
import {
  computeLinearAdjustment,
  interpolateMultiplier,
  LINEAR_ADJUSTMENT_DEFAULTS,
  type LinearAdjustmentSettings
} from "./bonusMultiplier";

export { interpolateMultiplier, computeLinearAdjustment, LINEAR_ADJUSTMENT_DEFAULTS } from "./bonusMultiplier";
export type { LinearAdjustmentSettings } from "./bonusMultiplier";

// Shared bonus-tier logic used by both the manual bonus-entry routes and the
// PDF-import routes, so the two entry paths always compute rates identically.

export const VALID_CHECK_TYPES = ["winding_pruning", "picking_peppers"] as const;
export type CheckType = (typeof VALID_CHECK_TYPES)[number];

// No longer read by computeBonusBatch (both jobs use the linear adjustment
// below) — kept because the generic workload-levels CRUD routes still exist
// for potential future reuse.
export const VALID_WORKLOAD_LEVELS = ["light", "normal", "heavy"] as const;
export type WorkloadLevel = (typeof VALID_WORKLOAD_LEVELS)[number];

export type ThresholdMode = "fixed" | "auto";

export function isCheckType(value: unknown): value is CheckType {
  return typeof value === "string" && VALID_CHECK_TYPES.includes(value as CheckType);
}

export function isWorkloadLevel(value: unknown): value is WorkloadLevel {
  return typeof value === "string" && VALID_WORKLOAD_LEVELS.includes(value as WorkloadLevel);
}

export function speedUnitFor(checkType: CheckType): string {
  return checkType === "picking_peppers" ? "kg/hr" : "heads/hr";
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// ── Weekly conditions & settings resolution ──────────────────────────────────

export type WeeklyConditions = {
  cropLoad?: number | null; // picking_peppers: weekly harvested kg/m^2
  setsPerPlant?: number | null; // winding_pruning: weekly fruit sets/m^2
};

export type AdjustmentSettings = {
  thresholdMode: ThresholdMode;
  linear: LinearAdjustmentSettings; // defaults applied per-job when unset
};

export async function getAdjustmentSettings(orgId: string, checkType: CheckType): Promise<AdjustmentSettings> {
  const { data, error } = await supabase
    .from("quality_bonus_adjustment_settings")
    .select("threshold_mode, standard_value, value_step, speed_change_per_step, min_adjustment, max_adjustment")
    .eq("organization_id", orgId)
    .eq("check_type", checkType)
    .maybeSingle();
  if (error) throw error;

  const defaults = LINEAR_ADJUSTMENT_DEFAULTS[checkType];
  return {
    thresholdMode: (data?.threshold_mode as ThresholdMode) ?? "fixed",
    linear: {
      standardValue: data?.standard_value ?? defaults.standardValue,
      valueStep: data?.value_step ?? defaults.valueStep,
      speedChangePerStep: data?.speed_change_per_step ?? defaults.speedChangePerStep,
      minAdjustment: data?.min_adjustment ?? defaults.minAdjustment,
      maxAdjustment: data?.max_adjustment ?? defaults.maxAdjustment
    }
  };
}

// ── Bonus tier resolution ─────────────────────────────────────────────────────

export type AppliedBonus = {
  applied_threshold: number | null; // the (possibly adjusted) threshold that was reached
  applied_rate: number;
  base_threshold: number | null; // the configured tier value before adjustment
  raw_adjustment: number | null; // auto mode only; null in fixed mode
  final_adjustment: number | null; // auto mode only; null in fixed mode
};

function pickBestTier(
  adjustedTiers: { base: number; adjusted: number; rate: number }[],
  enteredSpeed: number
): { applied_threshold: number | null; applied_rate: number; base_threshold: number | null } {
  const qualifying = adjustedTiers.filter((t) => t.adjusted <= enteredSpeed).sort((a, b) => b.adjusted - a.adjusted);
  const best = qualifying[0];
  if (!best) return { applied_threshold: null, applied_rate: 0, base_threshold: null };
  return { applied_threshold: best.adjusted, applied_rate: best.rate, base_threshold: best.base };
}

// Batch form: fetches settings/tiers once and resolves many speeds against
// them — used by the PDF-import calculate step so it doesn't re-query per
// row. The adjustment (linear kg/hr or heads/hr offset) is the same for
// every row; it only depends on the job's weekly conditions, not on
// individual employee speed.
export async function computeBonusBatch(
  orgId: string,
  checkType: CheckType,
  enteredSpeeds: number[],
  conditions: WeeklyConditions = {}
): Promise<{
  mode: ThresholdMode;
  rawAdjustment: number | null;
  finalAdjustment: number | null;
  linearSettings: LinearAdjustmentSettings | null;
  results: AppliedBonus[];
}> {
  const [settings, tiersResult] = await Promise.all([
    getAdjustmentSettings(orgId, checkType),
    supabase
      .from("quality_bonus_tiers")
      .select("min_speed, bonus_rate_per_hour")
      .eq("organization_id", orgId)
      .eq("check_type", checkType)
  ]);
  if (tiersResult.error) throw tiersResult.error;

  let rawAdjustment: number | null = null;
  let finalAdjustment: number | null = null;
  let linearSettings: LinearAdjustmentSettings | null = null;

  if (settings.thresholdMode === "auto") {
    linearSettings = settings.linear;
    // picking_peppers reads weekly crop load (kg/m^2); winding_pruning reads
    // weekly fruit sets/m^2 — same additive formula, different weekly input.
    const weeklyValue = checkType === "picking_peppers" ? conditions.cropLoad : conditions.setsPerPlant;
    if (weeklyValue !== null && weeklyValue !== undefined) {
      const computed = computeLinearAdjustment(settings.linear, weeklyValue);
      rawAdjustment = computed.rawAdjustment;
      finalAdjustment = computed.finalAdjustment;
    } else {
      rawAdjustment = 0;
      finalAdjustment = 0;
    }
  }

  const adjustedTiers = (tiersResult.data ?? []).map((t) => {
    const base = t.min_speed as number;
    const adjusted = Math.round(base + (finalAdjustment ?? 0));
    return { base, adjusted, rate: t.bonus_rate_per_hour as number };
  });

  const results = enteredSpeeds.map((speed) => {
    const best = pickBestTier(adjustedTiers, speed);
    return { ...best, raw_adjustment: rawAdjustment, final_adjustment: finalAdjustment };
  });

  return { mode: settings.thresholdMode, rawAdjustment, finalAdjustment, linearSettings, results };
}

// Highest tier threshold at or below enteredSpeed, after applying the
// weekly-conditions adjustment (none in fixed mode, or when no conditions
// are supplied for an auto-mode job); $0 if below the lowest adjusted tier.
export async function computeBonus(
  orgId: string,
  checkType: CheckType,
  enteredSpeed: number,
  conditions: WeeklyConditions = {}
): Promise<AppliedBonus> {
  const { results } = await computeBonusBatch(orgId, checkType, [enteredSpeed], conditions);
  return results[0];
}
