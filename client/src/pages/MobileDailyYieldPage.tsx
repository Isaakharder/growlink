import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/api";

type VarietyOption = {
  id: string;
  name: string;
  status: "active" | "inactive";
};

type LinkedRow = {
  row_id: string;
  row_number: number;
  variety_id: string;
  variety_name: string;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  total_plants: number;
  total_stems: number;
};

type OptionsResponse = {
  varieties: VarietyOption[];
  rows: LinkedRow[];
  casesPerBin: number;
};

type SampleResponse = {
  id: string;
  variety_id: string;
  row_id: string;
  bin_fill_percent: number;
  created_at: string;
};

type LocalSample = {
  id: string;
  row_id: string;
  row_number: number;
  bin_fill_percent: number;
};

const OPTIONS_URL = apiUrl("/api/mobile/daily-yield/options");
const SETTINGS_URL = apiUrl("/api/mobile/daily-yield/settings");
const SAMPLES_URL = apiUrl("/api/mobile/daily-yield/samples");
const MINIMUM_SAMPLE_COUNT = 4;

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function MobileDailyYieldPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [varieties, setVarieties] = useState<VarietyOption[]>([]);
  const [rows, setRows] = useState<LinkedRow[]>([]);

  const [selectedVarietyId, setSelectedVarietyId] = useState("");
  const [rowSearch, setRowSearch] = useState("");
  const [selectedRowId, setSelectedRowId] = useState("");
  const [binFillPercent, setBinFillPercent] = useState("0");

  const [samplesByVarietyId, setSamplesByVarietyId] = useState<
    Record<string, LocalSample[]>
  >({});

  const [casesSectionExpanded, setCasesSectionExpanded] = useState(false);
  const [casesPerBinDraft, setCasesPerBinDraft] = useState("38");
  const [savingCasesPerBin, setSavingCasesPerBin] = useState(false);
  const [savingSample, setSavingSample] = useState(false);

  const rowsById = useMemo(() => {
    return rows.reduce<Record<string, LinkedRow>>((accumulator, row) => {
      accumulator[row.row_id] = row;
      return accumulator;
    }, {});
  }, [rows]);

  const linkedRowsForVariety = useMemo(() => {
    const normalizedSearch = rowSearch.trim().toLowerCase();

    return rows
      .filter((row) => row.variety_id === selectedVarietyId)
      .filter((row) => {
        if (!normalizedSearch) {
          return true;
        }

        return String(row.row_number).includes(normalizedSearch);
      })
      .sort((a, b) => a.row_number - b.row_number);
  }, [rowSearch, rows, selectedVarietyId]);

  const allLinkedRowsForVariety = useMemo(
    () => rows.filter((row) => row.variety_id === selectedVarietyId),
    [rows, selectedVarietyId]
  );

  const samplesForVariety = useMemo(
    () => samplesByVarietyId[selectedVarietyId] ?? [],
    [samplesByVarietyId, selectedVarietyId]
  );

  const sampleCount = samplesForVariety.length;
  const averageBinPercent =
    sampleCount === 0
      ? 0
      : samplesForVariety.reduce((sum, sample) => sum + sample.bin_fill_percent, 0) /
        sampleCount;

  const totalLinkedRows = allLinkedRowsForVariety.length;
  const totalLinkedPlants = allLinkedRowsForVariety.reduce(
    (sum, row) => sum + row.total_plants,
    0
  );

  const casesPerBin = Number(casesPerBinDraft);
  const estimatedBins = (averageBinPercent / 100) * totalLinkedRows;
  const estimatedCases = estimatedBins * (Number.isFinite(casesPerBin) ? casesPerBin : 0);

  useEffect(() => {
    async function fetchOptions() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(OPTIONS_URL);
        if (!response.ok) {
          throw new Error("Failed to load daily yield options");
        }

        const data = (await response.json()) as OptionsResponse;
        const activeVarieties = data.varieties ?? [];
        const linkedRows = data.rows ?? [];

        setVarieties(activeVarieties);
        setRows(linkedRows);
        setCasesPerBinDraft(String(data.casesPerBin ?? 38));

        setSelectedVarietyId((current) => {
          if (current && activeVarieties.some((variety) => variety.id === current)) {
            return current;
          }

          return activeVarieties[0]?.id ?? "";
        });
      } catch (fetchError) {
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to load daily yield options"
        );
      } finally {
        setLoading(false);
      }
    }

    void fetchOptions();
  }, []);

  useEffect(() => {
    const firstRowId = linkedRowsForVariety[0]?.row_id ?? "";
    setSelectedRowId((current) => {
      if (current && linkedRowsForVariety.some((row) => row.row_id === current)) {
        return current;
      }
      return firstRowId;
    });
  }, [linkedRowsForVariety]);

  async function saveCasesPerBin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsedValue = Number(casesPerBinDraft);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      setError("Cases per bin must be greater than 0.");
      return;
    }

    setSavingCasesPerBin(true);

    try {
      const response = await fetch(SETTINGS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cases_per_bin: parsedValue })
      });

      if (!response.ok) {
        const responseBody = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(responseBody?.message ?? "Failed to save cases per bin");
      }
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save cases per bin"
      );
    } finally {
      setSavingCasesPerBin(false);
    }
  }

  async function addSample(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!selectedVarietyId) {
      setError("Please select a variety.");
      return;
    }

    if (!selectedRowId) {
      setError("Please select a row.");
      return;
    }

    const parsedPercent = Number(binFillPercent);
    if (!Number.isFinite(parsedPercent) || parsedPercent < 0 || parsedPercent > 100) {
      setError("Percent of bin filled must be between 0 and 100.");
      return;
    }

    if (samplesForVariety.some((sample) => sample.row_id === selectedRowId)) {
      setError("This row is already sampled for the selected variety.");
      return;
    }

    setSavingSample(true);

    try {
      const response = await fetch(SAMPLES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variety_id: selectedVarietyId,
          row_id: selectedRowId,
          bin_fill_percent: parsedPercent
        })
      });

      if (!response.ok) {
        const responseBody = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(responseBody?.message ?? "Failed to add sample");
      }

      const created = (await response.json()) as SampleResponse;
      const row = rowsById[created.row_id];

      if (!row) {
        throw new Error("Selected row is no longer available");
      }

      setSamplesByVarietyId((current) => ({
        ...current,
        [selectedVarietyId]: [
          ...(current[selectedVarietyId] ?? []),
          {
            id: created.id,
            row_id: created.row_id,
            row_number: row.row_number,
            bin_fill_percent: Number(created.bin_fill_percent)
          }
        ]
      }));

      setBinFillPercent("0");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to add sample");
    } finally {
      setSavingSample(false);
    }
  }

  function removeSample(sampleId: string) {
    if (!selectedVarietyId) {
      return;
    }

    setSamplesByVarietyId((current) => ({
      ...current,
      [selectedVarietyId]: (current[selectedVarietyId] ?? []).filter(
        (sample) => sample.id !== sampleId
      )
    }));
  }

  return (
    <section className="mobile-page mobile-yield-page">
      <h2>Daily Yield</h2>
      <p>Sample linked rows to project bins and cases for one variety.</p>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading...</p> : null}

      <div className="mobile-yield-card">
        <button
          type="button"
          className="mobile-section-toggle"
          onClick={() => setCasesSectionExpanded((value) => !value)}
        >
          Cases per bin
        </button>

        {casesSectionExpanded ? (
          <form className="mobile-yield-form" onSubmit={saveCasesPerBin}>
            <label>
              Cases per bin
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={casesPerBinDraft}
                onChange={(event) => setCasesPerBinDraft(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={savingCasesPerBin}>
              {savingCasesPerBin ? "Saving..." : "Save"}
            </button>
          </form>
        ) : null}
      </div>

      <div className="mobile-yield-card">
        <h3>Daily Sampling</h3>

        <form className="mobile-yield-form" onSubmit={addSample}>
          <label>
            Select Variety
            <select
              value={selectedVarietyId}
              onChange={(event) => {
                setSelectedVarietyId(event.target.value);
                setRowSearch("");
              }}
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
            Search row number
            <input
              type="text"
              inputMode="numeric"
              placeholder="e.g. 12"
              value={rowSearch}
              onChange={(event) => setRowSearch(event.target.value)}
            />
          </label>

          <label>
            Select Row
            <select
              value={selectedRowId}
              onChange={(event) => setSelectedRowId(event.target.value)}
              required
            >
              {linkedRowsForVariety.length === 0 ? <option value="">No linked rows</option> : null}
              {linkedRowsForVariety.map((row) => (
                <option key={row.row_id} value={row.row_id}>
                  Row {row.row_number} - {row.total_plants} plants
                </option>
              ))}
            </select>
          </label>

          <label>
            Percent of bin filled
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={binFillPercent}
              onChange={(event) => setBinFillPercent(event.target.value)}
              required
            />
          </label>

          <button type="submit" disabled={savingSample || !selectedVarietyId}>
            {savingSample ? "Adding..." : "Add Sample"}
          </button>
        </form>
      </div>

      <div className="mobile-yield-card">
        <h3>Samples</h3>
        <p>
          Samples entered: {sampleCount} / minimum {MINIMUM_SAMPLE_COUNT}
        </p>

        {samplesForVariety.length === 0 ? <p>No samples added yet.</p> : null}

        {samplesForVariety.length > 0 ? (
          <ul className="mobile-sample-list">
            {samplesForVariety.map((sample) => (
              <li key={sample.id}>
                <div>
                  <strong>Row {sample.row_number}</strong>
                  <span>{roundTo(sample.bin_fill_percent, 2)}%</span>
                </div>
                <button type="button" onClick={() => removeSample(sample.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mobile-projection-meta">
          <p>Total linked rows: {totalLinkedRows}</p>
          <p>Total plants: {roundTo(totalLinkedPlants, 2)}</p>
        </div>

        {sampleCount < MINIMUM_SAMPLE_COUNT ? (
          <p>Add at least 4 row samples for a better estimate.</p>
        ) : (
          <div className="mobile-projection-card">
            <p>Average bin %: {roundTo(averageBinPercent, 2)}%</p>
            <p>Estimated bins: {roundTo(estimatedBins, 2)}</p>
            <p>Estimated cases: {roundTo(estimatedCases, 2)}</p>
          </div>
        )}
      </div>
    </section>
  );
}
