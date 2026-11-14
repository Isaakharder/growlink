// Dated row measurements (migration 0157, preview): each greenhouse row's real
// width and length in meters, as versions that apply from a date. Setup → Map
// edits them; every area figure reads the version in effect on its own date,
// so resizing or adding rows for a future season never changes a past or
// current figure.
//
// Where 0157 isn't applied the table doesn't exist; callers get null and keep
// using today's Greenhouse Setup values (rowAreaM2 in varietyAreaFootprints).
import { supabase } from "../config/supabase";

export type MeasurementVersion = {
  row_id: string;
  width_m: number | null;
  length_m: number | null;
  effective_from: string | null; // null = since the beginning (the baseline copied from Greenhouse Setup)
  source: string;
};

const PAGE = 1000;
const MISSING_TABLE = new Set(["42P01", "PGRST205", "PGRST200"]);

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const isoDate = (v: unknown): string | null =>
  typeof v === "string" ? v.slice(0, 10) : v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : null;

/** Every measurement version of the organization by row, oldest first; null when 0157 isn't applied. */
export async function loadRowMeasurements(organizationId: string): Promise<Map<string, MeasurementVersion[]> | null> {
  const all: MeasurementVersion[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("greenhouse_row_measurements")
      .select("row_id, width_m, length_m, effective_from, source")
      .eq("organization_id", organizationId)
      .order("row_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (MISSING_TABLE.has(String((error as { code?: string }).code))) return null;
      throw error;
    }
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const m of page) {
      all.push({ row_id: String(m.row_id), width_m: num(m.width_m), length_m: num(m.length_m), effective_from: isoDate(m.effective_from), source: String(m.source) });
    }
    if (page.length < PAGE) break;
  }
  const byRow = new Map<string, MeasurementVersion[]>();
  for (const m of all) byRow.set(m.row_id, [...(byRow.get(m.row_id) ?? []), m]);
  for (const list of byRow.values()) list.sort((a, b) => (a.effective_from ?? "") < (b.effective_from ?? "") ? -1 : 1);
  return byRow;
}

/** The version in effect on a date (null when the row has no version yet on that date). */
export function measurementOn(versions: MeasurementVersion[] | undefined, date: string): MeasurementVersion | null {
  let found: MeasurementVersion | null = null;
  for (const v of versions ?? []) if (v.effective_from === null || v.effective_from <= date) found = v;
  return found;
}

export const measuredArea = (v: MeasurementVersion | null) => (v && v.width_m && v.length_m ? v.width_m * v.length_m : null);

/** The first day a row is in the greenhouse: null = always; a date for rows added for a later season. */
export function rowAvailableFrom(versions: MeasurementVersion[] | undefined): string | null {
  if (!versions?.length) return null;
  return versions[0].effective_from;
}
