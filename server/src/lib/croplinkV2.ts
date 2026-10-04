// CropLink integration v2 — pure contract logic (no database access), so it
// can be unit-tested without Supabase credentials.
//
// Week semantics: `year`/`week` here are GrowLink's PACKING week (the ISO
// week the yield entry was recorded under) and `packedDate` is the packing
// date. They are deliberately not called "harvest week": CropLink keeps its
// own survey/biological harvest timing separately.
import { createHash } from "crypto";
import type { VarietyFootprints } from "../utils/varietyAreaFootprints";

export const V2_DEFAULT_LIMIT = 500;
export const V2_MAX_LIMIT = 500;
export const MANIFEST_PAGE_MAX = 1000;
export const MANIFEST_TTL_MS = 60 * 60 * 1000;
/** A week can't settle until this long after it ends (largest observed post-week edit in 2026 was 9 days). */
export const SETTLE_AFTER_WEEK_END_DAYS = 10;
/** …and until its data has been unchanged for this long. */
export const SETTLE_QUIET_DAYS = 3;
export const MANIFEST_CHECKSUM_ALGORITHM = "sha256:sorted-lowercase-ids-newline-joined";
export const YIELD_DETAIL_SCOPE = "yield-detail:read";

const DAY_MS = 86_400_000;

// ── Rows as read from the database ─────────────────────────────────────────

export interface DailyBreakdownRow {
  id: string;
  packed_date: string | null;
  size_kg: Record<string, number> | null;
  total_kg: number | string | null;
  average_fruit_weight_g: number | string | null;
  created_at: string;
  updated_at: string;
}

export type LastWriteSource = "manual_create" | "manual_merge" | "manual_edit" | "import_pdf" | "import_csv" | "unknown";

export interface YieldWeekRow {
  id: string;
  variety_id: string;
  year: number;
  week: number;
  packed_date: string | null;
  size_kg: Record<string, number> | null;
  total_kg: number | string | null;
  average_fruit_weight_g: number | string | null;
  kg_per_m2: number | string | null;
  total_cases: number | string | null;
  last_write_source: LastWriteSource | null;
  created_at: string;
  /** Raw timestamp string exactly as Postgres returned it (microsecond precision) — used verbatim in cursors. */
  updated_at: string;
  varieties: { name: string; area_m2: number | string | null; updated_at: string | null } | null;
  yield_entry_daily_breakdown: DailyBreakdownRow[] | null;
}

export interface DeletionRow {
  id: string;
  entity_id: string;
  variety_id: string | null;
  year: number | null;
  week: number | null;
  deleted_at: string;
}

export interface ManifestRow {
  id: string;
  organization_id: string;
  entity_ids: string[];
  expected_count: number;
  checksum: string;
  algorithm: string;
  created_at: string;
  expires_at: string;
}

// ── Cursor ─────────────────────────────────────────────────────────────────

export interface KeysetCursor {
  /** Raw timestamp (updated_at or deleted_at) of the last row on the previous page. */
  at: string;
  id: string;
}

export function encodeCursor(c: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ at: c.at, id: c.id }), "utf8").toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export function decodeCursor(raw: string): KeysetCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.at !== "string" || typeof parsed?.id !== "string") return null;
    if (!TIMESTAMP_RE.test(parsed.at) || !UUID_RE.test(parsed.id)) return null;
    return { at: parsed.at, id: parsed.id.toLowerCase() };
  } catch {
    return null;
  }
}

// ── Query parameters ───────────────────────────────────────────────────────

export interface ListParams {
  limit: number;
  cursor: KeysetCursor | null;
  /** Exclusive lower bound on the row timestamp (incremental sync); ignored when a cursor is given. */
  after: string | null;
  year: number | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseListParams(query: Record<string, unknown>, afterParam: "updatedAfter" | "deletedAfter"): ParseResult<ListParams> {
  const limitRaw = query.limit;
  let limit = V2_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > V2_MAX_LIMIT) return { ok: false, message: `limit must be an integer between 1 and ${V2_MAX_LIMIT}.` };
    limit = n;
  }
  let cursor: KeysetCursor | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || !(cursor = decodeCursor(query.cursor))) return { ok: false, message: "cursor is invalid." };
  }
  let after: string | null = null;
  if (query[afterParam] !== undefined) {
    const v = query[afterParam];
    if (typeof v !== "string" || isNaN(Date.parse(v))) return { ok: false, message: `${afterParam} must be an ISO 8601 timestamp.` };
    after = new Date(v).toISOString();
  }
  let year: number | null = null;
  if (query.year !== undefined) {
    const y = Number(query.year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return { ok: false, message: "year must be an integer year." };
    year = y;
  }
  return { ok: true, value: { limit, cursor, after, year } };
}

/**
 * Rows are fetched as limit+1; this splits off the extra row and builds the
 * next cursor. `resumeCursor` is ALWAYS set (cursor of the last item, or the
 * incoming cursor when the page is empty) so a client can persist it and
 * resume strictly after the last row it stored — resuming by timestamp alone
 * would skip rows that share the last row's timestamp.
 */
export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => KeysetCursor, incoming: KeysetCursor | null = null): { items: T[]; hasMore: boolean; nextCursor: string | null; resumeCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const resume = last ? keyOf(last) : incoming;
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null, resumeCursor: resume ? encodeCursor(resume) : null };
}

// ── Settlement ─────────────────────────────────────────────────────────────

function tzOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** UTC instant of local midnight on the given calendar date in `timeZone` (DST-safe). */
export function zonedMidnightUtc(year: number, monthIndex: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, monthIndex, day);
  let utc = guess - tzOffsetMs(guess, timeZone);
  utc = guess - tzOffsetMs(utc, timeZone);
  return utc;
}

/** Monday (UTC date) of ISO week `week` of ISO year `year`. */
export function isoWeekMondayUtc(year: number, week: number): Date {
  const jan4Day = new Date(Date.UTC(year, 0, 4)).getUTCDay() || 7;
  return new Date(Date.UTC(year, 0, 4) - (jan4Day - 1) * DAY_MS + (week - 1) * 7 * DAY_MS);
}

/** End of Sunday of the ISO week, in the organization's local time, as a UTC instant. */
export function isoWeekEndUtc(year: number, week: number, timeZone: string): number {
  const nextMonday = new Date(isoWeekMondayUtc(year, week).getTime() + 7 * DAY_MS);
  return zonedMidnightUtc(nextMonday.getUTCFullYear(), nextMonday.getUTCMonth(), nextMonday.getUTCDate(), timeZone);
}

export interface Settlement {
  status: "settled" | "provisional";
  settledAt: string | null;
  reason: string;
}

/**
 * Settled once the packing week ended SETTLE_AFTER_WEEK_END_DAYS ago AND
 * the entry (including its daily breakdown, which bumps the entry's
 * updated_at) has been unchanged for SETTLE_QUIET_DAYS. Because it is
 * derived from updated_at, ANY later change to the source data makes the
 * week provisional again until it is quiet once more.
 */
export function computeSettlement(year: number, week: number, updatedAt: string, now: Date, timeZone: string): Settlement {
  const eligibleAt = isoWeekEndUtc(year, week, timeZone) + SETTLE_AFTER_WEEK_END_DAYS * DAY_MS;
  const quietAt = Date.parse(updatedAt) + SETTLE_QUIET_DAYS * DAY_MS;
  const settledAt = Math.max(eligibleAt, quietAt);
  if (now.getTime() >= settledAt) {
    return { status: "settled", settledAt: new Date(settledAt).toISOString(), reason: `week ended ${SETTLE_AFTER_WEEK_END_DAYS}+ days ago and unchanged for ${SETTLE_QUIET_DAYS}+ days` };
  }
  if (now.getTime() < eligibleAt) {
    return { status: "provisional", settledAt: null, reason: `week has not been over for ${SETTLE_AFTER_WEEK_END_DAYS} days yet` };
  }
  return { status: "provisional", settledAt: null, reason: `changed within the last ${SETTLE_QUIET_DAYS} days` };
}

// ── Item mapping ───────────────────────────────────────────────────────────

const num = (v: number | string | null | undefined): number | null => (v == null || v === "" ? null : Number(v));

export interface YieldWeekItem {
  yieldEntryId: string;
  varietyId: string;
  varietyName: string;
  packingYear: number;
  packingWeek: number;
  packedDate: string | null;
  totalKg: number | null;
  averageFruitWeightG: number | null;
  totalCases: number | null;
  sizeKg: Record<string, number>;
  kgPerM2: number | null;
  daily: { breakdownId: string; packedDate: string | null; totalKg: number | null; averageFruitWeightG: number | null; sizeKg: Record<string, number>; updatedAt: string }[];
  /** false after a manual edit (which collapses the breakdown to one row); null when the write path predates tracking. */
  dailyBreakdownComplete: boolean | null;
  lastWriteSource: LastWriteSource;
  /** The variety record's own area_m2 (describes one crop record; can double-count across renamed/split records). */
  varietyAreaM2: number | null;
  varietyUpdatedAt: string | null;
  /** Measured greenhouse-row footprint (GrowLink's physical-area rule); null when the variety has no footprint or no row has dimensions. */
  physicalAreaM2: number | null;
  physicalAreaRowCount: number;
  physicalAreaRowsMissingDimensions: number;
  createdAt: string;
  updatedAt: string;
  settlement: Settlement;
}

export interface PhysicalArea {
  areaM2: number | null;
  rowCount: number;
  rowsMissingDimensions: number;
}

/** Physical area per variety from resolveVarietyFootprints(): the sum of its footprint rows' measured areas. */
export function physicalAreasByVariety(f: VarietyFootprints): Map<string, PhysicalArea> {
  const areaByRow = new Map(f.rows.map(r => [r.key, r.areaM2]));
  const out = new Map<string, PhysicalArea>();
  for (const [varietyId, keys] of Object.entries(f.footprints)) {
    let sum = 0, measured = 0, missing = 0;
    for (const k of keys) {
      const a = areaByRow.get(k);
      if (a == null) missing++;
      else { sum += a; measured++; }
    }
    out.set(varietyId, { areaM2: measured > 0 ? sum : null, rowCount: keys.length, rowsMissingDimensions: missing });
  }
  return out;
}

const NO_FOOTPRINT: PhysicalArea = { areaM2: null, rowCount: 0, rowsMissingDimensions: 0 };

export function toYieldWeekItem(row: YieldWeekRow, now: Date, timeZone: string, physical: PhysicalArea = NO_FOOTPRINT): YieldWeekItem {
  const source = row.last_write_source ?? "unknown";
  return {
    yieldEntryId: row.id,
    varietyId: row.variety_id,
    varietyName: row.varieties?.name ?? "",
    packingYear: row.year,
    packingWeek: row.week,
    packedDate: row.packed_date,
    totalKg: num(row.total_kg),
    averageFruitWeightG: num(row.average_fruit_weight_g),
    totalCases: num(row.total_cases),
    sizeKg: row.size_kg ?? {},
    kgPerM2: num(row.kg_per_m2),
    daily: [...(row.yield_entry_daily_breakdown ?? [])]
      .sort((a, b) => String(a.packed_date ?? "").localeCompare(String(b.packed_date ?? "")) || a.id.localeCompare(b.id))
      .map(d => ({ breakdownId: d.id, packedDate: d.packed_date, totalKg: num(d.total_kg), averageFruitWeightG: num(d.average_fruit_weight_g), sizeKg: d.size_kg ?? {}, updatedAt: d.updated_at })),
    dailyBreakdownComplete: source === "unknown" ? null : source !== "manual_edit",
    lastWriteSource: source,
    varietyAreaM2: num(row.varieties?.area_m2),
    varietyUpdatedAt: row.varieties?.updated_at ?? null,
    physicalAreaM2: physical.areaM2,
    physicalAreaRowCount: physical.rowCount,
    physicalAreaRowsMissingDimensions: physical.rowsMissingDimensions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settlement: computeSettlement(row.year, row.week, row.updated_at, now, timeZone)
  };
}

// ── Manifest ───────────────────────────────────────────────────────────────

export function manifestChecksum(ids: string[]): string {
  const sorted = ids.map(i => i.toLowerCase()).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export function parseManifestPage(query: Record<string, unknown>): ParseResult<{ offset: number; limit: number }> {
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  if (!Number.isInteger(offset) || offset < 0) return { ok: false, message: "cursor is invalid." };
  const limit = query.limit === undefined ? MANIFEST_PAGE_MAX : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MANIFEST_PAGE_MAX) return { ok: false, message: `limit must be an integer between 1 and ${MANIFEST_PAGE_MAX}.` };
  return { ok: true, value: { offset, limit } };
}

export function manifestHeader(m: ManifestRow) {
  return { manifestId: m.id, expectedCount: m.expected_count, checksum: m.checksum, algorithm: m.algorithm, createdAt: m.created_at, expiresAt: m.expires_at };
}

/**
 * PostgREST `or()` filter for "strictly after (at, id)" on a (timestamp, id)
 * keyset. The timestamp is double-quoted because it contains PostgREST-
 * reserved characters (':' '.' '+'); both values were validated by
 * decodeCursor before reaching here.
 */
export function buildKeysetFilter(column: "updated_at" | "deleted_at", cursor: KeysetCursor): string {
  if (!TIMESTAMP_RE.test(cursor.at) || !UUID_RE.test(cursor.id)) throw new Error("invalid keyset cursor");
  return `${column}.gt."${cursor.at}",and(${column}.eq."${cursor.at}",id.gt.${cursor.id})`;
}
