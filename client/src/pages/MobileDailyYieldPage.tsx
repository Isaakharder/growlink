import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type VarietyOption = {
  id: string;
  name: string;
  status: "active" | "inactive";
};

type GreenhouseGroup = {
  id: string;
  type: string;
  name: string;
};

type GreenhouseSetupRow = {
  id: string;
  group_id: string;
  row_number: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  total_stems?: number;
  totalStems?: number;
};

type GreenhouseVarietyAssignment = {
  id: string;
  group_id: string;
  variety_id: string;
  start_row: number;
  end_row: number;
};

type GreenhouseSetupResponse = {
  groups: GreenhouseGroup[];
  rows: GreenhouseSetupRow[];
  varietyAssignments: GreenhouseVarietyAssignment[];
};

type LinkedRow = {
  row_id: string;
  row_number: number;
  phase_id: string;
  phase_name: string;
  label: string;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  total_plants: number;
  total_stems: number;
};

type LocalSample = {
  id: string;
  row_id: string;
  row_number: number;
  phase_id: string;
  phase_name: string;
  row_label: string;
  bin_fill_percent: number;
  sample_kg: number;
  sample_kg_per_stem: number;
  slab_count: number;
  plants_per_slab: number;
  stems_per_plant: number;
  total_plants: number;
  total_stems: number;
};

type PersistedSample = {
  id: string;
  row_id: string;
  row_number: number | null;
  phase_id: string | null;
  phase_name: string | null;
  row_label: string | null;
  percent_full: number;
  calculated_sample_kg: number;
  calculated_kg_per_stem: number;
  slab_count?: number | null;
  plants_per_slab?: number | null;
  stems_per_plant?: number | null;
  total_plants?: number | null;
  total_stems?: number | null;
};

const VARIETIES_URL = "/api/varieties";
const GREENHOUSE_URL = "/api/greenhouse-setup";
const SETTINGS_URL = "/api/mobile/daily-yield/settings";
const SAMPLES_URL = "/api/mobile/daily-yield/samples";
const MINIMUM_SAMPLE_COUNT = 4;
const KG_PER_FULL_BIN_STORAGE_KEY = "growlink.mobileDailyYield.kgPerFullBin";
const KG_PER_CASE_STORAGE_KEY = "growlink.mobileDailyYield.kgPerCase";

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function readStoredNumber(key: string): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedValue = window.localStorage.getItem(key);
  if (storedValue === null) {
    return null;
  }

  const parsed = Number(storedValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function persistInputValue(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, value);
}

function getIsoWeekAndYear(date: Date) {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  return {
    sessionYear: utcDate.getUTCFullYear(),
    sessionWeek: week
  };
}

function toSampleDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRowTotalStems(row: GreenhouseSetupRow): number {
  const explicitTotal =
    typeof row.total_stems === "number"
      ? row.total_stems
      : typeof row.totalStems === "number"
        ? row.totalStems
        : NaN;

  if (Number.isFinite(explicitTotal) && explicitTotal > 0) {
    return explicitTotal;
  }

  const slabCount = Number(row.slab_count);
  const plantsPerSlab = Number(row.plants_per_slab);
  const stemsPerPlant = Number(row.stems_per_plant);

  if (
    !Number.isFinite(slabCount) ||
    !Number.isFinite(plantsPerSlab) ||
    !Number.isFinite(stemsPerPlant)
  ) {
    return 0;
  }

  return slabCount * plantsPerSlab * stemsPerPlant;
}

function buildLinkedRowsByVariety(
  groups: GreenhouseGroup[],
  rows: GreenhouseSetupRow[],
  assignments: GreenhouseVarietyAssignment[]
): Record<string, LinkedRow[]> {
  const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
  const rowsByGroupId = new Map<string, GreenhouseSetupRow[]>();

  for (const row of rows) {
    const currentRows = rowsByGroupId.get(row.group_id) ?? [];
    currentRows.push(row);
    rowsByGroupId.set(row.group_id, currentRows);
  }

  const linkedByVariety: Record<string, LinkedRow[]> = {};
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const groupRows = rowsByGroupId.get(assignment.group_id) ?? [];

    for (const row of groupRows) {
      if (row.row_number < assignment.start_row || row.row_number > assignment.end_row) {
        continue;
      }

      const dedupeKey = `${assignment.variety_id}:${row.id}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const phaseName = groupNameById.get(row.group_id) ?? "Unknown";
      const totalPlants = row.slab_count * row.plants_per_slab;
      const totalStems = getRowTotalStems(row);

      const mapped: LinkedRow = {
        row_id: row.id,
        row_number: row.row_number,
        phase_id: row.group_id,
        phase_name: phaseName,
        label: `${phaseName} — Row ${row.row_number}`,
        slab_count: row.slab_count,
        plants_per_slab: row.plants_per_slab,
        stems_per_plant: row.stems_per_plant,
        total_plants: totalPlants,
        total_stems: totalStems
      };

      const current = linkedByVariety[assignment.variety_id] ?? [];
      current.push(mapped);
      linkedByVariety[assignment.variety_id] = current;
    }
  }

  for (const [varietyId, linkedRows] of Object.entries(linkedByVariety)) {
    linkedByVariety[varietyId] = linkedRows.sort((a, b) => a.row_number - b.row_number);
  }

  return linkedByVariety;
}

export function MobileDailyYieldPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [varieties, setVarieties] = useState<VarietyOption[]>([]);
  const [linkedRowsByVarietyId, setLinkedRowsByVarietyId] = useState<
    Record<string, LinkedRow[]>
  >({});

  const [selectedVarietyId, setSelectedVarietyId] = useState("");
  const [rowSearch, setRowSearch] = useState("");
  const [selectedRowId, setSelectedRowId] = useState("");
  const [binFillPercent, setBinFillPercent] = useState("0");
  const [kgPerFullBinDraft, setKgPerFullBinDraft] = useState("0");
  const [kgPerCaseDraft, setKgPerCaseDraft] = useState("0");

  const [samples, setSamples] = useState<LocalSample[]>([]);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [savingSample, setSavingSample] = useState(false);
  const [resettingSamples, setResettingSamples] = useState(false);

  const [casesSectionExpanded, setCasesSectionExpanded] = useState(false);
  const [casesPerBinDraft, setCasesPerBinDraft] = useState("38");
  const [savingCasesPerBin, setSavingCasesPerBin] = useState(false);

  const { sessionYear, sessionWeek } = useMemo(() => getIsoWeekAndYear(new Date()), []);

  function handleKgPerFullBinChange(value: string) {
    setKgPerFullBinDraft(value);
    persistInputValue(KG_PER_FULL_BIN_STORAGE_KEY, value);
  }

  function handleKgPerCaseChange(value: string) {
    setKgPerCaseDraft(value);
    persistInputValue(KG_PER_CASE_STORAGE_KEY, value);
  }

  const linkedRowsForVariety = useMemo(
    () => linkedRowsByVarietyId[selectedVarietyId] ?? [],
    [linkedRowsByVarietyId, selectedVarietyId]
  );

  const rowsById = useMemo(() => {
    return linkedRowsForVariety.reduce<Record<string, LinkedRow>>((accumulator, row) => {
      accumulator[row.row_id] = row;
      return accumulator;
    }, {});
  }, [linkedRowsForVariety]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = rowSearch.trim().toLowerCase();

    if (!normalizedSearch) {
      return linkedRowsForVariety;
    }

    return linkedRowsForVariety.filter(
      (row) =>
        String(row.row_number).includes(normalizedSearch) ||
        row.label.toLowerCase().includes(normalizedSearch)
    );
  }, [linkedRowsForVariety, rowSearch]);

  const sampleCount = samples.length;
  const sampledKgPerStemTotal = samples.reduce(
    (sum, sample) => sum + sample.sample_kg_per_stem,
    0
  );
  const avgKgPerStem = sampleCount > 0 ? sampledKgPerStemTotal / sampleCount : 0;

  const linkedRowsCount = linkedRowsForVariety.length;
  const totalLinkedStems = linkedRowsForVariety.reduce(
    (sum, row) => sum + row.total_stems,
    0
  );

  const kgPerFullBin = Number(kgPerFullBinDraft);
  const kgPerCase = Number(kgPerCaseDraft);
  const casesPerBin = Number(casesPerBinDraft);
  const canProject =
    Number.isFinite(kgPerFullBin) &&
    kgPerFullBin > 0 &&
    sampleCount > 0 &&
    totalLinkedStems > 0;

  const projectedKg = canProject ? avgKgPerStem * totalLinkedStems : 0;
  const projectedFullBins = canProject ? projectedKg / kgPerFullBin : 0;
  const usesKgPerCaseForCases = canProject && Number.isFinite(kgPerCase) && kgPerCase > 0;
  const projectedCases = usesKgPerCaseForCases
    ? projectedKg / kgPerCase
    : canProject && Number.isFinite(casesPerBin) && casesPerBin > 0
      ? projectedFullBins * casesPerBin
      : 0;

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const [varietiesRes, greenhouseRes, settingsRes] = await Promise.all([
          apiFetch(VARIETIES_URL),
          apiFetch(GREENHOUSE_URL),
          apiFetch(SETTINGS_URL)
        ]);

        if (!varietiesRes.ok) {
          throw new Error(`Failed to load varieties (${varietiesRes.status})`);
        }

        if (!greenhouseRes.ok) {
          throw new Error(`Failed to load greenhouse setup (${greenhouseRes.status})`);
        }

        const allVarieties = (await varietiesRes.json()) as VarietyOption[];
        const greenhouseData = (await greenhouseRes.json()) as GreenhouseSetupResponse;
        const settingsData = settingsRes.ok
          ? ((await settingsRes.json()) as {
              cases_per_bin?: number;
              kg_per_full_bin?: number;
              kg_per_case?: number;
            })
          : { cases_per_bin: 38, kg_per_full_bin: 0, kg_per_case: 0 };

        const storedKgPerFullBin = readStoredNumber(KG_PER_FULL_BIN_STORAGE_KEY);
        const storedKgPerCase = readStoredNumber(KG_PER_CASE_STORAGE_KEY);

        const resolvedKgPerFullBin =
          Number.isFinite(settingsData.kg_per_full_bin) &&
          Number(settingsData.kg_per_full_bin) > 0
            ? Number(settingsData.kg_per_full_bin)
            : (storedKgPerFullBin ?? 0);

        const resolvedKgPerCase =
          Number.isFinite(settingsData.kg_per_case) && Number(settingsData.kg_per_case) > 0
            ? Number(settingsData.kg_per_case)
            : (storedKgPerCase ?? 0);

        const activeVarieties = allVarieties.filter((variety) => variety.status === "active");
        const linked = buildLinkedRowsByVariety(
          greenhouseData.groups ?? [],
          greenhouseData.rows ?? [],
          greenhouseData.varietyAssignments ?? []
        );

        setVarieties(activeVarieties);
        setLinkedRowsByVarietyId(linked);
        setCasesPerBinDraft(String(settingsData.cases_per_bin ?? 38));
        setKgPerFullBinDraft(String(resolvedKgPerFullBin));
        setKgPerCaseDraft(String(resolvedKgPerCase));

        setSelectedVarietyId((current) => {
          if (current && activeVarieties.some((variety) => variety.id === current)) {
            return current;
          }
          return activeVarieties[0]?.id ?? "";
        });
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }

    void fetchData();
  }, []);

  useEffect(() => {
    const firstRowId = linkedRowsForVariety[0]?.row_id ?? "";
    setSelectedRowId(firstRowId);
    setRowSearch("");
    setBinFillPercent("0");
  }, [selectedVarietyId, linkedRowsForVariety]);

  useEffect(() => {
    setSelectedRowId((current) => {
      if (current && filteredRows.some((row) => row.row_id === current)) {
        return current;
      }
      return filteredRows[0]?.row_id ?? "";
    });
  }, [filteredRows]);

  useEffect(() => {
    async function loadSavedSamples() {
      if (!selectedVarietyId) {
        setSamples([]);
        return;
      }

      setSamplesLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          variety_id: selectedVarietyId,
          session_year: String(sessionYear),
          session_week: String(sessionWeek)
        });

        const response = await apiFetch(`${SAMPLES_URL}?${params.toString()}`);

        if (!response.ok) {
          throw new Error(`Failed to load saved samples (${response.status})`);
        }

        const data = (await response.json()) as PersistedSample[];

        setSamples(
          data.map((sample) => {
            const rowRef = rowsById[sample.row_id];

            return {
              id: sample.id,
              row_id: sample.row_id,
              row_number: sample.row_number ?? rowRef?.row_number ?? 0,
              phase_id: sample.phase_id ?? rowRef?.phase_id ?? "",
              phase_name: sample.phase_name ?? rowRef?.phase_name ?? "Unknown",
              row_label:
                sample.row_label ??
                rowRef?.label ??
                `Row ${sample.row_number ?? rowRef?.row_number ?? "-"}`,
              bin_fill_percent: Number(sample.percent_full ?? 0),
              sample_kg: Number(sample.calculated_sample_kg ?? 0),
              sample_kg_per_stem: Number(sample.calculated_kg_per_stem ?? 0),
              slab_count: Number(sample.slab_count ?? rowRef?.slab_count ?? 0),
              plants_per_slab: Number(
                sample.plants_per_slab ?? rowRef?.plants_per_slab ?? 0
              ),
              stems_per_plant: Number(sample.stems_per_plant ?? rowRef?.stems_per_plant ?? 0),
              total_plants: Number(sample.total_plants ?? rowRef?.total_plants ?? 0),
              total_stems: Number(sample.total_stems ?? rowRef?.total_stems ?? 0)
            };
          })
        );
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load saved samples"
        );
        setSamples([]);
      } finally {
        setSamplesLoading(false);
      }
    }

    void loadSavedSamples();
  }, [rowsById, selectedVarietyId, sessionWeek, sessionYear]);

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
      const response = await apiFetch(SETTINGS_URL, {
        method: "PUT",
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
      setError("Please select a linked row.");
      return;
    }

    const row = rowsById[selectedRowId];
    if (!row) {
      setError("Selected row is no longer available.");
      return;
    }

    const parsedPercent = Number(binFillPercent);
    if (!Number.isFinite(parsedPercent) || parsedPercent < 0) {
      setError("Percent of bin filled must be 0 or greater.");
      return;
    }

    const parsedKgPerCase = Number(kgPerCaseDraft);
    if (!Number.isFinite(parsedKgPerCase) || parsedKgPerCase < 0) {
      setError("Kg per case cannot be negative.");
      return;
    }

    const parsedKgPerBin = Number(kgPerFullBinDraft);
    if (!Number.isFinite(parsedKgPerBin) || parsedKgPerBin <= 0) {
      setError("Kg per full bin must be greater than 0.");
      return;
    }

    if (!Number.isFinite(row.total_stems) || row.total_stems <= 0) {
      setError("Selected row does not have a valid stem count.");
      return;
    }

    if (samples.some((sample) => sample.row_id === selectedRowId)) {
      setError("This row is already sampled for the selected variety.");
      return;
    }

    const sampleKg = (parsedPercent / 100) * parsedKgPerBin;
    const sampleKgPerStem = sampleKg / row.total_stems;

    setSavingSample(true);

    try {
      const response = await apiFetch(SAMPLES_URL, {
        method: "POST",
        body: JSON.stringify({
          variety_id: selectedVarietyId,
          row_id: row.row_id,
          phase_id: row.phase_id,
          phase_name: row.phase_name,
          row_label: row.label,
          row_number: row.row_number,
          percent_full: parsedPercent,
          kg_per_full_bin: parsedKgPerBin,
          kg_per_case: parsedKgPerCase,
          calculated_sample_kg: sampleKg,
          calculated_kg_per_stem: sampleKgPerStem,
          sample_date: toSampleDateString(new Date()),
          session_year: sessionYear,
          session_week: sessionWeek
        })
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save sample");
      }

      const saved = (await response.json()) as PersistedSample;

      setSamples((current) => [
        ...current,
        {
          id: saved.id,
          row_id: row.row_id,
          row_number: row.row_number,
          phase_id: row.phase_id,
          phase_name: row.phase_name,
          row_label: row.label,
          bin_fill_percent: parsedPercent,
          sample_kg: sampleKg,
          sample_kg_per_stem: sampleKgPerStem,
          slab_count: row.slab_count,
          plants_per_slab: row.plants_per_slab,
          stems_per_plant: row.stems_per_plant,
          total_plants: row.total_plants,
          total_stems: row.total_stems
        }
      ]);

      setBinFillPercent("0");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save sample");
    } finally {
      setSavingSample(false);
    }
  }

  async function resetSamples() {
    if (!selectedVarietyId) {
      return;
    }

    const confirmed = window.confirm("Reset saved samples for this variety and current week?");
    if (!confirmed) {
      return;
    }

    setResettingSamples(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        variety_id: selectedVarietyId,
        session_year: String(sessionYear),
        session_week: String(sessionWeek)
      });

      const response = await apiFetch(`${SAMPLES_URL}?${params.toString()}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to reset samples");
      }

      setSamples([]);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Failed to reset samples");
    } finally {
      setResettingSamples(false);
    }
  }

  return (
    <section className="mobile-page mobile-yield-page">
      <h2>Daily Yield</h2>
      <p>Sample linked rows to project stem-weighted yield for one variety.</p>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading...</p> : null}

      <div className="mobile-yield-card">
        <h3>Projection Inputs</h3>
        <form className="mobile-yield-form" onSubmit={(event) => event.preventDefault()}>
          <div
            style={{
              display: "grid",
              gap: "0.75rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))"
            }}
          >
            <label>
              Kg per full bin
              <input
                type="number"
                min="0"
                step="0.01"
                value={kgPerFullBinDraft}
                onChange={(event) => handleKgPerFullBinChange(event.target.value)}
              />
            </label>

            <label>
              Kg per case
              <input
                type="number"
                min="0"
                step="0.01"
                value={kgPerCaseDraft}
                onChange={(event) => handleKgPerCaseChange(event.target.value)}
              />
            </label>
          </div>
        </form>
      </div>

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
              onChange={(event) => setSelectedVarietyId(event.target.value)}
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
              {filteredRows.length === 0 ? <option value="">No linked rows</option> : null}
              {filteredRows.map((row) => (
                <option key={row.row_id} value={row.row_id}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Percent of bin filled
            <input
              type="number"
              min="0"
              step="0.1"
              value={binFillPercent}
              onChange={(event) => setBinFillPercent(event.target.value)}
              required
            />
          </label>

          <button type="submit" disabled={!selectedVarietyId || savingSample || samplesLoading}>
            {savingSample ? "Saving..." : "Add Sample"}
          </button>
        </form>
      </div>

      <div className="mobile-yield-card">
        <h3>Samples</h3>
        <p>Session: Week {sessionWeek}, {sessionYear}</p>
        <p>
          Samples entered: {sampleCount} / minimum {MINIMUM_SAMPLE_COUNT} recommended
        </p>

        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            onClick={resetSamples}
            disabled={!selectedVarietyId || resettingSamples || samplesLoading}
          >
            {resettingSamples ? "Resetting..." : "Reset samples"}
          </button>
        </div>

        {samplesLoading ? <p>Loading saved samples...</p> : null}

        {!samplesLoading && samples.length === 0 ? <p>No samples added yet.</p> : null}

        {samples.length > 0 ? (
          <ul className="mobile-sample-list">
            {samples.map((sample) => (
              <li key={sample.id}>
                <div>
                  <strong>{sample.row_label}</strong>
                  <span>
                    {roundTo(sample.bin_fill_percent, 2)}% | {roundTo(sample.sample_kg, 3)} kg | {roundTo(sample.sample_kg_per_stem, 6)} kg/stem
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mobile-projection-meta">
          <p>Linked rows: {linkedRowsCount}</p>
          <p>Total linked stems: {roundTo(totalLinkedStems, 2)}</p>
          <p>Avg kg per stem: {roundTo(avgKgPerStem, 6)}</p>
          <p>Projected kg: {roundTo(projectedKg, 2)}</p>
          <p>Projected full bins: {roundTo(projectedFullBins, 2)}</p>
          <p>Projected cases: {roundTo(projectedCases, 2)}</p>
          {canProject ? (
            <p>
              {usesKgPerCaseForCases
                ? "Cases calculated from kg per case"
                : "Cases calculated from cases per bin fallback"}
            </p>
          ) : null}
        </div>

        {!Number.isFinite(kgPerFullBin) || kgPerFullBin <= 0 ? (
          <p>Enter kg per full bin above to enable projection.</p>
        ) : null}

        {Number.isFinite(kgPerCase) && kgPerCase < 0 ? (
          <p>Kg per case cannot be negative.</p>
        ) : null}

        {sampleCount < MINIMUM_SAMPLE_COUNT ? (
          <p>Add at least 4 row samples for a better estimate.</p>
        ) : (
          <div className="mobile-projection-card">
            <p>Average kg per stem: {roundTo(avgKgPerStem, 6)}</p>
            <p>Projected kg: {roundTo(projectedKg, 2)}</p>
            <p>Projected full bins: {roundTo(projectedFullBins, 2)}</p>
            <p>Projected cases: {roundTo(projectedCases, 2)}</p>
            <p>
              {usesKgPerCaseForCases
                ? "Cases calculated from kg per case"
                : "Cases calculated from cases per bin fallback"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
