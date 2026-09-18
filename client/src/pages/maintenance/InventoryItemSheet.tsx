import { useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { listInventoryTransactions } from "./api";
import { formatDateTime, formatQuantity, inventoryUnitLabel, stockStatusClassSuffix, stockStatusLabel } from "./formatters";
import { AdjustStockSheet } from "./AdjustStockSheet";
import { ReceiveStockSheet } from "./ReceiveStockSheet";
import { InventoryItemRow, InventoryTransactionRow } from "./types";

type Props = {
  item: InventoryItemRow;
  canAct: boolean;
  onClose: () => void;
  onChanged: (updated: InventoryItemRow) => void;
};

export function InventoryItemSheet({ item, canAct, onClose, onChanged }: Props) {
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<InventoryTransactionRow[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) {
      setHistoryError(null);
      try {
        setHistory(await listInventoryTransactions({ item_id: item.id, limit: 50 }));
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : "Failed to load transaction history.");
      }
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="inventory-item-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="inventory-item-title">{item.name}</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        <div className="maintenance-card-top-row">
          <span className={`maintenance-status-badge ${stockStatusClassSuffix(item.stock_status)}`}>
            {stockStatusLabel(item.stock_status)}
          </span>
        </div>

        <div className="maintenance-detail-grid">
          <div><span>Part Number</span><strong>{item.part_number ?? "--"}</strong></div>
          <div><span>Part Type</span><strong>{item.part_type?.name ?? "--"}</strong></div>
          <div><span>Location</span><strong>{item.location?.name ?? "--"}</strong></div>
          <div><span>Quantity</span><strong>{formatQuantity(item.quantity_on_hand)} {inventoryUnitLabel(item)}</strong></div>
          <div><span>Reorder Level</span><strong>{item.minimum_quantity !== null ? formatQuantity(item.minimum_quantity) : "--"}</strong></div>
          <div><span>Suggested Reorder Qty</span><strong>{item.suggested_reorder_quantity !== null ? formatQuantity(item.suggested_reorder_quantity) : "--"}</strong></div>
          <div><span>Supplier</span><strong>{item.supplier ?? "--"}</strong></div>
        </div>
        {item.notes ? <p className="maintenance-instructions">{item.notes}</p> : null}

        {canAct ? (
          <div className="maintenance-button-row">
            <button type="button" onClick={() => setReceiveOpen(true)}>Receive Stock</button>
            <button type="button" className="btn-secondary" onClick={() => setAdjustOpen(true)}>Adjust Stock</button>
          </div>
        ) : null}

        <button type="button" className="maintenance-link-button" onClick={() => void toggleHistory()}>
          {historyOpen ? "Hide Transaction History" : "View Transaction History"}
        </button>

        {historyOpen ? (
          <div className="maintenance-history-list">
            {historyError ? <p className="form-error">{historyError}</p> : null}
            {history === null && !historyError ? <p>Loading…</p> : null}
            {history && history.length === 0 ? <p>No transactions recorded yet.</p> : null}
            {history?.map((tx) => (
              <div key={tx.id} className="maintenance-history-row">
                <span>{tx.transaction_type.replace(/_/g, " ")}</span>
                <span>{tx.quantity_change > 0 ? "+" : ""}{formatQuantity(tx.quantity_change)} {tx.unit_snapshot} → {formatQuantity(tx.quantity_after)}</span>
                <span>{formatDateTime(tx.created_at)}</span>
                <span>{tx.performed_by_name_snapshot}</span>
                {tx.reason ? <span className="maintenance-history-note">{tx.reason}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {receiveOpen ? (
        <ReceiveStockSheet
          item={item}
          onClose={() => setReceiveOpen(false)}
          onApplied={(result) => {
            setReceiveOpen(false);
            setHistory(null);
            onChanged(result.item);
          }}
        />
      ) : null}

      {adjustOpen ? (
        <AdjustStockSheet
          item={item}
          onClose={() => setAdjustOpen(false)}
          onApplied={(result) => {
            setAdjustOpen(false);
            setHistory(null);
            onChanged(result.item);
          }}
        />
      ) : null}
    </ModalOverlay>
  );
}
