import { FormEvent, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";
import { roundTo } from "../lib/roundTo";
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
  isPackWeek,
  notCountedText,
  type ShippedYieldResponse
} from "../lib/shippedYield";
import { LazyRoute } from "../components/LazyRoute";

// The weekly pack panel is only used here; loading it on demand keeps it out of
// the main bundle, which sits close to the PWA's 2 MiB precache limit.
const PackShipmentsWeek = lazy(() => import("./PackShipmentsWeek").then((m) => ({ default: m.PackShipmentsWeek })));
const RebuildRangesPanel = lazy(() => import("./RebuildRangesPanel").then((m) => ({ default: m.RebuildRangesPanel })));
const ManualPackEntryModal = lazy(() => import("./ManualPackEntryModal").then((m) => ({ default: m.ManualPackEntryModal })));

type VarietyColor = "red" | "orange" | "yellow" | "green";

type CaseEntry = {
  id: string;
  color: VarietyColor;
  year: number;
  week: number;
  total_cases: number;
  case_weight_kg: number;
  total_kg: number;
  kg_per_m2: number;
  color_area_m2: number;
  source?: "manual" | "docklink";
  synced_at?: string | null;
  created_at: string;
  updated_at: string;
};

type CaseEntryFormState = {
  color: VarietyColor;
  year: string;
  week: string;
  total_cases: string;
  case_weight_kg: string;
};

type WeekOption = {
  value: number;
  label: string;
};

const OPTIONS_URL = "/api/case-entry-options";
const ENTRIES_URL = "/api/color-case-entries";

function getWeekStartSunday(year: number, week: number) {
  const jan1 = new Date(year, 0, 1);
  const start = new Date(jan1);
  start.setDate(jan1.getDate() - jan1.getDay() + (week - 1) * 7);
  return start;
}

function formatMonthDay(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit"
  });
}

function createWeekOptions(year: number): WeekOption[] {
  const options: WeekOption[] = [];

  for (let week = 1; week <= 53; week += 1) {
    const start = getWeekStartSunday(year, week);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    options.push({
      value: week,
      label: `Week ${week} - ${formatMonthDay(start)} to ${formatMonthDay(end)}`
    });
  }

  return options;
}

function getCurrentWeek(year: number) {
  const now = new Date();
  const jan1 = new Date(year, 0, 1);
  const weekOneStart = new Date(jan1);
  weekOneStart.setDate(jan1.getDate() - jan1.getDay());

  const diffMs = now.getTime() - weekOneStart.getTime();
  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;

  return Math.min(Math.max(week, 1), 53);
}

function normalizeColor(value: unknown): VarietyColor | null {
  const color = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (color === "red" || color === "orange" || color === "yellow" || color === "green") {
    return color;
  }

  return null;
}

function numberOrZero(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRounded(value: number, decimals: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const rounded = roundTo(value, decimals);

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return rounded.toFixed(decimals).replace(/\.?0+$/, "");
}

export function CasesEntryTab() {
  const currentYear = new Date().getFullYear();
  const [colors, setColors] = useState<VarietyColor[]>([]);
  const [entries, setEntries] = useState<CaseEntry[]>([]);
  // The authoritative weekly shipped totals for the selected year (packs or colour totals per week).
  const [shipped, setShipped] = useState<ShippedYieldResponse | null>(null);
  const [shippedError, setShippedError] = useState<string | null>(null);
  const [packRefreshKey, setPackRefreshKey] = useState(0);
  const [isRecentExpanded, setIsRecentExpanded] = useState(false);
  const [selectedSummaryYear, setSelectedSummaryYear] = useState(String(currentYear));
  // Colour-total rows can still be corrected; new case entries are per Product Pack (ManualPackEntryModal).
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [isPackEntryOpen, setIsPackEntryOpen] = useState(false);
  const [packEntryStatus, setPackEntryStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CaseEntryFormState>({
    color: "red",
    year: String(currentYear),
    week: String(getCurrentWeek(currentYear)),
    total_cases: "0",
    case_weight_kg: "0"
  });

  const weekOptions = useMemo(() => createWeekOptions(Number(form.year)), [form.year]);

  const totalKg = useMemo(
    () => numberOrZero(form.total_cases) * numberOrZero(form.case_weight_kg),
    [form.total_cases, form.case_weight_kg]
  );

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

  const recentWeekKeys = useMemo(() => {
    const seen = new Set<string>();
    const weeks: Array<{ key: string; year: number; week: number; sortKey: number }> = [];

    for (const entry of entries) {
      const year = Number(entry.year);
      const week = Number(entry.week);

      if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
        continue;
      }

      const key = `${year}-${week}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      weeks.push({ key, year, week, sortKey: year * 100 + week });
    }

    return weeks.sort((a, b) => b.sortKey - a.sortKey);
  }, [entries]);

  const latestWeekKey = recentWeekKeys[0]?.key ?? null;
  const recentSixWeekKeys = useMemo(
    () => new Set(recentWeekKeys.slice(0, 6).map((item) => item.key)),
    [recentWeekKeys]
  );

  const displayedRecentEntries = useMemo(() => {
    const filtered = entries.filter((entry) => {
      const year = Number(entry.year);
      const week = Number(entry.week);

      if (!Number.isInteger(year) || !Number.isInteger(week)) {
        return false;
      }

      const key = `${year}-${week}`;

      if (isRecentExpanded) {
        return recentSixWeekKeys.has(key);
      }

      return latestWeekKey !== null && key === latestWeekKey;
    });

    return filtered.sort((a, b) => {
      const aYear = Number(a.year);
      const bYear = Number(b.year);
      const aWeek = Number(a.week);
      const bWeek = Number(b.week);
      const aSort = aYear * 100 + aWeek;
      const bSort = bYear * 100 + bWeek;

      if (aSort !== bSort) {
        return bSort - aSort;
      }

      return b.updated_at.localeCompare(a.updated_at);
    }).slice(0, 7);
  }, [entries, isRecentExpanded, latestWeekKey, recentSixWeekKeys]);


  async function fetchOptionsAndEntries() {
    setLoading(true);
    setError(null);

    try {
      const [optionsResponse, entriesResponse] = await Promise.all([apiFetch(OPTIONS_URL), apiFetch(ENTRIES_URL)]);

      if (!optionsResponse.ok) {
        throw new Error(`Failed to load options (${optionsResponse.status})`);
      }

      if (!entriesResponse.ok) {
        throw new Error(`Failed to load entries (${entriesResponse.status})`);
      }

      const optionsData = (await optionsResponse.json()) as {
        colors: VarietyColor[];
      };

      const entriesData = (await entriesResponse.json()) as CaseEntry[];

      setColors(optionsData.colors);
      setEntries(entriesData);

      setForm((current) => {
        const hasCurrentColor = optionsData.colors.includes(current.color);

        return {
          ...current,
          color: hasCurrentColor ? current.color : (optionsData.colors[0] ?? "red")
        };
      });
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : "Failed to load options"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchOptionsAndEntries();
  }, []);

  const shippedSync = shipped?.sync ?? null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!form.color) {
      setError("Color is required.");
      return;
    }

    const total_cases = numberOrZero(form.total_cases);
    const case_weight_kg = numberOrZero(form.case_weight_kg);

    if (total_cases < 0) {
      setError("Total cases must be 0 or greater.");
      return;
    }

    if (case_weight_kg < 0) {
      setError("Case weight must be 0 or greater.");
      return;
    }

    const payload = {
      color: form.color,
      year: Number(form.year),
      week: Number(form.week),
      total_cases,
      case_weight_kg
    };

    if (!Number.isInteger(payload.year)) {
      setError("Year is required.");
      return;
    }

    if (!Number.isInteger(payload.week)) {
      setError("Week is required.");
      return;
    }

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${ENTRIES_URL}/${editingId}` : ENTRIES_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `${editingId ? "Update" : "Save"} failed`;

        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore malformed error response and use fallback message.
        }

        throw new Error(message);
      }

      setEditingId(null);
      setForm({
        color: colors[0] ?? "red",
        year: String(currentYear),
        week: String(getCurrentWeek(currentYear)),
        total_cases: "0",
        case_weight_kg: "0"
      });
      setIsEntryModalOpen(false);

      const entriesResponse = await apiFetch(ENTRIES_URL);
      if (!entriesResponse.ok) {
        throw new Error("Saved, but failed to refresh entries");
      }

      const entriesData = (await entriesResponse.json()) as CaseEntry[];
      setEntries(entriesData);
      void loadShipped(Number(selectedSummaryYear));
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Failed to save entry"
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(entry: CaseEntry) {
    setEditingId(entry.id);
    setIsEntryModalOpen(true);
    setForm({
      color: entry.color,
      year: String(entry.year),
      week: String(entry.week),
      total_cases: String(entry.total_cases),
      case_weight_kg: String(entry.case_weight_kg)
    });

    setError(null);
  }

  function openEntryModal() {
    setPackEntryStatus(null);
    setIsPackEntryOpen(true);
  }

  function packEntriesChanged(message: string | null) {
    if (message) setPackEntryStatus(message);
    void loadShipped(Number(selectedSummaryYear));
    setPackRefreshKey((k) => k + 1);
  }

  function closeEntryModal() {
    setIsEntryModalOpen(false);
    setEditingId(null);
    setError(null);
    setForm({
      color: colors[0] ?? "red",
      year: String(currentYear),
      week: String(getCurrentWeek(currentYear)),
      total_cases: "0",
      case_weight_kg: "0"
    });
  }

  async function deleteEntry(id: string) {
    const confirmed = window.confirm("Delete this case entry?");
    if (!confirmed) {
      return;
    }

    setError(null);

    try {
      const response = await apiFetch(`${ENTRIES_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }

      if (editingId === id) {
        setEditingId(null);
      }

      const entriesResponse = await apiFetch(ENTRIES_URL);
      if (!entriesResponse.ok) {
        throw new Error("Deleted, but failed to refresh entries");
      }

      const entriesData = (await entriesResponse.json()) as CaseEntry[];
      setEntries(entriesData);
      void loadShipped(Number(selectedSummaryYear));
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete entry"
      );
    }
  }

  // Colour totals (legacy weeks) first, then pack shipments. A pack export
  // DockLink hasn't deployed yet is reported, not treated as a failure.
  async function syncDocklinkCases() {
    setSyncing(true);
    setSyncStatus(null);

    try {
      const message = await requestDocklinkCaseSync();
      const packs = await requestDocklinkPackSync();

      const entriesResponse = await apiFetch(ENTRIES_URL);
      if (!entriesResponse.ok) {
        throw new Error("Synced, but failed to refresh entries");
      }

      const entriesData = (await entriesResponse.json()) as CaseEntry[];
      setEntries(entriesData);
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
        <button
          type="button"
          className="cases-entry-open-button"
          onClick={openEntryModal}
          disabled={loading}
        >
          Add Case Entry
        </button>
      </div>

      {packEntryStatus ? (
        <p className="cases-sync-status cases-sync-status--success" role="status">
          {packEntryStatus}
        </p>
      ) : null}

      <LazyRoute>
        <PackShipmentsWeek refreshKey={packRefreshKey} onChanged={() => void loadShipped(Number(selectedSummaryYear))} />
      </LazyRoute>

      <LazyRoute>
        <RebuildRangesPanel refreshKey={packRefreshKey} onChanged={() => packEntriesChanged(null)} />
      </LazyRoute>

      <div className="coming-soon-card yield-entry-recent-entries">
        <div className="recent-entries-header">
          <h2>Colour Totals</h2>
          <div className="recent-entries-actions">
            {recentWeekKeys.length > 1 ? (
              <button
                type="button"
                className="recent-entries-toggle"
                onClick={() => setIsRecentExpanded((current) => !current)}
              >
                {isRecentExpanded ? "Collapse" : "Expand"}
              </button>
            ) : null}
            <button
              type="button"
              className="sync-button"
              onClick={() => void syncDocklinkCases()}
              disabled={syncing}
            >
              {syncing ? "Syncing..." : "Sync DockLink Cases"}
            </button>
          </div>
        </div>

        {syncStatus ? (
          <p
            className={`cases-sync-status cases-sync-status--${syncStatus.kind}`}
            role={syncStatus.kind === "error" ? "alert" : "status"}
          >
            {syncStatus.message}
          </p>
        ) : null}

        {entries.length > 0 ? (
          <p className="recent-entries-helper-text">
            {isRecentExpanded ? "Showing last 6 weeks" : "Showing latest week"}
          </p>
        ) : null}

        <p className="recent-entries-helper-text">
          Weekly colour totals from the DockLink colour sync and older colour entries. New case entries are made per Product Pack with Add Case
          Entry.
        </p>

        {entries.length === 0 && <p>No colour totals yet.</p>}

        {entries.length > 0 && displayedRecentEntries.length > 0 && (
          <>
          <div className="varieties-table-wrapper yield-entry-table-wrapper">
            <table className="varieties-table yield-entry-table yield-entry-table-cases">
              <thead>
                <tr>
                  <th>Color</th>
                  <th>Year</th>
                  <th>Week</th>
                  <th>Total cases</th>
                  <th>Case weight</th>
                  <th>Total kg</th>
                  <th>kg/m²</th>
                  <th>Source</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedRecentEntries.map((entry) => {
                  const source = entry.source || "manual";
                  const totalCases = Number(entry.total_cases);
                  const caseWeight = Number(entry.case_weight_kg);
                  const safeTotalCases = Number.isFinite(totalCases) && totalCases >= 0 ? totalCases : 0;
                  const hasWeight = Number.isFinite(caseWeight) && caseWeight > 0;
                  const storedKg = Number(entry.total_kg);
                  const storedKgPerM2 = Number(entry.kg_per_m2);
                  // Another source counts for this week (DockLink pack totals or manual pack entries); the row is kept but not counted.
                  const weekSource = shipped?.weeks.find((w) => w.isoYear === Number(entry.year) && w.isoWeek === Number(entry.week))?.source;
                  const superseded = isPackWeek(shippedSync, Number(entry.year), Number(entry.week)) || weekSource === "manual";

                  return (
                    <tr key={entry.id}>
                      <td>{entry.color.charAt(0).toUpperCase() + entry.color.slice(1)}</td>
                      <td>{entry.year}</td>
                      <td>{entry.week}</td>
                      <td>{formatRounded(safeTotalCases, 3)}</td>
                      <td>{hasWeight ? formatRounded(caseWeight, 2) : "Missing"}</td>
                      <td>{hasWeight && Number.isFinite(storedKg) ? String(Math.round(storedKg)) : "—"}</td>
                      <td>{hasWeight && Number.isFinite(storedKgPerM2) && storedKgPerM2 > 0 ? formatRounded(storedKgPerM2, 3) : "—"}</td>
                      <td>
                        <span className={`source-badge source-${source}`}>
                          {source.charAt(0).toUpperCase() + source.slice(1)}
                        </span>
                        {superseded ? (
                          <span
                            className="source-badge source-superseded"
                            title={`This ISO week counts ${weekSource === "manual" ? "manual pack entries" : "DockLink pack totals"}; this colour row is kept but not counted.`}
                          >
                            {weekSource === "manual" ? "Superseded by manual pack entries" : "Superseded by pack totals"}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button type="button" onClick={() => beginEdit(entry)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => deleteEntry(entry.id)}
                            title={source === "docklink" ? "Delete imported DockLink entry" : "Delete entry"}
                          >
                            {source === "docklink" ? "Remove" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="recent-entries-footer">Showing 7 most recent entries</p>
          </>
        )}
      </div>

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
                    <p className="weekly-docklink-incomplete">Has manual pack entries and colour totals: choose which counts on the Weekly Pack Shipments panel.</p>
                  ) : notCountedText(card) ? (
                    <p className="weekly-docklink-not-counted">{notCountedText(card)}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>

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

      {isEntryModalOpen ? (
        <ModalOverlay onClose={closeEntryModal} contentClassName="variety-modal" titleId="enter-cases-title">
            <h2 id="enter-cases-title">Edit Colour Total</h2>

            {error ? <p className="form-error">{error}</p> : null}
            {loading ? <p>Loading...</p> : null}

            {!loading ? (
              <form className="yield-entry-form" onSubmit={handleSubmit}>
                <label>
                  Color
                  <select
                    value={form.color}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, color: event.target.value as VarietyColor }))
                    }
                    required
                  >
                    {colors.length === 0 ? <option value="">No colors available</option> : null}
                    {colors.map((color) => (
                      <option key={color} value={color}>
                        {color.charAt(0).toUpperCase() + color.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Year
                  <select
                    value={form.year}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, year: event.target.value }))
                    }
                  >
                    {[currentYear - 1, currentYear, currentYear + 1].map((year) => (
                      <option key={year} value={String(year)}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Week
                  <select
                    value={form.week}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, week: event.target.value }))
                    }
                  >
                    {weekOptions.map((week) => (
                      <option key={week.value} value={String(week.value)}>
                        {week.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Total cases
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.total_cases}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        total_cases: event.target.value
                      }))
                    }
                  />
                </label>

                <label>
                  Case weight (kg)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.case_weight_kg}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        case_weight_kg: event.target.value
                      }))
                    }
                  />
                </label>

                <label>
                  Total kg
                  <input type="number" value={roundTo(totalKg, 3)} readOnly />
                </label>

                <div className="form-actions">
                  <button type="submit" disabled={saving || colors.length === 0}>
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={closeEntryModal}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
        </ModalOverlay>
      ) : null}
    </div>
  );
}
