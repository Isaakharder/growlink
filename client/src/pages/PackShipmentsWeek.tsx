import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { isoWeekOf, isoWeekRangeLabel, isoWeeksInYear, shiftIsoWeek } from "../lib/isoWeek";
import {
  ATTENTION_REASON_LABELS,
  PEPPER_COLORS,
  formatCases,
  formatShippedKg,
  incompleteShippedText,
  type PackSyncSummary,
  type PepperColor,
  type ShippedWeekTotals
} from "../lib/shippedYield";

// Weekly pack shipments: DockLink's shipped cases per Product Pack for one
// ISO week, with the measurements GrowLink needs to turn them into kg.
// Every kg shown here comes from the server's shipped-yield calculation —
// this screen only collects measurements.

const WEEK_URL = "/api/pack-shipments/week";
const MEASUREMENTS_URL = "/api/pack-shipments/measurements";
const COPY_URL = "/api/pack-shipments/measurements/copy";

type SeriesStatus = "measured" | "missing" | "incompatible" | "zero" | "no_shipments";

type MeasurementView = {
  netKgPerCase: number | null;
  components: Array<{ color: PepperColor; piecesPerCase: number; fruitWeightG: number }>;
  copiedFrom: { isoYear: number; isoWeek: number } | null;
};

type PackRow = {
  seriesKey: string | null;
  packId: string | null;
  name: string;
  packCode: string | null;
  currentName: string | null;
  currentPackCode: string | null;
  description: string | null;
  packStatus: "active" | "archived" | "not_in_catalogue";
  colorKind: "single" | "mixed" | string | null;
  colorKey: string | null;
  colorLabel: string | null;
  reclassifiedSince: boolean;
  cases: number;
  loadCount: number | null;
  status: SeriesStatus;
  kg: number | null;
  kgByColor: Partial<Record<PepperColor, number>> | null;
  measurement: MeasurementView | null;
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
  source: "packs" | "legacy";
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

function draftFrom(row: PackRow): Draft {
  const components = Object.fromEntries(PEPPER_COLORS.map((c) => [c, { piecesPerCase: "", fruitWeightG: "" }])) as Draft["components"];
  for (const c of row.measurement?.components ?? []) {
    components[c.color] = { piecesPerCase: String(c.piecesPerCase), fruitWeightG: String(c.fruitWeightG) };
  }
  return { netKgPerCase: row.measurement?.netKgPerCase != null ? String(row.measurement.netKgPerCase) : "", components };
}

function statusText(row: PackRow): { label: string; tone: "ok" | "warn" | "muted" } {
  switch (row.status) {
    case "measured":
      return row.measurement?.copiedFrom
        ? { label: `Measured · copied from ${weekLabel(row.measurement.copiedFrom)}`, tone: "ok" }
        : { label: "Measured", tone: "ok" };
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

function scopeText(sync: PackSyncSummary | null): string {
  if (!sync) return "Pack shipments haven't been synced from DockLink yet. Weekly totals use colour totals.";
  if (sync.scopeStatus === "available" && sync.firstWeek && sync.lastWeek) {
    const transition = sync.transitionWeek ? ` ${weekLabel(sync.transitionWeek)} and earlier use colour totals.` : "";
    return `Pack totals from ${weekLabel(sync.firstWeek)} to ${weekLabel(sync.lastWeek)}.${transition} Last synced ${new Date(sync.lastSyncedAt).toLocaleString()}.`;
  }
  return sync.scopeStatus === "pending_first_full_week"
    ? "DockLink has started capturing packs; pack totals begin after its first full week. Every week uses colour totals until then."
    : "Pack capture isn't active in DockLink yet. Every week uses colour totals.";
}

export function PackShipmentsWeek({ refreshKey = 0, initialWeek }: { refreshKey?: number; initialWeek?: { isoYear: number; isoWeek: number } }) {
  const [selected, setSelected] = useState(() => initialWeek ?? isoWeekOf(new Date()));
  const [data, setData] = useState<PackWeekResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`${WEEK_URL}?isoYear=${selected.isoYear}&isoWeek=${selected.isoWeek}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load pack shipments (${response.status})`);
      }
      const body = (await response.json()) as PackWeekResponse;
      setData(body);
      setDrafts(Object.fromEntries(body.packs.filter((p) => p.seriesKey).map((p) => [p.seriesKey as string, draftFrom(p)])));
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

  const yearOptions = useMemo(() => {
    const now = isoWeekOf(new Date()).isoYear;
    return [now - 2, now - 1, now, now + 1];
  }, []);

  function setDraft(seriesKey: string, update: (d: Draft) => Draft) {
    setDrafts((current) => ({ ...current, [seriesKey]: update(current[seriesKey]) }));
  }

  async function save(row: PackRow) {
    const seriesKey = row.seriesKey as string;
    const draft = drafts[seriesKey];
    setRowErrors((current) => ({ ...current, [seriesKey]: "" }));
    let payload: Record<string, unknown>;
    if (row.colorKind === "single") {
      const value = Number(draft.netKgPerCase);
      if (!draft.netKgPerCase.trim() || !Number.isFinite(value) || value <= 0) {
        setRowErrors((current) => ({ ...current, [seriesKey]: "Enter the average net pepper kg per shipping case (greater than 0)." }));
        return;
      }
      payload = { netKgPerCase: value };
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
          setRowErrors((current) => ({ ...current, [seriesKey]: `${COLOR_LABEL[color]}: enter both peppers per shipping case and fruit weight (g), each greater than 0 — or leave both blank.` }));
          return;
        }
        components.push({ color, piecesPerCase: pieces, fruitWeightG: weight });
      }
      if (components.length === 0) {
        setRowErrors((current) => ({ ...current, [seriesKey]: "Enter at least one colour in this pack." }));
        return;
      }
      payload = { components };
    }
    setSavingKey(seriesKey);
    try {
      const response = await apiFetch(MEASUREMENTS_URL, {
        method: "PUT",
        body: JSON.stringify({ isoYear: selected.isoYear, isoWeek: selected.isoWeek, seriesKey, ...payload })
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
    const seriesKey = row.seriesKey as string;
    setSavingKey(seriesKey);
    try {
      const params = new URLSearchParams({ isoYear: String(selected.isoYear), isoWeek: String(selected.isoWeek), seriesKey });
      const response = await apiFetch(`${MEASUREMENTS_URL}?${params.toString()}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Clear failed (${response.status})`);
      await load();
    } catch (clearError) {
      setRowErrors((current) => ({ ...current, [seriesKey]: clearError instanceof Error ? clearError.message : "Clear failed" }));
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

      {data && data.source === "legacy" ? (
        <div className="pack-week-legacy">
          <p>
            <strong>{weekLabel(data)} uses colour totals.</strong> Pack measurements don't apply to this week
            {data.sync?.firstWeek && data.sync.scopeStatus === "available" ? ` — pack totals start at ${weekLabel(data.sync.firstWeek)}` : ""}.
          </p>
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

      {data && data.source === "packs" ? (
        <>
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
                  <th scope="col">Shipped cases</th>
                  <th scope="col">Measurement for {weekLabel(selected)}</th>
                  <th scope="col">Shipped kg</th>
                </tr>
              </thead>
              <tbody>
                {data.packs.map((row) => {
                  const key = row.seriesKey ?? `pack:${row.packId}`;
                  const status = statusText(row);
                  const draft = row.seriesKey ? drafts[row.seriesKey] : undefined;
                  const editable = Boolean(row.seriesKey && draft) && row.status !== "no_shipments";
                  return (
                    <tr key={key} className={`pack-week-row pack-week-row--${row.status}`} data-series-key={row.seriesKey ?? undefined}>
                      <th scope="row">
                        <span className="pack-week-name">{row.name}</span>
                        {row.packCode ? <span className="pack-week-code">{row.packCode}</span> : null}
                        {row.packStatus === "archived" ? <span className="pack-week-badge">Archived</span> : null}
                        {row.packStatus === "not_in_catalogue" ? <span className="pack-week-badge">No longer in DockLink</span> : null}
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
                                onChange={(e) => setDraft(row.seriesKey!, (d) => ({ ...d, netKgPerCase: e.target.value }))}
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
                                          setDraft(row.seriesKey!, (d) => ({ ...d, components: { ...d.components, [color]: { ...d.components[color], piecesPerCase: e.target.value } } }))
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
                                          setDraft(row.seriesKey!, (d) => ({ ...d, components: { ...d.components, [color]: { ...d.components[color], fruitWeightG: e.target.value } } }))
                                        }
                                      />
                                    </td>
                                    <td>{row.status === "measured" && row.kgByColor?.[color] !== undefined ? formatShippedKg(row.kgByColor[color]!) : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {editable ? (
                          <div className="pack-week-actions">
                            <span className={`pack-week-status pack-week-status--${status.tone}`}>{status.label}</span>
                            <button type="button" onClick={() => void save(row)} disabled={savingKey === row.seriesKey}>
                              {savingKey === row.seriesKey ? "Saving…" : "Save"}
                            </button>
                            {row.measurement ? (
                              <button type="button" className="secondary" onClick={() => void clear(row)} disabled={savingKey === row.seriesKey}>
                                Clear
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {row.seriesKey && rowErrors[row.seriesKey] ? <p className="form-error" role="alert">{rowErrors[row.seriesKey]}</p> : null}
                      </td>
                      <td>{row.status === "measured" && row.kg !== null ? formatShippedKg(row.kg) : row.cases > 0 ? "Not measured" : "—"}</td>
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
            {weekLabel(selected)} shipped peppers {totals.source === "legacy" ? "(colour totals)" : "(pack totals)"}
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
          {incomplete ? <p className="pack-week-incomplete">{incomplete}</p> : <p className="pack-week-complete">Every shipped case this week is measured.</p>}
        </div>
      ) : null}
    </section>
  );
}
