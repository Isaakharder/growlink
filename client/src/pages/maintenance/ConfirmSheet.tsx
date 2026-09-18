import { ModalOverlay } from "../../components/ModalOverlay";

type Props = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

// GrowLink-styled replacement for window.confirm(), used throughout Setup
// for destructive/consequential actions (delete, deactivate).
export function ConfirmSheet({ title, message, confirmLabel = "Confirm", danger, busy, error, onCancel, onConfirm }: Props) {
  return (
    <ModalOverlay onClose={onCancel} contentClassName="maintenance-sheet maintenance-confirm-sheet" titleId="confirm-sheet-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="confirm-sheet-title">{title}</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onCancel} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="maintenance-sheet-body">
        <p>{message}</p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="maintenance-button-row">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={danger ? "maintenance-danger-button" : ""} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
