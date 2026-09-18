import { useEffect, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { cancelStockCountSession, confirmStockCountSession, getStockCountSession, saveStockCountLine } from "./api";
import { formatDateTime, formatQuantity } from "./formatters";
import { StockCountLineRow, StockCountSessionDetail } from "./types";

type Props = {
  sessionId: string;
  onClose: () => void;
  onChanged: () => void;
};

type LineDraft = { value: string; saving: boolean; saved: boolean; error: string | null };

export function StockCountSessionSheet({ sessionId, onClose, onChanged }: Props) {
  const { isOnline } = useOnlineStatus();
  const [session, setSession] = useState<StockCountSessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [reviewing, setReviewing] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Array<{ line_id: string; reason: string }> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const detail = await getStockCountSession(sessionId);
      setSession(detail);
      setDrafts((current) => {
        const next = { ...current };
        for (const line of detail.lines) {
          if (!next[line.id]) {
            next[line.id] = { value: line.counted_quantity !== null ? String(line.counted_quantity) : "", saving: false, saved: line.counted_quantity !== null, error: null };
          }
        }
        return next;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load stock count.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function saveLine(line: StockCountLineRow) {
    const draft = drafts[line.id];
    if (!draft) return;
    const trimmed = draft.value.trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], error: "Enter a quantity of zero or greater.", saved: false } }));
      return;
    }
    setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], saving: true, error: null } }));
    try {
      await saveStockCountLine(sessionId, line.id, { counted_quantity: parsed, notes: null });
      setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], saving: false, saved: true } }));
      setSession((current) =>
        current ? { ...current, lines: current.lines.map((l) => (l.id === line.id ? { ...l, counted_quantity: parsed, variance: parsed - l.expected_quantity } : l)) } : current
      );
    } catch (err) {
      setDrafts((current) => ({
        ...current,
        [line.id]: { ...current[line.id], saving: false, saved: false, error: err instanceof Error ? err.message : "Failed to save." }
      }));
    }
  }

  async function confirm() {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(null);
    setConflicts(null);
    const result = await confirmStockCountSession(sessionId);
    setConfirming(false);
    if (result.ok) {
      onChanged();
      onClose();
      return;
    }
    if (result.conflict) {
      setConflicts(result.conflicts);
    }
    setConfirmError(result.message);
  }

  async function cancelSession() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelStockCountSession(sessionId, null);
      onChanged();
      onClose();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "Failed to cancel count.");
    } finally {
      setCancelling(false);
    }
  }

  const uncountedCount = session ? session.lines.filter((l) => l.counted_quantity === null).length : 0;

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="stock-count-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="stock-count-title">Stock Count{session ? ` — ${session.location_name_snapshot}` : ""}</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        {loadError ? <p className="form-error">{loadError}</p> : null}
        {!session && !loadError ? <p>Loading…</p> : null}

        {session && session.status !== "draft" ? (
          <p>This count is {session.status}. {session.confirmed_at ? `Confirmed ${formatDateTime(session.confirmed_at)}.` : ""}</p>
        ) : null}

        {session && session.status === "draft" && !reviewing ? (
          <>
            <p>Enter the counted quantity for each part. Progress saves as you go — you can close and resume later.</p>
            <div className="maintenance-history-list">
              {session.lines.map((line) => {
                const draft = drafts[line.id];
                return (
                  <div key={line.id} className="maintenance-stock-count-row">
                    <div className="maintenance-card-top-row">
                      <strong>{line.item_name_snapshot}</strong>
                      <span>Expected {formatQuantity(line.expected_quantity)} {line.unit_snapshot}</span>
                    </div>
                    <div className="maintenance-button-row">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={draft?.value ?? ""}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], value: event.target.value, saved: false } }))
                        }
                        onBlur={() => void saveLine(line)}
                      />
                      {draft?.saving ? <span>Saving…</span> : draft?.saved ? <span>Saved ✓</span> : null}
                    </div>
                    {draft?.error ? <p className="form-error">{draft.error}</p> : null}
                  </div>
                );
              })}
            </div>
            {!isOnline ? <p className="form-error">You're offline — reconnect to save counts.</p> : null}
            <div className="maintenance-button-row">
              <button type="button" className="btn-secondary" onClick={() => void cancelSession()} disabled={cancelling}>
                {cancelling ? "…" : "Cancel Count"}
              </button>
              <button type="button" onClick={() => setReviewing(true)}>
                Review &amp; Submit
              </button>
            </div>
          </>
        ) : null}

        {session && session.status === "draft" && reviewing ? (
          <>
            <p>Review expected vs. counted before confirming. Confirming applies inventory corrections for every part with a difference.</p>
            {uncountedCount > 0 ? <p className="form-error">{uncountedCount} part(s) still have no count entered.</p> : null}
            <table className="maintenance-review-table">
              <thead>
                <tr><th>Part</th><th>Expected</th><th>Counted</th><th>Diff</th></tr>
              </thead>
              <tbody>
                {session.lines.map((line) => (
                  <tr key={line.id} className={conflicts?.some((c) => c.line_id === line.id) ? "maintenance-review-row-conflict" : ""}>
                    <td>{line.item_name_snapshot}</td>
                    <td>{formatQuantity(line.expected_quantity)}</td>
                    <td>{line.counted_quantity !== null ? formatQuantity(line.counted_quantity) : "--"}</td>
                    <td>{line.variance !== null ? (line.variance > 0 ? `+${formatQuantity(line.variance)}` : formatQuantity(line.variance)) : "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {confirmError ? (
              <div className="maintenance-form-error-block">
                <p className="form-error">{confirmError}</p>
                {conflicts ? <p>Some inventory changed since this count started. Cancel this count and start a new one to get fresh expected quantities.</p> : null}
              </div>
            ) : null}
            {!isOnline ? <p className="form-error">You're offline — reconnect to confirm.</p> : null}

            <div className="maintenance-button-row">
              <button type="button" className="btn-secondary" onClick={() => setReviewing(false)}>
                Back to Counting
              </button>
              <button type="button" onClick={() => void confirm()} disabled={confirming || !isOnline}>
                {confirming ? "Confirming…" : "Confirm Count"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </ModalOverlay>
  );
}
