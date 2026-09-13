// Chemical-rate and mixing math shared by every spray/drench method
// (Wanjet, Bogaerts Qii-Jet, valve drench). Method-specific concerns
// (travel speed, nozzle flow calibration, robot setup) do not belong here —
// this module only knows about product rate, area, and batch/tank division.

export type RateUnit =
  | "ml_per_acre" | "L_per_acre" | "ml_per_hectare" | "L_per_hectare"
  | "g_per_acre"  | "kg_per_acre" | "g_per_hectare"  | "kg_per_hectare";

export const LIQUID_RATE_OPTIONS: { value: RateUnit; label: string }[] = [
  { value: "ml_per_acre", label: "ml / acre" },
  { value: "L_per_acre", label: "L / acre" },
  { value: "ml_per_hectare", label: "ml / hectare" },
  { value: "L_per_hectare", label: "L / hectare" }
];

export const DRY_RATE_OPTIONS: { value: RateUnit; label: string }[] = [
  { value: "g_per_acre", label: "g / acre" },
  { value: "kg_per_acre", label: "kg / acre" },
  { value: "g_per_hectare", label: "g / hectare" },
  { value: "kg_per_hectare", label: "kg / hectare" }
];

export const M2_TO_FT2 = 10.7639;
export const M2_TO_HECTARES = 1 / 10000;
export const M2_TO_ACRES = 1 / 4046.8564224;

// 1 bar = 14.5038 psi. Bar is always the stored/native value for Bogaerts;
// psi is a derived display-only conversion, never entered directly.
export const BAR_TO_PSI = 14.5038;

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function isDryChemical(inventoryUnit: string): boolean {
  const u = inventoryUnit.toLowerCase().trim();
  if (["g", "kg", "grams", "gram", "kilograms", "kilogram"].includes(u)) return true;
  if (u.startsWith("g/") || u.startsWith("kg/")) return true;
  if (/(powder|dry|dust|granule|granules|wdg|wg|wp)/.test(u)) return true;
  return false;
}

export function isDryRateUnit(rateUnit: RateUnit): boolean {
  return rateUnit.startsWith("g_") || rateUnit.startsWith("kg_");
}

// Base-unit product amount needed for m2 at the given rate (ml for liquids,
// g for dry product). Never crosses mass <-> volume — the unit determines
// which base unit comes out.
export function computeChemicalMl(m2: number, rate: number, rateUnit: RateUnit): number {
  const acres = m2 * M2_TO_ACRES;
  const ha = m2 * M2_TO_HECTARES;
  switch (rateUnit) {
    case "ml_per_acre":    return rate * acres;
    case "L_per_acre":     return rate * acres * 1000;
    case "ml_per_hectare": return rate * ha;
    case "L_per_hectare":  return rate * ha * 1000;
    case "g_per_acre":     return rate * acres;
    case "kg_per_acre":    return rate * acres * 1000;
    case "g_per_hectare":  return rate * ha;
    case "kg_per_hectare": return rate * ha * 1000;
  }
}

export type ChemicalNeededResult = {
  ml: number;
  L: number;
  areaLabel: string;
  isDry: boolean;
  unit: "ml" | "g";
  unitLarge: "L" | "kg";
};

// PRODUCT APPLICATION — "how much pesticide belongs on the selected area."
// Deliberately has no knowledge of spray/carrier volume (L/ha) — that is a
// separate, independently-supplied value (see computeSprayVolume below).
export function computeChemicalNeeded(
  m2: number,
  rate: number,
  rateUnit: RateUnit
): ChemicalNeededResult | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isFinite(m2) || m2 <= 0) return null;

  const ml = computeChemicalMl(m2, rate, rateUnit);
  const isDry = isDryRateUnit(rateUnit);
  const acres = m2 * M2_TO_ACRES;
  const ha = m2 * M2_TO_HECTARES;
  const areaLabel = rateUnit.endsWith("_acre")
    ? `${roundTo(acres, 3)} acres`
    : `${roundTo(ha, 4)} ha`;

  return { ml, L: ml / 1000, areaLabel, isDry, unit: isDry ? "g" : "ml", unitLarge: isDry ? "kg" : "L" };
}

// SPRAY VOLUME — "how much total spray solution/water is required."
// Independent input (target application volume, e.g. L/ha) x area. Must
// never be derived from the product rate — a label rate like 500 mL/ha
// does not by itself imply any particular carrier volume.
export function computeSprayVolumeL(
  m2: number,
  targetVolumeLPerHa: number
): number | null {
  if (!Number.isFinite(m2) || m2 <= 0) return null;
  if (!Number.isFinite(targetVolumeLPerHa) || targetVolumeLPerHa <= 0) return null;
  const ha = m2 * M2_TO_HECTARES;
  return targetVolumeLPerHa * ha;
}

export type MixPlan = {
  totalVolumeL: number;
  batchSizeL: number;
  chemPerLiterMl: number;
  /** Number of batches mixed at the full batch size (excludes a smaller final batch, if any). */
  fullBatchCount: number;
  /** Total number of batches, including a smaller final batch when present. */
  totalBatchCount: number;
  chemPerFullBatchMl: number;
  finalBatchVolumeL: number;
  chemForFinalBatchMl: number;
  /** True when the total divides evenly and every batch (including the last) is full-size. */
  isLastFull: boolean;
};

// MIXING — "how the total required solution is divided into physical
// batches." Takes the two independent totals (solution volume, chemical
// amount) computed above and a chosen batch size; never re-derives them.
// V1 final-batch behavior is always "mix exact remaining amount" (no
// "round up to a full batch" option yet).
export function computeMixPlan(
  totalVolumeL: number,
  totalChemicalMl: number,
  batchSizeL: number
): MixPlan | null {
  if (!Number.isFinite(totalVolumeL) || totalVolumeL <= 0) return null;
  if (!Number.isFinite(batchSizeL) || batchSizeL <= 0) return null;
  if (!Number.isFinite(totalChemicalMl)) return null;

  const totalBatchCount = Math.ceil(totalVolumeL / batchSizeL);
  const chemPerLiterMl = totalChemicalMl / totalVolumeL;
  const chemPerFullBatchMl = chemPerLiterMl * batchSizeL;
  const rawFinalVolumeL = totalVolumeL % batchSizeL;
  const isLastFull = rawFinalVolumeL < 0.001;
  const finalBatchVolumeL = isLastFull ? batchSizeL : rawFinalVolumeL;
  const chemForFinalBatchMl = chemPerLiterMl * finalBatchVolumeL;
  const fullBatchCount = isLastFull ? totalBatchCount : totalBatchCount - 1;

  return {
    totalVolumeL,
    batchSizeL,
    chemPerLiterMl,
    fullBatchCount,
    totalBatchCount,
    chemPerFullBatchMl,
    finalBatchVolumeL,
    chemForFinalBatchMl,
    isLastFull
  };
}
