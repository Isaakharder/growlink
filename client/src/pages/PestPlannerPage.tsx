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

type Sprayer = {
  id: string;
  name: string;
  nozzle_count: number;
  nozzle_volume_l_per_min: number;
  nozzle_psi: number;
  speed_m_per_min: number;
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
  phi: string | null;
  chemical_group: string | null;
  chemical_type: ChemicalType | null;
  active_ingredients: string | null;
  registration_number: string | null;
  label_pdf_path: string | null;
};

type ApplicationType = "drench" | "spray";
type RateUnit = "ml_per_acre" | "L_per_acre" | "ml_per_hectare" | "L_per_hectare";

const RATE_UNIT_OPTIONS: { value: RateUnit; label: string }[] = [
  { value: "ml_per_acre", label: "ml / acre" },
  { value: "L_per_acre", label: "L / acre" },
  { value: "ml_per_hectare", label: "ml / hectare" },
  { value: "L_per_hectare", label: "L / hectare" }
];

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
  const [chemicals, setChemicals] = useState<Chemical[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Target area selection
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // ── Application details
  const [applicationType, setApplicationType] = useState<ApplicationType | "">("");
  const [rateValue, setRateValue] = useState("");
  const [rateUnit, setRateUnit] = useState<RateUnit>("ml_per_acre");

  // ── Sprayer
  const [sprayerId, setSprayerId] = useState("");
  const [nozzlesOpen, setNozzlesOpen] = useState("");

  // ── Chemical
  const [chemicalId, setChemicalId] = useState("");
  const [labelLoading, setLabelLoading] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [setupRes, sprayersRes, chemicalsRes] = await Promise.all([
          apiFetch("/api/greenhouse-setup"),
          apiFetch("/api/pest/sprayers"),
          apiFetch("/api/pest/chemicals")
        ]);

        if (!setupRes.ok || !sprayersRes.ok || !chemicalsRes.ok) {
          throw new Error("Failed to load planner data");
        }

        const setupData = (await setupRes.json()) as {
          groups: SetupGroup[];
          rows: SetupRow[];
        };
        const sprayersData = (await sprayersRes.json()) as Sprayer[];
        const chemicalsData = (await chemicalsRes.json()) as Chemical[];

        setGroups(setupData.groups ?? []);
        setRows(setupData.rows ?? []);
        setSprayers(sprayersData);
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

  const areaByGroupId = useMemo(() => {
    const result: Record<string, number> = {};
    for (const id of selectedGroupIds) {
      const groupRows = rowsByGroupId[id] ?? [];
      result[id] = groupRows.reduce((sum, r) => sum + rowAreaM2(r), 0);
    }
    return result;
  }, [selectedGroupIds, rowsByGroupId]);

  const totalM2 = useMemo(
    () => Object.values(areaByGroupId).reduce((sum, a) => sum + a, 0),
    [areaByGroupId]
  );

  // Sum of length_meters across every row in every selected group.
  // This is the actual linear distance the sprayer travels.
  const totalRowLengthMeters = useMemo(() => {
    let total = 0;
    for (const id of selectedGroupIds) {
      for (const row of rowsByGroupId[id] ?? []) {
        total += row.length_meters ?? 0;
      }
    }
    return total;
  }, [selectedGroupIds, rowsByGroupId]);

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

  // ── Application rate calculation ───────────────────────────────────────────

  const chemicalNeededResult = useMemo(() => {
    const rate = Number(rateValue);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    if (totalM2 <= 0) return null;

    const acres = totalM2 * M2_TO_ACRES;
    const ha = totalM2 * M2_TO_HECTARES;

    let ml: number;
    let areaLabel: string;

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
    }

    return { ml, L: ml / 1000, areaLabel };
  }, [rateValue, rateUnit, totalM2]);

  // ── Sprayer derivations ────────────────────────────────────────────────────

  const selectedSprayer = useMemo(
    () => sprayers.find((s) => s.id === sprayerId) ?? null,
    [sprayers, sprayerId]
  );

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

    const speed = selectedSprayer.speed_m_per_min;           // m/min
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
  }, [selectedSprayer, nozzlesOpenNum, nozzlesOpenError, totalRowLengthMeters]);

  function handleSprayerChange(id: string) {
    setSprayerId(id);
    const s = sprayers.find((sp) => sp.id === id);
    setNozzlesOpen(s ? String(s.nozzle_count) : "");
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

            <label style={{ marginTop: applicationType ? "0.75rem" : undefined }}>
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
                  {RATE_UNIT_OPTIONS.map((opt) => (
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
                {roundTo(chemicalNeededResult.ml, 0).toLocaleString()} ml
              </p>
              <p
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  margin: "0.2rem 0 0",
                  color: "var(--text)"
                }}
              >
                {roundTo(chemicalNeededResult.L, 3)} L
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

        {/* ── 3. Chemical ─────────────────────────────── */}
        <div className="coming-soon-card">
          <h2>3. Chemical</h2>

          {availableChemicals.length === 0 ? (
            <p style={{ fontSize: "0.88em" }}>
              No chemicals available. Add active chemicals with inventory in Pest Control
              Inventory.
            </p>
          ) : (
            <>
              {/* Select sits in its own 1-column form so it never stretches to match details height */}
              <div
                className="varieties-form"
                style={{ marginTop: "0.65rem", gridTemplateColumns: "1fr" }}
              >
                <label>
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
              </div>

              {/* Details rendered outside the form so they never share a grid row with the select */}
              {selectedChemical ? (
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

                  {selectedChemical.phi ? (
                    <div className="greenhouse-stat-item">
                      <span className="greenhouse-stat-label">PHI</span>
                      <span className="greenhouse-stat-value">{selectedChemical.phi}</span>
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
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* ── Sprayer & Water Details (Spray only) ─────────── */}
      {applicationType === "spray" ? (
        <div className="coming-soon-card">
          <h2>Sprayer &amp; Water Details</h2>

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
                      <span className="greenhouse-stat-label">Speed</span>
                      <span className="greenhouse-stat-value">
                        {selectedSprayer.speed_m_per_min} m/min
                      </span>
                    </div>
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

      {/* ── Safety note ─────────────────────────────────── */}
      <div className="coming-soon-card">
        <p>Always confirm label rates and legal requirements before spraying.</p>
      </div>
    </section>
  );
}
