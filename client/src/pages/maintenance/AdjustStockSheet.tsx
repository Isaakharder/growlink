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

type Direction = "add" | "remove";

export function AdjustStockSheet({ item, onClose, onApplied }: Props) {
  const { isOnline } = useOnlineStatus();
  const [direction, setDirection] = useState<Direction>("remove");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(crypto.randomUUID());

  const isDiscrete = DISCRETE_UNITS_OF_MEASURE.includes(item.unit_of_measure);
  const parsedQuantity = Number(quantity);
  const quantityValid = quantity.trim() !== "" && Number.isFinite(parsedQuantity) && parsedQuantity > 0 && (!isDiscrete || Number.isInteger(parsedQuantity));
  const resultingQuantity = item.quantity_on_hand + (direction === "add" ? parsedQuantity : -parsedQuantity);

  function reviewStep(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!quantityValid) {
      setError(isDiscrete ? "Enter a whole number greater than zero." : "Enter a quantity greater than zero.");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required for this adjustment.");
      return;
    }
    if (direction === "remove" && parsedQuantity > item.quantity_on_hand) {
      setError(`Cannot remove more than the current quantity (${formatQuantity(item.quantity_on_hand)} ${inventoryUnitLabel(item)}).`);
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
        transaction_type: direction,
        quantity: parsedQuantity,
        reason: reason.trim(),
        request_id: requestIdRef.current
      });
      onApplied(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to adjust stock.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="adjust-stock-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="adjust-stock-title">Adjust Stock</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        <p>{item.name} — currently {formatQuantity(item.quantity_on_hand)} {inventoryUnitLabel(item)}</p>

        {!confirming ? (
          <form className="maintenance-form" onSubmit={reviewStep}>
            <div className="maintenance-segmented" role="radiogroup" aria-label="Adjustment direction">
              <button type="button" className={direction === "add" ? "active" : ""} onClick={() => setDirection("add")}>
                Add
              </button>
              <button type="button" className={direction === "remove" ? "active" : ""} onClick={() => setDirection("remove")}>
                Remove
              </button>
            </div>

            <label>
              Quantity ({inventoryUnitLabel(item)})
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
              Reason (required)
              <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. damaged, used on job, count correction" />
            </label>

            {error ? <p className="form-error">{error}</p> : null}
            <button type="submit">Continue</button>
          </form>
        ) : (
          <div className="maintenance-confirm-block">
            <p>
              {direction === "add" ? "Add" : "Remove"} <strong>{formatQuantity(parsedQuantity)} {inventoryUnitLabel(item)}</strong> {direction === "add" ? "to" : "from"} {item.name}?
            </p>
            <p>Reason: {reason.trim()}</p>
            <p>New quantity will be {formatQuantity(resultingQuantity)} {inventoryUnitLabel(item)}.</p>
            {error ? <p className="form-error">{error}</p> : null}
            {!isOnline ? <p className="form-error">You're offline — reconnect to save.</p> : null}
            <div className="maintenance-button-row">
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={saving}>
                Back
              </button>
              <button type="button" onClick={() => void confirm()} disabled={saving || !isOnline}>
                {saving ? "Saving…" : "Confirm Adjustment"}
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
