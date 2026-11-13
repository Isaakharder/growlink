// Greenhouse maps (migration 0155): validation of a map before it is saved,
// and matching a LabourLink layout file to an organization's Greenhouse Setup.
//
// Pure functions, no database: the route loads the organization's groups and
// rows and passes them in.
//
// Matching never guesses and never creates anything. A LabourLink phase
// matches the Greenhouse Setup group with the same name (case and spacing
// ignored) only when exactly one group has that name; a LabourLink row
// matches the row with the same number in that group. Everything else is
// reported for the user to resolve (pick the group, pick the row number, or
// leave it off the map), and the import is refused until nothing is left
// unresolved.

export type Orientation = "horizontal" | "vertical";

export type SetupGroup = { id: string; name: string; type: string; status?: string | null };
export type SetupRow = { group_id: string; row_number: number };
export type Setup = { groups: SetupGroup[]; rows: SetupRow[] };

export type MapRow = {
  row_number: number;
  x_ft: number;
  y_ft: number;
  width_ft: number;
  length_ft: number;
  orientation: Orientation;
};
export type MapPhase = {
  group_id: string;
  x_feet_from_west: number;
  y_feet_from_north: number;
  east_west_feet: number;
  north_south_feet: number;
  sort_order: number | null;
  rows: MapRow[];
};
export type GreenhouseMapInput = {
  name: string;
  east_west_feet: number;
  north_south_feet: number;
  source?: "builder" | "labourlink_import";
  phases: MapPhase[];
};

export const MAX_MAP_PHASES = 200;
export const MAX_MAP_ROWS = 10000;
const EPSILON = 0.001;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MapInputError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
  }
}

const finite = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/** On-map width/height of a row: a horizontal row runs east-west. */
export function rowExtent(row: Pick<MapRow, "width_ft" | "length_ft" | "orientation">) {
  return row.orientation === "horizontal"
    ? { width: row.length_ft, height: row.width_ft }
    : { width: row.width_ft, height: row.length_ft };
}

/**
 * Parses and checks a map for one organization. Throws MapInputError listing
 * every problem; returns the normalized map otherwise. Every phase must be one
 * of the organization's Greenhouse Setup groups and every row one of its rows;
 * phases must lie on the land, rows inside their phase without overlapping.
 */
export function parseMap(raw: unknown, setup: Setup): GreenhouseMapInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) problems.push("The map needs a name of 1 to 120 characters.");
  const ew = finite(body.east_west_feet);
  const ns = finite(body.north_south_feet);
  if (!(ew > 0 && ew <= 100000) || !(ns > 0 && ns <= 100000)) problems.push("The land's east-west and north-south size must be between 0 and 100,000 ft.");
  const source = body.source === "labourlink_import" ? "labourlink_import" : "builder";

  const groups = new Map(setup.groups.map((g) => [g.id, g]));
  const setupRows = new Set(setup.rows.map((r) => `${r.group_id}:${r.row_number}`));
  const rawPhases = Array.isArray(body.phases) ? body.phases : [];
  if (!Array.isArray(body.phases)) problems.push("phases must be a list.");
  if (rawPhases.length > MAX_MAP_PHASES) problems.push(`A map can hold at most ${MAX_MAP_PHASES} phases.`);
  const totalRows = rawPhases.reduce((n: number, p) => n + (Array.isArray((p as { rows?: unknown })?.rows) ? ((p as { rows: unknown[] }).rows.length) : 0), 0);
  if (totalRows > MAX_MAP_ROWS) problems.push(`A map can hold at most ${MAX_MAP_ROWS} rows.`);
  if (problems.length) throw new MapInputError("The map can't be saved.", problems);

  const seenGroups = new Set<string>();
  const phases: MapPhase[] = [];
  for (const rawPhase of rawPhases) {
    const p = (rawPhase ?? {}) as Record<string, unknown>;
    const groupId = typeof p.group_id === "string" ? p.group_id : "";
    const group = UUID.test(groupId) ? groups.get(groupId) : undefined;
    if (!group) {
      problems.push("A phase on the map is not a group in this organization's Greenhouse Setup.");
      continue;
    }
    if (seenGroups.has(groupId)) {
      problems.push(`${group.name} is on the map more than once.`);
      continue;
    }
    seenGroups.add(groupId);
    const phase: MapPhase = {
      group_id: groupId,
      x_feet_from_west: finite(p.x_feet_from_west),
      y_feet_from_north: finite(p.y_feet_from_north),
      east_west_feet: finite(p.east_west_feet),
      north_south_feet: finite(p.north_south_feet),
      sort_order: Number.isInteger(p.sort_order) ? (p.sort_order as number) : null,
      rows: []
    };
    if (![phase.x_feet_from_west, phase.y_feet_from_north].every((v) => v >= 0) || !(phase.east_west_feet > 0 && phase.north_south_feet > 0)) {
      problems.push(`${group.name} needs a position of 0 ft or more and a size greater than 0 ft.`);
      continue;
    }
    if (phase.x_feet_from_west + phase.east_west_feet > ew + EPSILON || phase.y_feet_from_north + phase.north_south_feet > ns + EPSILON) {
      problems.push(`${group.name} extends past the edge of the land.`);
    }

    const seenRows = new Set<number>();
    let outside = 0;
    for (const rawRow of Array.isArray(p.rows) ? p.rows : []) {
      const r = (rawRow ?? {}) as Record<string, unknown>;
      const row: MapRow = {
        row_number: Number(r.row_number),
        x_ft: finite(r.x_ft),
        y_ft: finite(r.y_ft),
        width_ft: finite(r.width_ft),
        length_ft: finite(r.length_ft),
        orientation: r.orientation === "vertical" ? "vertical" : "horizontal"
      };
      if (!Number.isInteger(row.row_number) || row.row_number < 1) {
        problems.push(`${group.name} has a row without a valid row number.`);
        continue;
      }
      if (r.orientation !== "horizontal" && r.orientation !== "vertical") {
        problems.push(`${group.name} row ${row.row_number} needs an orientation of horizontal or vertical.`);
        continue;
      }
      if (!(row.x_ft >= 0 && row.y_ft >= 0 && row.width_ft > 0 && row.length_ft > 0)) {
        problems.push(`${group.name} row ${row.row_number} needs a position of 0 ft or more and a size greater than 0 ft.`);
        continue;
      }
      if (seenRows.has(row.row_number)) {
        problems.push(`${group.name} row ${row.row_number} is on the map more than once.`);
        continue;
      }
      seenRows.add(row.row_number);
      if (!setupRows.has(`${groupId}:${row.row_number}`)) {
        problems.push(`${group.name} row ${row.row_number} is not in Greenhouse Setup. Add it there first; the map never creates rows.`);
        continue;
      }
      const { width, height } = rowExtent(row);
      if (row.x_ft + width > phase.east_west_feet + EPSILON || row.y_ft + height > phase.north_south_feet + EPSILON) outside++;
      phase.rows.push(row);
    }
    if (outside) problems.push(`${outside} row${outside === 1 ? "" : "s"} in ${group.name} ${outside === 1 ? "falls" : "fall"} outside the phase.`);
    const overlap = firstOverlap(phase.rows);
    if (overlap) problems.push(`${group.name} row ${overlap[0]} overlaps row ${overlap[1]}.`);
    phase.rows.sort((a, b) => a.row_number - b.row_number);
    phases.push(phase);
  }
  if (problems.length) throw new MapInputError("The map can't be saved.", problems);
  return { name, east_west_feet: ew, north_south_feet: ns, source, phases };
}

/** The first pair of rows that overlap by a positive area (touching edges is fine). */
export function firstOverlap(rows: MapRow[]): [number, number] | null {
  const boxes = rows
    .map((r) => {
      const { width, height } = rowExtent(r);
      return { n: r.row_number, x0: r.x_ft, y0: r.y_ft, x1: r.x_ft + width, y1: r.y_ft + height };
    })
    .sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j].x0 < boxes[i].x1 - EPSILON; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > EPSILON && oy > EPSILON) return a.n < b.n ? [a.n, b.n] : [b.n, a.n];
    }
  }
  return null;
}

// ── LabourLink import ─────────────────────────────────────────────────────────

type LabourLinkRow = { rowNumber: number; xFt: number; yFt: number; widthFt: number; lengthFt: number; orientation: Orientation };
type LabourLinkPhase = {
  name: string;
  xFeetFromWest: number;
  yFeetFromNorth: number;
  eastWestFeet: number;
  northSouthFeet: number;
  sortOrder: number | null;
  rows: LabourLinkRow[];
};
type LabourLinkLand = { name: string; eastWestFeet: number; northSouthFeet: number; phases: LabourLinkPhase[] };

/** "skip" leaves a phase or row off the map; otherwise the group id / row number to use. */
export type ImportResolutions = {
  land_name?: string | null;
  phase_matches?: Record<string, string>;
  row_resolutions?: Record<string, number | "skip">;
};

export type PhaseReport = {
  source_name: string;
  status: "matched" | "resolved" | "unmatched" | "ambiguous" | "skipped";
  group_id: string | null;
  group_name: string | null;
  candidates: Array<{ id: string; name: string; type: string }>;
  reason: string | null;
  source_rows: number;
  matched_rows: number;
};
export type RowIssue = {
  key: string;
  phase: string;
  row_number: number;
  status: "unmatched" | "ambiguous" | "resolved" | "skipped";
  reason: string;
  resolved_row_number: number | null;
  available_row_numbers?: number[];
};
export type ImportReport = {
  lands: string[];
  land: { name: string; east_west_feet: number; north_south_feet: number } | null;
  phases: PhaseReport[];
  matched_rows: number;
  resolved_rows: number;
  skipped_rows: number;
  row_issues: RowIssue[];
  setup_rows_not_on_map: Array<{ group_id: string; group_name: string; row_numbers: number[] }>;
  groups_not_on_map: Array<{ group_id: string; group_name: string; rows: number }>;
  geometry_problems: string[];
  unresolved: number;
  ready: boolean;
};

const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export const rowIssueKey = (phase: string, rowNumber: number) => `${phase}#${rowNumber}`;

function parseLayoutFile(raw: unknown): LabourLinkLand[] {
  const file = (raw ?? {}) as Record<string, unknown>;
  if (file.format !== "labourlink-greenhouse-layout" || file.version !== 1 || !Array.isArray(file.lands)) {
    throw new MapInputError("This isn't a LabourLink layout file (format labourlink-greenhouse-layout, version 1).");
  }
  const num = (v: unknown) => finite(v);
  return (file.lands as Array<Record<string, unknown>>).map((land) => ({
    name: String(land?.name ?? "").trim(),
    eastWestFeet: num(land?.eastWestFeet),
    northSouthFeet: num(land?.northSouthFeet),
    phases: (Array.isArray(land?.phases) ? (land.phases as Array<Record<string, unknown>>) : []).map((p) => ({
      name: String(p?.name ?? "").trim(),
      xFeetFromWest: num(p?.xFeetFromWest),
      yFeetFromNorth: num(p?.yFeetFromNorth),
      eastWestFeet: num(p?.eastWestFeet),
      northSouthFeet: num(p?.northSouthFeet),
      sortOrder: Number.isInteger(p?.sortOrder) ? (p.sortOrder as number) : null,
      rows: (Array.isArray(p?.rows) ? (p.rows as Array<Record<string, unknown>>) : []).map((r) => ({
        rowNumber: Number(r?.rowNumber),
        xFt: num(r?.xFt),
        yFt: num(r?.yFt),
        widthFt: num(r?.widthFt),
        lengthFt: num(r?.lengthFt),
        orientation: r?.orientation === "vertical" ? "vertical" : "horizontal"
      }))
    }))
  }));
}

/**
 * Matches a LabourLink layout file to an organization's Greenhouse Setup and
 * builds the map it would import. `map` is null until a land is chosen.
 * Only layout geometry is read from the file; anything else in it is ignored.
 */
export function matchLabourLinkLayout(
  rawFile: unknown,
  setup: Setup,
  resolutions: ImportResolutions = {}
): { report: ImportReport; map: GreenhouseMapInput | null } {
  const lands = parseLayoutFile(rawFile);
  const landNames = lands.map((l) => l.name);
  const land = resolutions.land_name ? lands.find((l) => l.name === resolutions.land_name) : lands.length === 1 ? lands[0] : undefined;
  if (resolutions.land_name && !land) throw new MapInputError(`The file has no land named ${resolutions.land_name}.`);

  const emptyReport: ImportReport = {
    lands: landNames, land: null, phases: [], matched_rows: 0, resolved_rows: 0, skipped_rows: 0, row_issues: [],
    setup_rows_not_on_map: [], groups_not_on_map: [], geometry_problems: [], unresolved: 0, ready: false
  };
  if (!land) return { report: emptyReport, map: null };

  const groupsById = new Map(setup.groups.map((g) => [g.id, g]));
  const groupsByName = new Map<string, SetupGroup[]>();
  for (const g of setup.groups) groupsByName.set(normalize(g.name), [...(groupsByName.get(normalize(g.name)) ?? []), g]);
  const rowsByGroup = new Map<string, Set<number>>();
  for (const r of setup.rows) rowsByGroup.set(r.group_id, (rowsByGroup.get(r.group_id) ?? new Set()).add(r.row_number));

  const phaseMatches = resolutions.phase_matches ?? {};
  const rowResolutions = resolutions.row_resolutions ?? {};
  const sourceNameCounts = new Map<string, number>();
  for (const p of land.phases) sourceNameCounts.set(normalize(p.name), (sourceNameCounts.get(normalize(p.name)) ?? 0) + 1);

  // 1. Phases.
  const phaseReports: PhaseReport[] = land.phases.map((p) => {
    const candidates = (groupsByName.get(normalize(p.name)) ?? []).map((g) => ({ id: g.id, name: g.name, type: g.type }));
    const base = { source_name: p.name, candidates, source_rows: p.rows.length, matched_rows: 0 };
    const chosen = phaseMatches[p.name];
    if (chosen === "skip") return { ...base, status: "skipped", group_id: null, group_name: null, reason: "Left off the map." };
    if (chosen) {
      const g = groupsById.get(chosen);
      if (!g) return { ...base, status: "unmatched", group_id: null, group_name: null, reason: "The chosen group isn't in this organization's Greenhouse Setup." };
      return { ...base, status: "resolved", group_id: g.id, group_name: g.name, reason: "Chosen by you." };
    }
    if ((sourceNameCounts.get(normalize(p.name)) ?? 0) > 1) {
      return { ...base, status: "ambiguous", group_id: null, group_name: null, reason: "More than one LabourLink phase has this name." };
    }
    if (candidates.length === 1) return { ...base, status: "matched", group_id: candidates[0].id, group_name: candidates[0].name, reason: null };
    if (candidates.length > 1) {
      return { ...base, status: "ambiguous", group_id: null, group_name: null, reason: `${candidates.length} Greenhouse Setup groups are named ${p.name}.` };
    }
    return { ...base, status: "unmatched", group_id: null, group_name: null, reason: "No Greenhouse Setup group has this name." };
  });
  // Two LabourLink phases can't land on the same group.
  const byGroup = new Map<string, PhaseReport[]>();
  for (const r of phaseReports) if (r.group_id) byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r]);
  for (const [, reports] of byGroup) {
    if (reports.length < 2) continue;
    for (const r of reports) {
      r.reason = `${reports.map((x) => x.source_name).join(" and ")} both point at ${r.group_name}.`;
      r.status = "ambiguous";
      r.group_id = null;
      r.group_name = null;
    }
  }

  // 2. Rows.
  const rowIssues: RowIssue[] = [];
  const placed = new Map<string, Array<{ phase: LabourLinkPhase; row: LabourLinkRow; target: number; issueIndex: number | null }>>();
  let matched = 0;
  let resolved = 0;
  let skipped = 0;
  land.phases.forEach((p, index) => {
    const report = phaseReports[index];
    const groupRows = report.group_id ? rowsByGroup.get(report.group_id) ?? new Set<number>() : null;
    const sourceCounts = new Map<number, number>();
    for (const r of p.rows) sourceCounts.set(r.rowNumber, (sourceCounts.get(r.rowNumber) ?? 0) + 1);
    for (const r of p.rows) {
      const key = rowIssueKey(p.name, r.rowNumber);
      if (report.status === "skipped") {
        skipped++;
        continue;
      }
      if (!report.group_id || !groupRows) {
        rowIssues.push({ key, phase: p.name, row_number: r.rowNumber, status: "unmatched", reason: "Its phase isn't matched yet.", resolved_row_number: null });
        continue;
      }
      const choice = rowResolutions[key];
      if (choice === "skip") {
        rowIssues.push({ key, phase: p.name, row_number: r.rowNumber, status: "skipped", reason: "Left off the map.", resolved_row_number: null });
        skipped++;
        continue;
      }
      let target: number | null = null;
      let issue: RowIssue | null = null;
      if (typeof choice === "number" && Number.isInteger(choice)) {
        if (groupRows.has(choice)) {
          target = choice;
          if (choice !== r.rowNumber || (sourceCounts.get(r.rowNumber) ?? 0) > 1) {
            issue = { key, phase: p.name, row_number: r.rowNumber, status: "resolved", reason: `Placed as ${report.group_name} row ${choice}.`, resolved_row_number: choice };
          }
        } else {
          issue = { key, phase: p.name, row_number: r.rowNumber, status: "unmatched", reason: `${report.group_name} has no row ${choice} in Greenhouse Setup.`, resolved_row_number: null };
        }
      } else if ((sourceCounts.get(r.rowNumber) ?? 0) > 1) {
        issue = { key, phase: p.name, row_number: r.rowNumber, status: "ambiguous", reason: `LabourLink has more than one row ${r.rowNumber} in ${p.name}.`, resolved_row_number: null };
      } else if (groupRows.has(r.rowNumber)) {
        target = r.rowNumber;
      } else {
        issue = { key, phase: p.name, row_number: r.rowNumber, status: "unmatched", reason: `${report.group_name} has no row ${r.rowNumber} in Greenhouse Setup.`, resolved_row_number: null };
      }
      let issueIndex: number | null = null;
      if (issue) {
        rowIssues.push(issue);
        issueIndex = rowIssues.length - 1;
      }
      if (target !== null) {
        const slot = `${report.group_id}:${target}`;
        placed.set(slot, [...(placed.get(slot) ?? []), { phase: p, row: r, target, issueIndex }]);
      }
    }
  });
  // Two map rows can't point at the same Greenhouse Setup row.
  for (const [slot, entries] of placed) {
    if (entries.length < 2) continue;
    for (const e of entries) {
      const key = rowIssueKey(e.phase.name, e.row.rowNumber);
      const issue: RowIssue = {
        key, phase: e.phase.name, row_number: e.row.rowNumber, status: "ambiguous",
        reason: `${entries.length} LabourLink rows point at row ${e.target}; choose one row number for each.`, resolved_row_number: null
      };
      if (e.issueIndex !== null) rowIssues[e.issueIndex] = issue;
      else rowIssues.push(issue);
    }
    placed.delete(slot);
  }
  for (const entries of placed.values()) {
    const e = entries[0];
    if (e.issueIndex !== null && rowIssues[e.issueIndex].status === "resolved") resolved++;
    else matched++;
    const report = phaseReports[land.phases.indexOf(e.phase)];
    report.matched_rows++;
  }

  // Available row numbers for each unresolved row: the group's rows that no map row has taken.
  for (const issue of rowIssues) {
    if (issue.status !== "unmatched" && issue.status !== "ambiguous") continue;
    const report = phaseReports[land.phases.findIndex((p) => p.name === issue.phase)];
    if (!report?.group_id) continue;
    const taken = new Set(Array.from(placed.keys()).filter((k) => k.startsWith(`${report.group_id}:`)).map((k) => Number(k.split(":")[1])));
    issue.available_row_numbers = Array.from(rowsByGroup.get(report.group_id) ?? []).filter((n) => !taken.has(n)).sort((a, b) => a - b);
  }
  rowIssues.sort((a, b) => a.phase.localeCompare(b.phase) || a.row_number - b.row_number);

  // 3. The map it would import.
  const phases: MapPhase[] = [];
  land.phases.forEach((p, index) => {
    const report = phaseReports[index];
    if (!report.group_id || (report.status !== "matched" && report.status !== "resolved")) return;
    const rows: MapRow[] = [];
    for (const [slot, entries] of placed) {
      const e = entries[0];
      if (e.phase !== p || !slot.startsWith(`${report.group_id}:`)) continue;
      rows.push({ row_number: e.target, x_ft: e.row.xFt, y_ft: e.row.yFt, width_ft: e.row.widthFt, length_ft: e.row.lengthFt, orientation: e.row.orientation });
    }
    rows.sort((a, b) => a.row_number - b.row_number);
    phases.push({
      group_id: report.group_id,
      x_feet_from_west: p.xFeetFromWest,
      y_feet_from_north: p.yFeetFromNorth,
      east_west_feet: p.eastWestFeet,
      north_south_feet: p.northSouthFeet,
      sort_order: p.sortOrder,
      rows
    });
  });
  const map: GreenhouseMapInput = { name: land.name, east_west_feet: land.eastWestFeet, north_south_feet: land.northSouthFeet, source: "labourlink_import", phases };

  // 4. What the map leaves out of Greenhouse Setup (informational: those rows stay selectable in the planner's list).
  const onMap = new Set(phases.flatMap((p) => p.rows.map((r) => `${p.group_id}:${r.row_number}`)));
  const mapGroups = new Set(phases.map((p) => p.group_id));
  const setupRowsNotOnMap = phases
    .map((p) => ({
      group_id: p.group_id,
      group_name: groupsById.get(p.group_id)?.name ?? "",
      row_numbers: Array.from(rowsByGroup.get(p.group_id) ?? []).filter((n) => !onMap.has(`${p.group_id}:${n}`)).sort((a, b) => a - b)
    }))
    .filter((x) => x.row_numbers.length > 0);
  const groupsNotOnMap = setup.groups
    .filter((g) => !mapGroups.has(g.id) && (rowsByGroup.get(g.id)?.size ?? 0) > 0)
    .map((g) => ({ group_id: g.id, group_name: g.name, rows: rowsByGroup.get(g.id)?.size ?? 0 }));

  let geometryProblems: string[] = [];
  try {
    parseMap(map, setup);
  } catch (e) {
    if (e instanceof MapInputError) geometryProblems = e.details.length ? e.details : [e.message];
    else throw e;
  }

  const unresolvedPhases = phaseReports.filter((r) => r.status === "unmatched" || r.status === "ambiguous").length;
  const unresolvedRows = rowIssues.filter((r) => r.status === "unmatched" || r.status === "ambiguous").length;
  const unresolved = unresolvedPhases + unresolvedRows;
  return {
    report: {
      lands: landNames,
      land: { name: land.name, east_west_feet: land.eastWestFeet, north_south_feet: land.northSouthFeet },
      phases: phaseReports,
      matched_rows: matched,
      resolved_rows: resolved,
      skipped_rows: skipped,
      row_issues: rowIssues,
      setup_rows_not_on_map: setupRowsNotOnMap,
      groups_not_on_map: groupsNotOnMap,
      geometry_problems: geometryProblems,
      unresolved,
      ready: unresolved === 0 && geometryProblems.length === 0 && phases.length > 0
    },
    map
  };
}
