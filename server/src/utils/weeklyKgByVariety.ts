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
/** productCode is the variety's product (0148); the card shows one crop's totals at a time. */
export type WeeklyKgVariety = { id: string; name: string; status: string | null; productCode?: string };

/** A piece count (migration 0151): whole pieces, never kg. */
export type WeeklyPieceEntryRow = { variety_id: string; week: number; total_pieces: number };

export type WeeklyKgByVarietySource = {
  year: number | null;
  years: number[];
  entryCount: number;
  varieties: WeeklyKgVariety[];
  entries: WeeklyKgEntryRow[];
  /** Only when asked for (?units=all); kg entries above are never mixed with these. */
  pieceEntryCount?: number;
  pieceEntries?: WeeklyPieceEntryRow[];
};

export class IncompleteReadError extends Error {}

type RawEntry = {
  id: string;
  variety_id: string;
  week: number;
  total_kg: number | string;
  varieties:
    | { name: string | null; status: string | null; product_code?: string | null }
    | Array<{ name: string | null; status: string | null; product_code?: string | null }>
    | null;
};

/** Every distinct year with at least one entry, newest first. */
export async function fetchYieldEntryYears(
  db: SupabaseClient,
  organizationId: string,
  table: "yield_entries" | "yield_piece_entries" = "yield_entries"
): Promise<number[]> {
  const years = new Set<number>();
  for (let from = 0; ; from += WEEKLY_KG_PAGE_SIZE) {
    const { data, error } = await db
      .from(table)
      .select("id, year")
      .eq("organization_id", organizationId)
      .order("year", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + WEEKLY_KG_PAGE_SIZE - 1);
    // No piece table yet (migration 0151 not applied): no piece-count years.
    if (error && table === "yield_piece_entries" && (error.code === "42P01" || error.code === "PGRST205")) return [];
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
      .select("id, variety_id, week, total_kg, varieties(name, status, product_code)", { count: "exact" })
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

type RawPieceEntry = Omit<RawEntry, "total_kg"> & { total_pieces: number | string };

/** Every piece count of the year, read the same way as the kg entries: paged and checked against an exact count. */
export async function fetchYearPieceEntries(db: SupabaseClient, organizationId: string, year: number): Promise<RawPieceEntry[]> {
  const rows: RawPieceEntry[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from += WEEKLY_KG_PAGE_SIZE) {
    const { data, error, count } = await db
      .from("yield_piece_entries")
      .select("id, variety_id, week, total_pieces, varieties(name, status, product_code)", { count: "exact" })
      .eq("organization_id", organizationId)
      .eq("year", year)
      .order("id", { ascending: true })
      .range(from, from + WEEKLY_KG_PAGE_SIZE - 1);
    if (error && (error.code === "42P01" || error.code === "PGRST205")) return [];
    if (error) throw error;
    if (count === null || count === undefined) throw new IncompleteReadError("Piece count unavailable");
    if (expected === null) expected = count;
    else if (count !== expected) throw new IncompleteReadError(`Piece counts changed while reading (${expected} → ${count})`);
    rows.push(...((data ?? []) as unknown as RawPieceEntry[]));
    if (!data || data.length < WEEKLY_KG_PAGE_SIZE) break;
  }
  if (rows.length !== expected) throw new IncompleteReadError(`Read ${rows.length} of ${expected} piece counts`);
  return rows;
}

export async function loadWeeklyKgByVarietySource(
  db: SupabaseClient,
  organizationId: string,
  requestedYear: number | null,
  { withPieces = false }: { withPieces?: boolean } = {}
): Promise<WeeklyKgByVarietySource> {
  const kgYears = await fetchYieldEntryYears(db, organizationId);
  const years = withPieces
    ? [...new Set([...kgYears, ...(await fetchYieldEntryYears(db, organizationId, "yield_piece_entries"))])].sort((a, b) => b - a)
    : kgYears;
  const year = requestedYear ?? years[0] ?? null;
  const noPieces = withPieces ? { pieceEntryCount: 0, pieceEntries: [] } : {};
  if (year === null) return { year: null, years, entryCount: 0, varieties: [], entries: [], ...noPieces };

  const raw = await fetchYearEntries(db, organizationId, year);
  const varieties = new Map<string, WeeklyKgVariety>();
  const entries: WeeklyKgEntryRow[] = [];
  for (const row of raw) {
    const ref = Array.isArray(row.varieties) ? row.varieties[0] : row.varieties;
    if (!varieties.has(row.variety_id)) {
      varieties.set(row.variety_id, {
        id: row.variety_id,
        name: ref?.name ?? "Unknown variety",
        status: ref?.status ?? null,
        ...(ref?.product_code ? { productCode: ref.product_code } : {})
      });
    }
    entries.push({ variety_id: row.variety_id, week: Number(row.week), total_kg: Number(row.total_kg) });
  }
  if (!withPieces) {
    return { year, years, entryCount: entries.length, varieties: [...varieties.values()], entries };
  }

  const pieceEntries: WeeklyPieceEntryRow[] = [];
  for (const row of await fetchYearPieceEntries(db, organizationId, year)) {
    const ref = Array.isArray(row.varieties) ? row.varieties[0] : row.varieties;
    if (!varieties.has(row.variety_id)) {
      varieties.set(row.variety_id, {
        id: row.variety_id,
        name: ref?.name ?? "Unknown variety",
        status: ref?.status ?? null,
        ...(ref?.product_code ? { productCode: ref.product_code } : {})
      });
    }
    pieceEntries.push({ variety_id: row.variety_id, week: Number(row.week), total_pieces: Number(row.total_pieces) });
  }
  return {
    year,
    years,
    entryCount: entries.length,
    varieties: [...varieties.values()],
    entries,
    pieceEntryCount: pieceEntries.length,
    pieceEntries
  };
}
