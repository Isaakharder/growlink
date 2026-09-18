import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listEquipment, listSetupResource } from "./api";
import { QrScannerSheet } from "./QrScannerSheet";
import { EquipmentRow, SetupRecord } from "./types";
import { dueStatusClassSuffix, dueStatusLabel, equipmentMeterUnit, equipmentStatusLabel } from "./formatters";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; equipment: EquipmentRow[] }
  | { status: "error"; message: string };

type DueFilter = "all" | "overdue" | "due_soon";

export function EquipmentTab() {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [categories, setCategories] = useState<SetupRecord[]>([]);
  const [locations, setLocations] = useState<SetupRecord[]>([]);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [scannerOpen, setScannerOpen] = useState(false);

  async function load() {
    setState({ status: "loading" });
    try {
      const equipment = await listEquipment({
        search: search.trim() || undefined,
        category_id: categoryId || undefined,
        location_id: locationId || undefined,
        status: statusFilter || undefined
      });
      setState({ status: "loaded", equipment });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load equipment." });
    }
  }

  useEffect(() => {
    const timeout = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryId, locationId, statusFilter]);

  useEffect(() => {
    void listSetupResource("categories", undefined, "true").then(setCategories).catch(() => setCategories([]));
    void listSetupResource("locations", undefined, "true").then(setLocations).catch(() => setLocations([]));
  }, []);

  const equipment = state.status === "loaded" ? state.equipment : [];
  const overdueCount = useMemo(() => equipment.filter((e) => e.due_status === "overdue").length, [equipment]);
  const dueSoonCount = useMemo(() => equipment.filter((e) => e.due_status === "due_soon").length, [equipment]);
  const visibleEquipment = useMemo(() => {
    if (dueFilter === "all") return equipment;
    return equipment.filter((e) => e.due_status === dueFilter);
  }, [equipment, dueFilter]);

  return (
    <div className="maintenance-tab-panel">
      <div className="maintenance-toolbar">
        <input
          type="search"
          className="maintenance-search-input"
          placeholder="Search name or asset code"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button type="button" className="maintenance-scan-button" onClick={() => setScannerOpen(true)}>
          Scan QR
        </button>
      </div>

      <div className="maintenance-filter-row">
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="Filter by category">
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-label="Filter by location">
          <option value="">All Locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status">
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="out_of_service">Out of Service</option>
          <option value="retired">Retired</option>
        </select>
      </div>

      <div className="maintenance-chip-row" role="group" aria-label="Filter by due status">
        <button type="button" className={`maintenance-chip ${dueFilter === "all" ? "active" : ""}`} onClick={() => setDueFilter("all")}>
          All ({equipment.length})
        </button>
        <button type="button" className={`maintenance-chip maintenance-chip-overdue ${dueFilter === "overdue" ? "active" : ""}`} onClick={() => setDueFilter("overdue")}>
          Overdue ({overdueCount})
        </button>
        <button type="button" className={`maintenance-chip maintenance-chip-due-soon ${dueFilter === "due_soon" ? "active" : ""}`} onClick={() => setDueFilter("due_soon")}>
          Due Soon ({dueSoonCount})
        </button>
      </div>

      {state.status === "loading" ? <p>Loading equipment…</p> : null}

      {state.status === "error" ? (
        <div className="maintenance-card">
          <p className="form-error">{state.message}</p>
          <button type="button" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {state.status === "loaded" && visibleEquipment.length === 0 ? (
        <div className="maintenance-empty-state">
          <p>{equipment.length === 0 ? "No equipment found yet." : "No equipment matches this filter."}</p>
        </div>
      ) : null}

      {visibleEquipment.length > 0 ? (
        <div className="maintenance-card-list">
          {visibleEquipment.map((item) => (
            <button
              key={item.id}
              type="button"
              className="maintenance-card maintenance-equipment-card"
              onClick={() => navigate(`/mobile/maintenance/equipment/${item.id}`)}
            >
              <div className="maintenance-card-top-row">
                <span className="maintenance-card-title">{item.name}</span>
                <span className={`maintenance-status-badge ${dueStatusClassSuffix(item.due_status)}`}>
                  {dueStatusLabel(item.due_status)}
                </span>
              </div>
              <div className="maintenance-card-meta-row">
                <span>{item.asset_code}</span>
                {item.category ? <span>{item.category.name}</span> : null}
                {item.location ? <span>{item.location.name}</span> : null}
              </div>
              <div className="maintenance-card-meta-row">
                <span>{equipmentStatusLabel(item.status)}</span>
                <span>
                  {item.current_meter_reading !== null
                    ? `${item.current_meter_reading} ${equipmentMeterUnit(item)}`
                    : "No reading yet"}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {scannerOpen ? (
        <QrScannerSheet
          onClose={() => setScannerOpen(false)}
          onMatch={(matched) => {
            setScannerOpen(false);
            navigate(`/mobile/maintenance/equipment/${matched.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
