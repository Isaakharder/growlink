import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ModalOverlay } from "../ModalOverlay";

// Full-screen view for a chart card: an Expand button for the card header,
// and a fixed full-viewport overlay (portalled to <body>, 100dvh, safe-area
// padding) that shows the same chart. Not the Fullscreen API: that needs a
// permission gesture and is unreliable on iOS and in the installed PWA.

/**
 * Which chart is open, plus refs to each Expand button so focus can return
 * to it on close. Set explicitly: Safari doesn't focus a button on click,
 * so "whatever was focused before" can't be relied on.
 */
export function useFullscreenChart<Id extends string>() {
  const [expanded, setExpanded] = useState<Id | null>(null);
  const expandedRef = useRef<Id | null>(null);
  const buttons = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({});

  const buttonRef = useCallback(
    (id: Id) => (el: HTMLButtonElement | null) => {
      buttons.current[id] = el;
    },
    []
  );

  const open = useCallback((id: Id) => {
    expandedRef.current = id;
    setExpanded(id);
  }, []);

  const close = useCallback(() => {
    const returnTo = expandedRef.current ? buttons.current[expandedRef.current] : null;
    expandedRef.current = null;
    setExpanded(null);
    requestAnimationFrame(() => returnTo?.focus());
  }, []);

  return { expanded, open, close, buttonRef };
}

export function ExpandChartButton({
  title,
  onClick,
  buttonRef
}: {
  title: string;
  onClick: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className="csv-tb-btn csv-tb-btn--quiet csv-tb-btn--sm chart-expand-button"
      aria-label={`Expand ${title} graph`}
      title="Expand"
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 11.5 8.5M3.5 16.5l5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function FullscreenChartOverlay({
  title,
  description,
  onClose,
  children
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  /** The chart; it fills the space below the header (render it at 100% x 100%). */
  children: ReactNode;
}) {
  return createPortal(
    <ModalOverlay onClose={onClose} contentClassName="chart-fullscreen" titleId="chart-fullscreen-title" trapFocus>
      <div className="chart-fullscreen-head">
        <div>
          <h2 id="chart-fullscreen-title" className="chart-fullscreen-title">
            {title}
          </h2>
          {description ? <p className="chart-fullscreen-description">{description}</p> : null}
        </div>
        <button type="button" className="csv-tb-btn chart-fullscreen-close" aria-label="Close full-screen graph" onClick={onClose}>
          <svg className="csv-tb-btn-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Close
        </button>
      </div>
      <div className="chart-fullscreen-body">{children}</div>
    </ModalOverlay>,
    document.body
  );
}
