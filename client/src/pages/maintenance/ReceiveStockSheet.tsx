import { useRef, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { postInventoryTransaction } from "./api";
import { formatQuantity, inventoryUnitLabel } from "./formatters";
import { DISCRETE_UNITS_OF_MEASURE, InventoryItemRow, InventoryTransactionResult } from "./types";

type Props = {
  item: InventoryItemRow;
  onClose: () => void;
  onApplied: (result: InventoryTransactionResult) => void;
};

export function ReceiveStockSheet({ item, onClose, onApplied }: Props) {
  const { isOnline } = useOnlineStatus();
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(crypto.randomUUID());

  const isDiscrete = DISCRETE_UNITS_OF_MEASURE.includes(item.unit_of_measure);
  const parsedQuantity = Number(quantity);
  const quantityValid = quantity.trim() !== "" && Number.isFinite(parsedQuantity) && parsedQuantity > 0 && (!isDiscrete || Number.isInteger(parsedQuantity));

  function reviewStep(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!quantityValid) {
      setError(isDiscrete ? "Enter a whole number greater than zero." : "Enter a quantity greater than zero.");
      return;
    }
    setConfirming(true);
  }

  async function confirm() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await postInventoryTransaction(item.id, {
        transaction_type: "receive",
        quantity: parsedQuantity,
        reason: reason.trim() || null,
        request_id: requestIdRef.current
      });
      onApplied(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to receive stock.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="receive-stock-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="receive-stock-title">Receive Stock</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        <p>{item.name} — currently {formatQuantity(item.quantity_on_hand)} {inventoryUnitLabel(item)}</p>

        {!confirming ? (
          <form className="maintenance-form" onSubmit={reviewStep}>
            <label>
              Quantity received ({inventoryUnitLabel(item)})
              <input
                type="number"
                inputMode={isDiscrete ? "numeric" : "decimal"}
                min="0"
                step="any"
                value={quantity}
                autoFocus
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <label>
              Note (optional — PO#, supplier, etc.)
              <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button type="submit">Continue</button>
          </form>
        ) : (
          <div className="maintenance-confirm-block">
            <p>
              Receive <strong>{formatQuantity(parsedQuantity)} {inventoryUnitLabel(item)}</strong> of {item.name}?
            </p>
            <p>New quantity will be {formatQuantity(item.quantity_on_hand + parsedQuantity)} {inventoryUnitLabel(item)}.</p>
            {error ? <p className="form-error">{error}</p> : null}
            {!isOnline ? <p className="form-error">You're offline — reconnect to save.</p> : null}
            <div className="maintenance-button-row">
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={saving}>
                Back
              </button>
              <button type="button" onClick={() => void confirm()} disabled={saving || !isOnline}>
                {saving ? "Saving…" : "Confirm Receipt"}
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
