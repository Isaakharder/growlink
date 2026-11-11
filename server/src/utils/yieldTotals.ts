// A weekly yield entry's totals from its kg per size: total kg, kg/m² over the
// variety's area and cases at the variety's case weight (0 when the variety has
// no area or case weight). Manual Entry, PDF/FlowMaster imports and CSV
// template imports all store these, so they share this one calculation.
export type YieldTotalsVariety = {
  area_m2: number;
  case_kg: number;
};

export function calculateYieldTotals(sizeKg: Record<string, number>, variety: YieldTotalsVariety) {
  const total_kg = Object.values(sizeKg).reduce((sum, value) => sum + value, 0);
  return calculateYieldTotalsFromKg(total_kg, variety);
}

// The same totals for a product whose harvests are a total kg without size
// buckets (Cucumbers).
export function calculateYieldTotalsFromKg(total_kg: number, variety: YieldTotalsVariety) {
  const kg_per_m2 = variety.area_m2 > 0 ? total_kg / variety.area_m2 : 0;
  const total_cases = variety.case_kg > 0 ? total_kg / variety.case_kg : 0;

  return { total_kg, kg_per_m2, total_cases };
}
