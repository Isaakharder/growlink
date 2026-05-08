import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/api";

type YieldSizeStatus = "active" | "inactive";
type VarietyStatus = "active" | "inactive";

type VarietyOption = {
  id: string;
  name: string;
  area_m2: number;
  case_kg: number;
  status: VarietyStatus;
};

type YieldSizeOption = {
  id: string;
  name: string;
  sort_order: number;
  status: YieldSizeStatus;
};

type YieldEntry = {
  id: string;
  variety_id: string;
  variety_name: string;
  year: number;
  week: number;
  size_kg: Record<string, number>;
  total_kg: number;
  average_fruit_weight_g: number | null;
  kg_per_m2: number;
  total_cases: number;
  created_at: string;
  updated_at: string;
};

type YieldEntryFormState = {
  variety_id: string;
  year: string;
  week: string;
  average_fruit_weight_g: string;
  size_kg: Record<string, string>;
};

type WeekOption = {
  value: number;
  label: string;
};

const OPTIONS_URL = apiUrl("/api/yield-entry-options");
const ENTRIES_URL = apiUrl("/api/yield-entries");

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

function numberOrZero(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function YieldDataEntryPage() {
  const currentYear = new Date().getFullYear();
  const [varieties, setVarieties] = useState<VarietyOption[]>([]);
  const [yieldSizes, setYieldSizes] = useState<YieldSizeOption[]>([]);
  const [entries, setEntries] = useState<YieldEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<YieldEntryFormState>({
    variety_id: "",
    year: String(currentYear),
    week: String(getCurrentWeek(currentYear)),
    average_fruit_weight_g: "",
    size_kg: {}
  });

  const selectedVariety = useMemo(
    () => varieties.find((variety) => variety.id === form.variety_id),
    [form.variety_id, varieties]
  );

  const weekOptions = useMemo(() => createWeekOptions(Number(form.year)), [form.year]);

  const totalKg = useMemo(
    () => Object.values(form.size_kg).reduce((sum, value) => sum + numberOrZero(value), 0),
    [form.size_kg]
  );

  const kgPerM2 = useMemo(() => {
    if (!selectedVariety || selectedVariety.area_m2 <= 0) {
      return 0;
    }

    return totalKg / selectedVariety.area_m2;
  }, [selectedVariety, totalKg]);

  const totalCases = useMemo(() => {
    if (!selectedVariety || selectedVariety.case_kg <= 0) {
      return 0;
    }

    return totalKg / selectedVariety.case_kg;
  }, [selectedVariety, totalKg]);

  function resetSizeKgFields(sizes: YieldSizeOption[]) {
    const next: Record<string, string> = {};

    for (const size of sizes) {
      next[size.id] = "0";
    }

    return next;
  }

  async function fetchOptionsAndEntries() {
    setLoading(true);
    setError(null);

    try {
      const [optionsResponse, entriesResponse] = await Promise.all([
        fetch(OPTIONS_URL),
        fetch(ENTRIES_URL)
      ]);

      if (!optionsResponse.ok) {
        throw new Error(`Failed to load entry options (${optionsResponse.status})`);
      }

      if (!entriesResponse.ok) {
        throw new Error(`Failed to load entries (${entriesResponse.status})`);
      }

      const optionsData = (await optionsResponse.json()) as {
        varieties: VarietyOption[];
        yieldSizes: YieldSizeOption[];
      };

      const entriesData = (await entriesResponse.json()) as YieldEntry[];
      const sortedSizes = [...optionsData.yieldSizes].sort(
        (a, b) => a.sort_order - b.sort_order
      );

      setVarieties(optionsData.varieties);
      setYieldSizes(sortedSizes);
      setEntries(entriesData);

      setForm((current) => {
        const hasCurrentVariety = optionsData.varieties.some(
          (variety) => variety.id === current.variety_id
        );

        return {
          ...current,
          variety_id: hasCurrentVariety
            ? current.variety_id
            : (optionsData.varieties[0]?.id ?? ""),
          size_kg: Object.keys(current.size_kg).length
            ? {
                ...resetSizeKgFields(sortedSizes),
                ...current.size_kg
              }
            : resetSizeKgFields(sortedSizes)
        };
      });
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load data entry options"
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

    if (!form.variety_id) {
      setError("Variety is required.");
      return;
    }

    const payloadSizeKg: Record<string, number> = {};
    for (const size of yieldSizes) {
      const kg = numberOrZero(form.size_kg[size.id] ?? "0");
      if (kg < 0) {
        setError("Kg values must be 0 or greater.");
        return;
      }
      payloadSizeKg[size.id] = kg;
    }

    const payload = {
      variety_id: form.variety_id,
      year: Number(form.year),
      week: Number(form.week),
      size_kg: payloadSizeKg,
      average_fruit_weight_g:
        form.average_fruit_weight_g.trim() === ""
          ? null
          : Number(form.average_fruit_weight_g)
    };

    if (!Number.isInteger(payload.year)) {
      setError("Year is required.");
      return;
    }

    if (!Number.isInteger(payload.week)) {
      setError("Week is required.");
      return;
    }

    if (
      payload.average_fruit_weight_g !== null &&
      (!Number.isFinite(payload.average_fruit_weight_g) || payload.average_fruit_weight_g < 0)
    ) {
      setError("Average fruit weight must be 0 or greater.");
      return;
    }

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${ENTRIES_URL}/${editingId}` : ENTRIES_URL;

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
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
      setForm((current) => ({
        ...current,
        average_fruit_weight_g: "",
        size_kg: resetSizeKgFields(yieldSizes)
      }));

      const entriesResponse = await fetch(ENTRIES_URL);
      if (!entriesResponse.ok) {
        throw new Error("Saved, but failed to refresh entries");
      }

      const entriesData = (await entriesResponse.json()) as YieldEntry[];
      setEntries(entriesData);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save yield entry"
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(entry: YieldEntry) {
    const nextSizeKg = resetSizeKgFields(yieldSizes);

    for (const [sizeId, kg] of Object.entries(entry.size_kg ?? {})) {
      nextSizeKg[sizeId] = String(kg);
    }

    setEditingId(entry.id);
    setForm({
      variety_id: entry.variety_id,
      year: String(entry.year),
      week: String(entry.week),
      average_fruit_weight_g:
        entry.average_fruit_weight_g === null ? "" : String(entry.average_fruit_weight_g),
      size_kg: nextSizeKg
    });

    setError(null);
  }

  async function deleteEntry(id: string) {
    const confirmed = window.confirm("Delete this yield entry?");
    if (!confirmed) {
      return;
    }

    setError(null);

    try {
      const response = await fetch(`${ENTRIES_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }

      if (editingId === id) {
        setEditingId(null);
      }

      const entriesResponse = await fetch(ENTRIES_URL);
      if (!entriesResponse.ok) {
        throw new Error("Deleted, but failed to refresh entries");
      }

      const entriesData = (await entriesResponse.json()) as YieldEntry[];
      setEntries(entriesData);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete entry"
      );
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Yield Data Entry</h1>
        <p>Weekly one-screen entry for yield by size.</p>
      </header>

      <div className="yield-entry-layout">
        <div className="coming-soon-card yield-entry-primary">
          <h2>{editingId ? "Edit Yield Entry" : "Weekly Yield Entry"}</h2>

          {error ? <p className="form-error">{error}</p> : null}
          {loading ? <p>Loading...</p> : null}

          {!loading ? (
            <form className="yield-entry-form" onSubmit={handleSubmit}>
              <label>
                Variety
                <select
                  value={form.variety_id}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, variety_id: event.target.value }))
                  }
                  required
                >
                  {varieties.length === 0 ? <option value="">No active varieties</option> : null}
                  {varieties.map((variety) => (
                    <option key={variety.id} value={variety.id}>
                      {variety.name}
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

            <div className="yield-size-fields">
              {yieldSizes.map((size) => (
                <label key={size.id}>
                  {size.name} (kg)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.size_kg[size.id] ?? "0"}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        size_kg: {
                          ...current.size_kg,
                          [size.id]: event.target.value
                        }
                      }))
                    }
                  />
                </label>
              ))}
            </div>

            <label>
              Total kg
              <input type="number" value={roundTo(totalKg, 3)} readOnly />
            </label>

            <label>
              Average fruit weight (g)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.average_fruit_weight_g}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    average_fruit_weight_g: event.target.value
                  }))
                }
              />
            </label>

            <label>
              Kg/m²
              <input type="number" value={roundTo(kgPerM2, 3)} readOnly />
            </label>

            <label>
              Total cases
              <input type="number" value={roundTo(totalCases, 3)} readOnly />
            </label>

              <div className="form-actions">
                <button type="submit" disabled={saving || varieties.length === 0}>
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          ) : null}
        </div>

        <div className="coming-soon-card yield-entry-secondary">
          <h2>Recent Entries</h2>

          {entries.length === 0 ? <p>No yield entries yet.</p> : null}

          {entries.length > 0 ? (
            <div className="varieties-table-wrapper yield-entry-table-wrapper">
              <table className="varieties-table yield-entry-table">
                <thead>
                  <tr>
                    <th>Variety</th>
                    <th>Year</th>
                    <th>Week</th>
                    <th>Total kg</th>
                    <th>Kg/m²</th>
                    <th>Total cases</th>
                    <th>Average fruit weight</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.variety_name}</td>
                      <td>{entry.year}</td>
                      <td>{entry.week}</td>
                      <td>{roundTo(entry.total_kg, 3)}</td>
                      <td>{roundTo(entry.kg_per_m2, 3)}</td>
                      <td>{roundTo(entry.total_cases, 3)}</td>
                      <td>
                        {entry.average_fruit_weight_g === null
                          ? "-"
                          : roundTo(entry.average_fruit_weight_g, 2)}
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
          ) : null}
        </div>
      </div>
    </section>
  );
}
