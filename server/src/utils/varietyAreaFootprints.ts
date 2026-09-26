// Physical growing-area footprints for farm-wide kg/m2. Pure and DB-agnostic:
// the route (yieldEntries.ts) fetches the organization's greenhouse rows,
// sections, variety row assignments and variety_area_links and hands them
// here.
//
// Physical area is the measured greenhouse rows, never a variety record's
// own area_m2: a variety's area_m2 describes one crop, and summing those
// across records counts the same greenhouse again whenever a variety is
// renamed, split by phase or replaced. A row is identified by
// (greenhouse group, row number), so two varieties on the same row share
// one physical area.

export type FootprintRowInput = {
  group_id: string;
  row_number: number;
  width_meters: number | null;
  length_meters: number | null;
  section_id: string | null;
};

export type FootprintSectionInput = {
  id: string;
  width_meters: number | null;
  length_meters: number | null;
};

export type FootprintAssignmentInput = {
  group_id: string;
  variety_id: string;
  start_row: number;
  end_row: number;
  assignment_pattern: string | null;
};

export type FootprintLinkInput = {
  variety_id: string;
  successor_variety_id: string | null;
  greenhouse_group_id: string | null;
};

export type FootprintGroupInput = { id: string; name: string };

export type VarietyFootprints = {
  groups: Array<{ id: string; name: string }>;
  /** Every measured row, keyed "groupId:rowNumber"; areaM2 is null when neither the row nor its section has dimensions. */
  rows: Array<{ key: string; groupId: string; areaM2: number | null }>;
  /** Row keys each variety's yield physically came from. A variety absent here has no known footprint. */
  footprints: Record<string, string[]>;
};

export function rowKey(groupId: string, rowNumber: number): string {
  return `${groupId}:${rowNumber}`;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rowAreaM2(row: FootprintRowInput, sectionsById: Map<string, FootprintSectionInput>): number | null {
  if (positive(row.width_meters) && positive(row.length_meters)) return row.width_meters * row.length_meters;
  const section = row.section_id ? sectionsById.get(row.section_id) : undefined;
  if (section && positive(section.width_meters) && positive(section.length_meters)) {
    return section.width_meters * section.length_meters;
  }
  return null;
}

export function resolveVarietyFootprints(input: {
  groups: FootprintGroupInput[];
  rows: FootprintRowInput[];
  sections: FootprintSectionInput[];
  assignments: FootprintAssignmentInput[];
  links: FootprintLinkInput[];
}): VarietyFootprints {
  const sectionsById = new Map(input.sections.map((s) => [s.id, s]));
  const rows = input.rows.map((row) => ({
    key: rowKey(row.group_id, row.row_number),
    groupId: row.group_id,
    areaM2: rowAreaM2(row, sectionsById)
  }));
  const knownRows = new Set(rows.map((r) => r.key));
  const rowsByGroup = new Map<string, string[]>();
  for (const row of rows) {
    const list = rowsByGroup.get(row.groupId) ?? [];
    list.push(row.key);
    rowsByGroup.set(row.groupId, list);
  }

  // Row assignments — same stepping as greenhouseSetup.ts ("every_other" = start, start+2, ...).
  const direct = new Map<string, Set<string>>();
  for (const assignment of input.assignments) {
    const step = assignment.assignment_pattern === "every_other" ? 2 : 1;
    const set = direct.get(assignment.variety_id) ?? new Set<string>();
    for (let n = assignment.start_row; n <= assignment.end_row; n += step) {
      const key = rowKey(assignment.group_id, n);
      if (knownRows.has(key)) set.add(key);
    }
    direct.set(assignment.variety_id, set);
  }

  const linksByVariety = new Map<string, FootprintLinkInput[]>();
  for (const link of input.links) {
    const list = linksByVariety.get(link.variety_id) ?? [];
    list.push(link);
    linksByVariety.set(link.variety_id, list);
  }

  // Footprint = own rows plus every linked target's rows. A continuation
  // chain (A -> B -> C) is followed; a cycle stops at the first repeat.
  function footprintOf(varietyId: string, visiting: Set<string>): Set<string> {
    const result = new Set(direct.get(varietyId) ?? []);
    if (visiting.has(varietyId)) return result;
    visiting.add(varietyId);
    for (const link of linksByVariety.get(varietyId) ?? []) {
      if (link.greenhouse_group_id) {
        for (const key of rowsByGroup.get(link.greenhouse_group_id) ?? []) result.add(key);
      } else if (link.successor_variety_id) {
        for (const key of footprintOf(link.successor_variety_id, visiting)) result.add(key);
      }
    }
    visiting.delete(varietyId);
    return result;
  }

  const footprints: Record<string, string[]> = {};
  for (const varietyId of new Set([...direct.keys(), ...linksByVariety.keys()])) {
    const rowsForVariety = footprintOf(varietyId, new Set());
    if (rowsForVariety.size > 0) footprints[varietyId] = Array.from(rowsForVariety).sort();
  }

  return {
    groups: input.groups.map((g) => ({ id: g.id, name: g.name })),
    rows,
    footprints
  };
}
