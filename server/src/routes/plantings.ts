// Crop Planner → Plants (read-only, stage 1): what is planted where, from the
// live Greenhouse Setup assignments and each variety's planting and pull-out
// dates. Nothing here writes; the cards are worked out in the client
// (client/src/lib/plants/plantingCards.ts) from this one response.
//
// "Today" is the organization's local date (DEFAULT_ORG_TIMEZONE, as Food
// Safety and Calibration use), so a planting turns Active on its planting date
// in the greenhouse's time zone, not the viewer's.
import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission } from "../middleware/requirePermission";
import { loadOrganizationProducts } from "../utils/organizationProducts";
import { DEFAULT_ORG_TIMEZONE } from "../config/orgTimezone";
import { todayInOrgTimezone } from "./foodSafety/services/checklistPeriod";
import { rowAreaM2, type FootprintSectionInput } from "../utils/varietyAreaFootprints";

const plantingsRouter = Router();
const canView = requireAnyPermission(["greenhouse_setup:view", "greenhouse_setup:edit"]);

const PAGE = 1000;

/** Every row of a query, paged: PostgREST caps a response at 1,000 rows. */
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

/** A date column as YYYY-MM-DD (PostgREST sends a string; a pg driver may send a Date at UTC midnight). */
const isoDate = (value: unknown): string | null =>
  typeof value === "string" ? value.slice(0, 10) : value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null;
const numOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));

plantingsRouter.get("/crop-planner/plantings", canView, async (req, res) => {
  const organizationId = req.organizationId as string;
  try {
    const [groups, rows, sections, assignments, varieties, products] = await Promise.all([
      fetchAll<Record<string, unknown>>((from, to) =>
        supabase.from("greenhouse_groups").select("id, type, name, status").eq("organization_id", organizationId).order("created_at", { ascending: true }).range(from, to)
      ),
      fetchAll<Record<string, unknown>>((from, to) =>
        supabase
          .from("greenhouse_rows")
          .select("group_id, row_number, section_id, slab_count, plants_per_slab, stems_per_plant, width_meters, length_meters")
          .eq("organization_id", organizationId)
          .order("group_id", { ascending: true })
          .order("row_number", { ascending: true })
          .range(from, to)
      ),
      fetchAll<Record<string, unknown>>((from, to) =>
        supabase.from("greenhouse_row_sections").select("id, width_meters, length_meters").eq("organization_id", organizationId).range(from, to)
      ),
      fetchAll<Record<string, unknown>>((from, to) =>
        supabase
          .from("greenhouse_variety_assignments")
          .select("id, group_id, variety_id, start_row, end_row, assignment_pattern")
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true })
          .range(from, to)
      ),
      fetchAll<Record<string, unknown>>((from, to) =>
        supabase
          .from("varieties")
          .select("id, name, color, status, product_code, planting_date, pull_out_date")
          .eq("organization_id", organizationId)
          .order("name", { ascending: true })
          .range(from, to)
      ),
      loadOrganizationProducts(organizationId)
    ]);

    // Row area as yield analytics works it out: the row's own width × length,
    // else its section's (utils/varietyAreaFootprints.ts).
    const sectionsById = new Map<string, FootprintSectionInput>(
      sections.map((s) => [String(s.id), { id: String(s.id), width_meters: numOrNull(s.width_meters), length_meters: numOrNull(s.length_meters) }])
    );

    return res.json({
      today: todayInOrgTimezone(DEFAULT_ORG_TIMEZONE),
      timeZone: DEFAULT_ORG_TIMEZONE,
      groups,
      rows: rows.map((row) => ({
        group_id: row.group_id,
        row_number: Number(row.row_number),
        slab_count: Number(row.slab_count ?? 0),
        plants_per_slab: Number(row.plants_per_slab ?? 0),
        stems_per_plant: numOrNull(row.stems_per_plant),
        area_m2: rowAreaM2(
          {
            group_id: String(row.group_id),
            row_number: Number(row.row_number),
            section_id: (row.section_id as string | null) ?? null,
            width_meters: numOrNull(row.width_meters),
            length_meters: numOrNull(row.length_meters)
          },
          sectionsById
        )
      })),
      assignments: assignments.map((a) => ({
        id: a.id,
        group_id: a.group_id,
        variety_id: a.variety_id,
        start_row: Number(a.start_row),
        end_row: Number(a.end_row),
        assignment_pattern: a.assignment_pattern === "every_other" ? "every_other" : "all"
      })),
      varieties: varieties.map((v) => ({
        id: v.id,
        name: v.name,
        color: v.color ?? null,
        status: v.status,
        product_code: v.product_code ?? null,
        planting_date: isoDate(v.planting_date),
        pull_out_date: isoDate(v.pull_out_date)
      })),
      products: products.map((p) => ({ code: p.code, name: p.name, status: p.status }))
    });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load plantings.", "Plantings load error:", error);
  }
});

export { plantingsRouter };
