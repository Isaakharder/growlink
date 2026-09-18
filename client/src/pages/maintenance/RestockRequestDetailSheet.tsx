import { useEffect, useRef, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { cancelRestockRequest, getRestockRequest, markRestockRequestOrdered, receiveRestockLine } from "./api";
import { formatDateTime, formatQuantity } from "./formatters";
import { RestockRequestDetail, RestockRequestLineRow, RestockRequestStatus } from "./types";

type Props = {
  requestId: string;
  canAct: boolean;
  onClose: () => void;
  onChanged: () => void;
};

const STATUS_LABEL: Record<RestockRequestStatus, string> = {
  requested: "Requested",
  ordered: "Ordered",
  partially_received: "Partially Received",
  received: "Received",
  cancelled: "Cancelled"
};

function ReceiveLineRow({ requestId, line, canAct, isOnline, onReceived }: {
  requestId: string; line: RestockRequestLineRow; canAct: boolean; isOnline: boolean; onReceived: () => void;
}) {
  const remaining = line.requested_quantity - line.received_quantity;
  const [quantity, setQuantity] = useState(remaining > 0 ? String(remaining) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(crypto.randomUUID());

  async function receive() {
    if (saving) return;
    const parsed = Number(quantity);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a quantity greater than zero.");
      return;
    }
    if (parsed > remaining) {
      setError(`Only ${formatQuantity(remaining)} ${line.unit_snapshot} remains on this line.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await receiveRestockLine(requestId, line.id, { receive_quantity: parsed, request_id: requestIdRef.current });
      requestIdRef.current = crypto.randomUUID();
      onReceived();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to receive line.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="maintenance-restock-line-row maintenance-restock-line-detail">
      <div>
        <strong>{line.item_name_snapshot}</strong>
        <span>Requested {formatQuantity(line.requested_quantity)} {line.unit_snapshot} · Received {formatQuantity(line.received_quantity)} {line.unit_snapshot}</span>
      </div>
      {canAct && remaining > 0 ? (
        <>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <button type="button" onClick={() => void receive()} disabled={saving || !isOnline}>
            {saving ? "…" : "Receive"}
          </button>
        </>
      ) : (
        <span>{remaining <= 0 ? "Complete" : ""}</span>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

export function RestockRequestDetailSheet({ requestId, canAct, onClose, onChanged }: Props) {
  const { isOnline } = useOnlineStatus();
  const [detail, setDetail] = useState<RestockRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  async function load() {
    setError(null);
    try {
      setDetail(await getRestockRequest(requestId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load restock request.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  async function markOrdered() {
    if (acting) return;
    setActing(true);
    setActionError(null);
    try {
      await markRestockRequestOrdered(requestId);
      await load();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to mark as ordered.");
    } finally {
      setActing(false);
    }
  }

  async function cancel() {
    if (acting) return;
    setActing(true);
    setActionError(null);
    try {
      await cancelRestockRequest(requestId, null);
      await load();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel request.");
    } finally {
      setActing(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="restock-detail-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="restock-detail-title">Restock Request</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        {error ? <p className="form-error">{error}</p> : null}
        {!detail && !error ? <p>Loading…</p> : null}

        {detail ? (
          <>
            <div className="maintenance-card-top-row">
              <span className="maintenance-card-title">{STATUS_LABEL[detail.status]}</span>
              <span>{formatDateTime(detail.created_at)}</span>
            </div>
            <p>Requested by {detail.requested_by_name_snapshot}</p>
            {detail.notes ? <p className="maintenance-instructions">{detail.notes}</p> : null}

            <div className="maintenance-history-list">
              {detail.lines.map((line) => (
                <ReceiveLineRow
                  key={line.id}
                  requestId={requestId}
                  line={line}
                  canAct={canAct && (detail.status === "requested" || detail.status === "ordered" || detail.status === "partially_received")}
                  isOnline={isOnline}
                  onReceived={() => void load().then(onChanged)}
                />
              ))}
            </div>

            {actionError ? <p className="form-error">{actionError}</p> : null}

            {canAct && detail.status === "requested" ? (
              <div className="maintenance-button-row">
                <button type="button" onClick={() => void markOrdered()} disabled={acting || !isOnline}>Mark as Ordered</button>
                <button type="button" className="btn-secondary" onClick={() => void cancel()} disabled={acting || !isOnline}>Cancel Request</button>
              </div>
            ) : null}
            {canAct && (detail.status === "ordered" || detail.status === "partially_received") ? (
              <div className="maintenance-button-row">
                <button type="button" className="btn-secondary" onClick={() => void cancel()} disabled={acting || !isOnline}>Cancel Request</button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </ModalOverlay>
  );
}
