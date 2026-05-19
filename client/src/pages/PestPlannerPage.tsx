import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

type SetupGroup = {
  id: string;
  type: string;
  name: string;
  status: string;
};

type SetupRow = {
  id: string;
  group_id: string;
  width_meters: number | null;
  length_meters: number | null;
};

type FeedValve = { id: string; name: string; };
type RowValveLink = { id: string; valve_id: string; row_id: string; };

type SprayerTank = { id: string; name: string; volume_liters: number };

type Sprayer = {
  id: string;
  name: string;
  nozzle_count: number;
  nozzle_volume_l_per_min: number;
  nozzle_psi: number;
  speed_m_per_min: number | null;
  min_speed_m_per_min: number | null;
  max_speed_m_per_min: number | null;
  speed_step_m_per_min: number | null;
  has_tank: boolean;
  tank_volume_liters: number | null;
  tank_id: string | null;
  tank: SprayerTank | null;
};

type Tank = {
  id: string;
  name: string;
  volume_liters: number;
  active: boolean;
};

type ChemicalType = "fungicide" | "insecticide" | "herbicide" | "pesticide";

type Chemical = {
  id: string;
  name: string;
  active: boolean;
  inventory_qty: number;
  inventory_unit: string;
  pest_target: string;
  notes: string | null;
  rei?: string | null;
  phi: string | null;
  chemical_group: string | null;
  chemical_type: ChemicalType | null;
  active_ingredients: string | null;
  registration_number: string | null;
  label_pdf_path: string | null;
};

type ApplicationType = "drench" | "spray";
type RateUnit =
  | "ml_per_acre" | "L_per_acre" | "ml_per_hectare" | "L_per_hectare"
  | "g_per_acre"  | "kg_per_acre" | "g_per_hectare"  | "kg_per_hectare";

const LIQUID_RATE_OPTIONS: { value: RateUnit; label: string }[] = [
  { value: "ml_per_acre", label: "ml / acre" },
  { value: "L_per_acre", label: "L / acre" },
  { value: "ml_per_hectare", label: "ml / hectare" },
  { value: "L_per_hectare", label: "L / hectare" }
];

const DRY_RATE_OPTIONS: { value: RateUnit; label: string }[] = [
  { value: "g_per_acre", label: "g / acre" },
  { value: "kg_per_acre", label: "kg / acre" },
  { value: "g_per_hectare", label: "g / hectare" },
  { value: "kg_per_hectare", label: "kg / hectare" }
];

function isDryChemical(inventoryUnit: string): boolean {
  const u = inventoryUnit.toLowerCase().trim();
  if (["g", "kg", "grams", "gram", "kilograms", "kilogram"].includes(u)) return true;
  if (u.startsWith("g/") || u.startsWith("kg/")) return true;
  if (/(powder|dry|dust|granule|granules|wdg|wg|wp)/.test(u)) return true;
  return false;
}

const M2_TO_FT2 = 10.7639;
const M2_TO_HECTARES = 1 / 10000;
const M2_TO_ACRES = 1 / 4046.8564224;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function rowAreaM2(row: SetupRow): number {
  return (row.width_meters ?? 0) * (row.length_meters ?? 0);
}

export function PestPlannerPage() {
  const [groups, setGroups] = useState<SetupGroup[]>([]);
  const [rows, setRows] = useState<SetupRow[]>([]);
  const [sprayers, setSprayers] = useState<Sprayer[]>([]);
  const [tanks, setTanks] = useState<Tank[]>([]);
  const [chemicals, setChemicals] = useState<Chemical[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Target area selection
  const [targetMode, setTargetMode] = useState<"phase" | "valve">("phase");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [feedValves, setFeedValves] = useState<FeedValve[]>([]);
  const [rowValves, setRowValves] = useState<RowValveLink[]>([]);
  const [selectedValveIds, setSelectedValveIds] = useState<string[]>([]);

  // ── Application details
  const [applicationType, setApplicationType] = useState<ApplicationType | "">("");
  const [rateValue, setRateValue] = useState("");
  const [rateUnit, setRateUnit] = useState<RateUnit>("ml_per_acre");

  // ── Sprayer
  const [sprayerId, setSprayerId] = useState("");
  const [nozzlesOpen, setNozzlesOpen] = useState("");
  const [spraySpeed, setSpraySpeed] = useState("");

  // ── Chemical
  const [chemicalId, setChemicalId] = useState("");
  const [labelLoading, setLabelLoading] = useState(false);

  // ── Save as To Do
  const [instructions, setInstructions] = useState("");
  const [todoSaving, setTodoSaving] = useState(false);
  const [todoSavedMessage, setTodoSavedMessage] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [setupRes, sprayersRes, tanksRes, chemicalsRes] = await Promise.all([
          apiFetch("/api/greenhouse-setup"),
          apiFetch("/api/pest/sprayers"),
          apiFetch("/api/pest/tanks"),
          apiFetch("/api/pest/chemicals")
        ]);

        if (!setupRes.ok || !sprayersRes.ok || !tanksRes.ok || !chemicalsRes.ok) {
          throw new Error("Failed to load planner data");
        }

        const setupData = (await setupRes.json()) as {
          groups: SetupGroup[];
          rows: SetupRow[];
          rowValves?: RowValveLink[];
        };
        const sprayersData = (await sprayersRes.json()) as Sprayer[];
        const tanksData = (await tanksRes.json()) as Tank[];
        const chemicalsData = (await chemicalsRes.json()) as Chemical[];

        setGroups(setupData.groups ?? []);
        setRows(setupData.rows ?? []);
        setRowValves(setupData.rowValves ?? []);
        setSprayers(sprayersData);
        setTanks(tanksData);
        setChemicals(chemicalsData);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load planner data"
        );
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  useEffect(() => {
    async function loadValves() {
      try {
        const res = await apiFetch("/api/irrigation-setup");
        if (!res.ok) return;
        const data = (await res.json()) as { feedValves: FeedValve[] };
        setFeedValves(data.feedValves ?? []);
      } catch {
        // supplemental — silently ignore
      }
    }
    void loadValves();
  }, []);

  // ── Group selection ────────────────────────────────────────────────────────

  const selectedGroupIdsSet = useMemo(
    () => new Set(selectedGroupIds),
    [selectedGroupIds]
  );

  const allSelected = groups.length > 0 && selectedGroupIds.length === groups.length;
  const someSelected =
    selectedGroupIds.length > 0 && selectedGroupIds.length < groups.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  function toggleGroup(id: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return Array.from(next);
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedGroupIds([]);
    } else {
      setSelectedGroupIds(groups.map((g) => g.id));
    }
  }

  // ── Area derivations ───────────────────────────────────────────────────────

  const rowsByGroupId = useMemo(() => {
    const map: Record<string, SetupRow[]> = {};
    for (const row of rows) {
      if (!map[row.group_id]) map[row.group_id] = [];
      map[row.group_id].push(row);
    }
    return map;
  }, [rows]);

  const rowById = useMemo(() => {
    const map: Record<string, SetupRow> = {};
    for (const row of rows) map[row.id] = row;
    return map;
  }, [rows]);

  const areaByGroupId = useMemo(() => {
    const result: Record<string, number> = {};
    for (const id of selectedGroupIds) {
      const groupRows = rowsByGroupId[id] ?? [];
      result[id] = groupRows.reduce((sum, r) => sum + rowAreaM2(r), 0);
    }
    return result;
  }, [selectedGroupIds, rowsByGroupId]);

  // Rows linked to the currently selected valves (valve mode).
  const valveTargetRows = useMemo(() => {
    if (targetMode !== "valve" || selectedValveIds.length === 0) return [];
    const valveSet = new Set(selectedValveIds);
    return rowValves
      .filter((rv) => valveSet.has(rv.valve_id))
      .map((rv) => rowById[rv.row_id])
      .filter((r): r is SetupRow => r !== undefined);
  }, [targetMode, selectedValveIds, rowValves, rowById]);

  const totalM2 = useMemo(() => {
    if (targetMode === "valve") {
      return valveTargetRows.reduce((sum, r) => sum + rowAreaM2(r), 0);
    }
    return Object.values(areaByGroupId).reduce((sum, a) => sum + a, 0);
  }, [targetMode, valveTargetRows, areaByGroupId]);

  // Sum of length_meters across every row in every selected group/valve.
  // This is the actual linear distance the sprayer travels.
  const totalRowLengthMeters = useMemo(() => {
    if (targetMode === "valve") {
      return valveTargetRows.reduce((sum, r) => sum + (r.length_meters ?? 0), 0);
    }
    let total = 0;
    for (const id of selectedGroupIds) {
      for (const row of rowsByGroupId[id] ?? []) {
        total += row.length_meters ?? 0;
      }
    }
    return total;
  }, [targetMode, valveTargetRows, selectedGroupIds, rowsByGroupId]);

  const groupsWithNoDimensions = useMemo(
    () =>
      selectedGroupIds
        .map((id) => groups.find((g) => g.id === id))
        .filter((g): g is SetupGroup => g !== undefined && areaByGroupId[g.id] === 0),
    [selectedGroupIds, groups, areaByGroupId]
  );

  const selectedGroupNames = useMemo(
    () =>
      selectedGroupIds
        .map((id) => groups.find((g) => g.id === id)?.name ?? "")
        .filter(Boolean),
    [selectedGroupIds, groups]
  );

  const selectedValveNames = useMemo(
    () =>
      selectedValveIds
        .map((id) => feedValves.find((v) => v.id === id)?.name ?? "")
        .filter(Boolean),
    [selectedValveIds, feedValves]
  );

  // ── Application rate calculation ───────────────────────────────────────────

  const chemicalNeededResult = useMemo(() => {
    const rate = Number(rateValue);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    if (totalM2 <= 0) return null;

    const acres = totalM2 * M2_TO_ACRES;
    const ha = totalM2 * M2_TO_HECTARES;

    let ml: number;
    let areaLabel: string;
    let isDry = false;

    switch (rateUnit) {
      case "ml_per_acre":
        ml = rate * acres;
        areaLabel = `${roundTo(acres, 3)} acres`;
        break;
      case "L_per_acre":
        ml = rate * acres * 1000;
        areaLabel = `${roundTo(acres, 3)} acres`;
        break;
      case "ml_per_hectare":
        ml = rate * ha;
        areaLabel = `${roundTo(ha, 4)} ha`;
        break;
      case "L_per_hectare":
        ml = rate * ha * 1000;
        areaLabel = `${roundTo(ha, 4)} ha`;
        break;
      case "g_per_acre":
        ml = rate * acres;
        areaLabel = `${roundTo(acres, 3)} acres`;
        isDry = true;
        break;
      case "kg_per_acre":
        ml = rate * acres * 1000;
        areaLabel = `${roundTo(acres, 3)} acres`;
        isDry = true;
        break;
      case "g_per_hectare":
        ml = rate * ha;
        areaLabel = `${roundTo(ha, 4)} ha`;
        isDry = true;
        break;
      case "kg_per_hectare":
        ml = rate * ha * 1000;
        areaLabel = `${roundTo(ha, 4)} ha`;
        isDry = true;
        break;
    }

    return { ml, L: ml / 1000, areaLabel, isDry, unit: isDry ? "g" : "ml", unitLarge: isDry ? "kg" : "L" };
  }, [rateValue, rateUnit, totalM2]);

  // ── Sprayer derivations ────────────────────────────────────────────────────

  const selectedSprayer = useMemo(
    () => sprayers.find((s) => s.id === sprayerId) ?? null,
    [sprayers, sprayerId]
  );

  // Generate speed options from the sprayer's min/max/step range.
  // Falls back to the legacy single speed_m_per_min for old records.
  const speedOptions = useMemo<number[]>(() => {
    if (!selectedSprayer) return [];
    const { min_speed_m_per_min: min, max_speed_m_per_min: max, speed_step_m_per_min: step, speed_m_per_min: legacy } = selectedSprayer;
    if (min != null && max != null && min < max) {
      const inc = step != null && step > 0 ? step : 1;
      const opts: number[] = [];
      for (let v = min; v <= max + 1e-9; v += inc) {
        opts.push(Math.round(v * 1000) / 1000);
      }
      return opts;
    }
    if (legacy != null && legacy > 0) return [legacy];
    return [];
  }, [selectedSprayer]);

  // Effective tank volume: built-in on sprayer, or a linked standalone tank.
  const effectiveTankVolume = useMemo<number | null>(() => {
    if (!selectedSprayer) return null;
    if (selectedSprayer.has_tank && selectedSprayer.tank_volume_liters != null) {
      return selectedSprayer.tank_volume_liters;
    }
    // prefer the joined tank object returned by the API; fall back to tanks list
    const linkedTank = selectedSprayer.tank ?? tanks.find((t) => t.id === selectedSprayer.tank_id);
    return linkedTank?.volume_liters ?? null;
  }, [selectedSprayer, tanks]);

  const effectiveTankName = useMemo<string | null>(() => {
    if (!selectedSprayer) return null;
    if (selectedSprayer.has_tank) return "Built-in tank";
    const linkedTank = selectedSprayer.tank ?? tanks.find((t) => t.id === selectedSprayer.tank_id);
    return linkedTank?.name ?? null;
  }, [selectedSprayer, tanks]);

  const nozzlesOpenNum = useMemo(() => {
    const n = Number(nozzlesOpen);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
  }, [nozzlesOpen]);

  const flowLPerMin = useMemo(() => {
    if (!selectedSprayer || nozzlesOpenNum < 1) return null;
    return selectedSprayer.nozzle_volume_l_per_min * nozzlesOpenNum;
  }, [selectedSprayer, nozzlesOpenNum]);

  const nozzlesOpenError = useMemo(() => {
    if (!selectedSprayer || !nozzlesOpen) return null;
    const n = Number(nozzlesOpen);
    if (!Number.isInteger(n) || n < 1) return "Nozzles open must be 1 or greater.";
    if (n > selectedSprayer.nozzle_count)
      return `Cannot exceed sprayer nozzle count (${selectedSprayer.nozzle_count}).`;
    return null;
  }, [nozzlesOpen, selectedSprayer]);

  // Spray run calculations — only valid when sprayer + nozzles are set
  // and row lengths are known. Returns null when any input is missing/invalid.
  const sprayCalc = useMemo(() => {
    if (!selectedSprayer || nozzlesOpenNum < 1 || nozzlesOpenError) return null;
    if (totalRowLengthMeters <= 0) return null;

    const speed = Number(spraySpeed);
    if (!Number.isFinite(speed) || speed <= 0) return null;

    const flowPerNozzle = selectedSprayer.nozzle_volume_l_per_min; // L/min per nozzle

    const sprayTimeMinutes = totalRowLengthMeters / speed;
    const totalFlowLPerMin = flowPerNozzle * nozzlesOpenNum;
    const totalVolumeL = sprayTimeMinutes * totalFlowLPerMin;

    return {
      sprayTimeMinutes,
      sprayTimeHours: sprayTimeMinutes / 60,
      totalFlowLPerMin,
      totalVolumeL
    };
  }, [selectedSprayer, nozzlesOpenNum, nozzlesOpenError, totalRowLengthMeters, spraySpeed]);

  const tankCalc = useMemo(() => {
    if (!sprayCalc || !effectiveTankVolume || !chemicalNeededResult) return null;
    const totalVolumeL = sprayCalc.totalVolumeL;
    const tankVolumeL = effectiveTankVolume;
    if (totalVolumeL <= 0 || tankVolumeL <= 0) return null;

    const tankCount = Math.ceil(totalVolumeL / tankVolumeL);
    const chemPerLiterMl = chemicalNeededResult.ml / totalVolumeL;
    const chemPerFullTankMl = chemPerLiterMl * tankVolumeL;
    const rawFinalVolumeL = totalVolumeL % tankVolumeL;
    const isLastFull = rawFinalVolumeL < 0.001;
    const finalTankVolumeL = isLastFull ? tankVolumeL : rawFinalVolumeL;
    const chemForFinalTankMl = chemPerLiterMl * finalTankVolumeL;

    return {
      tankCount,
      chemPerLiterMl,
      chemPerFullTankMl,
      finalTankVolumeL,
      chemForFinalTankMl,
      isLastFull
    };
  }, [sprayCalc, effectiveTankVolume, chemicalNeededResult]);

  function handleSprayerChange(id: string) {
    setSprayerId(id);
    const s = sprayers.find((sp) => sp.id === id);
    setNozzlesOpen(s ? String(s.nozzle_count) : "");
    setSpraySpeed("");
  }

  // ── Chemical derivations ───────────────────────────────────────────────────

  const availableChemicals = useMemo(
    () => chemicals.filter((c) => c.active && c.inventory_qty > 0),
    [chemicals]
  );

  const selectedChemical = useMemo(
    () => availableChemicals.find((c) => c.id === chemicalId) ?? null,
    [availableChemicals, chemicalId]
  );

  useEffect(() => {
    if (!selectedChemical) return;
    const dry = isDryChemical(selectedChemical.inventory_unit);
    setRateUnit((prev) => {
      const prevIsDry = prev.startsWith("g_") || prev.startsWith("kg_");
      if (dry && !prevIsDry) return "g_per_acre";
      if (!dry && prevIsDry) return "ml_per_acre";
      return prev;
    });
  }, [selectedChemical]);

  const currentRateOptions = useMemo(
    () => (selectedChemical && isDryChemical(selectedChemical.inventory_unit) ? DRY_RATE_OPTIONS : LIQUID_RATE_OPTIONS),
    [selectedChemical]
  );

  const hasTargetArea =
    targetMode === "valve" ? selectedValveIds.length > 0 : selectedGroupIds.length > 0;

  // Card is visible as soon as type + area are chosen so the operator sees what's next.
  const showCreateJobCard = applicationType !== "" && hasTargetArea;

  // Button is only enabled when chemical is also selected (required for the todo payload).
  const canCreateJob =
    showCreateJobCard &&
    chemicalId !== "" &&
    (applicationType === "drench" || selectedSprayer !== null);

  const createJobLabel =
    applicationType === "spray"
      ? "Create Spray Job"
      : applicationType === "drench"
        ? "Create Drench Job"
        : "Create Job";

  const jobCreatedMessage =
    applicationType === "spray"
      ? "Spray job created. Open Pest Log on mobile to view it."
      : "Drench job created. Open Pest Log on mobile to view it.";

  async function handleSaveTodo() {
    if (!canCreateJob) return;
    setTodoSaving(true);
    setTodoSavedMessage("");
    setError(null);

    const chemical_snapshot = selectedChemical
      ? {
          id: selectedChemical.id,
          name: selectedChemical.name,
          chemical_type: selectedChemical.chemical_type,
          phi: selectedChemical.phi,
          chemical_group: selectedChemical.chemical_group,
          rate_value: rateValue || null,
          rate_unit: rateUnit
        }
      : {};

    const target_snapshot =
      targetMode === "valve"
        ? {
            target_mode: "valve",
            valve_ids: selectedValveIds,
            valve_names: selectedValveNames,
            total_m2: totalM2,
            total_row_length_meters: totalRowLengthMeters
          }
        : {
            target_mode: "phase",
            group_ids: selectedGroupIds,
            group_names: selectedGroupNames,
            total_m2: totalM2,
            total_row_length_meters: totalRowLengthMeters
          };

    const sprayer_snapshot =
      selectedSprayer && applicationType === "spray"
        ? {
            id: selectedSprayer.id,
            name: selectedSprayer.name,
            nozzle_count: selectedSprayer.nozzle_count,
            nozzle_volume_l_per_min: selectedSprayer.nozzle_volume_l_per_min,
            nozzle_psi: selectedSprayer.nozzle_psi,
            speed_m_per_min: Number(spraySpeed) || null,
            nozzles_open: nozzlesOpenNum
          }
        : {};

    const tank_snapshot =
      applicationType === "spray" && effectiveTankVolume != null
        ? {
            name: effectiveTankName ?? "Tank",
            volume_liters: effectiveTankVolume,
            is_builtin: selectedSprayer?.has_tank ?? false
          }
        : {};

    const calc_base = chemicalNeededResult
      ? {
          total_chemical_ml: chemicalNeededResult.ml,
          total_chemical_l: chemicalNeededResult.L,
          rate_value: rateValue ? Number(rateValue) : null,
          rate_unit: rateUnit,
          area_label: chemicalNeededResult.areaLabel
        }
      : {};

    const calculation_snapshot =
      applicationType === "spray" && sprayCalc
        ? {
            ...calc_base,
            type: "spray",
            total_volume_l: sprayCalc.totalVolumeL,
            spray_time_minutes: sprayCalc.sprayTimeMinutes,
            spray_time_hours: sprayCalc.sprayTimeHours,
            total_flow_l_per_min: sprayCalc.totalFlowLPerMin,
            tank_volume_l: effectiveTankVolume,
            tank_count: tankCalc?.tankCount ?? null,
            chem_per_liter_ml: tankCalc?.chemPerLiterMl ?? null,
            chem_per_full_tank_ml: tankCalc?.chemPerFullTankMl ?? null,
            final_tank_volume_l: tankCalc?.finalTankVolumeL ?? null,
            chem_for_final_tank_ml: tankCalc?.chemForFinalTankMl ?? null,
            is_last_full: tankCalc?.isLastFull ?? null
          }
        : { ...calc_base, type: applicationType };

    try {
      const res = await apiFetch("/api/pest/todos", {
        method: "POST",
        body: JSON.stringify({
          type: applicationType,
          chemical_id: chemicalId || null,
          chemical_snapshot,
          target_snapshot,
          sprayer_snapshot,
          tank_snapshot,
          calculation_snapshot,
          instructions: instructions.trim() || null
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save plan");
      }
      setTodoSavedMessage(jobCreatedMessage);
      setInstructions("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save plan");
    } finally {
      setTodoSaving(false);
    }
  }

  async function viewChemicalLabel(id: string) {
    setLabelLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/pest/chemicals/${id}/label-url`);
      if (!res.ok) throw new Error("Failed to get label URL");
      const { url } = (await res.json()) as { url: string };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : "Failed to open label");
    } finally {
      setLabelLoading(false);
    }
  }

  if (loading) {
    return (
      <section className="page-shell">
        <header>
          <h1>Pest Control Planner</h1>
        </header>
        <p>Loading...</p>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Pest Control Planner</h1>
        <p>Plan spray runs using greenhouse area, sprayer specs, and chemical inventory.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      {/* ── 3-card top row ───────────────────────────────── */}
      <div className="pest-planner-card-grid">
        {/* ── 1. Target Area ──────────────────────────── */}
        <div className="coming-soon-card">
          <h2>1. Target Area</h2>

          {groups.length === 0 ? (
            <p>No greenhouse groups configured. Add groups in Greenhouse Setup.</p>
          ) : (
            <>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginTop: "0.75rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontSize: "0.9em"
                }}
              >
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                />
                All greenhouse groups
              </label>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.25rem",
                  paddingLeft: "0.25rem",
                  marginTop: "0.35rem",
                  maxHeight: "160px",
                  overflowY: "auto"
                }}
              >
                {groups.map((g) => (
                  <label
                    key={g.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      cursor: "pointer",
                      fontSize: "0.88em"
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedGroupIdsSet.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    />
                    {g.name}
                    <span style={{ fontSize: "0.82em", color: "var(--text-muted)" }}>
                      {g.type}
                    </span>
                  </label>
                ))}
              </div>

              {selectedGroupIds.length === 0 ? (
                <p style={{ marginTop: "0.65rem", fontSize: "0.85em" }}>
                  Select at least one group.
                </p>
              ) : (
                <>
                  <p style={{ marginTop: "0.6rem", fontSize: "0.82em" }}>
                    <strong>
                      {selectedGroupIds.length} group
                      {selectedGroupIds.length !== 1 ? "s" : ""} selected
                    </strong>
                    {selectedGroupNames.length <= 3
                      ? `: ${selectedGroupNames.join(", ")}`
                      : null}
                  </p>

                  {groupsWithNoDimensions.length > 0 ? (
                    <p
                      style={{
                        marginTop: "0.2rem",
                        fontSize: "0.78em",
                        color: "var(--text-muted)"
                      }}
                    >
                      No dimensions for{" "}
                      {groupsWithNoDimensions.map((g) => g.name).join(", ")}.
                    </p>
                  ) : null}

                  {totalM2 > 0 ? (
                    <div
                      className="greenhouse-group-stats"
                      style={{
                        marginTop: "0.65rem",
                        gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
                      }}
                    >
                      <div className="greenhouse-stat-item">
                        <span className="greenhouse-stat-label">m²</span>
                        <span className="greenhouse-stat-value">
                          {roundTo(totalM2, 2).toLocaleString()}
                        </span>
                      </div>
                      <div className="greenhouse-stat-item">
                        <span className="greenhouse-stat-label">ft²</span>
                        <span className="greenhouse-stat-value">
                          {roundTo(totalM2 * M2_TO_FT2, 1).toLocaleString()}
                        </span>
                      </div>
                      <div className="greenhouse-stat-item">
                        <span className="greenhouse-stat-label">ha</span>
                        <span className="greenhouse-stat-value">
                          {roundTo(totalM2 * M2_TO_HECTARES, 4)}
                        </span>
                      </div>
                      <div className="greenhouse-stat-item">
                        <span className="greenhouse-stat-label">acres</span>
                        <span className="greenhouse-stat-value">
                          {roundTo(totalM2 * M2_TO_ACRES, 4)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p style={{ marginTop: "0.5rem", fontSize: "0.82em" }}>
                      No row dimensions recorded. Add width and length in Greenhouse Setup.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* ── 2. Application Details ──────────────────── */}
        <div className="coming-soon-card">
          <h2>2. Application Details</h2>

          <div className="varieties-form" style={{ marginTop: "0.65rem", gridTemplateColumns: "1fr" }}>
            <label>
              Application type
              <select
                value={applicationType}
                onChange={(event) =>
                  setApplicationType(event.target.value as ApplicationType | "")
                }
              >
                <option value="">— Select —</option>
                <option value="drench">Drench</option>
                <option value="spray">Spray</option>
              </select>
            </label>

            {applicationType ? (
              <p
                style={{
                  fontSize: "0.8em",
                  color: "var(--text-muted)",
                  margin: "0.1rem 0 0"
                }}
              >
                {applicationType === "drench"
                  ? "Drench — calculate product by area only"
                  : "Spray — calculate product + water requirements"}
              </p>
            ) : null}

            <label style={{ marginTop: "0.75rem" }}>
              Chemical
              <select
                value={chemicalId}
                onChange={(event) => setChemicalId(event.target.value)}
              >
                <option value="">Select a chemical…</option>
                {availableChemicals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.chemical_type ? ` (${c.chemical_type})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ marginTop: "0.75rem" }}>
              Application rate
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={rateValue}
                  placeholder="e.g. 400"
                  onChange={(event) => setRateValue(event.target.value)}
                  style={{ flex: "1 1 80px", minWidth: 0 }}
                />
                <select
                  value={rateUnit}
                  onChange={(event) => setRateUnit(event.target.value as RateUnit)}
                  style={{ flex: "1 1 120px", minWidth: 0 }}
                >
                  {currentRateOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </div>

          {/* Result card or placeholder */}
          {chemicalNeededResult ? (
            <div
              style={{
                background: "var(--brand-soft)",
                border: "1px solid var(--brand)",
                borderRadius: "10px",
                padding: "0.9rem 1rem",
                marginTop: "0.85rem",
                textAlign: "center"
              }}
            >
              <p
                style={{
                  fontSize: "0.68rem",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--brand)",
                  margin: 0
                }}
              >
                Total Product Needed
              </p>
              <p
                style={{
                  fontSize: "1.75rem",
                  fontWeight: 800,
                  margin: "0.4rem 0 0",
                  lineHeight: 1.1,
                  color: "var(--text)"
                }}
              >
                {roundTo(chemicalNeededResult.ml, 0).toLocaleString()} {chemicalNeededResult.unit}
              </p>
              <p
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  margin: "0.2rem 0 0",
                  color: "var(--text)"
                }}
              >
                {roundTo(chemicalNeededResult.L, 3)} {chemicalNeededResult.unitLarge}
              </p>
              <p
                style={{
                  fontSize: "0.78rem",
                  marginTop: "0.45rem",
                  color: "var(--text-muted)"
                }}
              >
                Based on {chemicalNeededResult.areaLabel}
              </p>
            </div>
          ) : (
            <p
              style={{
                fontSize: "0.82em",
                color: "var(--text-muted)",
                marginTop: "0.65rem"
              }}
            >
              {!applicationType
                ? "Select application type, target area, and rate to calculate product needed."
                : totalM2 === 0
                ? "Add row dimensions in Greenhouse Setup to calculate product needed."
                : "Enter an application rate to calculate product needed."}
            </p>
          )}
        </div>

        {/* ── 3. Chemical Details ─────────────────────── */}
        <div className="coming-soon-card">
          <h2>3. Chemical Details</h2>

          {!selectedChemical ? (
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.5rem" }}>
              Select a chemical in Application Details to view label and inventory information.
            </p>
          ) : (
            <div
              className="greenhouse-group-stats"
              style={{
                marginTop: "0.75rem",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
              }}
            >
              {selectedChemical.chemical_type ? (
                <div className="greenhouse-stat-item">
                  <span className="greenhouse-stat-label">Type</span>
                  <span className="greenhouse-stat-value">
                    {selectedChemical.chemical_type.charAt(0).toUpperCase() +
                      selectedChemical.chemical_type.slice(1)}
                  </span>
                </div>
              ) : null}

              {selectedChemical.chemical_group ? (
                <div className="greenhouse-stat-item">
                  <span className="greenhouse-stat-label">Group</span>
                  <span className="greenhouse-stat-value">
                    {selectedChemical.chemical_group}
                  </span>
                </div>
              ) : null}

              {selectedChemical.rei ? (
                <div className="greenhouse-stat-item">
                  <span className="greenhouse-stat-label">REI</span>
                  <span className="greenhouse-stat-value">{selectedChemical.rei}</span>
                </div>
              ) : null}

              {selectedChemical.phi ? (
                <div className="greenhouse-stat-item">
                  <span className="greenhouse-stat-label">PHI</span>
                  <span className="greenhouse-stat-value">{selectedChemical.phi}</span>
                </div>
              ) : null}

              {selectedChemical.pest_target ? (
                <div className="greenhouse-stat-item" style={{ gridColumn: "1 / -1" }}>
                  <span className="greenhouse-stat-label">Target pest</span>
                  <span className="greenhouse-stat-value">{selectedChemical.pest_target}</span>
                </div>
              ) : null}

              {selectedChemical.active_ingredients ? (
                <div className="greenhouse-stat-item" style={{ gridColumn: "1 / -1" }}>
                  <span className="greenhouse-stat-label">Active ingredients</span>
                  <span className="greenhouse-stat-value">
                    {selectedChemical.active_ingredients}
                  </span>
                </div>
              ) : null}

              {selectedChemical.registration_number ? (
                <div className="greenhouse-stat-item">
                  <span className="greenhouse-stat-label">Reg. No.</span>
                  <span className="greenhouse-stat-value">
                    {selectedChemical.registration_number}
                  </span>
                </div>
              ) : null}

              <div className="greenhouse-stat-item">
                <span className="greenhouse-stat-label">In stock</span>
                <span className="greenhouse-stat-value">
                  {selectedChemical.inventory_qty} {selectedChemical.inventory_unit}
                </span>
              </div>

              {selectedChemical.notes ? (
                <div className="greenhouse-stat-item" style={{ gridColumn: "1 / -1" }}>
                  <span className="greenhouse-stat-label">Notes</span>
                  <span className="greenhouse-stat-value">{selectedChemical.notes}</span>
                </div>
              ) : null}

              {selectedChemical.label_pdf_path ? (
                <div className="greenhouse-stat-item" style={{ gridColumn: "1 / -1" }}>
                  <span className="greenhouse-stat-label">Label</span>
                  <span className="greenhouse-stat-value">
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: "0.78em", padding: "0.2rem 0.5rem" }}
                      disabled={labelLoading}
                      onClick={() => void viewChemicalLabel(selectedChemical.id)}
                    >
                      {labelLoading ? "Opening…" : "View PDF"}
                    </button>
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* ── Sprayer & Water Details (Spray only) ─────────── */}
      {applicationType === "spray" ? (
        <div className="coming-soon-card">
          <h2>Sprayer Details</h2>

          {sprayers.length === 0 ? (
            <p>No sprayers configured. Add sprayers in Pest Control Setup.</p>
          ) : (
            <>
              {/* Sprayer select + nozzles open — 1-column to prevent stretch */}
              <div
                className="varieties-form"
                style={{ gridTemplateColumns: "1fr" }}
              >
                <label>
                  Sprayer
                  <select
                    value={sprayerId}
                    onChange={(event) => handleSprayerChange(event.target.value)}
                  >
                    <option value="">Select a sprayer…</option>
                    {sprayers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Sprayer speed
                  <select
                    value={spraySpeed}
                    disabled={!selectedSprayer || speedOptions.length === 0}
                    onChange={(event) => setSpraySpeed(event.target.value)}
                  >
                    <option value="">
                      {!selectedSprayer
                        ? "Select a sprayer first"
                        : speedOptions.length === 0
                          ? "No speed range configured"
                          : "Select speed…"}
                    </option>
                    {speedOptions.map((v) => (
                      <option key={v} value={String(v)}>
                        {v} m/min
                      </option>
                    ))}
                  </select>
                </label>

                {selectedSprayer ? (
                  <label>
                    Nozzles open
                    <input
                      type="number"
                      min="1"
                      max={selectedSprayer.nozzle_count}
                      step="1"
                      value={nozzlesOpen}
                      onChange={(event) => setNozzlesOpen(event.target.value)}
                    />
                  </label>
                ) : null}
              </div>

              {selectedSprayer ? (
                <>
                  {/* Sprayer spec stats */}
                  <div
                    className="greenhouse-group-stats"
                    style={{
                      marginTop: "0.65rem",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
                    }}
                  >
                    <div className="greenhouse-stat-item">
                      <span className="greenhouse-stat-label">PSI</span>
                      <span className="greenhouse-stat-value">
                        {selectedSprayer.nozzle_psi}
                      </span>
                    </div>
                    <div className="greenhouse-stat-item">
                      <span className="greenhouse-stat-label">Nozzles (total)</span>
                      <span className="greenhouse-stat-value">
                        {selectedSprayer.nozzle_count}
                      </span>
                    </div>
                    <div className="greenhouse-stat-item">
                      <span className="greenhouse-stat-label">Flow/nozzle</span>
                      <span className="greenhouse-stat-value">
                        {selectedSprayer.nozzle_volume_l_per_min} L/min
                      </span>
                    </div>
                  </div>

                  {nozzlesOpenError ? (
                    <p className="form-error" style={{ marginTop: "0.5rem" }}>
                      {nozzlesOpenError}
                    </p>
                  ) : null}

                  {/* Spray run summary */}
                  <div
                    style={{
                      marginTop: "1rem",
                      borderTop: "1px solid var(--border)",
                      paddingTop: "0.85rem"
                    }}
                  >
                    <p
                      style={{
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--text-muted)",
                        margin: "0 0 0.6rem"
                      }}
                    >
                      Spray Run Estimate
                    </p>

                    {selectedGroupIds.length === 0 ? (
                      <p style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                        Select target area in step 1.
                      </p>
                    ) : totalRowLengthMeters === 0 ? (
                      <p style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                        Add row lengths in Greenhouse Setup to calculate spray time and
                        volume.
                      </p>
                    ) : sprayCalc ? (
                      <div
                        className="greenhouse-group-stats"
                        style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
                      >
                        <div className="greenhouse-stat-item">
                          <span className="greenhouse-stat-label">Total row length</span>
                          <span className="greenhouse-stat-value">
                            {roundTo(totalRowLengthMeters, 1).toLocaleString()} m
                          </span>
                        </div>
                        <div className="greenhouse-stat-item">
                          <span className="greenhouse-stat-label">Total flow rate</span>
                          <span className="greenhouse-stat-value">
                            {roundTo(sprayCalc.totalFlowLPerMin, 2)} L/min
                          </span>
                        </div>
                        <div className="greenhouse-stat-item">
                          <span className="greenhouse-stat-label">Spray time</span>
                          <span className="greenhouse-stat-value">
                            {roundTo(sprayCalc.sprayTimeMinutes, 1)} min
                          </span>
                        </div>
                        <div className="greenhouse-stat-item">
                          <span className="greenhouse-stat-label">Spray time (hrs)</span>
                          <span className="greenhouse-stat-value">
                            {roundTo(sprayCalc.sprayTimeHours, 2)} hr
                          </span>
                        </div>
                        <div
                          className="greenhouse-stat-item"
                          style={{ gridColumn: "1 / -1" }}
                        >
                          <span className="greenhouse-stat-label">
                            Total spray volume
                          </span>
                          <span
                            className="greenhouse-stat-value"
                            style={{ fontSize: "1.1rem", color: "var(--brand)" }}
                          >
                            {roundTo(sprayCalc.totalVolumeL, 1).toLocaleString()} L
                          </span>
                        </div>
                      </div>
                    ) : (
                      <p style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                        Select a sprayer and set nozzles open to calculate spray run.
                      </p>
                    )}
                  </div>

                  {/* Tank mix breakdown */}
                  {sprayCalc && (
                    <div
                      style={{
                        marginTop: "1rem",
                        borderTop: "1px solid var(--border)",
                        paddingTop: "0.85rem"
                      }}
                    >
                      <p
                        style={{
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          color: "var(--text-muted)",
                          margin: "0 0 0.5rem"
                        }}
                      >
                        Tank Mix
                      </p>

                      {effectiveTankVolume == null ? (
                        <p style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                          No tank configured for this sprayer. Add a built-in or separate tank in Pest Control Setup.
                        </p>
                      ) : (
                        <>
                          <p style={{ fontSize: "0.85em", marginBottom: "0.5rem" }}>
                            {effectiveTankName ?? "Tank"}: {effectiveTankVolume} L
                          </p>

                          {tankCalc ? (
                            <div
                              className="greenhouse-group-stats"
                              style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
                            >
                              <div className="greenhouse-stat-item">
                                <span className="greenhouse-stat-label">Tanks needed</span>
                                <span className="greenhouse-stat-value" style={{ fontSize: "1.1rem", color: "var(--brand)" }}>
                                  {tankCalc.tankCount}
                                </span>
                              </div>
                              <div className="greenhouse-stat-item">
                                <span className="greenhouse-stat-label">Chemical per L water</span>
                                <span className="greenhouse-stat-value">
                                  {roundTo(tankCalc.chemPerLiterMl, 3)} ml/L
                                </span>
                              </div>
                              <div className="greenhouse-stat-item" style={{ gridColumn: "1 / -1" }}>
                                <span className="greenhouse-stat-label">
                                  Full tank ({effectiveTankVolume} L water)
                                </span>
                                <span className="greenhouse-stat-value">
                                  {roundTo(tankCalc.chemPerFullTankMl, 1)} ml chemical
                                </span>
                              </div>
                              {!tankCalc.isLastFull && (
                                <div className="greenhouse-stat-item" style={{ gridColumn: "1 / -1" }}>
                                  <span className="greenhouse-stat-label">
                                    Final tank ({roundTo(tankCalc.finalTankVolumeL, 1)} L water)
                                  </span>
                                  <span className="greenhouse-stat-value">
                                    {roundTo(tankCalc.chemForFinalTankMl, 1)} ml chemical
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p style={{ fontSize: "0.85em", color: "var(--text-muted)" }}>
                              Enter chemical rate in Application Details to calculate mix.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <p
                    style={{
                      fontSize: "0.78em",
                      color: "var(--text-muted)",
                      marginTop: "0.6rem"
                    }}
                  >
                    Estimates assume the sprayer travels every row at constant speed.
                    Confirm actual volume requirements before filling tanks.
                  </p>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* ── Create Job ───────────────────────────────────── */}
      {showCreateJobCard ? (
        <div className="coming-soon-card" style={{ marginTop: "1rem" }}>
          <h2>{createJobLabel}</h2>
          <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.2rem" }}>
            Sends the full plan to the mobile Pest Log so the operator can see exactly what to mix.
          </p>

          {!chemicalId ? (
            <p style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "0.65rem" }}>
              Select a chemical in Application Details before creating a job.
            </p>
          ) : (
            <div className="varieties-form" style={{ marginTop: "0.75rem", gridTemplateColumns: "1fr" }}>
              <label>
                Instructions for operator (optional)
                <textarea
                  rows={3}
                  value={instructions}
                  placeholder="e.g. Start from north end of Phase 1. Wear full PPE."
                  onChange={(e) => setInstructions(e.target.value)}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </label>
            </div>
          )}

          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="primary-action-button"
              disabled={!canCreateJob || todoSaving}
              onClick={() => void handleSaveTodo()}
            >
              {todoSaving ? "Saving…" : createJobLabel}
            </button>
            {todoSavedMessage ? (
              <p style={{ fontSize: "0.85em", color: "var(--brand)", margin: 0 }}>
                {todoSavedMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Safety note ─────────────────────────────────── */}
      <div className="coming-soon-card">
        <p>Always confirm label rates and legal requirements before spraying.</p>
      </div>
    </section>
  );
}
