// Client side of the one authoritative shipped-yield calculation
// (server/src/lib/shippedYield.ts, GET /api/shipped-yield). The Cases tab,
// Dashboard, Yield Analytics and the iOS workspace all read their shipped
// cases and kg from here, so every screen shows the same numbers. No screen
// computes shipped kg from case weights itself. Pure (no API client import);
// the request lives in shippedYieldApi.ts.

export const SHIPPED_YIELD_URL = "/api/shipped-yield";
export const DOCKLINK_PACK_SYNC_URL = "/api/integrations/docklink/sync-packs";

export type PepperColor = "red" | "orange" | "yellow" | "green";
export const PEPPER_COLORS: PepperColor[] = ["red", "orange", "yellow", "green"];

export type ColorTotals = Record<PepperColor, { kg: number; cases: number }>;
export type NonPepperTotal = { cropType: string; trackingUnit: string | null; cases: number };

export type ShippedWeekTotals = {
  isoYear: number;
  isoWeek: number;
  source: "packs" | "legacy";
  colors: ColorTotals;
  mixedCases: number;
  shippedCases: number;
  measuredCases: number;
  unmeasuredCases: number;
  attentionCases: number;
  kg: number;
  complete: boolean;
  nonPepper: NonPepperTotal[];
  supersededLegacyRows: number;
};

export type ShippedTotals = Omit<ShippedWeekTotals, "isoYear" | "isoWeek" | "source" | "supersededLegacyRows"> & {
  weekCount: number;
  packWeeks: number;
  legacyWeeks: number;
};

export type IsoWeek = { isoYear: number; isoWeek: number };

export type PackSyncSummary = {
  scopeStatus: "available" | "pending_first_full_week" | "capture_not_active";
  generatedAt: string;
  lastSyncedAt: string;
  captureActivatedAt: string | null;
  transitionWeek: IsoWeek | null;
  firstWeek: IsoWeek | null;
  lastWeek: IsoWeek | null;
  diagnostics: Record<string, unknown>;
};

export type ShippedYieldResponse = {
  sync: PackSyncSummary | null;
  weeks: ShippedWeekTotals[];
  totals: ShippedTotals;
};

export type WeekRangeParams = { fromYear: number; fromWeek?: number; toYear?: number; toWeek?: number };

export function shippedYieldUrl(range?: WeekRangeParams | null): string {
  if (!range) return SHIPPED_YIELD_URL;
  const params = new URLSearchParams({ fromYear: String(range.fromYear) });
  if (range.fromWeek !== undefined) params.set("fromWeek", String(range.fromWeek));
  params.set("toYear", String(range.toYear ?? range.fromYear));
  if (range.toWeek !== undefined) params.set("toWeek", String(range.toWeek));
  return `${SHIPPED_YIELD_URL}?${params.toString()}`;
}

/** True when pack totals are authoritative for this ISO week (and its colour rows are superseded). */
export function isPackWeek(sync: PackSyncSummary | null, year: number, week: number): boolean {
  if (!sync || sync.scopeStatus !== "available" || !sync.firstWeek || !sync.lastWeek) return false;
  const ord = year * 100 + week;
  return ord >= sync.firstWeek.isoYear * 100 + sync.firstWeek.isoWeek && ord <= sync.lastWeek.isoYear * 100 + sync.lastWeek.isoWeek;
}

export function formatCases(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? rounded.toLocaleString() : rounded.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function formatShippedKg(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

/**
 * "Incomplete: 432.5 shipped cases have no usable measurement · 75 cases need
 * attention", or null when every shipped case is measured.
 */
export function incompleteShippedText(totals: Pick<ShippedTotals, "complete" | "unmeasuredCases" | "attentionCases">): string | null {
  if (totals.complete) return null;
  const parts: string[] = [];
  if (totals.unmeasuredCases > 0) {
    parts.push(`${formatCases(totals.unmeasuredCases)} shipped case${totals.unmeasuredCases === 1 ? "" : "s"} ${totals.unmeasuredCases === 1 ? "has" : "have"} no usable measurement`);
  }
  if (totals.attentionCases > 0) {
    parts.push(`${formatCases(totals.attentionCases)} case${totals.attentionCases === 1 ? "" : "s"} need${totals.attentionCases === 1 ? "s" : ""} attention`);
  }
  return `Incomplete: ${parts.join(" · ")}. Shipped kg covers measured cases only.`;
}

export const ATTENTION_REASON_LABELS: Record<string, string> = {
  unattributed: "Not linked to a DockLink pack",
  unsupported_colour: "Pack colour GrowLink doesn't track",
  unsupported_kind: "Pack has no single or mixed pepper colour",
  unsupported_unit: "Not tracked in kg",
  unknown_crop: "Crop type missing"
};

/**
 * Shipped kg per colour from a /api/shipped-yield response body. A body
 * without totals (malformed, or an older server) reads as no shipped kg
 * rather than throwing, so a shipped-totals problem never hides harvested data.
 */
export function shippedKgByColor(body: unknown): Partial<Record<PepperColor, number>> {
  const colors = (body as { totals?: { colors?: Partial<ColorTotals> } } | null)?.totals?.colors;
  if (!colors || typeof colors !== "object") return {};
  const out: Partial<Record<PepperColor, number>> = {};
  for (const color of PEPPER_COLORS) {
    const kg = Number(colors[color]?.kg);
    if (Number.isFinite(kg) && kg > 0) out[color] = kg;
  }
  return out;
}

/** incompleteShippedText for a raw response body; null when the body has no totals. */
export function incompleteShippedTextFor(body: unknown): string | null {
  const totals = (body as { totals?: ShippedTotals } | null)?.totals;
  return totals && typeof totals.complete === "boolean" ? incompleteShippedText(totals) : null;
}
