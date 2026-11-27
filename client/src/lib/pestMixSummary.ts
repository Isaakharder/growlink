// Planned-versus-actual figures for one spray job's mixes.
//
// Kept identical to server/src/utils/pestMixSummary.ts (the record frozen at
// completion uses the same numbers the progress card showed offline);
// pestMixSummary.test.ts fails if the two drift apart.
//
// Definitions
//   mixed    what the operator recorded putting in the tanks
//   leftover mixture not applied (drained, returned, left in the tank)
//   applied  mixed − leftover. Chemical applied is the chemical mixed scaled
//            by the share of the tank's water that was applied (a mixed tank
//            is one solution, so a leftover carries chemical with it).
//   per row  an AVERAGE: a tank's applied water/chemical divided by the rows
//            it covered. No row is ever measured individually. A row started
//            on one tank and finished on another counts once in total — half
//            to each tank.
//
// A tank that is still in use has no leftover recorded yet, so its applied
// amount is not known: it counts as mixed, and per-row averages use closed
// tanks only until the job is completed.

export type MixChemicalLine = { chemical_id: string; name: string; amount: number; unit: string };

export type MixInput = {
  mix_number: number;
  status: "active" | "completed";
  is_extra?: boolean;
  water_l: number;
  leftover_l: number;
  chemicals: MixChemicalLine[];
};

export type RowInput = {
  completed: boolean;
  /** Mixes that sprayed this row, in order. Old snapshots only have completedByMixNumber. */
  mixNumbers?: number[] | null;
  completedByMixNumber?: number | null;
};

export type PlanInput = {
  water_l: number | null;
  mixes: number | null;
  chemicals: MixChemicalLine[];
};

export type Comparison = { planned: number | null; actual: number; diff: number | null; pct: number | null };

export type ChemicalTotals = {
  chemical_id: string;
  name: string;
  unit: string;
  planned: number | null;
  mixed: number;
  leftover: number;
  applied: number;
  /** Average applied per completed row (closed tanks only); null until a tank is closed with rows. */
  per_row: number | null;
  applied_vs_plan: Comparison;
  mixed_vs_plan: Comparison;
};

export type MixShare = {
  mix_number: number;
  status: "active" | "completed";
  is_extra: boolean;
  /** Rows covered, counting a row split across two tanks as ½ to each. */
  rows: number;
  water_mixed: number;
  water_applied: number | null;
  avg_water_per_row: number | null;
  chemicals: Array<{ chemical_id: string; mixed: number; applied: number | null; avg_per_row: number | null }>;
};

export type MixSummary = {
  planned_mixes: number | null;
  mixes_made: number;
  extra_mixes: number;
  active_mix_number: number | null;
  completed_rows: number;
  rows_without_mix: number;
  water: {
    planned: number | null;
    mixed: number;
    leftover: number;
    applied: number;
    per_row: number | null;
    applied_vs_plan: Comparison;
    mixed_vs_plan: Comparison;
  };
  chemicals: ChemicalTotals[];
  /** true while a tank is still in use (its applied amount is not known yet). */
  applied_pending: boolean;
  /** Rows the per-row averages are based on (closed tanks only). */
  per_row_basis_rows: number;
  mixes: MixShare[];
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function compare(planned: number | null, actual: number): Comparison {
  if (planned == null || !Number.isFinite(planned)) return { planned: null, actual, diff: null, pct: null };
  const diff = actual - planned;
  return { planned, actual, diff, pct: planned > 0 ? (diff / planned) * 100 : null };
}

export function rowMixNumbers(row: RowInput): number[] {
  const list = Array.isArray(row.mixNumbers) ? row.mixNumbers.filter((x) => Number.isInteger(x) && x > 0) : [];
  if (list.length === 0 && Number.isInteger(row.completedByMixNumber) && (row.completedByMixNumber as number) > 0) {
    list.push(row.completedByMixNumber as number);
  }
  return [...new Set(list)];
}

function appliedShare(m: MixInput): number {
  const water = n(m.water_l);
  if (water <= 0) return m.chemicals.length ? 1 : 0;
  return Math.max(0, water - Math.min(n(m.leftover_l), water)) / water;
}

export function summarizeMixes(plan: PlanInput, mixes: MixInput[], rows: RowInput[], options: { assumeClosed?: boolean } = {}): MixSummary {
  const sorted = [...mixes].sort((a, b) => a.mix_number - b.mix_number);
  const isOpen = (m: MixInput) => !options.assumeClosed && m.status === "active";

  // Row coverage per mix: 1 / (number of tanks that sprayed the row).
  const coverage = new Map<number, number>();
  let completedRows = 0;
  let rowsWithoutMix = 0;
  for (const row of rows) {
    if (!row.completed) continue;
    completedRows += 1;
    const nums = rowMixNumbers(row).filter((x) => sorted.some((m) => m.mix_number === x));
    if (nums.length === 0) {
      rowsWithoutMix += 1;
      continue;
    }
    for (const x of nums) coverage.set(x, (coverage.get(x) ?? 0) + 1 / nums.length);
  }

  // Chemical lines: planned ones first, then any recorded only in mixes.
  const chemOrder: Array<{ chemical_id: string; name: string; unit: string }> = [];
  const seen = new Set<string>();
  for (const c of [...plan.chemicals, ...sorted.flatMap((m) => m.chemicals)]) {
    if (seen.has(c.chemical_id)) continue;
    seen.add(c.chemical_id);
    chemOrder.push({ chemical_id: c.chemical_id, name: c.name, unit: c.unit });
  }

  let waterMixed = 0;
  let waterLeftover = 0;
  let waterApplied = 0;
  let closedWaterApplied = 0;
  let closedRows = 0;
  const chemMixed = new Map<string, number>();
  const chemLeftover = new Map<string, number>();
  const chemApplied = new Map<string, number>();
  const chemClosedApplied = new Map<string, number>();
  const shares: MixShare[] = [];

  for (const m of sorted) {
    const open = isOpen(m);
    const share = appliedShare(m);
    const water = n(m.water_l);
    const leftover = open ? 0 : Math.min(n(m.leftover_l), water);
    const rowsCovered = coverage.get(m.mix_number) ?? 0;
    waterMixed += water;
    waterLeftover += leftover;
    if (!open) {
      waterApplied += water - leftover;
      closedWaterApplied += water - leftover;
      closedRows += rowsCovered;
    }
    const mixChems: MixShare["chemicals"] = [];
    for (const c of m.chemicals) {
      const amount = n(c.amount);
      chemMixed.set(c.chemical_id, (chemMixed.get(c.chemical_id) ?? 0) + amount);
      const applied = open ? null : amount * share;
      if (applied != null) {
        chemApplied.set(c.chemical_id, (chemApplied.get(c.chemical_id) ?? 0) + applied);
        chemLeftover.set(c.chemical_id, (chemLeftover.get(c.chemical_id) ?? 0) + (amount - applied));
        chemClosedApplied.set(c.chemical_id, (chemClosedApplied.get(c.chemical_id) ?? 0) + applied);
      }
      mixChems.push({
        chemical_id: c.chemical_id,
        mixed: amount,
        applied,
        avg_per_row: applied != null && rowsCovered > 0 ? applied / rowsCovered : null
      });
    }
    shares.push({
      mix_number: m.mix_number,
      status: options.assumeClosed ? "completed" : m.status,
      is_extra: Boolean(m.is_extra),
      rows: rowsCovered,
      water_mixed: water,
      water_applied: open ? null : water - leftover,
      avg_water_per_row: !open && rowsCovered > 0 ? (water - leftover) / rowsCovered : null,
      chemicals: mixChems
    });
  }

  const active = sorted.find((m) => isOpen(m)) ?? null;
  const plannedMixes = plan.mixes != null && plan.mixes > 0 ? plan.mixes : null;

  return {
    planned_mixes: plannedMixes,
    mixes_made: sorted.length,
    extra_mixes: plannedMixes == null ? 0 : Math.max(0, sorted.length - plannedMixes),
    active_mix_number: active?.mix_number ?? null,
    completed_rows: completedRows,
    rows_without_mix: rowsWithoutMix,
    water: {
      planned: plan.water_l,
      mixed: waterMixed,
      leftover: waterLeftover,
      applied: waterApplied,
      per_row: closedRows > 0 ? closedWaterApplied / closedRows : null,
      applied_vs_plan: compare(plan.water_l, waterApplied),
      mixed_vs_plan: compare(plan.water_l, waterMixed)
    },
    chemicals: chemOrder.map((c) => {
      const planned = plan.chemicals.find((p) => p.chemical_id === c.chemical_id)?.amount ?? null;
      const mixed = chemMixed.get(c.chemical_id) ?? 0;
      const applied = chemApplied.get(c.chemical_id) ?? 0;
      return {
        ...c,
        planned,
        mixed,
        leftover: chemLeftover.get(c.chemical_id) ?? 0,
        applied,
        per_row: closedRows > 0 ? (chemClosedApplied.get(c.chemical_id) ?? 0) / closedRows : null,
        applied_vs_plan: compare(planned, applied),
        mixed_vs_plan: compare(planned, mixed)
      };
    }),
    applied_pending: active != null,
    per_row_basis_rows: closedRows,
    mixes: shares
  };
}

/** The plan baseline from a todo's snapshots (never modified by execution). */
export function planFromTodo(todo: {
  chemical_id?: string | null;
  chemical_snapshot?: Record<string, unknown> | null;
  calculation_snapshot?: Record<string, unknown> | null;
}): PlanInput {
  const calc = todo.calculation_snapshot ?? {};
  const chem = todo.chemical_snapshot ?? {};
  const rateUnit = typeof calc.rate_unit === "string" ? calc.rate_unit : typeof chem.rate_unit === "string" ? chem.rate_unit : "";
  const unit = /^(g|kg)_/.test(rateUnit) ? "g" : "ml";
  const total = typeof calc.total_chemical_ml === "number" ? calc.total_chemical_ml : null;
  return {
    water_l: typeof calc.total_volume_l === "number" ? calc.total_volume_l : null,
    mixes: typeof calc.tank_count === "number" ? calc.tank_count : null,
    chemicals: todo.chemical_id && total != null
      ? [{ chemical_id: todo.chemical_id, name: typeof chem.name === "string" ? chem.name : "", amount: total, unit }]
      : []
  };
}
