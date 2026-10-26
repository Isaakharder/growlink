import { lazy, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import {
  buildCaseEntryYearOptions,
  formatCaseTotal,
  requestDocklinkCaseSync,
  requestDocklinkPackSync
} from "../lib/yieldEntries/caseTotals";
import { fetchShippedYield } from "../lib/shippedYieldApi";
import {
  PEPPER_COLORS,
  formatShippedKg,
  WEEK_SOURCE_LABELS,
  incompleteShippedText,
  notCountedText,
  type ShippedYieldResponse
} from "../lib/shippedYield";
import { LazyRoute } from "../components/LazyRoute";

// The weekly pack panel is only used here; loading it on demand keeps it out of
// the main bundle, which sits close to the PWA's 2 MiB precache limit.
const PackShipmentsWeek = lazy(() => import("./PackShipmentsWeek").then((m) => ({ default: m.PackShipmentsWeek })));
const RebuildRangesPanel = lazy(() => import("./RebuildRangesPanel").then((m) => ({ default: m.RebuildRangesPanel })));
const ManualPackEntryModal = lazy(() => import("./ManualPackEntryModal").then((m) => ({ default: m.ManualPackEntryModal })));

/** A stored colour-total row; only its year is used here (for the Weekly Case Totals year list). */
type CaseEntry = { year: number };

const ENTRIES_URL = "/api/color-case-entries";

export function CasesEntryTab() {
  const currentYear = new Date().getFullYear();
  // Slot at the bottom of the page for the selected week's source/completion line.
  const [weekSourceSlot, setWeekSourceSlot] = useState<HTMLDivElement | null>(null);
  // Colour-total rows (DockLink colour sync and older entries): still counted for colour-total
  // weeks by the server; here they only add their years to the Weekly Case Totals year list.
  const [entries, setEntries] = useState<CaseEntry[]>([]);
  // The authoritative weekly shipped totals for the selected year (packs or colour totals per week).
  const [shipped, setShipped] = useState<ShippedYieldResponse | null>(null);
  const [shippedError, setShippedError] = useState<string | null>(null);
  const [packRefreshKey, setPackRefreshKey] = useState(0);
  const [selectedSummaryYear, setSelectedSummaryYear] = useState(String(currentYear));
  const [isPackEntryOpen, setIsPackEntryOpen] = useState(false);
  const [packEntryStatus, setPackEntryStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const caseEntryYearOptions = useMemo(() => {
    const packYears = [shipped?.sync?.firstWeek?.isoYear, shipped?.sync?.lastWeek?.isoYear]
      .filter((y): y is number => typeof y === "number")
      .map((year) => ({ year }));
    return buildCaseEntryYearOptions([...entries, ...packYears], currentYear);
  }, [currentYear, entries, shipped]);

  useEffect(() => {
    const selected = Number(selectedSummaryYear);
    if (!caseEntryYearOptions.includes(selected)) {
      setSelectedSummaryYear(String(caseEntryYearOptions[0] ?? currentYear));
    }
  }, [currentYear, caseEntryYearOptions, selectedSummaryYear]);

  const loadShipped = useCallback(async (year: number) => {
    setShippedError(null);
    try {
      setShipped(await fetchShippedYield({ fromYear: year, toYear: year }));
    } catch (loadError) {
      setShippedError(loadError instanceof Error ? loadError.message : "Failed to load weekly totals");
    }
  }, []);

  useEffect(() => {
    void loadShipped(Number(selectedSummaryYear));
  }, [loadShipped, selectedSummaryYear]);

  // Newest week first; weeks with no pepper cases have no card.
  const weeklyCaseCards = useMemo(
    () => [...(shipped?.weeks ?? [])].filter((w) => w.shippedCases > 0).sort((a, b) => b.isoWeek - a.isoWeek),
    [shipped]
  );

  async function loadEntries() {
    const response = await apiFetch(ENTRIES_URL);
    if (!response.ok) throw new Error(`Failed to load colour totals (${response.status})`);
    setEntries((await response.json()) as CaseEntry[]);
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    loadEntries()
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load colour totals"))
      .finally(() => setLoading(false));
  }, []);

  function openEntryModal() {
    setPackEntryStatus(null);
    setIsPackEntryOpen(true);
  }

  function packEntriesChanged(message: string | null) {
    if (message) setPackEntryStatus(message);
    void loadShipped(Number(selectedSummaryYear));
    setPackRefreshKey((k) => k + 1);
  }

  // Colour totals (legacy weeks) first, then pack shipments. A pack export
  // DockLink hasn't deployed yet is reported, not treated as a failure.
  async function syncDocklinkCases() {
    setSyncing(true);
    setSyncStatus(null);

    try {
      const message = await requestDocklinkCaseSync();
      const packs = await requestDocklinkPackSync();

      try {
        await loadEntries();
      } catch {
        throw new Error("Synced, but failed to refresh entries");
      }
      void loadShipped(Number(selectedSummaryYear));
      setPackRefreshKey((k) => k + 1);
      const combined = [message ?? "DockLink cases synced", packs.message].filter(Boolean).join(" · ");
      setSyncStatus({ kind: packs.ok ? "success" : "error", message: combined });
    } catch (syncError) {
      setSyncStatus({
        kind: "error",
        message: syncError instanceof Error ? syncError.message : "Failed to sync DockLink cases"
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="yield-entry-layout">
      <div className="cases-entry-header">
        <h2>Cases Entry</h2>
        <div className="cases-entry-header-buttons">
          <button type="button" className="sync-button" onClick={() => void syncDocklinkCases()} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync DockLink Cases"}
          </button>
          <button type="button" className="cases-entry-open-button" onClick={openEntryModal} disabled={loading}>
            Add Case Entry
          </button>
        </div>
      </div>

      {syncStatus ? (
        <p className={`cases-sync-status cases-sync-status--${syncStatus.kind}`} role={syncStatus.kind === "error" ? "alert" : "status"}>
          {syncStatus.message}
        </p>
      ) : null}

      {error ? <p className="form-error cases-entry-error">{error}</p> : null}

      {packEntryStatus ? (
        <p className="cases-sync-status cases-sync-status--success" role="status">
          {packEntryStatus}
        </p>
      ) : null}

      <LazyRoute>
        <PackShipmentsWeek refreshKey={packRefreshKey} onChanged={() => void loadShipped(Number(selectedSummaryYear))} sourceSlot={weekSourceSlot} />
      </LazyRoute>

      <LazyRoute>
        <RebuildRangesPanel refreshKey={packRefreshKey} onChanged={() => packEntriesChanged(null)} />
      </LazyRoute>

      <div className="coming-soon-card yield-entry-weekly-cases">
        <div className="recent-entries-header">
          <h2>Weekly Case Totals</h2>
          <label className="weekly-docklink-year-filter">
            <span>Year</span>
            <select
              value={selectedSummaryYear}
              onChange={(event) => setSelectedSummaryYear(event.target.value)}
            >
              {caseEntryYearOptions.map((year) => (
                <option key={year} value={String(year)}>
                  {year}
                </option>
              ))}
            </select>
          </label>
        </div>

        {shippedError ? <p className="form-error">{shippedError}</p> : null}

        {weeklyCaseCards.length === 0 ? (
          <p>No case totals found for {selectedSummaryYear}.</p>
        ) : (
          <div className="weekly-docklink-cards">
            {weeklyCaseCards.map((card) => {
              const incomplete = incompleteShippedText(card);
              return (
                <article key={`${card.isoYear}-${card.isoWeek}`} className="weekly-docklink-card">
                  <h3>Week {card.isoWeek} · {card.isoYear}</h3>
                  <p className="weekly-docklink-source">{WEEK_SOURCE_LABELS[card.source]}</p>

                  <dl className="weekly-docklink-rows">
                    {PEPPER_COLORS.filter((color) => card.colors[color].cases > 0).map((color) => (
                      <div key={color} className="weekly-docklink-row">
                        <dt>
                          <span className={`weekly-docklink-dot weekly-docklink-dot-${color}`} />
                          {color.charAt(0).toUpperCase() + color.slice(1)}
                        </dt>
                        <dd>{formatCaseTotal(card.colors[color].cases)}</dd>
                      </div>
                    ))}
                    {card.mixedCases > 0 ? (
                      <div className="weekly-docklink-row">
                        <dt>Mixed / rainbow</dt>
                        <dd>{formatCaseTotal(card.mixedCases)}</dd>
                      </div>
                    ) : null}
                    {card.attentionCases > 0 ? (
                      <div className="weekly-docklink-row">
                        <dt>Needs attention</dt>
                        <dd>{formatCaseTotal(card.attentionCases)}</dd>
                      </div>
                    ) : null}

                    <div className="weekly-docklink-row weekly-docklink-total-row">
                      <dt>Total</dt>
                      <dd>{formatCaseTotal(card.shippedCases)}</dd>
                    </div>
                    <div className="weekly-docklink-row weekly-docklink-kg-row">
                      <dt>Shipped kg</dt>
                      <dd>{formatShippedKg(card.kg)}</dd>
                    </div>
                  </dl>
                  {incomplete ? <p className="weekly-docklink-incomplete">{incomplete}</p> : null}
                  {card.needsSourceDecision ? (
                    <p className="weekly-docklink-incomplete">Has manual pack entries and colour totals: choose which counts in the week's source at the bottom of the page.</p>
                  ) : notCountedText(card) ? (
                    <p className="weekly-docklink-not-counted">{notCountedText(card)}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* The selected week's source/completion line (rendered by PackShipmentsWeek): the very bottom of the page. */}
      <div ref={setWeekSourceSlot} className="cases-week-source-slot" />

      {isPackEntryOpen ? (
        <LazyRoute>
          <ManualPackEntryModal
            mode={{ kind: "create" }}
            onClose={() => setIsPackEntryOpen(false)}
            onSaved={(message) => {
              setIsPackEntryOpen(false);
              packEntriesChanged(message);
            }}
          />
        </LazyRoute>
      ) : null}

    </div>
  );
}
