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

  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [sprayerId, setSprayerId] = useState("");
  const [nozzlesOpen, setNozzlesOpen] = useState("");
  const [plannedWaterL, setPlannedWaterL] = useState("");
  const [chemicalId, setChemicalId] = useState("");
  const [labelLoading, setLabelLoading] = useState(false);

  const selectAllRef = useRef<HTMLInputElement>(null);

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
  const someSelected = selectedGroupIds.length > 0 && selectedGroupIds.length < groups.length;

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

      {/* ── 1. Target Area ──────────────────────────────── */}
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
                marginBottom: "0.5rem",
                fontWeight: 600,
                cursor: "pointer"
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
                gap: "0.3rem",
                paddingLeft: "0.25rem"
              }}
            >
              {groups.map((g) => (
                <label
                  key={g.id}
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={selectedGroupIdsSet.has(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  {g.name}
                  <span style={{ fontSize: "0.82em", color: "var(--color-text-muted, #888)" }}>
                    {g.type}
                  </span>
                </label>
              ))}
            </div>

            {selectedGroupIds.length === 0 ? (
              <p style={{ marginTop: "0.75rem" }}>Select at least one greenhouse group.</p>
            ) : (
              <>
                <p style={{ marginTop: "0.75rem", fontSize: "0.9em" }}>
                  <strong>
                    {selectedGroupIds.length} group
                    {selectedGroupIds.length !== 1 ? "s" : ""} selected
                  </strong>
                  {selectedGroupNames.length <= 4
                    ? `: ${selectedGroupNames.join(", ")}`
                    : null}
                </p>

                {groupsWithNoDimensions.length > 0 ? (
                  <p
                    style={{
                      marginTop: "0.25rem",
                      fontSize: "0.85em",
                      color: "var(--color-text-muted, #888)"
                    }}
                  >
                    No row dimensions for{" "}
                    {groupsWithNoDimensions.map((g) => g.name).join(", ")} — excluded from
                    area total.
                  </p>
                ) : null}

                {totalM2 > 0 ? (
                  <div className="greenhouse-group-stats" style={{ marginTop: "0.75rem" }}>
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
                  <p style={{ marginTop: "0.5rem" }}>
                    No row dimensions recorded for the selected groups. Add width and length
                    to rows in Greenhouse Setup to enable area-based calculations.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* ── 2. Sprayer ──────────────────────────────────── */}
      <div className="coming-soon-card">
        <h2>2. Sprayer</h2>

        {sprayers.length === 0 ? (
          <p>No sprayers configured. Add sprayers in Pest Control Setup.</p>
        ) : (
          <div className="varieties-form">
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
              <>
                <div className="greenhouse-group-stats" style={{ marginTop: "0.5rem" }}>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Nozzles</span>
                    <span className="greenhouse-stat-value">
                      {selectedSprayer.nozzle_count}
                    </span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">L/min/nozzle</span>
                    <span className="greenhouse-stat-value">
                      {selectedSprayer.nozzle_volume_l_per_min}
                    </span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">PSI</span>
                    <span className="greenhouse-stat-value">{selectedSprayer.nozzle_psi}</span>
                  </div>
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Speed (m/min)</span>
                    <span className="greenhouse-stat-value">
                      {selectedSprayer.speed_m_per_min}
                    </span>
                  </div>
                </div>

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

                {nozzlesOpenError ? (
                  <p className="form-error">{nozzlesOpenError}</p>
                ) : null}

                {flowLPerMin !== null && !nozzlesOpenError ? (
                  <div className="greenhouse-group-stats" style={{ marginTop: "0.5rem" }}>
                    <div className="greenhouse-stat-item">
                      <span className="greenhouse-stat-label">Flow rate</span>
                      <span className="greenhouse-stat-value">
                        {roundTo(flowLPerMin, 2)} L/min
                      </span>
                    </div>
                  </div>
                ) : null}

                <label>
                  Planned water volume (L)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={plannedWaterL}
                    onChange={(event) => setPlannedWaterL(event.target.value)}
                    placeholder="e.g. 500"
                  />
                </label>

                <p style={{ fontSize: "0.85em", color: "var(--color-text-muted, #666)" }}>
                  Spray width / boom width is required for exact L/ha. Add boom width to
                  sprayer setup or enter target water volume manually.
                </p>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* ── 3. Chemical ─────────────────────────────────── */}
      <div className="coming-soon-card">
        <h2>3. Chemical</h2>

        {availableChemicals.length === 0 ? (
          <p>
            No chemicals available. Add active chemicals with inventory in Pest Control
            Inventory.
          </p>
        ) : (
          <div className="varieties-form">
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
                    {c.chemical_type ? ` (${c.chemical_type})` : ""} —{" "}
                    {c.inventory_qty} {c.inventory_unit} in stock
                  </option>
                ))}
              </select>
            </label>

            {selectedChemical ? (
              <div className="greenhouse-group-stats" style={{ marginTop: "0.5rem" }}>
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
                  <div className="greenhouse-stat-item">
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

                {selectedChemical.pest_target ? (
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Target</span>
                    <span className="greenhouse-stat-value">
                      {selectedChemical.pest_target}
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
                  <div className="greenhouse-stat-item">
                    <span className="greenhouse-stat-label">Label</span>
                    <span className="greenhouse-stat-value">
                      <button
                        type="button"
                        className="secondary"
                        style={{ fontSize: "0.8em", padding: "0.2rem 0.5rem" }}
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
          </div>
        )}
      </div>

      {/* ── Safety note ─────────────────────────────────── */}
      <div className="coming-soon-card">
        <p>Always confirm label rates and legal requirements before spraying.</p>
      </div>
    </section>
  );
}
