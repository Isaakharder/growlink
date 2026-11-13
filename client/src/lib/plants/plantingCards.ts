// Crop Planner → Plants (stage 1, read-only): one card per variety that is
// assigned to rows in Greenhouse Setup, sorted into Active, Upcoming and Past
// by the variety's planting and pull-out dates against the organization's
// local date.
//
// Today a "planting" is a variety's live row assignments plus the dates on
// the variety itself; the dated planting model (stage 2) will give each
// planting its own dates and rows.
//
// Totals never count a missing input as zero. A row without a width or length
// leaves the m² total incomplete; a row without slabs or plants per slab
// leaves plants and heads incomplete. Each card lists what is missing.

export type PlantingStatus = "active" | "upcoming" | "past";

/** The greenhouse and catalog every card is worked out against. */
export type PlantsGreenhouse = {
  today: string; // YYYY-MM-DD in the organization's time zone
  timeZone: string;
  groups: Array<{ id: string; type: string; name: string; status: string }>;
  rows: Array<{
    group_id: string;
    row_number: number;
    slab_count: number;
    plants_per_slab: number;
    stems_per_plant: number | null;
    /** The row's m² (its own width × length, else its section's); null when neither is set. */
    area_m2: number | null;
  }>;
  varieties: Array<{
    id: string;
    name: string;
    color: string | null;
    status: string;
    product_code: string | null;
    planting_date: string | null;
    pull_out_date: string | null;
  }>;
  products: Array<{ code: string; name: string; status: string }>;
};

export type RowRef = { group_id: string; row_number: number };
/** A planting's row; pull_out_date is the row's own (partial pull-out), if it ends before the planting. */
export type PlantingRowRef = RowRef & { pull_out_date?: string | null };

/** A row's last day in the ground: the earlier of its own pull-out date and its planting's (null = open-ended). */
export function rowEnd(rowPullOut: string | null | undefined, plantingPullOut: string | null): string | null {
  if (rowPullOut && plantingPullOut) return rowPullOut < plantingPullOut ? rowPullOut : plantingPullOut;
  return rowPullOut ?? plantingPullOut;
}

/** One variety on a set of rows from its planting date to its optional pull-out date. */
export type PlantingInput = {
  id: string;
  variety_id: string;
  planting_date: string | null;
  pull_out_date: string | null;
  rows: PlantingRowRef[];
};

/** Stage 1: today's undated Greenhouse Setup assignments; the variety carries the dates. */
export type PlantingsData = PlantsGreenhouse & {
  assignments: Array<{
    id: string;
    group_id: string;
    variety_id: string;
    start_row: number;
    end_row: number;
    assignment_pattern: "all" | "every_other";
  }>;
};

/** The dated planting model (0156): each planting has its own dates and rows. */
export type DatedPlantingsData = PlantsGreenhouse & {
  plantings: Array<PlantingInput & { planting_date: string; notes: string | null }>;
};

/** A total over rows: the sum of the rows that have the input, and how many rows don't. */
export type Measure = { value: number; missingRows: number };

export type PhaseLine = {
  groupId: string;
  groupName: string;
  rowNumbers: number[];
  rowsLabel: string;
  m2: Measure;
  plants: Measure;
  heads: Measure;
  /** Rows the assignment lists that Greenhouse Setup doesn't have. */
  rowsNotInSetup: number[];
};

export type PlantingCard = {
  plantingId: string;
  varietyId: string;
  varietyName: string;
  color: string | null;
  cropName: string | null;
  plantingDate: string | null;
  pullOutDate: string | null;
  status: PlantingStatus;
  phases: PhaseLine[];
  rowCount: number;
  m2: Measure;
  plants: Measure;
  heads: Measure;
  issues: string[];
  /** Rows pulled out before the planting's own pull-out date, by date: "Phase 1 rows 1–4". */
  endedEarly: Array<{ date: string; rows: string }>;
};

export type PlantingBoard = Record<PlantingStatus, PlantingCard[]>;

export function statusOn(today: string, plantingDate: string | null, pullOutDate: string | null): PlantingStatus {
  // ISO dates compare correctly as strings. A planting is still Active on its
  // pull-out date and becomes Past the day after.
  if (pullOutDate && pullOutDate < today) return "past";
  if (plantingDate && plantingDate > today) return "upcoming";
  return "active";
}

/** Rows an assignment covers: every row from start to end, or every other row. */
export function assignmentRows(a: { start_row: number; end_row: number; assignment_pattern: string }): number[] {
  const step = a.assignment_pattern === "every_other" ? 2 : 1;
  const rows: number[] = [];
  for (let r = a.start_row; r <= a.end_row; r += step) rows.push(r);
  return rows;
}

/** 1, 2, 3, 5, 7 → "1–3, 5, 7" */
export function compressRows(rowNumbers: number[]): string {
  const sorted = [...new Set(rowNumbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

const add = (into: Measure, value: number | null) => {
  if (value === null) into.missingRows += 1;
  else into.value += value;
};
const zero = (): Measure => ({ value: 0, missingRows: 0 });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Stage 1: one planting per variety, from its live assignments and the variety's dates. */
export function buildPlantingBoard(data: PlantingsData): PlantingBoard {
  const byVariety = new Map<string, RowRef[]>();
  for (const a of data.assignments) {
    const list = byVariety.get(a.variety_id) ?? [];
    byVariety.set(a.variety_id, list);
    for (const r of assignmentRows(a)) list.push({ group_id: a.group_id, row_number: r });
  }
  const varieties = new Map(data.varieties.map((v) => [v.id, v]));
  const plantings: PlantingInput[] = [...byVariety].map(([varietyId, rows]) => ({
    id: varietyId,
    variety_id: varietyId,
    planting_date: varieties.get(varietyId)?.planting_date ?? null,
    pull_out_date: varieties.get(varietyId)?.pull_out_date ?? null,
    rows
  }));
  return buildBoard(data, plantings);
}

/** One card per planting, sorted into Active, Upcoming and Past by the organization's today. */
export function buildBoard(data: PlantsGreenhouse, plantings: PlantingInput[]): PlantingBoard {
  const rowsByKey = new Map(data.rows.map((r) => [`${r.group_id}:${r.row_number}`, r]));
  const groupsById = new Map(data.groups.map((g) => [g.id, g]));
  const groupOrder = new Map(data.groups.map((g, i) => [g.id, i]));
  const varietiesById = new Map(data.varieties.map((v) => [v.id, v]));
  const productNames = new Map(data.products.map((p) => [p.code, p.name]));

  const board: PlantingBoard = { active: [], upcoming: [], past: [] };
  const cards: PlantingCard[] = [];

  for (const planting of plantings) {
    const varietyId = planting.variety_id;
    // group → row numbers (a row listed twice counts once)
    const groups = new Map<string, Set<number>>();
    for (const r of planting.rows) {
      const set = groups.get(r.group_id) ?? new Set<number>();
      groups.set(r.group_id, set);
      set.add(r.row_number);
    }
    const variety = varietiesById.get(varietyId);
    const plantingDate = planting.planting_date;
    const pullOutDate = planting.pull_out_date;
    const card: PlantingCard = {
      plantingId: planting.id,
      varietyId,
      varietyName: variety?.name ?? "Unknown variety",
      color: variety?.color ?? null,
      cropName: variety?.product_code ? productNames.get(variety.product_code) ?? null : null,
      plantingDate,
      pullOutDate,
      status: statusOn(data.today, plantingDate, pullOutDate),
      phases: [],
      rowCount: 0,
      m2: zero(),
      plants: zero(),
      heads: zero(),
      issues: [],
      endedEarly: []
    };

    const orderedGroups = [...groups.entries()].sort(
      ([a], [b]) => (groupOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(b) ?? Number.MAX_SAFE_INTEGER)
    );
    for (const [groupId, rowSet] of orderedGroups) {
      const rowNumbers = [...rowSet].sort((a, b) => a - b);
      const line: PhaseLine = {
        groupId,
        groupName: groupsById.get(groupId)?.name ?? "Unknown phase",
        rowNumbers,
        rowsLabel: compressRows(rowNumbers),
        m2: zero(),
        plants: zero(),
        heads: zero(),
        rowsNotInSetup: []
      };
      for (const n of rowNumbers) {
        const row = rowsByKey.get(`${groupId}:${n}`);
        if (!row) {
          line.rowsNotInSetup.push(n);
          add(line.m2, null);
          add(line.plants, null);
          add(line.heads, null);
          continue;
        }
        const area = row.area_m2 && row.area_m2 > 0 ? row.area_m2 : null;
        const plants = row.slab_count > 0 && row.plants_per_slab > 0 ? row.slab_count * row.plants_per_slab : null;
        const heads = plants !== null && row.stems_per_plant && row.stems_per_plant > 0 ? plants * row.stems_per_plant : null;
        add(line.m2, area);
        add(line.plants, plants);
        add(line.heads, heads);
      }
      card.phases.push(line);
      card.rowCount += rowNumbers.length;
      for (const key of ["m2", "plants", "heads"] as const) {
        card[key].value += line[key].value;
        card[key].missingRows += line[key].missingRows;
      }
    }

    // Rows pulled out early, grouped by date and phase.
    const early = new Map<string, Map<string, number[]>>();
    for (const r of planting.rows) {
      if (!r.pull_out_date || (pullOutDate && r.pull_out_date >= pullOutDate)) continue;
      const byGroup = early.get(r.pull_out_date) ?? new Map<string, number[]>();
      early.set(r.pull_out_date, byGroup);
      byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r.row_number]);
    }
    card.endedEarly = [...early.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, byGroup]) => ({
        date,
        rows: [...byGroup].map(([g, nums]) => `${groupsById.get(g)?.name ?? "Phase"} row${nums.length === 1 ? "" : "s"} ${compressRows(nums)}`).join("; ")
      }));

    // Flags, never zeros.
    if (!variety) card.issues.push("This variety no longer exists in Varieties.");
    if (!plantingDate) card.issues.push("No planting date. Add one in Crop Planner → Varieties.");
    if (planting.rows.length === 0) card.issues.push("No rows linked yet.");
    if (plantingDate && pullOutDate && pullOutDate < plantingDate) card.issues.push("The pull-out date is before the planting date.");
    for (const line of card.phases) {
      if (line.rowsNotInSetup.length) {
        card.issues.push(`${line.groupName}: ${plural(line.rowsNotInSetup.length, "row")} not in Greenhouse Setup (${compressRows(line.rowsNotInSetup)}).`);
      }
    }
    const notInSetup = card.phases.reduce((n, l) => n + l.rowsNotInSetup.length, 0);
    const missingArea = card.m2.missingRows - notInSetup;
    const missingPlants = card.plants.missingRows - notInSetup;
    const missingHeads = card.heads.missingRows - card.plants.missingRows;
    if (missingArea > 0) card.issues.push(`${plural(missingArea, "row")} without a width or length: m² is incomplete.`);
    if (missingPlants > 0) card.issues.push(`${plural(missingPlants, "row")} without slabs or plants per slab: plants and heads are incomplete.`);
    if (missingHeads > 0) card.issues.push(`${plural(missingHeads, "row")} without stems per plant: heads are incomplete.`);
    cards.push(card);
  }

  // A row assigned to two varieties that are both in the ground today.
  const activeOwners = new Map<string, string[]>();
  const rowEnds = new Map<string, string | null>();
  for (const p of plantings) for (const r of p.rows) rowEnds.set(`${p.id}|${r.group_id}:${r.row_number}`, rowEnd(r.pull_out_date, p.pull_out_date));
  for (const card of cards.filter((c) => c.status === "active")) {
    for (const line of card.phases) {
      for (const n of line.rowNumbers) {
        const key = `${line.groupId}:${n}`;
        const end = rowEnds.get(`${card.plantingId}|${key}`);
        if (end && end < data.today) continue; // pulled out early: not in the ground today
        activeOwners.set(key, [...(activeOwners.get(key) ?? []), card.plantingId]);
      }
    }
  }
  for (const card of cards.filter((c) => c.status === "active")) {
    for (const line of card.phases) {
      const shared = line.rowNumbers.filter((n) => {
        const owners = activeOwners.get(`${line.groupId}:${n}`) ?? [];
        return owners.length > 1 && owners.includes(card.plantingId);
      });
      if (shared.length) {
        const nameOf = new Map(cards.map((c) => [c.plantingId, c.varietyName]));
        const others = new Set(
          shared.flatMap((n) => activeOwners.get(`${line.groupId}:${n}`)!).filter((id) => id !== card.plantingId).map((id) => nameOf.get(id) ?? "another variety")
        );
        card.issues.push(`${line.groupName} rows ${compressRows(shared)} are also assigned to ${[...others].join(", ")} today.`);
      }
    }
  }

  for (const card of cards) board[card.status].push(card);
  const byDate = (key: "plantingDate" | "pullOutDate", dir: 1 | -1) => (a: PlantingCard, b: PlantingCard) =>
    ((a[key] ?? "") < (b[key] ?? "") ? -dir : (a[key] ?? "") > (b[key] ?? "") ? dir : 0) || a.varietyName.localeCompare(b.varietyName);
  board.active.sort(byDate("plantingDate", 1));
  board.upcoming.sort(byDate("plantingDate", 1));
  board.past.sort(byDate("pullOutDate", -1));
  return board;
}
