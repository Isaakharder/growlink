// Manual pack case entries: reconstructing shipment history per Product Pack
// from invoices (server/src/routes/manualPackEntries.ts). Entries are user
// data — a DockLink sync never writes, overwrites or zeroes them.
import { apiFetch } from "./api";

export const MANUAL_ENTRIES_URL = "/api/manual-pack-entries";
export const MANUAL_PACKS_URL = "/api/manual-pack-entries/packs";
export const HISTORICAL_PACKS_URL = "/api/historical-packs";
export const WEEK_SOURCES_URL = "/api/case-week-sources";

export type PackSource = "docklink" | "historical";
export type ColorKind = "single" | "mixed" | "none";
export type WeekSourceChoice = "manual_packs" | "legacy_colours";

export type SelectablePack = {
  packSource: PackSource;
  packId: string;
  name: string;
  packCode: string | null;
  description: string | null;
  colorKind: ColorKind;
  colorKey: string;
  cropType: string | null;
  trackingUnit: string | null;
  displayOrder: number | null;
  /** active | archived | not_in_docklink (DockLink packs), historical (GrowLink-defined) */
  status: "active" | "archived" | "not_in_docklink" | "historical";
  entryCount?: number;
};

export type PackCatalogue = { docklink: SelectablePack[]; historical: SelectablePack[] };

export type ManualEntry = {
  id: string;
  isoYear: number;
  isoWeek: number;
  packSource: PackSource;
  packId: string;
  packName: string;
  packCode: string | null;
  colorKind: string;
  colorKey: string;
  cropType: string;
  trackingUnit: string;
  cases: number;
  invoiceRef: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** Other entries that look like the same invoice line (same invoice and pack, or same week/pack/cases without a reference). */
  duplicates: Array<{ id: string; isoYear: number; isoWeek: number; cases: number; invoiceRef: string | null }>;
};

export type DuplicateHit = { line: number; existing: ManualEntry };

/** A rejected save the user can resolve: confirm duplicates, or choose the week's source. */
export class ManualEntryConflict extends Error {
  constructor(
    message: string,
    readonly code: "possible_duplicates" | "week_source_required" | "docklink_owned_week" | string,
    readonly details: { duplicates?: DuplicateHit[]; legacyCases?: number; legacyRows?: number }
  ) {
    super(message);
  }
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const body = (await response.json().catch(() => null)) as (Record<string, unknown> & { message?: string; code?: string }) | null;
  if (!response.ok) {
    const message = body?.message ?? `Request failed (${response.status})`;
    if (response.status === 409 && body?.code) throw new ManualEntryConflict(message, body.code, body as never);
    throw new Error(message);
  }
  return body as T;
}

export const fetchPackCatalogue = () => send<PackCatalogue>(MANUAL_PACKS_URL, { method: "GET" });

export type NewEntriesInput = {
  isoYear: number;
  isoWeek: number;
  invoiceRef: string | null;
  note: string | null;
  lines: Array<{ packSource: PackSource; packId: string; cases: number }>;
  weekSource?: WeekSourceChoice | null;
  confirmDuplicates?: boolean;
};

export const createManualEntries = (input: NewEntriesInput) =>
  send<{ entries: ManualEntry[]; weekSource: WeekSourceChoice | null }>(MANUAL_ENTRIES_URL, { method: "POST", body: JSON.stringify(input) });

export type EntryUpdate = Partial<{
  isoYear: number;
  isoWeek: number;
  packSource: PackSource;
  packId: string;
  cases: number;
  invoiceRef: string | null;
  note: string | null;
  weekSource: WeekSourceChoice | null;
  confirmDuplicates: boolean;
}>;

export const updateManualEntry = (id: string, update: EntryUpdate) =>
  send<{ entry: ManualEntry; releasedPreviousWeek: boolean }>(`${MANUAL_ENTRIES_URL}/${id}`, { method: "PUT", body: JSON.stringify(update) });

export const deleteManualEntry = (id: string) =>
  send<{ deleted: string; releasedWeekSource: boolean }>(`${MANUAL_ENTRIES_URL}/${id}`, { method: "DELETE" });

export const setWeekSource = (isoYear: number, isoWeek: number, source: WeekSourceChoice) =>
  send<{ source: WeekSourceChoice }>(WEEK_SOURCES_URL, { method: "PUT", body: JSON.stringify({ isoYear, isoWeek, source }) });

export type NewHistoricalPack = {
  name: string;
  packCode: string | null;
  colorKind: ColorKind;
  colorKey: string | null;
  cropType: string;
  trackingUnit: string;
  note: string | null;
};

export const createHistoricalPack = (pack: NewHistoricalPack) =>
  send<{ pack: { id: string } }>(HISTORICAL_PACKS_URL, { method: "POST", body: JSON.stringify(pack) });

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Red", "Mixed / rainbow", "No colour · cucumber, pieces" — how a pack is classified for kg. */
export function classificationLabel(p: Pick<SelectablePack, "colorKind" | "colorKey" | "cropType" | "trackingUnit">): string {
  const crop = p.cropType && p.cropType !== "pepper" ? ` · ${p.cropType}` : "";
  const unit = p.trackingUnit && p.trackingUnit !== "kg" ? `, ${p.trackingUnit}` : "";
  if (p.colorKind === "mixed") return `Mixed / rainbow${crop}${unit}`;
  if (p.colorKind === "single" && p.colorKey) return `${cap(p.colorKey)}${crop}${unit}`;
  return `No colour${crop}${unit}`;
}

export const packOptionValue = (p: Pick<SelectablePack, "packSource" | "packId">) => `${p.packSource}:${p.packId}`;
