// Supabase implementation of the CropLink v2 store. Every query is scoped to
// the authenticated organization.
import { randomUUID } from "crypto";
import { supabase } from "../config/supabase";
import { CroplinkV2Store } from "./croplinkV2";
import {
  DeletionRow, ManifestRow, YieldWeekRow, MANIFEST_CHECKSUM_ALGORITHM, buildKeysetFilter, manifestChecksum, physicalAreasByVariety
} from "../lib/croplinkV2";
import { resolveVarietyFootprints, FootprintRowInput } from "../utils/varietyAreaFootprints";

const YIELD_WEEK_SELECT =
  "id, variety_id, year, week, packed_date, size_kg, total_kg, average_fruit_weight_g, kg_per_m2, total_cases, last_write_source, created_at, updated_at, " +
  "varieties(name, area_m2, updated_at), " +
  "yield_entry_daily_breakdown(id, packed_date, size_kg, total_kg, average_fruit_weight_g, created_at, updated_at)";

// PostgREST caps unranged responses at 1,000 rows; manifests page with
// .range() and verify the count so they can never silently truncate.
const ID_PAGE = 1000;

export const supabaseCroplinkV2Store: CroplinkV2Store = {
  async listYieldWeeks(organizationId, { cursor, after, year, limit }) {
    let q = supabase.from("yield_entries").select(YIELD_WEEK_SELECT).eq("organization_id", organizationId);
    if (cursor) q = q.or(buildKeysetFilter("updated_at", cursor));
    else if (after) q = q.gt("updated_at", after);
    if (year != null) q = q.eq("year", year);
    const { data, error } = await q.order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
    if (error) throw error;
    return (data ?? []) as unknown as YieldWeekRow[];
  },

  async listDeletions(organizationId, { cursor, after, limit }) {
    let q = supabase.from("integration_deletions").select("id, entity_id, variety_id, year, week, deleted_at")
      .eq("organization_id", organizationId).eq("entity", "yield_entry");
    if (cursor) q = q.or(buildKeysetFilter("deleted_at", cursor));
    else if (after) q = q.gt("deleted_at", after);
    const { data, error } = await q.order("deleted_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
    if (error) throw error;
    return (data ?? []) as DeletionRow[];
  },

  async createManifest(organizationId, ttlMs) {
    const { count, error: countError } = await supabase.from("yield_entries").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
    if (countError) throw countError;
    const ids: string[] = [];
    for (let from = 0; ; from += ID_PAGE) {
      const { data, error } = await supabase.from("yield_entries").select("id").eq("organization_id", organizationId)
        .order("id", { ascending: true }).range(from, from + ID_PAGE - 1);
      if (error) throw error;
      ids.push(...(data ?? []).map(r => String(r.id).toLowerCase()));
      if (!data || data.length < ID_PAGE) break;
    }
    if (count != null && count !== ids.length) {
      // Entries changed while paging — refuse rather than hand out a manifest that isn't one consistent set.
      throw new Error(`yield_entries changed during manifest build (count ${count}, paged ${ids.length}); retry`);
    }
    ids.sort();
    const now = Date.now();
    const row = {
      id: randomUUID(),
      organization_id: organizationId,
      entity: "yield_entry",
      entity_ids: ids,
      expected_count: ids.length,
      checksum: manifestChecksum(ids),
      algorithm: MANIFEST_CHECKSUM_ALGORITHM,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString()
    };
    const { error } = await supabase.from("integration_manifests").insert(row);
    if (error) throw error;
    return row as ManifestRow;
  },

  async physicalAreas(organizationId) {
    // Same inputs as GET /yield-analytics/area-footprints (yieldEntries.ts).
    const rows: FootprintRowInput[] = [];
    for (let from = 0; ; from += ID_PAGE) {
      const { data, error } = await supabase.from("greenhouse_rows").select("group_id, row_number, width_meters, length_meters, section_id")
        .eq("organization_id", organizationId).order("group_id", { ascending: true }).order("row_number", { ascending: true }).range(from, from + ID_PAGE - 1);
      if (error) throw error;
      rows.push(...((data ?? []) as FootprintRowInput[]));
      if (!data || data.length < ID_PAGE) break;
    }
    const [groups, sections, assignments, links] = await Promise.all([
      supabase.from("greenhouse_groups").select("id, name").eq("organization_id", organizationId),
      supabase.from("greenhouse_row_sections").select("id, width_meters, length_meters").eq("organization_id", organizationId),
      supabase.from("greenhouse_variety_assignments").select("group_id, variety_id, start_row, end_row, assignment_pattern").eq("organization_id", organizationId),
      supabase.from("variety_area_links").select("variety_id, successor_variety_id, greenhouse_group_id").eq("organization_id", organizationId)
    ]);
    for (const r of [groups, sections, assignments]) if (r.error) throw r.error;
    // 42P01 / PGRST205: variety_area_links not migrated yet — footprints from row assignments alone.
    if (links.error && links.error.code !== "42P01" && links.error.code !== "PGRST205") throw links.error;
    return physicalAreasByVariety(resolveVarietyFootprints({
      groups: groups.data ?? [], rows, sections: sections.data ?? [], assignments: assignments.data ?? [], links: links.error ? [] : links.data ?? []
    }));
  },

  async getManifest(organizationId, manifestId) {
    if (!/^[0-9a-f-]{36}$/i.test(manifestId)) return null;
    const { data, error } = await supabase.from("integration_manifests")
      .select("id, organization_id, entity_ids, expected_count, checksum, algorithm, created_at, expires_at")
      .eq("id", manifestId).eq("organization_id", organizationId).maybeSingle();
    if (error) throw error;
    return (data as ManifestRow | null) ?? null;
  }
};
