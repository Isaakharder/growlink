// Crop Planner calculations: each row's planting layout, plants per row, the
// seed order by variety and the slab order by slab type. Pure functions, so
// the map, the order summary, the print view and the CSV all agree.
//
// Plants are plants: stems per plant never enters a plant or seed count.

export type PlanGroup = { id: string; type: string; name: string; status?: string };
export type PlanGreenhouseRow = {
  group_id: string;
  row_number: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant?: number;
};
export type RowRef = { group_id: string; row_number: number };
export type PlantingAssignment = RowRef & { variety_id: string };
export type SlabAssignment = RowRef & { slab_type_id: string };
export type RowLayoutInput = RowRef & {
  slabs_per_trough: number | null;
  troughs_per_row: number | null;
  plants_per_slab: number | null;
};
export type PlanVariety = { id: string; name: string; product_code?: string | null; color?: string | null; status?: string };
export type PlanSlabType = { id: string; name: string; status?: string };

export const rowKey = (row: RowRef) => `${row.group_id}:${row.row_number}`;

export type MissingInput = "slabs per row" | "plants per slab" | "row not in Greenhouse Setup";

export type RowLayout = {
  slabsPerRow: number | null;
  plantsPerSlab: number | null;
  /** Plants in the row: slabs per row x plants per slab, or null when an input is missing. */
  plants: number | null;
  /** Where each value came from: the plan's inputs, or the row's Greenhouse Setup layout. */
  slabsSource: "plan" | "setup" | null;
  plantsSource: "plan" | "setup" | null;
  /** "53 x 2 x 3", the arithmetic as entered, when the plan gives troughs. */
  formula: string | null;
  missing: MissingInput[];
};

/**
 * A row's layout for the plan: the plan's inputs where given (slabs per
 * trough x troughs per row, plants per slab), else the row's Greenhouse Setup
 * layout (its slab count and plants per slab; 0 means not set).
 */
export function rowLayout(row: PlanGreenhouseRow | undefined, input: RowLayoutInput | undefined): RowLayout {
  const missing: MissingInput[] = [];
  let slabsPerRow: number | null = null;
  let slabsSource: RowLayout["slabsSource"] = null;
  if (input && input.slabs_per_trough && input.troughs_per_row) {
    slabsPerRow = input.slabs_per_trough * input.troughs_per_row;
    slabsSource = "plan";
  } else if (row && row.slab_count > 0) {
    slabsPerRow = row.slab_count;
    slabsSource = "setup";
  }
  let plantsPerSlab: number | null = null;
  let plantsSource: RowLayout["plantsSource"] = null;
  if (input && input.plants_per_slab) {
    plantsPerSlab = input.plants_per_slab;
    plantsSource = "plan";
  } else if (row && row.plants_per_slab > 0) {
    plantsPerSlab = row.plants_per_slab;
    plantsSource = "setup";
  }
  if (!row) missing.push("row not in Greenhouse Setup");
  if (slabsPerRow === null) missing.push("slabs per row");
  if (plantsPerSlab === null) missing.push("plants per slab");
  const formula =
    input && input.slabs_per_trough && input.troughs_per_row && plantsPerSlab !== null
      ? `${input.slabs_per_trough} × ${input.troughs_per_row} × ${plantsPerSlab}`
      : null;
  return {
    slabsPerRow,
    plantsPerSlab,
    plants: slabsPerRow !== null && plantsPerSlab !== null ? slabsPerRow * plantsPerSlab : null,
    slabsSource,
    plantsSource,
    formula,
    missing
  };
}

/** Indexes the plan's greenhouse rows and layout inputs by row key. */
export function layoutIndex(rows: PlanGreenhouseRow[], inputs: RowLayoutInput[]) {
  const rowByKey = new Map(rows.map((row) => [rowKey(row), row]));
  const inputByKey = new Map(inputs.map((input) => [rowKey(input), input]));
  return (ref: RowRef) => rowLayout(rowByKey.get(rowKey(ref)), inputByKey.get(rowKey(ref)));
}

/**
 * Total seeds for target plants with an oversow percentage, rounded up once
 * on the total: 1,000 plants + 30% = 1,300 seeds; 1,001 + 12.5% = 1,127.
 * Percentages carry at most two decimals; the sum is done in whole numbers.
 */
export function seedsWithOversow(targetPlants: number, oversowPct: number): number {
  const basisPoints = Math.round(oversowPct * 100);
  const numerator = targetPlants * (10000 + basisPoints);
  return Math.floor((numerator + 9999) / 10000);
}

export type PhaseLine = { group_id: string; group_name: string; rows: number; quantity: number; missingRows: RowRef[] };

export type SeedLine = {
  variety_id: string;
  variety_name: string;
  phases: PhaseLine[];
  rows: number;
  targetPlants: number;
  oversowPct: number;
  baseSeeds: number;
  extraSeeds: number;
  totalSeeds: number;
  /** Rows whose plant count can't be worked out yet; the order is incomplete until they are filled in. */
  missingRows: RowRef[];
  incomplete: boolean;
};

export type SlabLine = {
  slab_type_id: string;
  slab_type_name: string;
  phases: PhaseLine[];
  rows: number;
  slabs: number;
  missingRows: RowRef[];
  incomplete: boolean;
};

function phaseLines(
  assignments: RowRef[],
  groups: PlanGroup[],
  quantityOf: (ref: RowRef) => number | null
): { phases: PhaseLine[]; total: number; missingRows: RowRef[] } {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const order = new Map(groups.map((group, index) => [group.id, index]));
  const byGroup = new Map<string, PhaseLine>();
  const missingRows: RowRef[] = [];
  let total = 0;
  for (const ref of assignments) {
    const line = byGroup.get(ref.group_id) ?? {
      group_id: ref.group_id,
      group_name: groupName.get(ref.group_id) ?? "Unknown group",
      rows: 0,
      quantity: 0,
      missingRows: []
    };
    line.rows += 1;
    const quantity = quantityOf(ref);
    if (quantity === null) {
      line.missingRows.push(ref);
      missingRows.push(ref);
    } else {
      line.quantity += quantity;
      total += quantity;
    }
    byGroup.set(ref.group_id, line);
  }
  const phases = Array.from(byGroup.values()).sort(
    (a, b) => (order.get(a.group_id) ?? 1e9) - (order.get(b.group_id) ?? 1e9) || a.group_name.localeCompare(b.group_name)
  );
  for (const phase of phases) phase.missingRows.sort((a, b) => a.row_number - b.row_number);
  return { phases, total, missingRows };
}

/**
 * The seed order by variety: target plants over every row planted with it
 * (all phases combined), base seeds = target plants, and the variety's
 * oversow added to the combined total and rounded up once.
 */
export function seedOrder(params: {
  plantings: PlantingAssignment[];
  groups: PlanGroup[];
  varieties: PlanVariety[];
  oversow: Array<{ variety_id: string; oversow_pct: number }>;
  layoutOf: (ref: RowRef) => RowLayout;
}): SeedLine[] {
  const varietyName = new Map(params.varieties.map((v) => [v.id, v.name]));
  const oversowOf = new Map(params.oversow.map((o) => [o.variety_id, Number(o.oversow_pct)]));
  const byVariety = new Map<string, PlantingAssignment[]>();
  for (const planting of params.plantings) {
    byVariety.set(planting.variety_id, [...(byVariety.get(planting.variety_id) ?? []), planting]);
  }
  return Array.from(byVariety.entries())
    .map(([varietyId, rows]) => {
      const { phases, total, missingRows } = phaseLines(rows, params.groups, (ref) => params.layoutOf(ref).plants);
      const oversowPct = oversowOf.get(varietyId) ?? 0;
      const totalSeeds = seedsWithOversow(total, oversowPct);
      return {
        variety_id: varietyId,
        variety_name: varietyName.get(varietyId) ?? "Unknown variety",
        phases,
        rows: rows.length,
        targetPlants: total,
        oversowPct,
        baseSeeds: total,
        extraSeeds: totalSeeds - total,
        totalSeeds,
        missingRows,
        incomplete: missingRows.length > 0
      };
    })
    .sort((a, b) => a.variety_name.localeCompare(b.variety_name));
}

/**
 * The slab order by slab type: slabs over every row given that type, from
 * each row's layout (never from the seed oversow).
 */
export function slabOrder(params: {
  slabs: SlabAssignment[];
  groups: PlanGroup[];
  slabTypes: PlanSlabType[];
  layoutOf: (ref: RowRef) => RowLayout;
}): SlabLine[] {
  const typeName = new Map(params.slabTypes.map((t) => [t.id, t.name]));
  const byType = new Map<string, SlabAssignment[]>();
  for (const slab of params.slabs) byType.set(slab.slab_type_id, [...(byType.get(slab.slab_type_id) ?? []), slab]);
  return Array.from(byType.entries())
    .map(([typeId, rows]) => {
      const { phases, total, missingRows } = phaseLines(rows, params.groups, (ref) => params.layoutOf(ref).slabsPerRow);
      return {
        slab_type_id: typeId,
        slab_type_name: typeName.get(typeId) ?? "Unknown slab type",
        phases,
        rows: rows.length,
        slabs: total,
        missingRows,
        incomplete: missingRows.length > 0
      };
    })
    .sort((a, b) => a.slab_type_name.localeCompare(b.slab_type_name));
}

/** Greenhouse rows with no assignment in the given list, by group. */
export function unassignedRows(rows: PlanGreenhouseRow[], assigned: RowRef[]): RowRef[] {
  const taken = new Set(assigned.map(rowKey));
  return rows.filter((row) => !taken.has(rowKey(row))).map(({ group_id, row_number }) => ({ group_id, row_number }));
}

/** "1–20, 25, 27–28": row numbers as compact ranges. */
export function formatRowRanges(numbers: number[]): string {
  const sorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i];
    parts.push(start === end ? String(start) : `${start}–${end}`);
  }
  return parts.join(", ");
}

/** Rows of a group between two row numbers (inclusive, either order), as they exist in the greenhouse. */
export function rowsInRange(rows: PlanGreenhouseRow[], groupId: string, from: number, to: number): RowRef[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return rows
    .filter((row) => row.group_id === groupId && row.row_number >= low && row.row_number <= high)
    .map(({ group_id, row_number }) => ({ group_id, row_number }));
}

/** What a selection would add: its row count and plants (or slabs), and which rows are missing an input. */
export function selectionSummary(selection: RowRef[], layoutOf: (ref: RowRef) => RowLayout) {
  let plants = 0;
  let slabs = 0;
  const missingPlants: RowRef[] = [];
  const missingSlabs: RowRef[] = [];
  for (const ref of selection) {
    const layout = layoutOf(ref);
    if (layout.plants === null) missingPlants.push(ref);
    else plants += layout.plants;
    if (layout.slabsPerRow === null) missingSlabs.push(ref);
    else slabs += layout.slabsPerRow;
  }
  return { rows: selection.length, plants, slabs, missingPlants, missingSlabs };
}

export type OrderCsvInput = {
  season: string;
  planName: string;
  seeds: SeedLine[];
  slabs: SlabLine[];
};

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * The order summary as CSV: a seed list and a slab list, each with its phase
 * breakdown and final quantity, and an incomplete note on any line still
 * missing layout inputs.
 */
export function orderCsv({ season, planName, seeds, slabs }: OrderCsvInput): string {
  const lines: Array<Array<string | number>> = [
    ["Season", season],
    ["Plan", planName],
    [],
    ["Seed order"],
    ["Variety", "Phase", "Rows", "Target plants", "Oversow %", "Base seeds", "Extra seeds", "Total seeds to order", "Status"]
  ];
  for (const line of seeds) {
    for (const phase of line.phases) {
      lines.push([line.variety_name, phase.group_name, phase.rows, phase.quantity, "", "", "", "", phase.missingRows.length ? `Missing inputs: rows ${formatRowRanges(phase.missingRows.map((r) => r.row_number))}` : ""]);
    }
    lines.push([line.variety_name, "All phases", line.rows, line.targetPlants, line.oversowPct, line.baseSeeds, line.extraSeeds, line.totalSeeds, line.incomplete ? "Incomplete" : "Complete"]);
  }
  lines.push([], ["Slab order"], ["Slab type", "Phase", "Rows", "Slabs to order", "Status"]);
  for (const line of slabs) {
    for (const phase of line.phases) {
      lines.push([line.slab_type_name, phase.group_name, phase.rows, phase.quantity, phase.missingRows.length ? `Missing inputs: rows ${formatRowRanges(phase.missingRows.map((r) => r.row_number))}` : ""]);
    }
    lines.push([line.slab_type_name, "All phases", line.rows, line.slabs, line.incomplete ? "Incomplete" : "Complete"]);
  }
  return lines.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
