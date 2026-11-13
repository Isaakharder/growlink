// DTOs for /api/greenhouse-map (server/src/routes/greenhouseMap.ts, migration 0155).
// Feet; x eastward from the land's west edge, y southward from its north edge.
// A phase is placed on the land; its rows are placed relative to the phase.

export type Orientation = "horizontal" | "vertical";

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

export type GreenhouseMap = {
  id?: string;
  name: string;
  east_west_feet: number;
  north_south_feet: number;
  source?: "builder" | "labourlink_import";
  updated_at?: string;
  phases: MapPhase[];
};

export type SetupGroup = { id: string; name: string; type: string; status?: string | null };
export type SetupRow = { group_id: string; row_number: number };

export type GreenhouseMapResponse = { map: GreenhouseMap | null; setup: { groups: SetupGroup[]; rows: SetupRow[] } };

/** On-map width/height of a row: a horizontal row runs east-west. */
export function rowExtent(row: Pick<MapRow, "width_ft" | "length_ft" | "orientation">) {
  return row.orientation === "horizontal" ? { width: row.length_ft, height: row.width_ft } : { width: row.width_ft, height: row.length_ft };
}

// LabourLink import report (POST /api/greenhouse-map/import/preview).
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
