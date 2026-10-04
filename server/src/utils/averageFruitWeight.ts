// Combining average fruit weight (AFW) when kg is appended to an existing
// weekly yield entry. AFW is grams per fruit, so the combined value is total
// grams over total fruit — the same rule csvMappingTemplates'
// mergeAppendAverageFruitWeight applies to CSV appends — not "keep the latest
// day's AFW" and not an arithmetic mean.
const EPS = 0.005;

export function mergeAverageFruitWeightG(
  existingKg: number,
  existingAfwG: number | null,
  incomingKg: number,
  incomingAfwG: number | null
): number | null {
  const hasExistingKg = existingKg > EPS;
  const hasIncomingKg = incomingKg > EPS;
  const existingKnown = existingAfwG != null && existingAfwG > 0;
  const incomingKnown = incomingAfwG != null && incomingAfwG > 0;
  if (!hasIncomingKg) return hasExistingKg && existingKnown ? existingAfwG : null;
  if (!hasExistingKg) return incomingKnown ? incomingAfwG : null;
  // Fruit count of either part is unknown → the combined AFW is unknown, not a guess.
  if (!existingKnown || !incomingKnown) return null;
  const pieces = (existingKg * 1000) / (existingAfwG as number) + (incomingKg * 1000) / (incomingAfwG as number);
  return ((existingKg + incomingKg) * 1000) / pieces;
}
