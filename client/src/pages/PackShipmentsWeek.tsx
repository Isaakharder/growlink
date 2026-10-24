import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { isoWeekOf, isoWeekRangeLabel, isoWeeksInYear, shiftIsoWeek } from "../lib/isoWeek";
import {
  ATTENTION_REASON_LABELS,
  PEPPER_COLORS,
  MANUAL_STATUS_LABELS,
  WEEK_SOURCE_LABELS,
  WEEK_SOURCE_REASON_LABELS,
  formatCases,
  formatShippedKg,
  incompleteShippedText,
  notCountedText,
  type NotCounted,
  type ManualWeekStatus,
  type PackSyncSummary,
  type PepperColor,
  type ShippedWeekTotals,
  type WeekSource,
  type WeekSourceReason
} from "../lib/shippedYield";
import { classificationLabel, confirmWeek, deleteManualEntry, setWeekSource, unconfirmWeek, type ManualEntry, type WeekSourceChoice } from "../lib/manualPackEntries";
import { ManualPackEntryModal } from "./ManualPackEntryModal";

// Weekly pack shipments for one ISO week: DockLink's shipped cases per
// Product Pack, or the week's manual pack entries (from invoices), with the
// measurements GrowLink needs to turn them into kg. Exactly one source counts
// per week and the screen says which. Every kg shown here comes from the
// server's shipped-yield calculation — this screen only collects
// measurements and manual entries.

const WEEK_URL = "/api/pack-shipments/week";
const MEASUREMENTS_URL = "/api/pack-shipments/measurements";
const COPY_URL = "/api/pack-shipments/measurements/copy";
const DEFAULTS_URL = "/api/pack-shipments/measurement-defaults";

/** "remembered": no measurement of the week's own; kg uses the remembered measurement in effect. */
type SeriesStatus = "measured" | "remembered" | "missing" | "incompatible" | "zero" | "no_shipments";

type MeasurementView = {
  netKgPerCase: number | null;
  components: Array<{ color: PepperColor; piecesPerCase: number; fruitWeightG: number }>;
  copiedFrom: { isoYear: number; isoWeek: number } | null;
};

type WeekRef = { isoYear: number; isoWeek: number };
/** A remembered value in effect for this week (value null when none), the week it took effect, and the week a later remembered value takes over. */
type RememberedSlot<T> = { value: T | null; from: WeekRef | null; nextChange: WeekRef | null };
type RememberedView = {
  netKgPerCase: RememberedSlot<number>;
  counts: RememberedSlot<Array<{ color: PepperColor; piecesPerCase: number }>>;
  fruitWeights: RememberedSlot<Array<{ color: PepperColor; fruitWeightG: number }>>;
};
type RememberKind = "net_kg" | "counts" | "fruit_weights";

type PackRow = {
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

type AttentionRow = { seriesKey: string; name: string; packCode: string | null; cases: number; reason: string; sourcePackRef: string | null; colorKey: string | null; cropType: string | null; trackingUnit: string | null };
type NonPepperRow = { seriesKey: string | null; name: string; packCode: string | null; cases: number; cropType: string | null; trackingUnit: string | null };
type LegacyRowView = { color: string; totalCases: number; caseWeightKg: number; totalKg: number; source: string | null };

export type PackWeekResponse = {
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  weekEnd: string;
  sync: PackSyncSummary | null;
  source: WeekSource;
  sourceReason: WeekSourceReason;
  needsSourceDecision: boolean;
  weekSourceChoice: WeekSourceChoice | null;
  rebuildRange: { id: string; from: { isoYear: number; isoWeek: number }; to: { isoYear: number; isoWeek: number } } | null;
  manualStatus: ManualWeekStatus | null;
  confirmation: { confirmedAt: string; note: string | null } | null;
  notCounted: NotCounted;
  manualEntryAllowed: boolean;
  manualEntryBlockedReason: string | null;
  manualEntries: ManualEntry[];
  packs: PackRow[];
  attention: AttentionRow[];
  nonPepper: NonPepperRow[];
  legacyRows: LegacyRowView[];
  totals: ShippedWeekTotals | null;
  copySource: { isoYear: number; isoWeek: number; matchingSeries: number } | null;
};

type Draft = { netKgPerCase: string; components: Record<PepperColor, { piecesPerCase: string; fruitWeightG: string }> };

const COLOR_LABEL: Record<PepperColor, string> = { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green" };
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const weekLabel = (w: { isoYear: number; isoWeek: number }) => `${w.isoYear}-W${String(w.isoWeek).padStart(2, "0")}`;

/** The week's own measurement, or else the remembered values in effect (so they can be saved for this week only, or changed). */
function draftFrom(row: PackRow): Draft {
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

const formatPerCase = (kg: number) => `${kg.toLocaleString(undefined, { maximumFractionDigits: 3 })} kg/case`;
const countsText = (list: Array<{ color: PepperColor; piecesPerCase: number }>) => list.map((c) => `${COLOR_LABEL[c.color]} ${c.piecesPerCase}`).join(", ");
const weightsText = (list: Array<{ color: PepperColor; fruitWeightG: number }>) => list.map((c) => `${COLOR_LABEL[c.color]} ${c.fruitWeightG} g`).join(", ");

/** One line per remembered value in effect this week, with when it took effect and when a later one takes over. */
function rememberedLines(row: PackRow): string[] {
  const r = row.remembered;
  if (!r) return [];
  const span = (slot: RememberedSlot<unknown>) =>
    `${slot.from ? ` (from ${weekLabel(slot.from)})` : ""}${slot.nextChange ? `; changes from ${weekLabel(slot.nextChange)}` : ""}`;
  const lines: string[] = [];
  if (row.colorKind === "single") {
    if (r.netKgPerCase.value !== null) lines.push(`Remembered weight: ${formatPerCase(r.netKgPerCase.value)}${span(r.netKgPerCase)}`);
    return lines;
  }
  if (r.counts.value) lines.push(`Remembered peppers per case: ${countsText(r.counts.value)}${span(r.counts)}`);
  if (r.fruitWeights.value) lines.push(`Remembered fruit weights: ${weightsText(r.fruitWeights.value)}${span(r.fruitWeights)}`);
  return lines;
}

function statusText(row: PackRow): { label: string; tone: "ok" | "warn" | "muted" } {
  switch (row.status) {
    case "measured":
      return row.measurement?.copiedFrom
        ? { label: `Measured · copied from ${weekLabel(row.measurement.copiedFrom)}`, tone: "ok" }
        : { label: "Measured", tone: "ok" };
    case "remembered":
      return row.colorKind === "single" && row.remembered?.netKgPerCase.value != null
        ? { label: `Remembered weight · ${formatPerCase(row.remembered.netKgPerCase.value)}`, tone: "ok" }
        : { label: "Remembered weight", tone: "ok" };
    case "missing":
      return { label: "Missing measurement", tone: "warn" };
    case "incompatible":
      return { label: "Measurement was entered for another classification — enter it again", tone: "warn" };
    case "zero":
      return { label: "0 cases (voided or corrected)", tone: "muted" };
    default:
      return { label: "No shipments this week", tone: "muted" };
  }
}

const hasKg = (row: PackRow) => row.status === "measured" || row.status === "remembered";
const hasRemembered = (row: PackRow) => rememberedLines(row).length > 0;

/** The remembered values in effect this week, what this week uses, and Forget for each. */
function RememberedNotes({ row, disabled, onForget }: { row: PackRow; disabled: boolean; onForget: (kind: RememberKind) => void }) {
  const r = row.remembered;
  if (!r) return null;
  const slots: Array<{ kind: RememberKind; line: string; label: string }> = [];
  const lines = rememberedLines(row);
  if (row.colorKind === "single") {
    if (r.netKgPerCase.value !== null) slots.push({ kind: "net_kg", line: lines[0], label: "Forget remembered weight" });
  } else {
    let i = 0;
    if (r.counts.value) slots.push({ kind: "counts", line: lines[i++], label: "Forget remembered counts" });
    if (r.fruitWeights.value) slots.push({ kind: "fruit_weights", line: lines[i++], label: "Forget remembered fruit weights" });
  }
  if (slots.length === 0) return null;
  const overridden = row.status === "measured";
  const partial = row.colorKind === "mixed" && row.status !== "remembered" && !overridden;
  return (
    <div className="pack-week-remembered">
      {slots.map((s) => (
        <p key={s.kind} className="pack-week-note">
          {s.line}{" "}
          <button type="button" className="link-button" onClick={() => onForget(s.kind)} disabled={disabled}>
            {s.label}
          </button>
        </p>
      ))}
      {overridden ? <p className="pack-week-note">This week's own measurement is used instead; Clear it to use the remembered values.</p> : null}
      {partial ? (
        <p className="pack-week-note">
          {r.counts.value && !r.fruitWeights.value
            ? "Remembered counts are filled in. Enter this week's fruit weights and Save, or remember fruit weights too."
            : r.fruitWeights.value && !r.counts.value
              ? "Remembered fruit weights are filled in. Enter this week's peppers per case and Save, or remember counts too."
              : "The remembered fruit weights don't cover every remembered colour; enter the missing ones and Save or remember them."}
        </p>
      ) : null}
    </div>
  );
}

function scopeText(sync: PackSyncSummary | null): string {
  if (!sync) return "Pack shipments haven't been synced from DockLink yet. Weekly totals use colour totals.";
  if (sync.scopeStatus === "available" && sync.firstWeek && sync.lastWeek) {
    const transition = sync.transitionWeek ? ` ${weekLabel(sync.transitionWeek)} and earlier use colour totals or manual pack entries.` : "";
    return `Pack totals from ${weekLabel(sync.firstWeek)} to ${weekLabel(sync.lastWeek)}.${transition} Last synced ${new Date(sync.lastSyncedAt).toLocaleString()}.`;
  }
  return sync.scopeStatus === "pending_first_full_week"
    ? "DockLink has started capturing packs; pack totals begin after its first full week. Every week uses colour totals until then."
    : "Pack capture isn't active in DockLink yet. Every week uses colour totals.";
}

export function PackShipmentsWeek({
  refreshKey = 0,
  initialWeek,
  onChanged
}: {
  refreshKey?: number;
  initialWeek?: { isoYear: number; isoWeek: number };
  /** Called after manual entries or the week's source change, so other totals on the page can refresh. */
  onChanged?: () => void;
}) {
  const [selected, setSelected] = useState(() => initialWeek ?? isoWeekOf(new Date()));
  const [data, setData] = useState<PackWeekResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const [entryModal, setEntryModal] = useState<{ kind: "create" } | { kind: "edit"; entry: ManualEntry } | null>(null);
  const [entryStatus, setEntryStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`${WEEK_URL}?isoYear=${selected.isoYear}&isoWeek=${selected.isoWeek}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load pack shipments (${response.status})`);
      }
      const raw = (await response.json()) as Partial<PackWeekResponse> & Pick<PackWeekResponse, "isoYear" | "isoWeek">;
      // A server from before manual pack entries (e.g. mid-deploy) omits these; read it as "nothing manual".
      const body: PackWeekResponse = {
        ...(raw as PackWeekResponse),
        sourceReason: raw.sourceReason ?? (raw.source === "packs" ? "docklink_scope" : "legacy_only"),
        needsSourceDecision: raw.needsSourceDecision ?? false,
        weekSourceChoice: raw.weekSourceChoice ?? null,
        rebuildRange: raw.rebuildRange ?? null,
        manualStatus: raw.manualStatus ?? null,
        confirmation: raw.confirmation ?? null,
        notCounted: raw.notCounted ?? { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 },
        manualEntryAllowed: raw.manualEntryAllowed ?? false,
        manualEntryBlockedReason: raw.manualEntryBlockedReason ?? null,
        manualEntries: raw.manualEntries ?? [],
        packs: (raw.packs ?? []).map((p) => ({ ...p, measurementKey: p.measurementKey ?? p.seriesKey ?? null, origin: p.origin ?? "import", counted: p.counted ?? true })),
        attention: raw.attention ?? [],
        nonPepper: raw.nonPepper ?? [],
        legacyRows: raw.legacyRows ?? []
      } as PackWeekResponse;
      setData(body);
      setDrafts(Object.fromEntries(body.packs.filter((p) => p.measurementKey).map((p) => [p.measurementKey as string, draftFrom(p)])));
      setRowErrors({});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load pack shipments");
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Manual history can go back further than DockLink's pack capture.
  const yearOptions = useMemo(() => {
    const now = isoWeekOf(new Date()).isoYear;
    return Array.from({ length: 8 }, (_, i) => now - 6 + i);
  }, []);

  function setDraft(key: string, update: (d: Draft) => Draft) {
    setDrafts((current) => ({ ...current, [key]: update(current[key]) }));
  }

  async function changed(message: string | null) {
    if (message) setEntryStatus({ kind: "success", message });
    await load();
    onChanged?.();
  }

  async function removeEntry(entry: ManualEntry) {
    if (!window.confirm(`Delete this entry (${entry.packName}, ${formatCases(entry.cases)} cases${entry.invoiceRef ? `, invoice ${entry.invoiceRef}` : ""})?`)) return;
    try {
      const result = await deleteManualEntry(entry.id);
      await changed(
        result.remainingEntries === 0
          ? "Entry deleted. The week has no entries left; it still uses manual pack entries and reads “not entered yet” until you add entries, confirm it had no shipments, or switch it to colour totals."
          : "Entry deleted."
      );
    } catch (deleteError) {
      setEntryStatus({ kind: "error", message: deleteError instanceof Error ? deleteError.message : "Delete failed" });
    }
  }

  async function setConfirmed(confirmed: boolean) {
    try {
      if (confirmed) await confirmWeek(selected.isoYear, selected.isoWeek);
      else await unconfirmWeek(selected.isoYear, selected.isoWeek);
      await changed(confirmed ? `${weekLabel(selected)} confirmed complete.` : `${weekLabel(selected)} is no longer confirmed.`);
    } catch (confirmError) {
      setEntryStatus({ kind: "error", message: confirmError instanceof Error ? confirmError.message : "Couldn't change the confirmation" });
    }
  }

  async function chooseSource(source: WeekSourceChoice) {
    try {
      await setWeekSource(selected.isoYear, selected.isoWeek, source);
      await changed(`${weekLabel(selected)} now counts ${source === "manual_packs" ? "manual pack entries" : "colour totals"}.`);
    } catch (sourceError) {
      setEntryStatus({ kind: "error", message: sourceError instanceof Error ? sourceError.message : "Couldn't change the week's source" });
    }
  }

  /** kg per case from the draft, or an error message. */
  function draftNetKg(draft: Draft): { netKgPerCase: number } | string {
    const value = Number(draft.netKgPerCase);
    if (!draft.netKgPerCase.trim() || !Number.isFinite(value) || value <= 0) return "Enter the average net pepper kg per shipping case (greater than 0).";
    return { netKgPerCase: value };
  }

  const rowError = (key: string, message: string) => setRowErrors((current) => ({ ...current, [key]: message }));

  async function save(row: PackRow) {
    const seriesKey = row.measurementKey as string;
    const draft = drafts[seriesKey];
    rowError(seriesKey, "");
    let payload: Record<string, unknown>;
    if (row.colorKind === "single") {
      const net = draftNetKg(draft);
      if (typeof net === "string") return rowError(seriesKey, net);
      payload = net;
    } else {
      const components: Array<{ color: PepperColor; piecesPerCase: number; fruitWeightG: number }> = [];
      for (const color of PEPPER_COLORS) {
        const c = draft.components[color];
        const hasPieces = c.piecesPerCase.trim() !== "";
        const hasWeight = c.fruitWeightG.trim() !== "";
        if (!hasPieces && !hasWeight) continue;
        const pieces = Number(c.piecesPerCase);
        const weight = Number(c.fruitWeightG);
        if (!hasPieces || !hasWeight || !(pieces > 0) || !(weight > 0)) {
          return rowError(seriesKey, `${COLOR_LABEL[color]}: enter both peppers per shipping case and fruit weight (g), each greater than 0 — or leave both blank.`);
        }
        components.push({ color, piecesPerCase: pieces, fruitWeightG: weight });
      }
      if (components.length === 0) return rowError(seriesKey, "Enter at least one colour in this pack.");
      payload = { components };
    }
    setSavingKey(seriesKey);
    try {
      const response = await apiFetch(MEASUREMENTS_URL, {
        method: "PUT",
        // seriesKey too for DockLink series, so an older server (series-keyed measurements) still finds the row.
        body: JSON.stringify({ isoYear: selected.isoYear, isoWeek: selected.isoWeek, measurementKey: seriesKey, ...(row.seriesKey ? { seriesKey: row.seriesKey } : {}), ...payload })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Save failed (${response.status})`);
      }
      await load();
    } catch (saveError) {
      setRowErrors((current) => ({ ...current, [seriesKey]: saveError instanceof Error ? saveError.message : "Save failed" }));
    } finally {
      setSavingKey(null);
    }
  }

  async function clear(row: PackRow) {
    const seriesKey = row.measurementKey as string;
    setSavingKey(seriesKey);
    try {
      const params = new URLSearchParams({ isoYear: String(selected.isoYear), isoWeek: String(selected.isoWeek), measurementKey: seriesKey });
      if (row.seriesKey) params.set("seriesKey", row.seriesKey);
      const response = await apiFetch(`${MEASUREMENTS_URL}?${params.toString()}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Clear failed (${response.status})`);
      await load();
    } catch (clearError) {
      setRowErrors((current) => ({ ...current, [seriesKey]: clearError instanceof Error ? clearError.message : "Clear failed" }));
    } finally {
      setSavingKey(null);
    }
  }

  const rowParams = (row: PackRow) => ({
    isoYear: selected.isoYear,
    isoWeek: selected.isoWeek,
    measurementKey: row.measurementKey as string,
    ...(row.seriesKey ? { seriesKey: row.seriesKey } : {})
  });

  /**
   * Remembers this row's draft (kg per case, or a rainbow pack's counts or
   * fruit weights) for this week and later weeks without a measurement of
   * their own. Earlier weeks and saved measurements are unchanged.
   */
  async function remember(row: PackRow, kind: RememberKind) {
    const key = row.measurementKey as string;
    const draft = drafts[key];
    rowError(key, "");
    let payload: Record<string, unknown>;
    if (kind === "net_kg") {
      const net = draftNetKg(draft);
      if (typeof net === "string") return rowError(key, net);
      payload = net;
    } else {
      const field = kind === "counts" ? "piecesPerCase" : "fruitWeightG";
      const list: Array<Record<string, unknown>> = [];
      for (const color of PEPPER_COLORS) {
        const raw = draft.components[color][field];
        if (raw.trim() === "") continue;
        const value = Number(raw);
        if (!(value > 0)) {
          return rowError(key, `${COLOR_LABEL[color]}: ${kind === "counts" ? "peppers per shipping case" : "fruit weight (g)"} must be greater than 0 — or leave it blank.`);
        }
        list.push({ color, [field]: value });
      }
      if (list.length === 0) {
        return rowError(key, kind === "counts" ? "Enter peppers per shipping case for at least one colour to remember." : "Enter a fruit weight for at least one colour to remember.");
      }
      payload = kind === "counts" ? { counts: list } : { fruitWeights: list };
    }
    setSavingKey(key);
    try {
      const response = await apiFetch(DEFAULTS_URL, { method: "PUT", body: JSON.stringify({ ...rowParams(row), valueKind: kind, ...payload }) });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Remember failed (${response.status})`);
      }
      await load();
      onChanged?.();
    } catch (rememberError) {
      rowError(key, rememberError instanceof Error ? rememberError.message : "Remember failed");
    } finally {
      setSavingKey(null);
    }
  }

  async function forget(row: PackRow, kind: RememberKind) {
    const key = row.measurementKey as string;
    const what = kind === "net_kg" ? "remembered weight" : kind === "counts" ? "remembered peppers per case" : "remembered fruit weights";
    if (!window.confirm(`Forget the ${what} from ${weekLabel(selected)} on? Earlier weeks keep it, and weeks with their own measurement are unchanged.`)) return;
    rowError(key, "");
    setSavingKey(key);
    try {
      const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(rowParams(row)).map(([k, v]) => [k, String(v)])), valueKind: kind });
      const response = await apiFetch(`${DEFAULTS_URL}?${params.toString()}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Forget failed (${response.status})`);
      }
      await load();
      onChanged?.();
    } catch (forgetError) {
      rowError(key, forgetError instanceof Error ? forgetError.message : "Forget failed");
    } finally {
      setSavingKey(null);
    }
  }

  async function copyFrom(source: { isoYear: number; isoWeek: number }) {
    setCopyState({ busy: true, message: null });
    try {
      const response = await apiFetch(COPY_URL, {
        method: "POST",
        body: JSON.stringify({ isoYear: selected.isoYear, isoWeek: selected.isoWeek, fromIsoYear: source.isoYear, fromIsoWeek: source.isoWeek })
      });
      const body = (await response.json().catch(() => null)) as { message?: string; copied?: unknown[]; skipped?: unknown[] } | null;
      if (!response.ok) throw new Error(body?.message ?? `Copy failed (${response.status})`);
      const copied = body?.copied?.length ?? 0;
      setCopyState({ busy: false, message: `Copied ${copied} measurement${copied === 1 ? "" : "s"} from ${weekLabel(source)}. Check them before relying on this week's kg.` });
      await load();
    } catch (copyError) {
      setCopyState({ busy: false, message: copyError instanceof Error ? copyError.message : "Copy failed" });
    }
  }

  const totals = data?.totals ?? null;
  const incomplete = totals ? incompleteShippedText(totals) : null;
  const rememberHint = `Used from ${weekLabel(selected)} on for this pack and colour, in weeks without their own measurement. Earlier weeks and saved measurements aren't changed.`;

  return (
    <section className="coming-soon-card pack-week" aria-labelledby="pack-week-title">
      <div className="recent-entries-header">
        <h2 id="pack-week-title">Weekly Pack Shipments</h2>
        <div className="pack-week-picker">
          <button type="button" onClick={() => setSelected((s) => shiftIsoWeek(s.isoYear, s.isoWeek, -1))} aria-label="Previous ISO week">
            ‹
          </button>
          <label>
            <span>ISO year</span>
            <select
              value={selected.isoYear}
              onChange={(e) => {
                const isoYear = Number(e.target.value);
                setSelected((s) => ({ isoYear, isoWeek: Math.min(s.isoWeek, isoWeeksInYear(isoYear)) }));
              }}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>ISO week</span>
            <select value={selected.isoWeek} onChange={(e) => setSelected((s) => ({ ...s, isoWeek: Number(e.target.value) }))}>
              {Array.from({ length: isoWeeksInYear(selected.isoYear) }, (_, i) => i + 1).map((w) => (
                <option key={w} value={w}>
                  W{String(w).padStart(2, "0")}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setSelected((s) => shiftIsoWeek(s.isoYear, s.isoWeek, 1))} aria-label="Next ISO week">
            ›
          </button>
        </div>
      </div>

      <p className="pack-week-heading">
        <strong>{weekLabel(selected)}</strong> · {isoWeekRangeLabel(selected.isoYear, selected.isoWeek)} (ISO week, UTC)
      </p>
      {data ? <p className="recent-entries-helper-text">{scopeText(data.sync)}</p> : null}
      <p className="pack-week-explainer">
        <strong>Shipping case</strong> = one case on the pallet as DockLink counts it. A shipping case can hold several inner retail packs
        (for example 15 × 3-packs); enter measurements per <em>shipping case</em>, never per retail pack.
      </p>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading && !data ? <p>Loading…</p> : null}

      {data ? (
        <div
          className={`pack-week-source pack-week-source--${data.source}${data.needsSourceDecision ? " pack-week-source--decide" : ""}`}
          role="region"
          aria-label={`Source for ${weekLabel(data)}`}
        >
          <p>
            <span className="pack-week-source-label">Counted for {weekLabel(data)}:</span> <strong>{WEEK_SOURCE_LABELS[data.source]}</strong>
          </p>
          <p className="pack-week-note">
            {WEEK_SOURCE_REASON_LABELS[data.sourceReason]}
            {data.rebuildRange
              ? ` Rebuild range: ${weekLabel(data.rebuildRange.from)} to ${weekLabel(data.rebuildRange.to)}.`
              : ""}
          </p>
          {data.source === "manual" && data.manualStatus ? (
            <div className={`pack-week-manual-status pack-week-manual-status--${data.manualStatus}`}>
              <p>
                <strong>{MANUAL_STATUS_LABELS[data.manualStatus]}</strong>
                {data.manualStatus === "not_entered"
                  ? " — nothing entered for this week. Its shipments are unknown, not zero."
                  : data.manualStatus === "entered"
                    ? " — add any remaining invoices, then confirm the week."
                    : ` — ${data.manualEntries.length === 0 ? "no shipments this week" : "every invoice entered"} (confirmed ${new Date(data.confirmation?.confirmedAt ?? "").toLocaleDateString()}).`}
              </p>
              {data.manualEntryAllowed ? (
                data.manualStatus === "confirmed" ? (
                  <button type="button" className="secondary" onClick={() => void setConfirmed(false)}>
                    Undo confirmation
                  </button>
                ) : (
                  <button type="button" onClick={() => void setConfirmed(true)}>
                    {data.manualEntries.length === 0 ? "Confirm no shipments this week" : "Confirm week complete"}
                  </button>
                )
              ) : null}
            </div>
          ) : null}
          {notCountedText(data) ? <p className="pack-week-not-counted">{notCountedText(data)}</p> : null}
          {data.source !== "packs" && data.manualEntries.length > 0 && data.legacyRows.length > 0 ? (
            <div className="pack-week-source-actions">
              {data.source !== "manual" ? (
                <button type="button" onClick={() => void chooseSource("manual_packs")}>
                  Count manual pack entries
                </button>
              ) : null}
              {data.source !== "legacy" ? (
                <button type="button" className="secondary" onClick={() => void chooseSource("legacy_colours")}>
                  Count colour totals instead
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {data ? (
        <div className="pack-week-manual" role="region" aria-label="Manual pack entries">
          <div className="pack-week-manual-header">
            <h3>Manual pack entries</h3>
            {data.manualEntryAllowed ? (
              <button
                type="button"
                onClick={() => {
                  setEntryStatus(null);
                  setEntryModal({ kind: "create" });
                }}
              >
                Add entries for {weekLabel(data)}
              </button>
            ) : null}
          </div>
          {!data.manualEntryAllowed ? <p className="pack-week-note">{data.manualEntryBlockedReason}</p> : null}
          {entryStatus ? (
            <p className={`cases-sync-status cases-sync-status--${entryStatus.kind}`} role={entryStatus.kind === "error" ? "alert" : "status"}>
              {entryStatus.message}
            </p>
          ) : null}
          {data.manualEntries.length === 0 ? (
            data.manualEntryAllowed ? <p className="pack-week-note">No manual entries for this week.</p> : null
          ) : (
            <div className="varieties-table-wrapper">
              <table className="varieties-table pack-week-entries">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Pack</th>
                    <th scope="col">Colour</th>
                    <th scope="col">Cases</th>
                    <th scope="col">Note</th>
                    <th scope="col">
                      <span className="ya-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.manualEntries.map((e) => (
                    <tr key={e.id} className={e.duplicates.length > 0 ? "pack-week-entry--duplicate" : undefined}>
                      <td>
                        {e.invoiceRef ?? <span className="pack-week-note">No reference</span>}
                        {e.duplicates.length > 0 ? (
                          <span className="pack-week-badge pack-week-badge--warn" title="Same invoice and pack, or same week, pack and cases without a reference">
                            Possible duplicate of{" "}
                            {e.duplicates.map((d) => `${weekLabel(d)} · ${formatCases(d.cases)}${d.invoiceRef ? ` · ${d.invoiceRef}` : ""}`).join("; ")}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="pack-week-name">{e.packName}</span>
                        {e.packCode ? <span className="pack-week-code">{e.packCode}</span> : null}
                        {e.packSource === "historical" ? <span className="pack-week-badge">Historical</span> : null}
                      </td>
                      <td>{classificationLabel({ colorKind: e.colorKind as "single" | "mixed" | "none", colorKey: e.colorKey, cropType: e.cropType, trackingUnit: e.trackingUnit })}</td>
                      <td>{formatCases(e.cases)}</td>
                      <td>{e.note ?? ""}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            onClick={() => {
                              setEntryStatus(null);
                              setEntryModal({ kind: "edit", entry: e });
                            }}
                            aria-label={`Edit entry: ${e.packName}${e.invoiceRef ? `, invoice ${e.invoiceRef}` : ""}`}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void removeEntry(e)}
                            aria-label={`Delete entry: ${e.packName}${e.invoiceRef ? `, invoice ${e.invoiceRef}` : ""}`}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {data && (data.source === "legacy" || data.legacyRows.length > 0) ? (
        <div className={`pack-week-legacy${data.source === "legacy" ? "" : " pack-week-legacy--not-counted"}`}>
          <h3>Colour totals{data.source === "legacy" ? "" : " (not counted this week)"}</h3>
          {data.source === "legacy" && data.packs.length === 0 ? (
            <p>
              Pack measurements don't apply to colour-total weeks
              {data.sync?.firstWeek && data.sync.scopeStatus === "available" ? ` — DockLink pack totals start at ${weekLabel(data.sync.firstWeek)}` : ""}.
            </p>
          ) : null}
          {data.legacyRows.length === 0 ? (
            <p>No colour totals recorded for this week.</p>
          ) : (
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Colour</th>
                  <th>Cases</th>
                  <th>Case weight (kg)</th>
                  <th>Total kg</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {data.legacyRows.map((r) => (
                  <tr key={r.color}>
                    <td>{cap(r.color)}</td>
                    <td>{formatCases(r.totalCases)}</td>
                    <td>{r.caseWeightKg > 0 ? r.caseWeightKg : "Missing"}</td>
                    <td>{r.caseWeightKg > 0 ? formatShippedKg(r.totalKg) : "—"}</td>
                    <td>{cap(r.source ?? "manual")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {data && data.packs.length > 0 ? (
        <>
          {data.source !== "packs" ? (
            <h3 className="pack-week-subheading">
              Packs entered for {weekLabel(data)}
              {data.source === "manual" ? " — kg from this week's measurements" : " (not counted this week)"}
            </h3>
          ) : null}
          {data.copySource ? (
            <div className="pack-week-copy">
              <p>
                {data.copySource.matchingSeries} pack{data.copySource.matchingSeries === 1 ? "" : "s"} without a measurement this week{" "}
                {data.copySource.matchingSeries === 1 ? "has" : "have"} one in <strong>{weekLabel(data.copySource)}</strong> (same pack and classification).
              </p>
              <button type="button" onClick={() => void copyFrom(data.copySource!)} disabled={copyState.busy}>
                {copyState.busy ? "Copying…" : `Copy measurements from ${weekLabel(data.copySource)}`}
              </button>
            </div>
          ) : null}
          {copyState.message ? <p className="cases-sync-status cases-sync-status--success" role="status">{copyState.message}</p> : null}

          <div className="varieties-table-wrapper">
            <table className="varieties-table pack-week-table">
              <thead>
                <tr>
                  <th scope="col">Pack</th>
                  <th scope="col">Colour (at ship time)</th>
                  <th scope="col">{data.source === "packs" ? "Shipped cases" : "Entered cases"}</th>
                  <th scope="col">Measurement for {weekLabel(selected)}</th>
                  <th scope="col">Shipped kg</th>
                </tr>
              </thead>
              <tbody>
                {data.packs.map((row) => {
                  const key = row.measurementKey ?? row.seriesKey ?? `pack:${row.packId}`;
                  const mk = row.measurementKey;
                  const status = statusText(row);
                  const draft = mk ? drafts[mk] : undefined;
                  const editable = Boolean(mk && draft) && row.status !== "no_shipments";
                  return (
                    <tr key={key} className={`pack-week-row pack-week-row--${row.status}`} data-series-key={row.seriesKey ?? undefined}>
                      <th scope="row">
                        <span className="pack-week-name">{row.name}</span>
                        {row.packCode ? <span className="pack-week-code">{row.packCode}</span> : null}
                        {row.packStatus === "archived" ? <span className="pack-week-badge">Archived</span> : null}
                        {row.packStatus === "not_in_catalogue" ? <span className="pack-week-badge">No longer in DockLink</span> : null}
                        {row.packStatus === "historical" ? <span className="pack-week-badge">Historical pack</span> : null}
                        {row.currentName || row.currentPackCode ? (
                          <span className="pack-week-note">Now “{row.currentName ?? row.name}”{row.currentPackCode ? ` (${row.currentPackCode})` : ""}</span>
                        ) : null}
                        {row.reclassifiedSince ? <span className="pack-week-note">Classification changed since; this row keeps its ship-time colour.</span> : null}
                        {row.description ? <span className="pack-week-note">{row.description}</span> : null}
                      </th>
                      <td>
                        {row.colorKind === "mixed" ? (
                          <span className="pack-week-colour pack-week-colour--mixed">Mixed / rainbow</span>
                        ) : (
                          <span className="pack-week-colour">
                            {(PEPPER_COLORS as string[]).includes(row.colorKey ?? "") ? (
                              <span className={`weekly-docklink-dot weekly-docklink-dot-${row.colorKey}`} aria-hidden="true" />
                            ) : null}
                            {cap(row.colorKey ?? "") || "No colour"}
                            {(PEPPER_COLORS as string[]).includes(row.colorKey ?? "") ? null : (
                              <span className="pack-week-note">Not a colour GrowLink tracks — shipments would need attention</span>
                            )}
                          </span>
                        )}
                      </td>
                      <td>
                        {formatCases(row.cases)}
                        {row.loadCount ? <span className="pack-week-note">{row.loadCount} load{row.loadCount === 1 ? "" : "s"}</span> : null}
                        {row.entryCount ? <span className="pack-week-note">{row.entryCount} entr{row.entryCount === 1 ? "y" : "ies"}</span> : null}
                      </td>
                      <td>
                        {!editable ? (
                          <span className="pack-week-status pack-week-status--muted">{status.label}</span>
                        ) : row.colorKind === "single" ? (
                          <div className="pack-week-measure">
                            <label>
                              <span>Avg net pepper kg per shipping case</span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="0.01"
                                value={draft!.netKgPerCase}
                                aria-label={`Average net pepper kg per shipping case for ${row.name}`}
                                onChange={(e) => setDraft(mk!, (d) => ({ ...d, netKgPerCase: e.target.value }))}
                              />
                            </label>
                          </div>
                        ) : (
                          <div className="pack-week-measure pack-week-measure--mixed">
                            <p className="pack-week-note">Per colour, in one <strong>shipping case</strong> (all retail packs inside it). Leave colours that aren't in this pack blank.</p>
                            <table className="pack-week-components">
                              <thead>
                                <tr>
                                  <th scope="col">Colour</th>
                                  <th scope="col">Peppers per shipping case</th>
                                  <th scope="col">Avg fruit weight (g)</th>
                                  <th scope="col">kg</th>
                                </tr>
                              </thead>
                              <tbody>
                                {PEPPER_COLORS.map((color) => (
                                  <tr key={color}>
                                    <th scope="row">
                                      <span className={`weekly-docklink-dot weekly-docklink-dot-${color}`} aria-hidden="true" />
                                      {COLOR_LABEL[color]}
                                    </th>
                                    <td>
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        min="0"
                                        step="1"
                                        value={draft!.components[color].piecesPerCase}
                                        aria-label={`${COLOR_LABEL[color]} peppers per shipping case for ${row.name}`}
                                        onChange={(e) =>
                                          setDraft(mk!, (d) => ({ ...d, components: { ...d.components, [color]: { ...d.components[color], piecesPerCase: e.target.value } } }))
                                        }
                                      />
                                    </td>
                                    <td>
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        min="0"
                                        step="0.1"
                                        value={draft!.components[color].fruitWeightG}
                                        aria-label={`${COLOR_LABEL[color]} average fruit weight in grams for ${row.name}`}
                                        onChange={(e) =>
                                          setDraft(mk!, (d) => ({ ...d, components: { ...d.components, [color]: { ...d.components[color], fruitWeightG: e.target.value } } }))
                                        }
                                      />
                                    </td>
                                    <td>{hasKg(row) && row.kgByColor?.[color] !== undefined ? formatShippedKg(row.kgByColor[color]!) : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {editable ? (
                          <div className="pack-week-actions">
                            <span className={`pack-week-status pack-week-status--${status.tone}`}>{status.label}</span>
                            <button
                              type="button"
                              onClick={() => void save(row)}
                              disabled={savingKey === mk}
                              title={`Saves a measurement for ${weekLabel(selected)} only`}
                            >
                              {savingKey === mk ? "Saving…" : "Save"}
                            </button>
                            {row.colorKind === "single" ? (
                              <button type="button" className="secondary" onClick={() => void remember(row, "net_kg")} disabled={savingKey === mk} title={rememberHint}>
                                Remember for future weeks
                              </button>
                            ) : (
                              <>
                                <button type="button" className="secondary" onClick={() => void remember(row, "counts")} disabled={savingKey === mk} title={rememberHint}>
                                  Remember counts for future weeks
                                </button>
                                <button type="button" className="secondary" onClick={() => void remember(row, "fruit_weights")} disabled={savingKey === mk} title={rememberHint}>
                                  Remember fruit weights for future weeks
                                </button>
                              </>
                            )}
                            {row.measurement ? (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => void clear(row)}
                                disabled={savingKey === mk}
                                title={hasRemembered(row) ? `Clears ${weekLabel(selected)}'s own measurement; the remembered values apply instead` : undefined}
                              >
                                Clear
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {editable ? <RememberedNotes row={row} disabled={savingKey === mk} onForget={(kind) => void forget(row, kind)} /> : null}
                        {mk && rowErrors[mk] ? <p className="form-error" role="alert">{rowErrors[mk]}</p> : null}
                      </td>
                      <td>
                        {hasKg(row) && row.kg !== null ? formatShippedKg(row.kg) : row.cases > 0 ? "Not measured" : "—"}
                        {row.status === "remembered" ? <span className="pack-week-note">Remembered weight</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.attention.length > 0 ? (
            <div className="pack-week-attention" role="region" aria-label="Needs attention">
              <h3>Needs attention</h3>
              <p className="pack-week-note">These shipments aren't counted in any colour or in shipped kg. Fix them in DockLink (link the line to a Product Pack or set a supported colour), then sync again.</p>
              <ul>
                {data.attention.map((a) => (
                  <li key={a.seriesKey}>
                    <strong>{a.name}</strong>
                    {a.packCode ? ` (${a.packCode})` : ""} — {formatCases(a.cases)} cases · {ATTENTION_REASON_LABELS[a.reason] ?? a.reason}
                    {a.reason === "unsupported_colour" && a.colorKey ? `: “${a.colorKey}”` : ""}
                    {a.sourcePackRef ? <span className="pack-week-note">DockLink reference: {a.sourcePackRef}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.nonPepper.length > 0 ? (
            <div className="pack-week-nonpepper" role="region" aria-label="Other products">
              <h3>Other products</h3>
              <p className="pack-week-note">Not peppers — kept out of pepper cases and kg.</p>
              <ul>
                {data.nonPepper.map((n) => (
                  <li key={n.seriesKey ?? n.name}>
                    <strong>{n.name}</strong>
                    {n.packCode ? ` (${n.packCode})` : ""} — {formatCases(n.cases)} cases · {cap(n.cropType ?? "")}
                    {n.trackingUnit ? `, tracked in ${n.trackingUnit}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {totals ? (
        <div className="pack-week-totals" role="region" aria-label="Week totals">
          <h3>
            {weekLabel(selected)} shipped peppers ({WEEK_SOURCE_LABELS[totals.source].toLowerCase()})
          </h3>
          <dl className="weekly-docklink-rows">
            {PEPPER_COLORS.filter((c) => totals.colors[c].kg > 0 || totals.colors[c].cases > 0).map((c) => (
              <div key={c} className="weekly-docklink-row">
                <dt>
                  <span className={`weekly-docklink-dot weekly-docklink-dot-${c}`} aria-hidden="true" />
                  {COLOR_LABEL[c]}
                </dt>
                <dd>
                  {formatShippedKg(totals.colors[c].kg)}
                  {totals.colors[c].cases > 0 ? ` · ${formatCases(totals.colors[c].cases)} single-colour cases` : ""}
                </dd>
              </div>
            ))}
            {totals.mixedCases > 0 ? (
              <div className="weekly-docklink-row">
                <dt>Mixed / rainbow</dt>
                <dd>{formatCases(totals.mixedCases)} cases (counted once; kg is in each colour above)</dd>
              </div>
            ) : null}
            <div className="weekly-docklink-row weekly-docklink-total-row">
              <dt>Total</dt>
              <dd>
                {formatShippedKg(totals.kg)} · {formatCases(totals.shippedCases)} shipping cases
              </dd>
            </div>
          </dl>
          {incomplete ? (
            <p className="pack-week-incomplete">{incomplete}</p>
          ) : (
            <p className="pack-week-complete">
              {totals.rememberedCases
                ? `Every shipped case this week has kg; ${formatCases(totals.rememberedCases)} use${totals.rememberedCases === 1 ? "s" : ""} a remembered weight.`
                : "Every shipped case this week is measured."}
            </p>
          )}
        </div>
      ) : null}

      {entryModal ? (
        <ManualPackEntryModal
          mode={entryModal.kind === "create" ? { kind: "create", initialWeek: selected } : entryModal}
          onClose={() => setEntryModal(null)}
          onSaved={(message) => {
            setEntryModal(null);
            void changed(message);
          }}
        />
      ) : null}
    </section>
  );
}
