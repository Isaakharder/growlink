export function parseRequiredNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} is required`);
  }

  return parsed;
}

export function parseBinFillPercent(value: unknown): number {
  const parsed = parseRequiredNumber(value, "bin_fill_percent");

  if (parsed < 0) {
    throw new Error("bin_fill_percent must be 0 or greater");
  }

  return parsed;
}

export function calculateSampleMetrics(
  percentFull: number,
  kgPerFullBin: number,
  totalStems: number
) {
  const calculatedSampleKg = (percentFull / 100) * kgPerFullBin;
  const calculatedKgPerStem = totalStems > 0 ? calculatedSampleKg / totalStems : 0;

  return {
    calculatedSampleKg,
    calculatedKgPerStem
  };
}
