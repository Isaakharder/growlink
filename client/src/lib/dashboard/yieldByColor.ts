import { roundTo } from "../roundTo";

// Yield by Color: harvested and shipped kg/m² per colour, the weekly kg by
// colour series and the Total Picked by Color shares. Shared by the desktop
// Dashboard and the iOS workspace so both show identical values.

export type VarietyColor = "red" | "orange" | "yellow" | "green";

export const COLOR_ORDER: VarietyColor[] = ["red", "orange", "yellow", "green"];

export type ColorYieldEntry = {
  variety_id: string;
  year: number;
  week: number;
  total_kg: number;
};

export type ColorYieldVariety = {
  id: string;
  color: VarietyColor | string | null;
  area_m2: number;
  status: "active" | "inactive";
};

export type ColorCaseEntry = {
  color: VarietyColor | string | null;
  total_cases: number;
  case_weight_kg: number;
  total_kg: number;
};

export type ColorYieldSummary = {
  color: VarietyColor;
  totalKg: number;
  totalAreaM2: number;
  harvestedKgPerM2: number | null;
  exportedKg: number;
  exportedKgPerM2: number | null;
};

export type YieldTrendPoint = {
  label: string;
  sortKey: number;
  red: number;
  orange: number;
  yellow: number;
  green: number;
};

export type YieldPieSlice = {
  color: VarietyColor;
  kg: number;
  percent: number;
};

export function normalizeColor(value: unknown): VarietyColor | null {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (color === "red" || color === "orange" || color === "yellow" || color === "green") {
    return color;
  }

  return null;
}

function readNumberField(
  record: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const raw = record[key];
    const parsed = typeof raw === "number" ? raw : Number(raw);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function readStringField(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const raw = record[key];

    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return null;
}

/** /api/yield-entries → entries with a variety, kg ≥ 0 and week 1–53. */
export function normalizeYieldEntries(input: unknown): ColorYieldEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: ColorYieldEntry[] = [];

  for (const rawEntry of input) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const varietyId = readStringField(entry, ["variety_id", "varietyId"]);
    const totalKg = readNumberField(entry, ["total_kg", "totalKg"]);
    const week = readNumberField(entry, ["week", "iso_week", "weekNumber"]);
    const year = readNumberField(entry, ["year", "iso_year"]);

    if (!varietyId || totalKg === null || week === null || year === null) {
      continue;
    }

    if (totalKg < 0) {
      continue;
    }

    const normalizedWeek = Math.trunc(week);
    const normalizedYear = Math.trunc(year);

    if (normalizedWeek < 1 || normalizedWeek > 53) {
      continue;
    }

    result.push({
      variety_id: varietyId,
      total_kg: totalKg,
      week: normalizedWeek,
      year: normalizedYear
    });
  }

  return result;
}

/** /api/color-case-entries → entries with cases and case weight ≥ 0. */
export function normalizeColorCaseEntries(input: unknown): ColorCaseEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: ColorCaseEntry[] = [];

  for (const rawEntry of input) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const totalCases = readNumberField(entry, ["total_cases", "totalCases"]);
    const caseWeightKg = readNumberField(entry, ["case_weight_kg", "caseWeightKg"]);
    const totalKg = readNumberField(entry, ["total_kg", "totalKg"]) ?? 0;

    if (totalCases === null || caseWeightKg === null || totalCases < 0 || caseWeightKg < 0) {
      continue;
    }

    result.push({
      color: (entry.color as VarietyColor | string | null) ?? null,
      total_cases: totalCases,
      case_weight_kg: caseWeightKg,
      total_kg: totalKg
    });
  }

  return result;
}

/**
 * Per colour, in COLOR_ORDER: kg and area of the ACTIVE varieties, shipped
 * kg from the colour case entries, and each per m² (null without area).
 */
export function buildColorYieldSummary(
  entries: ColorYieldEntry[],
  varieties: ColorYieldVariety[],
  colorCaseEntries: ColorCaseEntry[]
): ColorYieldSummary[] {
  const activeVarieties = (varieties ?? []).filter(
    (variety) => variety.status === "active"
  );
  const varietyById = new Map<string, ColorYieldVariety>();
  const totalsByColor = new Map<
    VarietyColor,
    { totalKg: number; exportedKg: number; totalAreaM2: number }
  >();

  for (const color of COLOR_ORDER) {
    totalsByColor.set(color, { totalKg: 0, exportedKg: 0, totalAreaM2: 0 });
  }

  for (const variety of activeVarieties) {
    const color = normalizeColor(variety.color);
    if (!color) {
      continue;
    }

    varietyById.set(variety.id, variety);
    const bucket = totalsByColor.get(color)!;
    bucket.totalAreaM2 +=
      Number.isFinite(Number(variety.area_m2)) && Number(variety.area_m2) > 0
        ? Number(variety.area_m2)
        : 0;
  }

  for (const entry of entries ?? []) {
    const variety = varietyById.get(entry.variety_id);
    const color = normalizeColor(variety?.color);
    const totalKg = Number(entry.total_kg);

    if (!color || !Number.isFinite(totalKg) || totalKg < 0) {
      continue;
    }

    const bucket = totalsByColor.get(color)!;
    bucket.totalKg += totalKg;
  }

  for (const entry of colorCaseEntries ?? []) {
    const color = normalizeColor(entry.color);
    const totalCases = Number(entry.total_cases);
    const caseWeightKg = Number(entry.case_weight_kg);

    if (!color || !Number.isFinite(totalCases) || !Number.isFinite(caseWeightKg)) {
      continue;
    }

    if (totalCases < 0 || caseWeightKg < 0) {
      continue;
    }

    const bucket = totalsByColor.get(color)!;
    bucket.exportedKg += entry.total_kg;
  }

  return COLOR_ORDER.map((color) => {
    const bucket = totalsByColor.get(color)!;
    const harvestedKgPerM2 =
      bucket.totalAreaM2 > 0 ? bucket.totalKg / bucket.totalAreaM2 : null;
    const exportedKgPerM2 =
      bucket.totalAreaM2 > 0 ? bucket.exportedKg / bucket.totalAreaM2 : null;

    return {
      color,
      totalKg: bucket.totalKg,
      totalAreaM2: bucket.totalAreaM2,
      harvestedKgPerM2,
      exportedKg: bucket.exportedKg,
      exportedKgPerM2
    };
  });
}

/** "2.17 kg/m2", or "—" when the colour has no area. */
export function formatColorKgPerM2(value: number | null) {
  return value === null ? "—" : `${roundTo(value, 2)} kg/m2`;
}

/**
 * Weekly kg by colour, oldest week first. Maps colour through ALL varieties
 * (not only active ones), unlike buildColorYieldSummary.
 */
export function buildYieldTrendPoints(
  yieldEntries: ColorYieldEntry[],
  varieties: ColorYieldVariety[]
): YieldTrendPoint[] {
  const varietyColorById = new Map<string, VarietyColor>();

  for (const variety of varieties) {
    const color = normalizeColor(variety.color);
    if (color) {
      varietyColorById.set(variety.id, color);
    }
  }

  const byWeek = new Map<string, YieldTrendPoint>();

  for (const entry of yieldEntries) {
    const color = varietyColorById.get(entry.variety_id);
    const totalKg = Number(entry.total_kg);
    const year = Number(entry.year);
    const week = Number(entry.week);

    if (!color || !Number.isFinite(totalKg) || !Number.isFinite(year) || !Number.isFinite(week)) {
      continue;
    }

    const label = `W${week} ${year}`;
    const sortKey = year * 100 + week;

    if (!byWeek.has(label)) {
      byWeek.set(label, {
        label,
        sortKey,
        red: 0,
        orange: 0,
        yellow: 0,
        green: 0
      });
    }

    const point = byWeek.get(label)!;
    point[color] += totalKg;
  }

  return Array.from(byWeek.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((point) => ({
      ...point,
      red: roundTo(point.red, 2),
      orange: roundTo(point.orange, 2),
      yellow: roundTo(point.yellow, 2),
      green: roundTo(point.green, 2)
    }));
}

/** Each colour's total kg and its share of all colours (1 dp), in COLOR_ORDER. */
export function buildYieldPieSlices(colorYieldSummary: ColorYieldSummary[]): YieldPieSlice[] {
  const colorTotals = new Map<VarietyColor, number>();

  for (const color of COLOR_ORDER) {
    colorTotals.set(color, 0);
  }

  for (const entry of colorYieldSummary) {
    colorTotals.set(entry.color, entry.totalKg);
  }

  const greenhouseTotalKg = Array.from(colorTotals.values()).reduce(
    (sum, value) => sum + value,
    0
  );

  return COLOR_ORDER.map((color) => {
    const kg = colorTotals.get(color) ?? 0;
    return {
      color,
      kg: roundTo(kg, 2),
      percent: greenhouseTotalKg > 0 ? roundTo((kg / greenhouseTotalKg) * 100, 1) : 0
    };
  });
}
