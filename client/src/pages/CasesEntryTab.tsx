import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

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

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function numberOrZero(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function CasesEntryTab() {
  const currentYear = new Date().getFullYear();
  const [colors, setColors] = useState<VarietyColor[]>([]);
  const [entries, setEntries] = useState<CaseEntry[]>([]);
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

  async function fetchOptionsAndEntries() {
    setLoading(true);
    setError(null);

    try {
      const [optionsResponse, entriesResponse] = await Promise.all([
        apiFetch(OPTIONS_URL),
        apiFetch(ENTRIES_URL)
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
    setForm({
      color: entry.color,
      year: String(entry.year),
      week: String(entry.week),
      total_cases: String(entry.total_cases),
      case_weight_kg: String(entry.case_weight_kg)
    });

    setError(null);
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
      <div className="coming-soon-card yield-entry-primary">
        <h2>{editingId ? "Edit Case Entry" : "Weekly Cases Entry"}</h2>

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
            </div>
          </form>
        ) : null}
      </div>

      <div className="coming-soon-card yield-entry-secondary">
        <div className="recent-entries-header">
          <h2>Recent Entries</h2>
          <button
            type="button"
            className="sync-button"
            onClick={() => void syncDocklinkCases()}
            disabled={syncing}
          >
            {syncing ? "Syncing..." : "Sync DockLink Cases"}
          </button>
        </div>

        {entries.length === 0 && <p>No case entries yet.</p>}

        {entries.length > 0 && (
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
                  <th>Kg/m²</th>
                  <th>Source</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.color.charAt(0).toUpperCase() + entry.color.slice(1)}</td>
                    <td>{entry.year}</td>
                    <td>{entry.week}</td>
                    <td>{roundTo(entry.total_cases, 3)}</td>
                    <td>{roundTo(entry.case_weight_kg, 3)}</td>
                    <td>{roundTo(entry.total_kg, 3)}</td>
                    <td>{roundTo(entry.kg_per_m2, 3)}</td>
                    <td>
                      <span className={`source-badge source-${entry.source || "manual"}`}>
                        {(entry.source || "manual").charAt(0).toUpperCase() +
                          (entry.source || "manual").slice(1)}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {(!entry.source || entry.source === "manual") && (
                          <>
                            <button type="button" onClick={() => beginEdit(entry)}>
                              Edit
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => deleteEntry(entry.id)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                        {entry.source === "docklink" && (
                          <button
                            type="button"
                            className="danger"
                            onClick={() => deleteEntry(entry.id)}
                            title="Delete imported DockLink entry"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
