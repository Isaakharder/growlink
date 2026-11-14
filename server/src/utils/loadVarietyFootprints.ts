// Loads the inputs for resolveVarietyFootprints() — the physical growing area
// behind Yield Analytics' farm-wide kg/m² and CropLink v2's physicalAreaM2 —
// in one place, so the two reports can't drift apart.
//
// Row sizes: where Setup → Map measurements exist (migration 0157) each row
// carries its dated sizes, and a report for a packing week uses the size in
// effect on that week's Monday (footprintRowAreaOn + isoWeekMondayUtc). A
// resize or new rows for a future season therefore never change a past
// week, and they take effect on their own date without anything having to
// rewrite greenhouse_rows. Before 0157, rows keep Greenhouse Setup's size.
import { supabase } from "../config/supabase";
import { DEFAULT_ORG_TIMEZONE } from "../config/orgTimezone";
import { todayInOrgTimezone } from "../routes/foodSafety/services/checklistPeriod";
import { loadRowMeasurements } from "./rowMeasurements";
import { resolveVarietyFootprints, type FootprintRowInput, type VarietyFootprints } from "./varietyAreaFootprints";

const PAGE = 1000;
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

export class FootprintLoadError extends Error {
  constructor(readonly part: string, readonly cause: unknown) {
    super(`Failed to load ${part}`);
  }
}

/** Every greenhouse row, paged: PostgREST caps a response at 1,000 rows, and a truncated list would undercount physical area. */
async function fetchAllRows(organizationId: string): Promise<FootprintRowInput[]> {
  const out: FootprintRowInput[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("greenhouse_rows")
      .select("id, group_id, row_number, width_meters, length_meters, section_id")
      .eq("organization_id", organizationId)
      .order("group_id", { ascending: true })
      .order("row_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new FootprintLoadError("rows", error);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of page) {
      out.push({
        id: String(r.id),
        group_id: String(r.group_id),
        row_number: Number(r.row_number),
        width_meters: r.width_meters === null || r.width_meters === undefined ? null : Number(r.width_meters),
        length_meters: r.length_meters === null || r.length_meters === undefined ? null : Number(r.length_meters),
        section_id: r.section_id ? String(r.section_id) : null
      });
    }
    if (page.length < PAGE) return out;
  }
}

export type LoadedFootprints = VarietyFootprints & {
  /** false until variety_area_links (0138) is applied; footprints then come from row assignments alone. */
  linksAvailable: boolean;
  /** true when rows carry Setup → Map dated sizes. */
  measured: boolean;
  /** Today in the organization's time zone (what areaM2 means). */
  today: string;
};

export async function loadVarietyFootprints(organizationId: string): Promise<LoadedFootprints> {
  const [groups, rows, sections, assignments, links] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name").eq("organization_id", organizationId),
    fetchAllRows(organizationId),
    supabase.from("greenhouse_row_sections").select("id, width_meters, length_meters").eq("organization_id", organizationId),
    supabase.from("greenhouse_variety_assignments").select("group_id, variety_id, start_row, end_row, assignment_pattern").eq("organization_id", organizationId),
    supabase.from("variety_area_links").select("variety_id, successor_variety_id, greenhouse_group_id").eq("organization_id", organizationId)
  ]);
  for (const [part, r] of [["groups", groups], ["sections", sections], ["assignments", assignments]] as const) {
    if (r.error) throw new FootprintLoadError(part, r.error);
  }
  const linksAvailable = !links.error;
  if (links.error && !MISSING_TABLE.has(String((links.error as { code?: string }).code))) throw new FootprintLoadError("links", links.error);

  let measurements;
  try {
    measurements = await loadRowMeasurements(organizationId);
  } catch (error) {
    throw new FootprintLoadError("row measurements", error);
  }
  const today = todayInOrgTimezone(DEFAULT_ORG_TIMEZONE);
  const footprints = resolveVarietyFootprints({
    groups: (groups.data ?? []) as Array<{ id: string; name: string }>,
    rows,
    sections: ((sections.data ?? []) as Array<Record<string, unknown>>).map((s) => ({
      id: String(s.id),
      width_meters: s.width_meters === null || s.width_meters === undefined ? null : Number(s.width_meters),
      length_meters: s.length_meters === null || s.length_meters === undefined ? null : Number(s.length_meters)
    })),
    assignments: (assignments.data ?? []) as Array<{ group_id: string; variety_id: string; start_row: number; end_row: number; assignment_pattern: string | null }>,
    links: linksAvailable ? ((links.data ?? []) as Array<{ variety_id: string; successor_variety_id: string | null; greenhouse_group_id: string | null }>) : [],
    measurements,
    today
  });
  return { ...footprints, linksAvailable, measured: Boolean(measurements && measurements.size), today };
}
