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

export type PlantingsData = {
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
  assignments: Array<{
    id: string;
    group_id: string;
    variety_id: string;
    start_row: number;
    end_row: number;
    assignment_pattern: "all" | "every_other";
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

export function buildPlantingBoard(data: PlantingsData): PlantingBoard {
  const rowsByKey = new Map(data.rows.map((r) => [`${r.group_id}:${r.row_number}`, r]));
  const groupsById = new Map(data.groups.map((g) => [g.id, g]));
  const groupOrder = new Map(data.groups.map((g, i) => [g.id, i]));
  const varietiesById = new Map(data.varieties.map((v) => [v.id, v]));
  const productNames = new Map(data.products.map((p) => [p.code, p.name]));

  // variety → group → row numbers (an assignment can repeat or overlap another of the same variety)
  const byVariety = new Map<string, Map<string, Set<number>>>();
  for (const a of data.assignments) {
    const groups = byVariety.get(a.variety_id) ?? new Map<string, Set<number>>();
    byVariety.set(a.variety_id, groups);
    const set = groups.get(a.group_id) ?? new Set<number>();
    groups.set(a.group_id, set);
    for (const r of assignmentRows(a)) set.add(r);
  }

  const board: PlantingBoard = { active: [], upcoming: [], past: [] };
  const cards: PlantingCard[] = [];

  for (const [varietyId, groups] of byVariety) {
    const variety = varietiesById.get(varietyId);
    const plantingDate = variety?.planting_date ?? null;
    const pullOutDate = variety?.pull_out_date ?? null;
    const card: PlantingCard = {
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
      issues: []
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

    // Flags, never zeros.
    if (!variety) card.issues.push("This variety no longer exists in Varieties.");
    if (!plantingDate) card.issues.push("No planting date. Add one in Crop Planner → Varieties.");
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
  for (const card of cards.filter((c) => c.status === "active")) {
    for (const line of card.phases) {
      for (const n of line.rowNumbers) {
        const key = `${line.groupId}:${n}`;
        activeOwners.set(key, [...(activeOwners.get(key) ?? []), card.varietyId]);
      }
    }
  }
  for (const card of cards.filter((c) => c.status === "active")) {
    for (const line of card.phases) {
      const shared = line.rowNumbers.filter((n) => (activeOwners.get(`${line.groupId}:${n}`) ?? []).length > 1);
      if (shared.length) {
        const others = new Set(
          shared.flatMap((n) => activeOwners.get(`${line.groupId}:${n}`)!).filter((id) => id !== card.varietyId).map((id) => varietiesById.get(id)?.name ?? "another variety")
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
