import { useEffect, useMemo, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { createRestockRequest, listInventoryItems } from "./api";
import { DISCRETE_UNITS_OF_MEASURE, InventoryItemRow, RestockRequestDetail } from "./types";
import { inventoryUnitLabel } from "./formatters";

type Props = {
  onClose: () => void;
  onCreated: (request: RestockRequestDetail) => void;
};

export function RestockRequestSheet({ onClose, onCreated }: Props) {
  const { isOnline } = useOnlineStatus();
  const [items, setItems] = useState<InventoryItemRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listInventoryItems({ active: "true" })
      .then((loaded) => {
        setItems(loaded);
        // Pre-fill a suggested quantity for anything already low/out of
        // stock — the common case for opening this sheet — while leaving
        // it fully editable.
        const initial: Record<string, string> = {};
        for (const item of loaded) {
          if (item.stock_status !== "in_stock") {
            const suggestion = item.suggested_reorder_quantity ?? item.minimum_quantity;
            if (suggestion) initial[item.id] = String(suggestion);
          }
        }
        setQuantities(initial);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load inventory."));
  }, []);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((i) => i.name.toLowerCase().includes(term) || (i.part_number ?? "").toLowerCase().includes(term));
  }, [items, search]);

  const selectedLines = useMemo(() => {
    if (!items) return [];
    return items
      .map((item) => ({ item, quantity: Number(quantities[item.id]) }))
      .filter(({ item, quantity }) => (quantities[item.id] ?? "").trim() !== "" && Number.isFinite(quantity) && quantity > 0);
  }, [items, quantities]);

  function reviewStep(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (selectedLines.length === 0) {
      setError("Enter a quantity for at least one part.");
      return;
    }
    for (const { item, quantity } of selectedLines) {
      if (DISCRETE_UNITS_OF_MEASURE.includes(item.unit_of_measure) && !Number.isInteger(quantity)) {
        setError(`${item.name} requires a whole number quantity.`);
        return;
      }
    }
    setConfirming(true);
  }

  async function confirm() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const request = await createRestockRequest({
        lines: selectedLines.map(({ item, quantity }) => ({ item_id: item.id, requested_quantity: quantity, notes: null })),
        notes: notes.trim() || null
      });
      onCreated(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create restock request.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="restock-request-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="restock-request-title">New Restock Request</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        {loadError ? <p className="form-error">{loadError}</p> : null}
        {items === null && !loadError ? <p>Loading parts…</p> : null}

        {!confirming && items ? (
          <form className="maintenance-form" onSubmit={reviewStep}>
            <input
              type="search"
              className="maintenance-search-input"
              placeholder="Search parts"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

            <div className="maintenance-restock-line-list">
              {filteredItems.map((item) => (
                <div key={item.id} className="maintenance-restock-line-row">
                  <div>
                    <strong>{item.name}</strong>
                    <span>{item.part_number ?? ""} {item.stock_status !== "in_stock" ? `· ${item.stock_status === "out_of_stock" ? "Out of stock" : "Low stock"}` : ""}</span>
                  </div>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    placeholder="Qty"
                    value={quantities[item.id] ?? ""}
                    onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                  />
                  <span>{inventoryUnitLabel(item)}</span>
                </div>
              ))}
            </div>

            <label>
              Request notes (optional)
              <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>

            {error ? <p className="form-error">{error}</p> : null}
            <button type="submit">Review Request ({selectedLines.length} part{selectedLines.length === 1 ? "" : "s"})</button>
          </form>
        ) : null}

        {confirming ? (
          <div className="maintenance-confirm-block">
            <p>Submit a restock request for:</p>
            <ul>
              {selectedLines.map(({ item, quantity }) => (
                <li key={item.id}>{item.name}: {quantity} {inventoryUnitLabel(item)}</li>
              ))}
            </ul>
            {error ? <p className="form-error">{error}</p> : null}
            {!isOnline ? <p className="form-error">You're offline — reconnect to submit.</p> : null}
            <div className="maintenance-button-row">
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={saving}>
                Back
              </button>
              <button type="button" onClick={() => void confirm()} disabled={saving || !isOnline}>
                {saving ? "Submitting…" : "Submit Request"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </ModalOverlay>
  );
}
