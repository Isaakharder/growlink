import { useEffect, useState } from "react";
import {
  getInventoryByLocationReport, getLowStockReport, getOutOfStockReport, getRecentAdjustments, getRecentReceipts,
  listRestockRequests, listStockCountSessions
} from "./api";
import { formatDateTime, formatQuantity, inventoryUnitLabel, stockStatusClassSuffix, stockStatusLabel } from "./formatters";
import { RestockRequestDetailSheet } from "./RestockRequestDetailSheet";
import { RestockRequestSheet } from "./RestockRequestSheet";
import { StartStockCountSheet } from "./StartStockCountSheet";
import { StockCountSessionSheet } from "./StockCountSessionSheet";
import { InventoryItemRow, InventoryTransactionRow, RestockRequestRow, StockCountSessionRow } from "./types";
import { usePermissions } from "../../hooks/usePermissions";

const MAINTENANCE_ACT_PERMISSIONS = ["mobile:maintenance", "maintenance:edit"];

type ReportSection = "low_stock" | "out_of_stock" | "by_location" | "receipts" | "adjustments" | null;

const RESTOCK_STATUS_LABEL: Record<string, string> = {
  requested: "Requested", ordered: "Ordered", partially_received: "Partially Received", received: "Received", cancelled: "Cancelled"
};

const STOCK_COUNT_STATUS_LABEL: Record<string, string> = { draft: "In Progress", confirmed: "Confirmed", cancelled: "Cancelled" };

function InventoryReportRow({ item }: { item: InventoryItemRow }) {
  return (
    <div className="maintenance-history-row">
      <span>{item.name}{item.part_number ? ` (${item.part_number})` : ""}</span>
      <span>{item.location?.name ?? "--"}</span>
      <span>
        {formatQuantity(item.quantity_on_hand)} {inventoryUnitLabel(item)}
      </span>
      <span className={`maintenance-status-badge ${stockStatusClassSuffix(item.stock_status)}`}>{stockStatusLabel(item.stock_status)}</span>
    </div>
  );
}

function TransactionReportRow({ tx }: { tx: InventoryTransactionRow }) {
  return (
    <div className="maintenance-history-row">
      <span>{tx.item?.name ?? tx.item_name_snapshot}</span>
      <span>{tx.transaction_type.replace(/_/g, " ")}</span>
      <span>{tx.quantity_change > 0 ? "+" : ""}{formatQuantity(tx.quantity_change)} {tx.unit_snapshot}</span>
      <span>{formatDateTime(tx.created_at)}</span>
    </div>
  );
}

export function ReportsTab() {
  const { canAny } = usePermissions();
  const canAct = canAny(MAINTENANCE_ACT_PERMISSIONS);

  const [openSection, setOpenSection] = useState<ReportSection>(null);
  const [sectionData, setSectionData] = useState<InventoryItemRow[] | InventoryTransactionRow[] | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);

  const [restockRequests, setRestockRequests] = useState<RestockRequestRow[] | null>(null);
  const [restockError, setRestockError] = useState<string | null>(null);
  const [creatingRestock, setCreatingRestock] = useState(false);
  const [openRestockId, setOpenRestockId] = useState<string | null>(null);

  const [stockCounts, setStockCounts] = useState<StockCountSessionRow[] | null>(null);
  const [stockCountError, setStockCountError] = useState<string | null>(null);
  const [startingCount, setStartingCount] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  async function loadRestock() {
    setRestockError(null);
    try {
      setRestockRequests(await listRestockRequests({ limit: 25 }));
    } catch (err) {
      setRestockError(err instanceof Error ? err.message : "Failed to load restock requests.");
    }
  }

  async function loadStockCounts() {
    setStockCountError(null);
    try {
      setStockCounts(await listStockCountSessions({ limit: 25 }));
    } catch (err) {
      setStockCountError(err instanceof Error ? err.message : "Failed to load stock counts.");
    }
  }

  useEffect(() => {
    void loadRestock();
    void loadStockCounts();
  }, []);

  async function toggleSection(section: Exclude<ReportSection, null>) {
    if (openSection === section) {
      setOpenSection(null);
      return;
    }
    setOpenSection(section);
    setSectionData(null);
    setSectionError(null);
    try {
      const loaders: Record<Exclude<ReportSection, null>, () => Promise<InventoryItemRow[] | InventoryTransactionRow[]>> = {
        low_stock: getLowStockReport,
        out_of_stock: getOutOfStockReport,
        by_location: getInventoryByLocationReport,
        receipts: getRecentReceipts,
        adjustments: getRecentAdjustments
      };
      setSectionData(await loaders[section]());
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : "Failed to load report.");
    }
  }

  const draftCount = stockCounts?.filter((s) => s.status === "draft").length ?? 0;

  return (
    <div className="maintenance-tab-panel">
      <div className="maintenance-card">
        <h3>Inventory Reports</h3>
        {(
          [
            ["low_stock", "Low Stock"],
            ["out_of_stock", "Out of Stock"],
            ["by_location", "Inventory by Location"],
            ["receipts", "Recent Receipts"],
            ["adjustments", "Recent Adjustments"]
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <button type="button" className="maintenance-link-button" onClick={() => void toggleSection(key)}>
              {openSection === key ? "▾" : "▸"} {label}
            </button>
            {openSection === key ? (
              <div className="maintenance-history-list">
                {sectionError ? <p className="form-error">{sectionError}</p> : null}
                {sectionData === null && !sectionError ? <p>Loading…</p> : null}
                {sectionData && sectionData.length === 0 ? <p>Nothing to show.</p> : null}
                {sectionData && (key === "low_stock" || key === "out_of_stock" || key === "by_location")
                  ? (sectionData as InventoryItemRow[]).map((item) => <InventoryReportRow key={item.id} item={item} />)
                  : null}
                {sectionData && (key === "receipts" || key === "adjustments")
                  ? (sectionData as InventoryTransactionRow[]).map((tx) => <TransactionReportRow key={tx.id} tx={tx} />)
                  : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="maintenance-card">
        <div className="maintenance-card-top-row">
          <h3>Restock Requests</h3>
          {canAct ? (
            <button type="button" onClick={() => setCreatingRestock(true)}>
              + New
            </button>
          ) : null}
        </div>
        {restockError ? <p className="form-error">{restockError}</p> : null}
        {restockRequests === null && !restockError ? <p>Loading…</p> : null}
        {restockRequests && restockRequests.length === 0 ? <p>No restock requests yet.</p> : null}
        <div className="maintenance-card-list">
          {restockRequests?.map((request) => (
            <button key={request.id} type="button" className="maintenance-card maintenance-equipment-card" onClick={() => setOpenRestockId(request.id)}>
              <div className="maintenance-card-top-row">
                <span className="maintenance-card-title">{RESTOCK_STATUS_LABEL[request.status] ?? request.status}</span>
                <span>{formatDateTime(request.created_at)}</span>
              </div>
              <div className="maintenance-card-meta-row">
                <span>Requested by {request.requested_by_name_snapshot}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="maintenance-card">
        <div className="maintenance-card-top-row">
          <h3>Stock Counts</h3>
          {canAct ? (
            <button type="button" onClick={() => setStartingCount(true)}>
              + Start Count
            </button>
          ) : null}
        </div>
        {draftCount > 0 ? <p>{draftCount} count{draftCount === 1 ? "" : "s"} in progress — tap to resume.</p> : null}
        {stockCountError ? <p className="form-error">{stockCountError}</p> : null}
        {stockCounts === null && !stockCountError ? <p>Loading…</p> : null}
        {stockCounts && stockCounts.length === 0 ? <p>No stock counts yet.</p> : null}
        <div className="maintenance-card-list">
          {stockCounts?.map((session) => (
            <button key={session.id} type="button" className="maintenance-card maintenance-equipment-card" onClick={() => setOpenSessionId(session.id)}>
              <div className="maintenance-card-top-row">
                <span className="maintenance-card-title">{session.location_name_snapshot}</span>
                <span>{STOCK_COUNT_STATUS_LABEL[session.status] ?? session.status}</span>
              </div>
              <div className="maintenance-card-meta-row">
                <span>Started {formatDateTime(session.started_at)} by {session.started_by_name_snapshot}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {creatingRestock ? (
        <RestockRequestSheet
          onClose={() => setCreatingRestock(false)}
          onCreated={(request) => {
            setCreatingRestock(false);
            void loadRestock();
            setOpenRestockId(request.id);
          }}
        />
      ) : null}

      {openRestockId ? (
        <RestockRequestDetailSheet
          requestId={openRestockId}
          canAct={canAct}
          onClose={() => setOpenRestockId(null)}
          onChanged={() => void loadRestock()}
        />
      ) : null}

      {startingCount ? (
        <StartStockCountSheet
          onClose={() => setStartingCount(false)}
          onStarted={(session) => {
            setStartingCount(false);
            void loadStockCounts();
            setOpenSessionId(session.id);
          }}
        />
      ) : null}

      {openSessionId ? (
        <StockCountSessionSheet
          sessionId={openSessionId}
          onClose={() => setOpenSessionId(null)}
          onChanged={() => void loadStockCounts()}
        />
      ) : null}
    </div>
  );
}
