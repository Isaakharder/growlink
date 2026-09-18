import { useEffect, useMemo, useState } from "react";
import { listInventoryItems, listSetupResource } from "./api";
import { formatQuantity, inventoryUnitLabel, stockStatusClassSuffix, stockStatusLabel } from "./formatters";
import { InventoryItemSheet } from "./InventoryItemSheet";
import { InventoryItemRow, SetupRecord } from "./types";
import { usePermissions } from "../../hooks/usePermissions";

const MAINTENANCE_ACT_PERMISSIONS = ["mobile:maintenance", "maintenance:edit"];

type LoadState = { status: "loading" } | { status: "loaded"; items: InventoryItemRow[] } | { status: "error"; message: string };

type StockFilter = "all" | "low_stock" | "out_of_stock";

export function InventoryTab() {
  const { canAny } = usePermissions();
  const canAct = canAny(MAINTENANCE_ACT_PERMISSIONS);

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [locations, setLocations] = useState<SetupRecord[]>([]);
  const [partTypes, setPartTypes] = useState<SetupRecord[]>([]);
  const [search, setSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [partTypeId, setPartTypeId] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [selectedItem, setSelectedItem] = useState<InventoryItemRow | null>(null);

  async function load() {
    setState({ status: "loading" });
    try {
      const items = await listInventoryItems({
        search: search.trim() || undefined,
        location_id: locationId || undefined,
        part_type_id: partTypeId || undefined,
        active: "true"
      });
      setState({ status: "loaded", items });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load inventory." });
    }
  }

  useEffect(() => {
    const timeout = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, locationId, partTypeId]);

  useEffect(() => {
    void listSetupResource("locations", undefined, "true").then(setLocations).catch(() => setLocations([]));
    void listSetupResource("part-types", undefined, "true").then(setPartTypes).catch(() => setPartTypes([]));
  }, []);

  const items = state.status === "loaded" ? state.items : [];
  const lowStockCount = useMemo(() => items.filter((i) => i.stock_status === "low_stock").length, [items]);
  const outOfStockCount = useMemo(() => items.filter((i) => i.stock_status === "out_of_stock").length, [items]);
  const visibleItems = useMemo(() => {
    if (stockFilter === "all") return items;
    return items.filter((i) => i.stock_status === stockFilter);
  }, [items, stockFilter]);

  return (
    <div className="maintenance-tab-panel">
      <div className="maintenance-toolbar">
        <input
          type="search"
          className="maintenance-search-input"
          placeholder="Search name or part number"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="maintenance-filter-row">
        <select value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-label="Filter by location">
          <option value="">All Locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <select value={partTypeId} onChange={(event) => setPartTypeId(event.target.value)} aria-label="Filter by part type">
          <option value="">All Part Types</option>
          {partTypes.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="maintenance-chip-row" role="group" aria-label="Filter by stock state">
        <button type="button" className={`maintenance-chip ${stockFilter === "all" ? "active" : ""}`} onClick={() => setStockFilter("all")}>
          All ({items.length})
        </button>
        <button type="button" className={`maintenance-chip maintenance-chip-due-soon ${stockFilter === "low_stock" ? "active" : ""}`} onClick={() => setStockFilter("low_stock")}>
          Low Stock ({lowStockCount})
        </button>
        <button type="button" className={`maintenance-chip maintenance-chip-overdue ${stockFilter === "out_of_stock" ? "active" : ""}`} onClick={() => setStockFilter("out_of_stock")}>
          Out of Stock ({outOfStockCount})
        </button>
      </div>

      {state.status === "loading" ? <p>Loading inventory…</p> : null}

      {state.status === "error" ? (
        <div className="maintenance-card">
          <p className="form-error">{state.message}</p>
          <button type="button" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {state.status === "loaded" && visibleItems.length === 0 ? (
        <div className="maintenance-empty-state">
          <p>{items.length === 0 ? "No inventory parts found yet." : "No parts match this filter."}</p>
        </div>
      ) : null}

      {visibleItems.length > 0 ? (
        <div className="maintenance-card-list">
          {visibleItems.map((item) => (
            <button key={item.id} type="button" className="maintenance-card maintenance-equipment-card" onClick={() => setSelectedItem(item)}>
              <div className="maintenance-card-top-row">
                <span className="maintenance-card-title">{item.name}</span>
                <span className={`maintenance-status-badge ${stockStatusClassSuffix(item.stock_status)}`}>
                  {stockStatusLabel(item.stock_status)}
                </span>
              </div>
              <div className="maintenance-card-meta-row">
                {item.part_number ? <span>{item.part_number}</span> : null}
                {item.part_type ? <span>{item.part_type.name}</span> : null}
                {item.location ? <span>{item.location.name}</span> : null}
              </div>
              <div className="maintenance-card-meta-row">
                <span>{formatQuantity(item.quantity_on_hand)} {inventoryUnitLabel(item)} on hand</span>
                {item.minimum_quantity !== null ? <span>Reorder at {formatQuantity(item.minimum_quantity)}</span> : null}
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {selectedItem ? (
        <InventoryItemSheet
          item={selectedItem}
          canAct={canAct}
          onClose={() => setSelectedItem(null)}
          onChanged={(updated) => {
            setSelectedItem(updated);
            setState((current) => (current.status === "loaded" ? { status: "loaded", items: current.items.map((i) => (i.id === updated.id ? updated : i)) } : current));
          }}
        />
      ) : null}
    </div>
  );
}
