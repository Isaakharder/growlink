import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

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

type WeeklyDocklinkCaseCard = {
  year: number;
  week: number;
  totals: Record<VarietyColor, number>;
};

type WeeklyDocklinkColorRow = {
  color: VarietyColor;
  total: number;
};

type VarietySetting = {
  color: VarietyColor | string | null;
  area_m2: number;
  case_kg: number;
  status?: "active" | "inactive";
};

type ColorVarietyStats = {
  totalAreaM2: number;
  avgCaseWeight: number | null;
};

const OPTIONS_URL = "/api/case-entry-options";
const ENTRIES_URL = "/api/color-case-entries";
const VARIETIES_URL = "/api/varieties";
const CASE_COLORS: VarietyColor[] = ["red", "orange", "yellow", "green"];

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

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatCaseTotal(value: number) {
  const rounded = roundTo(value, 3);
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(3).replace(/\.?0+$/, "");
}

function getVisibleColorRows(totals: Record<VarietyColor, number>): WeeklyDocklinkColorRow[] {
  return CASE_COLORS.map((color) => ({ color, total: Number(totals[color]) }))
    .filter((row) => Number.isFinite(row.total) && row.total > 0)
    .map((row) => ({ ...row, total: roundTo(row.total, 3) }));
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
  const [varieties, setVarieties] = useState<VarietySetting[]>([]);
  const [isRecentExpanded, setIsRecentExpanded] = useState(false);
  const [selectedSummaryYear, setSelectedSummaryYear] = useState(String(currentYear));
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
    const years = new Set<number>([currentYear]);

    for (const entry of entries) {
      if (Number.isInteger(entry.year)) {
        years.add(entry.year);
      }
    }

    return Array.from(years).sort((a, b) => b - a);
  }, [currentYear, entries]);

  useEffect(() => {
    const selected = Number(selectedSummaryYear);
    if (!caseEntryYearOptions.includes(selected)) {
      setSelectedSummaryYear(String(caseEntryYearOptions[0] ?? currentYear));
    }
  }, [currentYear, caseEntryYearOptions, selectedSummaryYear]);

  const weeklyCaseCards = useMemo(() => {
    const selectedYear = Number(selectedSummaryYear);

    if (!Number.isInteger(selectedYear)) {
      return [] as WeeklyDocklinkCaseCard[];
    }

    const byWeek = new Map<number, Record<VarietyColor, number>>();

    for (const entry of entries) {
      if (entry.year !== selectedYear) {
        continue;
      }

      if (!Number.isInteger(entry.week) || entry.week < 1 || entry.week > 53) {
        continue;
      }

      if (!CASE_COLORS.includes(entry.color)) {
        continue;
      }

      const totalCases = Number(entry.total_cases);
      if (!Number.isFinite(totalCases)) {
        continue;
      }

      const totals = byWeek.get(entry.week) ?? {
        red: 0,
        orange: 0,
        yellow: 0,
        green: 0
      };

      totals[entry.color] += totalCases;
      byWeek.set(entry.week, totals);
    }

    return Array.from(byWeek.entries())
      .map(([week, totals]) => ({
        year: selectedYear,
        week,
        totals
      }))
      .filter((card) => CASE_COLORS.some((color) => card.totals[color] > 0))
      .sort((a, b) => b.week - a.week);
  }, [entries, selectedSummaryYear]);

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

  const varietyStatsByColor = useMemo(() => {
    const statsMap = new Map<VarietyColor, ColorVarietyStats>();

    for (const color of CASE_COLORS) {
      statsMap.set(color, {
        totalAreaM2: 0,
        avgCaseWeight: null
      });
    }

    const weightedNumerator: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };
    const weightedDenominator: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };
    const simpleSum: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };
    const simpleCount: Record<VarietyColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0
    };

    for (const variety of varieties) {
      if (variety.status && variety.status !== "active") {
        continue;
      }

      const color = normalizeColor(variety.color);
      if (!color) {
        continue;
      }

      const area = Number(variety.area_m2);
      const caseKg = Number(variety.case_kg);

      if (Number.isFinite(area) && area > 0) {
        const current = statsMap.get(color);
        if (current) {
          current.totalAreaM2 += area;
        }
      }

      if (!Number.isFinite(caseKg) || caseKg < 0) {
        continue;
      }

      simpleSum[color] += caseKg;
      simpleCount[color] += 1;

      if (Number.isFinite(area) && area > 0) {
        weightedNumerator[color] += caseKg * area;
        weightedDenominator[color] += area;
      }
    }

    for (const color of CASE_COLORS) {
      const current = statsMap.get(color);
      if (!current) {
        continue;
      }

      if (weightedDenominator[color] > 0) {
        current.avgCaseWeight = weightedNumerator[color] / weightedDenominator[color];
      } else if (simpleCount[color] > 0) {
        current.avgCaseWeight = simpleSum[color] / simpleCount[color];
      } else {
        current.avgCaseWeight = null;
      }
    }

    return statsMap;
  }, [varieties]);

  async function fetchOptionsAndEntries() {
    setLoading(true);
    setError(null);

    try {
      const [optionsResponse, entriesResponse, varietiesResponse] = await Promise.all([
        apiFetch(OPTIONS_URL),
        apiFetch(ENTRIES_URL),
        apiFetch(VARIETIES_URL)
      ]);

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

      let varietiesData: VarietySetting[] = [];
      if (varietiesResponse.ok) {
        varietiesData = (await varietiesResponse.json()) as VarietySetting[];
      }

      setColors(optionsData.colors);
      setEntries(entriesData);
      setVarieties(varietiesData);

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
    setError(null);
    setEditingId(null);
    setForm({
      color: colors[0] ?? "red",
      year: String(currentYear),
      week: String(getCurrentWeek(currentYear)),
      total_cases: "0",
      case_weight_kg: "0"
    });
    setIsEntryModalOpen(true);
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
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete entry"
      );
    }
  }

  async function syncDocklinkCases() {
    setSyncing(true);
    setError(null);

    try {
      const response = await apiFetch("/api/integrations/docklink/sync-color-cases", {
        method: "POST"
      });

      if (!response.ok) {
        let message = "Sync failed";

        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore
        }

        throw new Error(message);
      }

      const entriesResponse = await apiFetch(ENTRIES_URL);
      if (!entriesResponse.ok) {
        throw new Error("Synced, but failed to refresh entries");
      }

      const entriesData = (await entriesResponse.json()) as CaseEntry[];
      setEntries(entriesData);
    } catch (syncError) {
      setError(
        syncError instanceof Error ? syncError.message : "Failed to sync DockLink cases"
      );
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

      <div className="coming-soon-card yield-entry-recent-entries">
        <div className="recent-entries-header">
          <h2>Recent Entries</h2>
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

        {entries.length > 0 ? (
          <p className="recent-entries-helper-text">
            {isRecentExpanded ? "Showing last 6 weeks" : "Showing latest week"}
          </p>
        ) : null}

        {entries.length === 0 && <p>No case entries yet.</p>}

        {entries.length > 0 && displayedRecentEntries.length > 0 && (
          <>
          <div className="varieties-table-wrapper yield-entry-table-wrapper">
            <table className="varieties-table yield-entry-table">
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
                  const varietyStats = varietyStatsByColor.get(entry.color);
                  const totalCases = Number(entry.total_cases);
                  const fallbackCaseWeight =
                    Number.isFinite(Number(entry.case_weight_kg)) && Number(entry.case_weight_kg) >= 0
                      ? Number(entry.case_weight_kg)
                      : 0;

                  const displayCaseWeight =
                    source === "docklink"
                      ? varietyStats?.avgCaseWeight ?? fallbackCaseWeight
                      : fallbackCaseWeight;
                  const safeCaseWeight =
                    Number.isFinite(displayCaseWeight) && displayCaseWeight >= 0
                      ? displayCaseWeight
                      : 0;
                  const safeTotalCases = Number.isFinite(totalCases) && totalCases >= 0 ? totalCases : 0;
                  const displayTotalKg =
                    source === "docklink"
                      ? safeTotalCases * safeCaseWeight
                      : Number.isFinite(Number(entry.total_kg)) && Number(entry.total_kg) >= 0
                        ? Number(entry.total_kg)
                        : 0;
                  const displayAreaM2 =
                    source === "docklink"
                      ? varietyStats?.totalAreaM2 ?? 0
                      : Number.isFinite(Number(entry.color_area_m2)) && Number(entry.color_area_m2) > 0
                        ? Number(entry.color_area_m2)
                        : 0;
                  const roundedDisplayKg = Math.round(displayTotalKg);
                  const displayKgPerM2 =
                    displayAreaM2 > 0
                      ? roundedDisplayKg / displayAreaM2
                      : source === "docklink"
                        ? null
                        : Number.isFinite(Number(entry.kg_per_m2)) && Number(entry.kg_per_m2) >= 0
                          ? Number(entry.kg_per_m2)
                          : null;

                  return (
                    <tr key={entry.id}>
                      <td>{entry.color.charAt(0).toUpperCase() + entry.color.slice(1)}</td>
                      <td>{entry.year}</td>
                      <td>{entry.week}</td>
                      <td>{formatRounded(safeTotalCases, 3)}</td>
                      <td>
                        {formatRounded(safeCaseWeight, 2)}
                        {source === "docklink" && varietyStats?.avgCaseWeight != null ? " (avg)" : ""}
                      </td>
                      <td>{String(roundedDisplayKg)}</td>
                      <td>{displayKgPerM2 === null ? "—" : formatRounded(displayKgPerM2, 3)}</td>
                      <td>
                        <span className={`source-badge source-${source}`}>
                          {source.charAt(0).toUpperCase() + source.slice(1)}
                        </span>
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

        {weeklyCaseCards.length === 0 ? (
          <p>No case totals found for {selectedSummaryYear}.</p>
        ) : (
          <div className="weekly-docklink-cards">
            {weeklyCaseCards.map((card) => {
              const visibleColorRows = getVisibleColorRows(card.totals);
              const weekTotal = visibleColorRows.reduce((sum, row) => sum + row.total, 0);

              return (
                <article key={`${card.year}-${card.week}`} className="weekly-docklink-card">
                  <h3>Week {card.week} · {card.year}</h3>

                  <dl className="weekly-docklink-rows">
                    {visibleColorRows.map((row) => (
                      <div key={row.color} className="weekly-docklink-row">
                        <dt>
                          <span
                            className={`weekly-docklink-dot weekly-docklink-dot-${row.color}`}
                          />
                          {row.color.charAt(0).toUpperCase() + row.color.slice(1)}
                        </dt>
                        <dd>{formatCaseTotal(row.total)}</dd>
                      </div>
                    ))}

                    <div className="weekly-docklink-row weekly-docklink-total-row">
                      <dt>Total</dt>
                      <dd>{formatCaseTotal(weekTotal)}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {isEntryModalOpen ? (
        <ModalOverlay onClose={closeEntryModal} contentClassName="variety-modal" titleId="enter-cases-title">
            <h2 id="enter-cases-title">Enter Cases</h2>

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
