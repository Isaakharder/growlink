import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type VarietyOption = {
  id: string;
  name: string;
  status: "active" | "inactive";
  color: string | null;
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

type PhaseProjection = {
  phase_id: string;
  phase_name: string;
  sampledRowCount: number;
  linkedRowCount: number;
  totalLinkedStems: number;
  avgKgPerStem: number;
  projectedKg: number;
  projectedFullBins: number;
  projectedCases: number;
  canProject: boolean;
  canShowKg: boolean;
  canShowBins: boolean;
  canShowCases: boolean;
};

const VARIETIES_URL = "/api/varieties";
const GREENHOUSE_URL = "/api/greenhouse-setup";
const SETTINGS_URL = "/api/mobile/daily-yield/settings";
const SAMPLES_URL = "/api/mobile/daily-yield/samples";
const MINIMUM_SAMPLE_COUNT = 4;

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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
  const [kgPerFullBin, setKgPerFullBin] = useState(0);
  const [kgPerCase, setKgPerCase] = useState(0);

  const [samples, setSamples] = useState<LocalSample[]>([]);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [savingSample, setSavingSample] = useState(false);
  const [resettingSamples, setResettingSamples] = useState(false);

  const [casesSectionExpanded, setCasesSectionExpanded] = useState(false);
  const [casesPerBinDraft, setCasesPerBinDraft] = useState("38");
  const [savingCasesPerBin, setSavingCasesPerBin] = useState(false);

  // Raw weekly samples for every variety — drives the per-color totals card.
  // Keyed by variety_id, values are PersistedSample[] for the current week.
  const [allWeekSamples, setAllWeekSamples] = useState<Record<string, PersistedSample[]>>({});

  const { sessionYear, sessionWeek } = useMemo(() => getIsoWeekAndYear(new Date()), []);

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

  const casesPerBin = Number(casesPerBinDraft);
  const canShowKg =
    sampleCount >= MINIMUM_SAMPLE_COUNT &&
    totalLinkedStems > 0 &&
    Number.isFinite(avgKgPerStem) &&
    avgKgPerStem > 0;

  const canShowBins = canShowKg && Number.isFinite(kgPerFullBin) && kgPerFullBin > 0;
  const canProject = canShowKg;

  const projectedKg = canShowKg ? avgKgPerStem * totalLinkedStems : 0;
  const projectedFullBins = canShowBins ? projectedKg / kgPerFullBin : 0;
  const usesKgPerCaseForCases = canShowKg && Number.isFinite(kgPerCase) && kgPerCase > 0;
  const canShowCases =
    usesKgPerCaseForCases ||
    (canShowBins && Number.isFinite(casesPerBin) && casesPerBin > 0);
  const projectedCases = usesKgPerCaseForCases
    ? projectedKg / kgPerCase
    : canShowBins && Number.isFinite(casesPerBin) && casesPerBin > 0
      ? projectedFullBins * casesPerBin
      : 0;

  // ── Per-phase projections ────────────────────────────────────────────────
  // Groups sampled rows by phase_id, computes projection per phase using the
  // same formula as the global projection but scoped to that phase's linked stems.

  const phaseProjections = useMemo((): PhaseProjection[] => {
    if (samples.length < MINIMUM_SAMPLE_COUNT) return [];

    // Index linked rows by phase so we can count stems per phase.
    const linkedByPhase = new Map<string, LinkedRow[]>();
    for (const row of linkedRowsForVariety) {
      const group = linkedByPhase.get(row.phase_id) ?? [];
      group.push(row);
      linkedByPhase.set(row.phase_id, group);
    }

    // Group samples by phase.
    const samplesByPhase = new Map<string, LocalSample[]>();
    for (const sample of samples) {
      const group = samplesByPhase.get(sample.phase_id) ?? [];
      group.push(sample);
      samplesByPhase.set(sample.phase_id, group);
    }

    const results: PhaseProjection[] = [];

    for (const [phase_id, phaseSamples] of samplesByPhase.entries()) {
      const phase_name = phaseSamples[0]?.phase_name ?? "Unknown";
      const linkedRowsForPhase = linkedByPhase.get(phase_id) ?? [];
      const phaseLinkedStems = linkedRowsForPhase.reduce((sum, r) => sum + r.total_stems, 0);

      const sumKgPerStem = phaseSamples.reduce((sum, s) => sum + s.sample_kg_per_stem, 0);
      const phaseAvgKgPerStem = phaseSamples.length > 0 ? sumKgPerStem / phaseSamples.length : 0;

      const phaseCanShowKg =
        phaseLinkedStems > 0 &&
        Number.isFinite(phaseAvgKgPerStem) &&
        phaseAvgKgPerStem > 0;
      const phaseProjectedKg = phaseCanShowKg ? phaseAvgKgPerStem * phaseLinkedStems : 0;
      const phaseCanShowBins =
        phaseCanShowKg && Number.isFinite(kgPerFullBin) && kgPerFullBin > 0;
      const phaseProjectedFullBins = phaseCanShowBins ? phaseProjectedKg / kgPerFullBin : 0;
      const phaseUsesKgPerCase =
        phaseCanShowKg && Number.isFinite(kgPerCase) && kgPerCase > 0;
      const phaseCanShowCases =
        phaseUsesKgPerCase ||
        (phaseCanShowBins && Number.isFinite(casesPerBin) && casesPerBin > 0);
      const phaseProjectedCases = phaseUsesKgPerCase
        ? phaseProjectedKg / kgPerCase
        : phaseCanShowBins && Number.isFinite(casesPerBin) && casesPerBin > 0
          ? phaseProjectedFullBins * casesPerBin
          : 0;

      results.push({
        phase_id,
        phase_name,
        sampledRowCount: phaseSamples.length,
        linkedRowCount: linkedRowsForPhase.length,
        totalLinkedStems: phaseLinkedStems,
        avgKgPerStem: Number.isFinite(phaseAvgKgPerStem) ? phaseAvgKgPerStem : 0,
        projectedKg: Number.isFinite(phaseProjectedKg) ? phaseProjectedKg : 0,
        projectedFullBins: Number.isFinite(phaseProjectedFullBins) ? phaseProjectedFullBins : 0,
        projectedCases: Number.isFinite(phaseProjectedCases) ? phaseProjectedCases : 0,
        canProject: phaseCanShowKg,
        canShowKg: phaseCanShowKg,
        canShowBins: phaseCanShowBins,
        canShowCases: phaseCanShowCases
      });
    }

    return results.sort((a, b) => a.phase_name.localeCompare(b.phase_name));
  }, [samples, linkedRowsForVariety, kgPerFullBin, kgPerCase, casesPerBin]);

  const combinedTotal = useMemo(() => {
    if (phaseProjections.length === 0) return null;
    return {
      projectedKg: phaseProjections.reduce((sum, p) => sum + p.projectedKg, 0),
      projectedFullBins: phaseProjections.reduce((sum, p) => sum + p.projectedFullBins, 0),
      projectedCases: phaseProjections.reduce((sum, p) => sum + p.projectedCases, 0)
    };
  }, [phaseProjections]);

  // ── Projected cases by color ─────────────────────────────────────────────
  // Sums projected cases across all varieties for the current week, grouped by
  // variety.color. Uses allWeekSamples (loaded for every variety) so the totals
  // remain visible when the user switches between varieties.

  const colorTotals = useMemo((): { color: string; cases: number }[] => {
    const hasKgPerBin = Number.isFinite(kgPerFullBin) && kgPerFullBin > 0;
    const hasKgPerCase = Number.isFinite(kgPerCase) && kgPerCase > 0;
    if (!hasKgPerBin && !hasKgPerCase) return [];

    const totalsMap = new Map<string, number>();

    for (const variety of varieties) {
      const color = variety.color;
      if (!color) continue;

      const varietySamples = allWeekSamples[variety.id] ?? [];
      if (varietySamples.length < MINIMUM_SAMPLE_COUNT) continue;

      const linkedRows = linkedRowsByVarietyId[variety.id] ?? [];
      const totalLinkedStems = linkedRows.reduce((sum, r) => sum + r.total_stems, 0);
      if (totalLinkedStems <= 0) continue;

      const sumKgPerStem = varietySamples.reduce((sum, s) => sum + s.calculated_kg_per_stem, 0);
      const avgKgPerStem = sumKgPerStem / varietySamples.length;
      if (!Number.isFinite(avgKgPerStem) || avgKgPerStem <= 0) continue;

      const projectedKg = avgKgPerStem * totalLinkedStems;
      const projectedCases =
        Number.isFinite(kgPerCase) && kgPerCase > 0
          ? projectedKg / kgPerCase
          : Number.isFinite(casesPerBin) && casesPerBin > 0
            ? (projectedKg / kgPerFullBin) * casesPerBin
            : 0;

      if (!Number.isFinite(projectedCases) || projectedCases <= 0) continue;

      totalsMap.set(color, (totalsMap.get(color) ?? 0) + projectedCases);
    }

    return Array.from(totalsMap.entries())
      .map(([color, cases]) => ({ color, cases }))
      .sort((a, b) => a.color.localeCompare(b.color));
  }, [allWeekSamples, varieties, linkedRowsByVarietyId, kgPerFullBin, kgPerCase, casesPerBin]);

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

        const resolvedKgPerFullBin =
          Number.isFinite(settingsData.kg_per_full_bin) &&
          Number(settingsData.kg_per_full_bin) > 0
            ? Number(settingsData.kg_per_full_bin)
            : 0;

        const resolvedKgPerCase =
          Number.isFinite(settingsData.kg_per_case) && Number(settingsData.kg_per_case) > 0
            ? Number(settingsData.kg_per_case)
            : 0;

        const activeVarieties = allVarieties.filter((variety) => variety.status === "active");
        const linked = buildLinkedRowsByVariety(
          greenhouseData.groups ?? [],
          greenhouseData.rows ?? [],
          greenhouseData.varietyAssignments ?? []
        );

        setVarieties(activeVarieties);
        setLinkedRowsByVarietyId(linked);
        setCasesPerBinDraft(String(settingsData.cases_per_bin ?? 38));
        setKgPerFullBin(resolvedKgPerFullBin);
        setKgPerCase(resolvedKgPerCase);

        setSelectedVarietyId((current) => {
          if (current && activeVarieties.some((variety) => variety.id === current)) {
            return current;
          }
          return activeVarieties[0]?.id ?? "";
        });

        // Load weekly samples for every variety in parallel to power the
        // per-color totals. Failures are silently ignored per-variety.
        const { sessionYear: sy, sessionWeek: sw } = getIsoWeekAndYear(new Date());
        const sampleResults = await Promise.allSettled(
          activeVarieties.map(async (v) => {
            const params = new URLSearchParams({
              variety_id: v.id,
              session_year: String(sy),
              session_week: String(sw)
            });
            const res = await apiFetch(`${SAMPLES_URL}?${params.toString()}`);
            if (!res.ok) return { varietyId: v.id, data: [] as PersistedSample[] };
            const data = (await res.json()) as PersistedSample[];
            return { varietyId: v.id, data };
          })
        );
        const weekMap: Record<string, PersistedSample[]> = {};
        for (const result of sampleResults) {
          if (result.status === "fulfilled") {
            weekMap[result.value.varietyId] = result.value.data;
          }
        }
        setAllWeekSamples(weekMap);
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
        // Keep allWeekSamples in sync for color totals.
        setAllWeekSamples((prev) => ({ ...prev, [selectedVarietyId]: data }));
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

    if (!Number.isFinite(kgPerFullBin) || kgPerFullBin <= 0) {
      setError("Set kg per full bin in Greenhouse Setup to enable sampling.");
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

    const sampleKg = (parsedPercent / 100) * kgPerFullBin;
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
          kg_per_full_bin: kgPerFullBin,
          kg_per_case: kgPerCase,
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

      // Keep allWeekSamples in sync so color totals update immediately.
      setAllWeekSamples((prev) => ({
        ...prev,
        [selectedVarietyId]: [...(prev[selectedVarietyId] ?? []), saved]
      }));
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
      setAllWeekSamples((prev) => ({ ...prev, [selectedVarietyId]: [] }));
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
          {sampleCount >= MINIMUM_SAMPLE_COUNT ? (
            <>
              <p>Avg kg per stem: {roundTo(avgKgPerStem, 6)}</p>
              {canShowKg ? (
                <p>Projected kg: {roundTo(projectedKg, 2)}</p>
              ) : (
                <p>No linked stems — projected kg unavailable.</p>
              )}
              {canShowBins ? (
                <p>Projected full bins: {roundTo(projectedFullBins, 2)}</p>
              ) : canShowKg ? (
                <p>Set kg per full bin in Greenhouse Setup to show bin projection.</p>
              ) : null}
              {canShowCases ? (
                <>
                  <p>Projected cases: {roundTo(projectedCases, 2)}</p>
                  <p>
                    {usesKgPerCaseForCases
                      ? "Cases calculated from kg per case"
                      : "Cases calculated from cases per bin fallback"}
                  </p>
                </>
              ) : canShowKg ? (
                <p>Set kg per case in Greenhouse Setup to show case projection.</p>
              ) : null}
            </>
          ) : null}
        </div>

        {!Number.isFinite(kgPerFullBin) || kgPerFullBin <= 0 ? (
          <p>Set kg per full bin in Greenhouse Setup to enable projection.</p>
        ) : null}

        {Number.isFinite(kgPerCase) && kgPerCase < 0 ? (
          <p>Kg per case cannot be negative.</p>
        ) : null}

        {sampleCount === 1 ? (
          <p className="mobile-projection-hint">
            Must enter 4 more lines for more accurate projections.
          </p>
        ) : null}

        {sampleCount >= 2 && sampleCount < MINIMUM_SAMPLE_COUNT ? (
          <p className="mobile-projection-hint">
            Enter at least 4 lines before showing projections. More lines will improve accuracy.
          </p>
        ) : null}

        {phaseProjections.map((phase) => (
          <div className="mobile-projection-card" key={phase.phase_id}>
            <p style={{ fontWeight: 700, marginBottom: "0.3rem" }}>{phase.phase_name}</p>
            <p>Sampled rows: {phase.sampledRowCount} of {phase.linkedRowCount} linked</p>
            <p>Linked stems: {roundTo(phase.totalLinkedStems, 0).toLocaleString()}</p>
            {phase.canShowKg ? (
              <>
                <p>Avg kg/stem: {roundTo(phase.avgKgPerStem, 6)}</p>
                <p>Projected kg: {roundTo(phase.projectedKg, 2)}</p>
                {phase.canShowBins ? (
                  <p>Projected bins: {roundTo(phase.projectedFullBins, 2)}</p>
                ) : (
                  <p style={{ fontSize: "0.82em", color: "var(--text-muted)" }}>
                    Set kg per full bin in Greenhouse Setup to show bin projection.
                  </p>
                )}
                {phase.canShowCases ? (
                  <p>Projected cases: {roundTo(phase.projectedCases, 2)}</p>
                ) : (
                  <p style={{ fontSize: "0.82em", color: "var(--text-muted)" }}>
                    Set kg per case in Greenhouse Setup to show case projection.
                  </p>
                )}
              </>
            ) : (
              <p style={{ fontSize: "0.82em", color: "var(--text-muted)" }}>
                No linked stems for this phase — cannot project.
              </p>
            )}
          </div>
        ))}

        {combinedTotal ? (
          <div
            className="mobile-projection-card"
            style={{ borderColor: "var(--brand)", background: "var(--brand-soft)" }}
          >
            <p style={{ fontWeight: 700, marginBottom: "0.3rem" }}>
              {phaseProjections.length > 1 ? "Combined Total" : "Total"}
            </p>
            <p>Projected kg: {roundTo(combinedTotal.projectedKg, 2)}</p>
            <p>Projected bins: {roundTo(combinedTotal.projectedFullBins, 2)}</p>
            <p>Projected cases: {roundTo(combinedTotal.projectedCases, 2)}</p>
            <p style={{ fontSize: "0.8em", marginTop: "0.25rem", opacity: 0.8 }}>
              {usesKgPerCaseForCases
                ? "Cases from kg per case"
                : "Cases from cases per bin"}
            </p>
          </div>
        ) : null}

        {sampleCount >= MINIMUM_SAMPLE_COUNT && sampleCount < 6 ? (
          <p className="mobile-projection-hint">
            More lines will improve projection accuracy.
          </p>
        ) : null}
      </div>

      {/* ── Projected cases by color ─────────────────────────────────── */}
      {colorTotals.length > 0 ? (
        <div className="mobile-yield-card">
          <h3>Projected Cases by Color</h3>
          <p style={{ fontSize: "0.82em", color: "var(--text-muted)", marginTop: "0.15rem", marginBottom: "0.65rem" }}>
            Week {sessionWeek}, {sessionYear} — all varieties combined
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {colorTotals.map(({ color, cases }) => (
              <div
                key={color}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.55rem 0.75rem",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  background: "var(--surface)"
                }}
              >
                <span style={{ fontSize: "0.95rem", textTransform: "capitalize" }}>{color}</span>
                <span style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--brand)" }}>
                  {roundTo(cases, 1).toLocaleString()} cases
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
