// Planned-versus-actual figures for one spray job's mixes.
//
// Kept identical to server/src/utils/pestMixSummary.ts (the record frozen at
// completion uses the same numbers the progress card showed offline);
// pestMixSummary.test.ts fails if the two drift apart.
//
// Definitions
//   mixed    what the operator recorded putting in the tanks (or, for a mix
//            carried over from before 0158, the plan's amounts — a PLANNED
//            ESTIMATE until an operator confirms it)
//   leftover mixture not applied (drained, returned, left in the tank).
//            null = NOT RECORDED. Never read as 0.
//   applied  mixed − leftover, for tanks that are closed and whose leftover
//            is recorded. Chemical applied is the chemical mixed scaled by the
//            share of the tank's water that was applied (a mixed tank is one
//            solution, so a leftover carries chemical with it). When any tank
//            is still in use or has no leftover recorded, the job's applied
//            total is NOT KNOWN (null); `applied_known` is the part that is
//            known and `applied_max` (= mixed − recorded leftovers) the most
//            it can be.
//   per row  an AVERAGE: a tank's applied water/chemical divided by the rows
//            it covered. No row is ever measured individually. A row started
//            on one tank and finished on another counts once in total, split
//            ½ to each tank — an ESTIMATE, since where the tank ran out along
//            the row isn't measured.

export type MixChemicalLine = { chemical_id: string; name: string; amount: number; unit: string };

export type MixInput = {
  mix_number: number;
  status: "active" | "completed";
  is_extra?: boolean;
  water_l: number;
  /** null = leftover not recorded. */
  leftover_l: number | null;
  chemicals: MixChemicalLine[];
  /** Amounts are the plan's, carried over from before mix tracking — not yet confirmed. */
  estimated?: boolean;
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

/** actual null = not known (diff and pct are then null too). */
export type Comparison = { planned: number | null; actual: number | null; diff: number | null; pct: number | null };

type Totals = {
  planned: number | null;
  mixed: number;
  /** Sum of the leftovers that were recorded. */
  leftover: number;
  /** Total applied; null unless every tank is closed with its leftover recorded. */
  applied: number | null;
  /** Applied by the tanks whose leftover is recorded. */
  applied_known: number;
  /** The most that can have been applied: mixed − recorded leftovers. */
  applied_max: number;
  /** Average applied per completed row over tanks with a known applied amount. */
  per_row: number | null;
  applied_vs_plan: Comparison;
  mixed_vs_plan: Comparison;
};

export type ChemicalTotals = Totals & { chemical_id: string; name: string; unit: string };

export type MixShare = {
  mix_number: number;
  status: "active" | "completed";
  is_extra: boolean;
  /** Planned estimate carried over from before mix tracking. */
  estimated: boolean;
  leftover_recorded: boolean;
  /** Rows covered, counting a row split across two tanks as ½ to each. */
  rows: number;
  /** The part of `rows` that comes from estimated ½-splits. */
  split_rows: number;
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
  /** Completed rows sprayed by more than one tank (coverage split ½ each, estimated). */
  split_rows: number;
  water: Totals;
  chemicals: ChemicalTotals[];
  /** true when every tank is closed with its leftover recorded. */
  applied_complete: boolean;
  /** true while a tank is still in use. */
  applied_pending: boolean;
  /** Closed tanks whose leftover was not recorded. */
  unknown_leftover_mixes: number[];
  /** Mixes whose amounts are planned estimates, not confirmed. */
  estimated_mixes: number[];
  /** Rows the per-row averages are based on. */
  per_row_basis_rows: number;
  /** Per-row averages lean on ½-splits or planned estimates. */
  per_row_estimated: boolean;
  mixes: MixShare[];
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function compare(planned: number | null, actual: number | null): Comparison {
  if (planned == null || !Number.isFinite(planned) || actual == null) return { planned: planned ?? null, actual, diff: null, pct: null };
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

export function summarizeMixes(plan: PlanInput, mixes: MixInput[], rows: RowInput[], options: { assumeClosed?: boolean } = {}): MixSummary {
  const sorted = [...mixes].sort((a, b) => a.mix_number - b.mix_number);
  const isOpen = (m: MixInput) => !options.assumeClosed && m.status === "active";
  const leftoverOf = (m: MixInput): number | null =>
    m.leftover_l == null || !Number.isFinite(m.leftover_l) ? null : Math.min(Math.max(m.leftover_l, 0), n(m.water_l));
  /** Applied share of the tank, or null when not known (in use / leftover not recorded). */
  const appliedShare = (m: MixInput): number | null => {
    if (isOpen(m)) return null;
    const left = leftoverOf(m);
    if (left == null) return null;
    const water = n(m.water_l);
    return water > 0 ? (water - left) / water : 1;
  };

  // Row coverage per mix: 1 / (number of tanks that sprayed the row).
  const coverage = new Map<number, number>();
  const splitCoverage = new Map<number, number>();
  let completedRows = 0;
  let rowsWithoutMix = 0;
  let splitRows = 0;
  for (const row of rows) {
    if (!row.completed) continue;
    completedRows += 1;
    const nums = rowMixNumbers(row).filter((x) => sorted.some((m) => m.mix_number === x));
    if (nums.length === 0) {
      rowsWithoutMix += 1;
      continue;
    }
    if (nums.length > 1) splitRows += 1;
    for (const x of nums) {
      coverage.set(x, (coverage.get(x) ?? 0) + 1 / nums.length);
      if (nums.length > 1) splitCoverage.set(x, (splitCoverage.get(x) ?? 0) + 1 / nums.length);
    }
  }

  // Chemical lines: planned ones first, then any recorded only in mixes.
  const chemOrder: Array<{ chemical_id: string; name: string; unit: string }> = [];
  const seen = new Set<string>();
  for (const c of [...plan.chemicals, ...sorted.flatMap((m) => m.chemicals)]) {
    if (seen.has(c.chemical_id)) continue;
    seen.add(c.chemical_id);
    chemOrder.push({ chemical_id: c.chemical_id, name: c.name, unit: c.unit });
  }

  type Acc = { mixed: number; leftover: number; appliedKnown: number; perRowApplied: number };
  const water: Acc = { mixed: 0, leftover: 0, appliedKnown: 0, perRowApplied: 0 };
  const chem = new Map<string, Acc>(chemOrder.map((c) => [c.chemical_id, { mixed: 0, leftover: 0, appliedKnown: 0, perRowApplied: 0 }]));
  let basisRows = 0;
  let basisEstimated = false;
  const shares: MixShare[] = [];
  const unknownLeftover: number[] = [];
  let anyOpen = false;

  for (const m of sorted) {
    const open = isOpen(m);
    if (open) anyOpen = true;
    const share = appliedShare(m);
    const left = open ? null : leftoverOf(m);
    if (!open && left == null) unknownLeftover.push(m.mix_number);
    const waterMixed = n(m.water_l);
    const rowsCovered = coverage.get(m.mix_number) ?? 0;
    const waterApplied = share == null ? null : waterMixed * share;
    water.mixed += waterMixed;
    if (left != null) water.leftover += left;
    if (waterApplied != null) {
      water.appliedKnown += waterApplied;
      if (rowsCovered > 0) {
        water.perRowApplied += waterApplied;
        basisRows += rowsCovered;
        if ((splitCoverage.get(m.mix_number) ?? 0) > 0 || m.estimated) basisEstimated = true;
      }
    }
    const mixChems: MixShare["chemicals"] = [];
    for (const c of m.chemicals) {
      const acc = chem.get(c.chemical_id)!;
      const amount = n(c.amount);
      const applied = share == null ? null : amount * share;
      acc.mixed += amount;
      if (applied != null) {
        acc.appliedKnown += applied;
        acc.leftover += amount - applied;
        if (rowsCovered > 0) acc.perRowApplied += applied;
      }
      mixChems.push({ chemical_id: c.chemical_id, mixed: amount, applied, avg_per_row: applied != null && rowsCovered > 0 ? applied / rowsCovered : null });
    }
    shares.push({
      mix_number: m.mix_number,
      status: options.assumeClosed ? "completed" : m.status,
      is_extra: Boolean(m.is_extra),
      estimated: Boolean(m.estimated),
      leftover_recorded: left != null,
      rows: rowsCovered,
      split_rows: splitCoverage.get(m.mix_number) ?? 0,
      water_mixed: waterMixed,
      water_applied: waterApplied,
      avg_water_per_row: waterApplied != null && rowsCovered > 0 ? waterApplied / rowsCovered : null,
      chemicals: mixChems
    });
  }

  const complete = !anyOpen && unknownLeftover.length === 0;
  const totals = (planned: number | null, a: Acc, leftover: number): Totals => {
    const applied = complete ? a.appliedKnown : null;
    return {
      planned,
      mixed: a.mixed,
      leftover,
      applied,
      applied_known: a.appliedKnown,
      applied_max: a.mixed - leftover,
      per_row: basisRows > 0 ? a.perRowApplied / basisRows : null,
      applied_vs_plan: compare(planned, applied),
      mixed_vs_plan: compare(planned, a.mixed)
    };
  };

  const active = sorted.find((m) => isOpen(m)) ?? null;
  const plannedMixes = plan.mixes != null && plan.mixes > 0 ? plan.mixes : null;

  return {
    planned_mixes: plannedMixes,
    mixes_made: sorted.length,
    extra_mixes: plannedMixes == null ? 0 : Math.max(0, sorted.length - plannedMixes),
    active_mix_number: active?.mix_number ?? null,
    completed_rows: completedRows,
    rows_without_mix: rowsWithoutMix,
    split_rows: splitRows,
    water: totals(plan.water_l, water, water.leftover),
    chemicals: chemOrder.map((c) => {
      const a = chem.get(c.chemical_id)!;
      const planned = plan.chemicals.find((p) => p.chemical_id === c.chemical_id)?.amount ?? null;
      return { ...c, ...totals(planned, a, a.leftover) };
    }),
    applied_complete: complete,
    applied_pending: anyOpen,
    unknown_leftover_mixes: unknownLeftover,
    estimated_mixes: sorted.filter((m) => m.estimated).map((m) => m.mix_number),
    per_row_basis_rows: basisRows,
    per_row_estimated: basisEstimated,
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
