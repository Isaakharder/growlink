// Pure adjustment math, kept dependency-free (no supabase import) so it can
// be unit-tested without needing database credentials in the test env.

export type MultiplierPoint = { reference_value: number; multiplier: number };

// Linear interpolation between the two nearest configured points; clamps to
// the lowest/highest configured multiplier outside the configured range.
// No longer used by either job's live calculation (both Picking and
// Winding/Pruning now use the additive linear adjustment below), kept as a
// general-purpose utility in case a future job/axis wants a curve again.
export function interpolateMultiplier(points: MultiplierPoint[], value: number): number {
  if (points.length === 0) return 1;
  const sorted = [...points].sort((a, b) => a.reference_value - b.reference_value);

  if (value <= sorted[0].reference_value) return sorted[0].multiplier;
  const last = sorted[sorted.length - 1];
  if (value >= last.reference_value) return last.multiplier;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (value >= a.reference_value && value <= b.reference_value) {
      const span = b.reference_value - a.reference_value;
      const t = span === 0 ? 0 : (value - a.reference_value) / span;
      return a.multiplier + t * (b.multiplier - a.multiplier);
    }
  }
  return 1;
}

// Shared by both Picking (weekly value = harvested kg/m^2) and Winding/Pruning
// (weekly value = fruit sets/m^2) — same additive formula, different unit and
// different default magnitudes.
export type LinearAdjustmentSettings = {
  standardValue: number;
  valueStep: number;
  speedChangePerStep: number;
  minAdjustment: number;
  maxAdjustment: number;
};

export type LinearAdjustmentJob = "picking_peppers" | "winding_pruning";

export const LINEAR_ADJUSTMENT_DEFAULTS: Record<LinearAdjustmentJob, LinearAdjustmentSettings> = {
  picking_peppers: {
    standardValue: 1.2, // kg/m^2
    valueStep: 0.2, // kg/m^2
    speedChangePerStep: 10, // kg/hr
    minAdjustment: -50,
    maxAdjustment: 75
  },
  winding_pruning: {
    standardValue: 5, // fruit sets/m^2
    valueStep: 1, // fruit sets/m^2
    speedChangePerStep: 10, // heads/hr
    minAdjustment: -100,
    maxAdjustment: 100
  }
};

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Additive threshold adjustment shared by Picking and Winding/Pruning:
//   raw = ((weekly value - standard value) / value step) * speed change per step
//   final = clamp(raw, minAdjustment, maxAdjustment)
// The same final adjustment is added to every tier's base threshold — never
// a percentage/multiplier, so bonus dollar amounts are unaffected.
// Rounded to 4dp to avoid floating-point noise (e.g. -19.999999999999996)
// leaking into the stored audit trail or displayed summary.
export function computeLinearAdjustment(
  settings: LinearAdjustmentSettings,
  weeklyValue: number
): { rawAdjustment: number; finalAdjustment: number } {
  const rawAdjustment = round4(
    ((weeklyValue - settings.standardValue) / settings.valueStep) * settings.speedChangePerStep
  );
  const finalAdjustment = Math.max(settings.minAdjustment, Math.min(rawAdjustment, settings.maxAdjustment));
  return { rawAdjustment, finalAdjustment };
}
