// Pure helpers for the weekly pack measurement cards: what a card shows, how
// its inputs (the "draft") compare with what's saved, what Save / Remember
// would send, and how drafts survive a data refresh. No kg is calculated
// here — every kg comes from the server's shipped-yield calculation.
import { PEPPER_COLORS, type PepperColor } from "../lib/shippedYield";

/** "remembered": no measurement of the week's own; kg uses the remembered measurement in effect. */
export type SeriesStatus = "measured" | "remembered" | "missing" | "incompatible" | "zero" | "no_shipments";

export type MeasurementView = {
  netKgPerCase: number | null;
  components: Array<{ color: PepperColor; piecesPerCase: number; fruitWeightG: number }>;
  copiedFrom: { isoYear: number; isoWeek: number } | null;
};

export type WeekRef = { isoYear: number; isoWeek: number };
/** A remembered value in effect for this week (value null when none), the week it took effect, and the week a later remembered value takes over. */
export type RememberedSlot<T> = { value: T | null; from: WeekRef | null; nextChange: WeekRef | null };
export type RememberedView = {
  netKgPerCase: RememberedSlot<number>;
  counts: RememberedSlot<Array<{ color: PepperColor; piecesPerCase: number }>>;
  fruitWeights: RememberedSlot<Array<{ color: PepperColor; fruitWeightG: number }>>;
};
export type RememberKind = "net_kg" | "counts" | "fruit_weights";

export type PackRow = {
  seriesKey: string | null;
  /** Identity of the week's measurement (pack + ship-time classification); null when nothing can be measured. */
  measurementKey: string | null;
  origin: "import" | "manual";
  entryCount: number | null;
  packId: string | null;
  name: string;
  packCode: string | null;
  currentName: string | null;
  currentPackCode: string | null;
  description: string | null;
  packStatus: "active" | "archived" | "not_in_catalogue" | "historical";
  colorKind: "single" | "mixed" | string | null;
  colorKey: string | null;
  colorLabel: string | null;
  reclassifiedSince: boolean;
  cases: number;
  loadCount: number | null;
  status: SeriesStatus;
  /** False for manual entries in a week where colour totals count instead. */
  counted: boolean;
  kg: number | null;
  kgByColor: Partial<Record<PepperColor, number>> | null;
  /** The week's own measurement (never a remembered one). */
  measurement: MeasurementView | null;
  /** Remembered values in effect for this week; absent from servers before remembered measurements. */
  remembered?: RememberedView | null;
};

export type Draft = { netKgPerCase: string; components: Record<PepperColor, { piecesPerCase: string; fruitWeightG: string }> };

export const COLOR_LABEL: Record<PepperColor, string> = { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green" };
export const weekLabel = (w: { isoYear: number; isoWeek: number }) => `${w.isoYear}-W${String(w.isoWeek).padStart(2, "0")}`;
export const formatPerCase = (kg: number) => `${kg.toLocaleString(undefined, { maximumFractionDigits: 3 })} kg/case`;

const REMEMBER_NAMES: Record<RememberKind, string> = { net_kg: "Weight", counts: "Counts", fruit_weights: "Fruit weights" };
export const rememberedNotice = (kind: RememberKind, week: WeekRef) => `✓ ${REMEMBER_NAMES[kind]} remembered from ${weekLabel(week)}`;

/** The week's own measurement, or else the remembered values in effect (so they can be saved for this week only, or changed). */
export function draftFrom(row: PackRow): Draft {
  const components = Object.fromEntries(PEPPER_COLORS.map((c) => [c, { piecesPerCase: "", fruitWeightG: "" }])) as Draft["components"];
  if (row.measurement) {
    for (const c of row.measurement.components) {
      components[c.color] = { piecesPerCase: String(c.piecesPerCase), fruitWeightG: String(c.fruitWeightG) };
    }
    return { netKgPerCase: row.measurement.netKgPerCase != null ? String(row.measurement.netKgPerCase) : "", components };
  }
  for (const c of row.remembered?.counts.value ?? []) components[c.color] = { ...components[c.color], piecesPerCase: String(c.piecesPerCase) };
  for (const c of row.remembered?.fruitWeights.value ?? []) components[c.color] = { ...components[c.color], fruitWeightG: String(c.fruitWeightG) };
  const net = row.remembered?.netKgPerCase.value;
  return { netKgPerCase: net != null ? String(net) : "", components };
}

/** "5.20" and "5.2" are the same value; blank stays blank; anything else compares as typed. */
const normal = (v: string) => {
  const t = v.trim();
  if (t === "") return "";
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : t;
};

/** True when two drafts hold the same values (so the inputs match what was loaded). */
export function sameDraft(a: Draft, b: Draft): boolean {
  if (normal(a.netKgPerCase) !== normal(b.netKgPerCase)) return false;
  return PEPPER_COLORS.every(
    (c) => normal(a.components[c].piecesPerCase) === normal(b.components[c].piecesPerCase) && normal(a.components[c].fruitWeightG) === normal(b.components[c].fruitWeightG)
  );
}

type Checked<T> = { ok: true; payload: T } | { ok: false; error: string | null };

/** What Save sends for the row (this week's own measurement), or why it can't be sent (error null: nothing entered). */
export function measurementPayload(row: PackRow, draft: Draft): Checked<Record<string, unknown>> {
  if (row.colorKind === "single") {
    if (draft.netKgPerCase.trim() === "") return { ok: false, error: null };
    const value = Number(draft.netKgPerCase);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: "Enter the average net pepper kg per shipping case (greater than 0)." };
    return { ok: true, payload: { netKgPerCase: value } };
  }
  const components: Array<{ color: PepperColor; piecesPerCase: number; fruitWeightG: number }> = [];
  for (const color of PEPPER_COLORS) {
    const c = draft.components[color];
    const hasPieces = c.piecesPerCase.trim() !== "";
    const hasWeight = c.fruitWeightG.trim() !== "";
    if (!hasPieces && !hasWeight) continue;
    const pieces = Number(c.piecesPerCase);
    const weight = Number(c.fruitWeightG);
    if (!hasPieces || !hasWeight || !(pieces > 0) || !(weight > 0)) {
      return { ok: false, error: `${COLOR_LABEL[color]}: enter both peppers per shipping case and fruit weight (g), each greater than 0 — or leave both blank.` };
    }
    components.push({ color, piecesPerCase: pieces, fruitWeightG: weight });
  }
  if (components.length === 0) return { ok: false, error: null };
  return { ok: true, payload: { components } };
}

/** What a Remember action sends: kg per case, or a rainbow pack's counts or fruit weights on their own. */
export function rememberPayload(draft: Draft, kind: RememberKind): Checked<Record<string, unknown>> {
  if (kind === "net_kg") {
    if (draft.netKgPerCase.trim() === "") return { ok: false, error: null };
    const value = Number(draft.netKgPerCase);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: "Enter the average net pepper kg per shipping case (greater than 0)." };
    return { ok: true, payload: { netKgPerCase: value } };
  }
  const field = kind === "counts" ? "piecesPerCase" : "fruitWeightG";
  const list: Array<Record<string, unknown>> = [];
  for (const color of PEPPER_COLORS) {
    const raw = draft.components[color][field];
    if (raw.trim() === "") continue;
    const value = Number(raw);
    if (!(value > 0)) {
      return { ok: false, error: `${COLOR_LABEL[color]}: ${kind === "counts" ? "peppers per shipping case" : "fruit weight (g)"} must be greater than 0 — or leave it blank.` };
    }
    list.push({ color, [field]: value });
  }
  if (list.length === 0) return { ok: false, error: null };
  return { ok: true, payload: kind === "counts" ? { counts: list } : { fruitWeights: list } };
}

/** True when the inputs hold exactly the remembered value in effect this week (remembering again would change nothing). */
export function matchesRemembered(row: PackRow, draft: Draft, kind: RememberKind): boolean {
  const r = row.remembered;
  if (!r) return false;
  if (kind === "net_kg") return r.netKgPerCase.value !== null && normal(draft.netKgPerCase) === String(r.netKgPerCase.value);
  const remembered = kind === "counts" ? r.counts.value : r.fruitWeights.value;
  if (!remembered) return false;
  const field = kind === "counts" ? "piecesPerCase" : "fruitWeightG";
  const byColor = new Map<PepperColor, number>(remembered.map((c) => [c.color, kind === "counts" ? (c as { piecesPerCase: number }).piecesPerCase : (c as { fruitWeightG: number }).fruitWeightG]));
  return PEPPER_COLORS.every((c) => normal(draft.components[c][field]) === (byColor.has(c) ? String(byColor.get(c)) : ""));
}

/**
 * New drafts after a refresh: cards whose inputs were edited (they differ
 * from what was loaded before) keep the edits, unless listed in `reset` (just
 * saved or cleared); every other card shows the fresh data.
 */
export function mergeDrafts(
  rows: PackRow[],
  current: Record<string, Draft>,
  previousBaselines: Record<string, Draft>,
  reset: ReadonlySet<string> = new Set()
): { drafts: Record<string, Draft>; baselines: Record<string, Draft> } {
  const drafts: Record<string, Draft> = {};
  const baselines: Record<string, Draft> = {};
  for (const row of rows) {
    if (!row.measurementKey) continue;
    const key = row.measurementKey;
    const fresh = draftFrom(row);
    baselines[key] = fresh;
    const edited = current[key] && previousBaselines[key] && !sameDraft(current[key], previousBaselines[key]);
    drafts[key] = edited && !reset.has(key) ? current[key] : fresh;
  }
  return { drafts, baselines };
}

/** What the card's save indicator says. */
export type SaveState = "saving" | "unsaved" | "saved" | null;

export function saveState(row: PackRow, draft: Draft, baseline: Draft | undefined, saving: boolean): SaveState {
  if (saving) return "saving";
  if (baseline && !sameDraft(draft, baseline)) return "unsaved";
  return row.measurement ? "saved" : null;
}

export function statusText(row: PackRow): { label: string; tone: "ok" | "remembered" | "warn" | "muted" } {
  switch (row.status) {
    case "measured":
      return row.measurement?.copiedFrom
        ? { label: `Measured · copied from ${weekLabel(row.measurement.copiedFrom)}`, tone: "ok" }
        : { label: "Measured", tone: "ok" };
    case "remembered":
      return row.colorKind === "single" && row.remembered?.netKgPerCase.value != null
        ? { label: `Remembered weight · ${formatPerCase(row.remembered.netKgPerCase.value)}`, tone: "remembered" }
        : { label: "Remembered weight", tone: "remembered" };
    case "missing":
      return { label: "Missing measurement", tone: "warn" };
    case "incompatible":
      return { label: "Measured for another classification — enter again", tone: "warn" };
    case "zero":
      return { label: "0 cases (voided or corrected)", tone: "muted" };
    default:
      return { label: "No shipments this week", tone: "muted" };
  }
}

const countsText = (list: Array<{ color: PepperColor; piecesPerCase: number }>) => list.map((c) => `${COLOR_LABEL[c.color]} ${c.piecesPerCase}`).join(", ");
const weightsText = (list: Array<{ color: PepperColor; fruitWeightG: number }>) => list.map((c) => `${COLOR_LABEL[c.color]} ${c.fruitWeightG} g`).join(", ");

/** One line per remembered value in effect this week, with when it took effect and when a later one takes over. */
export function rememberedLines(row: PackRow): Array<{ kind: RememberKind; text: string }> {
  const r = row.remembered;
  if (!r) return [];
  const span = (slot: RememberedSlot<unknown>) =>
    `${slot.from ? ` (from ${weekLabel(slot.from)})` : ""}${slot.nextChange ? `; changes from ${weekLabel(slot.nextChange)}` : ""}`;
  if (row.colorKind === "single") {
    return r.netKgPerCase.value !== null ? [{ kind: "net_kg", text: `Remembered weight: ${formatPerCase(r.netKgPerCase.value)}${span(r.netKgPerCase)}` }] : [];
  }
  const lines: Array<{ kind: RememberKind; text: string }> = [];
  if (r.counts.value) lines.push({ kind: "counts", text: `Remembered peppers per case: ${countsText(r.counts.value)}${span(r.counts)}` });
  if (r.fruitWeights.value) lines.push({ kind: "fruit_weights", text: `Remembered fruit weights: ${weightsText(r.fruitWeights.value)}${span(r.fruitWeights)}` });
  return lines;
}
