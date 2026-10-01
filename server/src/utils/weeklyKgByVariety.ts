import type { SupabaseClient } from "@supabase/supabase-js";

// Read-only source data for the Kg Entries tab's "Weekly kg by Variety"
// card: every saved yield entry of one recorded harvest year, plus the
// years that have entries. Rows are paged (PostgREST caps a response at
// 1,000 rows) and checked against an exact count, so a season total is
// never built from a partial read. Aggregation happens in the client
// (lib/yieldEntries/weeklyKgByVariety.ts) so the card and both exports share
// one calculation.

export const WEEKLY_KG_PAGE_SIZE = 1000;

export type WeeklyKgEntryRow = { variety_id: string; week: number; total_kg: number };
export type WeeklyKgVariety = { id: string; name: string; status: string | null };

export type WeeklyKgByVarietySource = {
  year: number | null;
  years: number[];
  entryCount: number;
  varieties: WeeklyKgVariety[];
  entries: WeeklyKgEntryRow[];
};

export class IncompleteReadError extends Error {}

type RawEntry = {
  id: string;
  variety_id: string;
  week: number;
  total_kg: number | string;
  varieties: { name: string | null; status: string | null } | Array<{ name: string | null; status: string | null }> | null;
};

/** Every distinct year with at least one entry, newest first. */
export async function fetchYieldEntryYears(db: SupabaseClient, organizationId: string): Promise<number[]> {
  const years = new Set<number>();
  for (let from = 0; ; from += WEEKLY_KG_PAGE_SIZE) {
    const { data, error } = await db
      .from("yield_entries")
      .select("id, year")
      .eq("organization_id", organizationId)
      .order("year", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + WEEKLY_KG_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ year: number }>) years.add(Number(row.year));
    if (!data || data.length < WEEKLY_KG_PAGE_SIZE) break;
  }
  return [...years].filter(Number.isInteger).sort((a, b) => b - a);
}

/** Every entry of the year, paged in a stable order, verified against an exact count. */
export async function fetchYearEntries(db: SupabaseClient, organizationId: string, year: number): Promise<RawEntry[]> {
  const rows: RawEntry[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from += WEEKLY_KG_PAGE_SIZE) {
    const { data, error, count } = await db
      .from("yield_entries")
      .select("id, variety_id, week, total_kg, varieties(name, status)", { count: "exact" })
      .eq("organization_id", organizationId)
      .eq("year", year)
      .order("id", { ascending: true })
      .range(from, from + WEEKLY_KG_PAGE_SIZE - 1);
    if (error) throw error;
    if (count === null || count === undefined) throw new IncompleteReadError("Entry count unavailable");
    if (expected === null) expected = count;
    else if (count !== expected) throw new IncompleteReadError(`Entries changed while reading (${expected} → ${count})`);
    rows.push(...((data ?? []) as unknown as RawEntry[]));
    if (!data || data.length < WEEKLY_KG_PAGE_SIZE) break;
  }
  if (rows.length !== expected) throw new IncompleteReadError(`Read ${rows.length} of ${expected} entries`);
  return rows;
}

export async function loadWeeklyKgByVarietySource(
  db: SupabaseClient,
  organizationId: string,
  requestedYear: number | null
): Promise<WeeklyKgByVarietySource> {
  const years = await fetchYieldEntryYears(db, organizationId);
  const year = requestedYear ?? years[0] ?? null;
  if (year === null) return { year: null, years, entryCount: 0, varieties: [], entries: [] };

  const raw = await fetchYearEntries(db, organizationId, year);
  const varieties = new Map<string, WeeklyKgVariety>();
  const entries: WeeklyKgEntryRow[] = [];
  for (const row of raw) {
    const ref = Array.isArray(row.varieties) ? row.varieties[0] : row.varieties;
    if (!varieties.has(row.variety_id)) {
      varieties.set(row.variety_id, { id: row.variety_id, name: ref?.name ?? "Unknown variety", status: ref?.status ?? null });
    }
    entries.push({ variety_id: row.variety_id, week: Number(row.week), total_kg: Number(row.total_kg) });
  }
  return { year, years, entryCount: entries.length, varieties: [...varieties.values()], entries };
}
