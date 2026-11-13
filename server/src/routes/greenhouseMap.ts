// Greenhouse map (migration 0155): the organization's drawn greenhouse, used by
// the Crop Planner to select rows by clicking them, plus the import of a
// LabourLink layout file.
//
// The map is drawing only. Saving, importing or deleting a map never writes
// greenhouse_groups, greenhouse_rows, greenhouse_variety_assignments or any
// crop plan; every phase and row on it must already exist in this
// organization's Greenhouse Setup.
import { Router, type Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";
import {
  MapInputError,
  matchLabourLinkLayout,
  parseMap,
  type GreenhouseMapInput,
  type ImportResolutions,
  type Setup,
  type SetupGroup,
  type SetupRow
} from "../lib/greenhouseMap";

const greenhouseMapRouter = Router();

// Same permissions as Greenhouse Setup and the Crop Planner.
const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);
const canEdit = requirePermission("greenhouse_setup:edit");

const PAGE = 1000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

async function loadSetup(organizationId: string): Promise<Setup> {
  const [groups, rows] = await Promise.all([
    fetchAll<SetupGroup>((from, to) =>
      supabase.from("greenhouse_groups").select("id, type, name, status").eq("organization_id", organizationId).order("created_at", { ascending: true }).range(from, to)
    ),
    fetchAll<SetupRow>((from, to) =>
      supabase
        .from("greenhouse_rows")
        .select("group_id, row_number")
        .eq("organization_id", organizationId)
        .order("group_id", { ascending: true })
        .order("row_number", { ascending: true })
        .range(from, to)
    )
  ]);
  return { groups, rows: rows.map((r) => ({ group_id: r.group_id, row_number: Number(r.row_number) })) };
}

type StoredMap = { id: string; name: string; east_west_feet: number; north_south_feet: number; source: string; updated_at: string };

async function loadMap(organizationId: string) {
  const { data: map, error } = await supabase
    .from("greenhouse_maps")
    .select("id, name, east_west_feet, north_south_feet, source, updated_at")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!map) return null;
  const m = map as StoredMap;
  const [phases, rows] = await Promise.all([
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("greenhouse_map_phases")
        .select("group_id, x_feet_from_west, y_feet_from_north, east_west_feet, north_south_feet, sort_order")
        .eq("organization_id", organizationId)
        .eq("map_id", m.id)
        .order("sort_order", { ascending: true })
        .range(from, to)
    ),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("greenhouse_map_rows")
        .select("group_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation")
        .eq("organization_id", organizationId)
        .eq("map_id", m.id)
        .order("group_id", { ascending: true })
        .order("row_number", { ascending: true })
        .range(from, to)
    )
  ]);
  return {
    id: m.id,
    name: m.name,
    east_west_feet: Number(m.east_west_feet),
    north_south_feet: Number(m.north_south_feet),
    source: m.source,
    updated_at: m.updated_at,
    phases: phases.map((p) => ({
      group_id: String(p.group_id),
      x_feet_from_west: Number(p.x_feet_from_west),
      y_feet_from_north: Number(p.y_feet_from_north),
      east_west_feet: Number(p.east_west_feet),
      north_south_feet: Number(p.north_south_feet),
      sort_order: p.sort_order === null || p.sort_order === undefined ? null : Number(p.sort_order),
      rows: rows
        .filter((r) => r.group_id === p.group_id)
        .map((r) => ({
          row_number: Number(r.row_number),
          x_ft: Number(r.x_ft),
          y_ft: Number(r.y_ft),
          width_ft: Number(r.width_ft),
          length_ft: Number(r.length_ft),
          orientation: r.orientation as "horizontal" | "vertical"
        }))
    }))
  };
}

function handleError(res: Response, error: unknown, clientMessage: string, logContext: string) {
  if (error instanceof MapInputError) return res.status(400).json({ message: error.message, problems: error.details });
  const code = (error as { code?: string } | null)?.code;
  if (code === "40001") return res.status(409).json({ message: (error as { message?: string }).message ?? "The map was changed by another save." });
  if (code === "23514" || code === "23503" || code === "23505") {
    return res.status(400).json({ message: "The map doesn't match this organization's Greenhouse Setup. Reload and try again." });
  }
  return sendSafeError(res, 500, clientMessage, logContext, error);
}

function expectedUpdatedAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new MapInputError("expected_updated_at must be the map's updated_at, or null for a new map.");
  return value;
}

async function save(organizationId: string, userId: string | undefined, map: GreenhouseMapInput, expected: string | null) {
  const { data, error } = await supabase.rpc("save_greenhouse_map", {
    p_organization_id: organizationId,
    p_map: map,
    p_user_id: userId ?? null,
    p_expected_updated_at: expected
  });
  if (error) throw error;
  return data as { id: string; updated_at: string };
}

function parseResolutions(body: Record<string, unknown>): ImportResolutions {
  const phase_matches: Record<string, string> = {};
  const row_resolutions: Record<string, number | "skip"> = {};
  const pm = (body.phase_matches ?? {}) as Record<string, unknown>;
  const rr = (body.row_resolutions ?? {}) as Record<string, unknown>;
  if (typeof pm !== "object" || typeof rr !== "object") throw new MapInputError("phase_matches and row_resolutions must be objects.");
  for (const [k, v] of Object.entries(pm)) if (typeof v === "string" && v) phase_matches[k] = v;
  for (const [k, v] of Object.entries(rr)) {
    if (v === "skip") row_resolutions[k] = "skip";
    else if (Number.isInteger(Number(v)) && Number(v) >= 1 && v !== "" && v !== null) row_resolutions[k] = Number(v);
  }
  return { land_name: typeof body.land_name === "string" && body.land_name ? body.land_name : null, phase_matches, row_resolutions };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// The map (null when the organization has none) and the Greenhouse Setup
// groups and rows it can be built from.
greenhouseMapRouter.get("/greenhouse-map", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const [map, setup] = await Promise.all([loadMap(organizationId), loadSetup(organizationId)]);
    return res.json({ map, setup });
  } catch (error) {
    return handleError(res, error, "Failed to load the greenhouse map.", "Greenhouse map fetch error:");
  }
});

// Replaces the whole map. expected_updated_at is the updated_at the editor
// loaded (null for a new map); a save over someone else's newer save is 409.
greenhouseMapRouter.put("/greenhouse-map", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expected = expectedUpdatedAt(body.expected_updated_at);
    const setup = await loadSetup(organizationId);
    const map = parseMap({ ...(body.map as object), source: "builder" }, setup);
    await save(organizationId, req.userId, map, expected);
    return res.json({ map: await loadMap(organizationId) });
  } catch (error) {
    return handleError(res, error, "Failed to save the greenhouse map.", "Greenhouse map save error:");
  }
});

greenhouseMapRouter.delete("/greenhouse-map", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const { error } = await supabase.from("greenhouse_maps").delete().eq("organization_id", organizationId);
    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "Failed to delete the greenhouse map.", "Greenhouse map delete error:");
  }
});

// Matches a LabourLink layout file to this organization's Greenhouse Setup and
// returns the match report and the map it would import. Writes nothing.
greenhouseMapRouter.post("/greenhouse-map/import/preview", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const setup = await loadSetup(organizationId);
    return res.json(matchLabourLinkLayout(body.layout, setup, parseResolutions(body)));
  } catch (error) {
    return handleError(res, error, "Failed to read the layout file.", "Greenhouse map import preview error:");
  }
});

// Imports the matched map, replacing this organization's map. Refused (409,
// with the report) while any phase or row is unmatched or ambiguous: nothing
// is guessed and no Greenhouse Setup row is created.
greenhouseMapRouter.post("/greenhouse-map/import", canEdit, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expected = expectedUpdatedAt(body.expected_updated_at);
    const setup = await loadSetup(organizationId);
    const { report, map } = matchLabourLinkLayout(body.layout, setup, parseResolutions(body));
    if (!map || !report.ready) {
      return res.status(409).json({ message: "Resolve every unmatched or ambiguous phase and row before importing.", report });
    }
    await save(organizationId, req.userId, parseMap(map, setup), expected);
    return res.json({ map: await loadMap(organizationId), report });
  } catch (error) {
    return handleError(res, error, "Failed to import the layout.", "Greenhouse map import error:");
  }
});

export { greenhouseMapRouter };
