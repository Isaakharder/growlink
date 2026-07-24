import { CSSProperties, ReactNode, useEffect, useRef } from "react";

type ModalOverlayProps = {
  /** Called when the backdrop is genuinely clicked/tapped, or Escape is pressed. */
  onClose: () => void;
  children: ReactNode;
  /** Class name(s) for the modal's content box (e.g. "variety-modal"). */
  contentClassName?: string;
  /** Inline style for the content box — only for legacy modals still styled ad hoc. */
  contentStyle?: CSSProperties;
  /** id of the element (usually the modal's <h2>) that labels the dialog for screen readers. */
  titleId?: string;
  /** Default true. Set false for a modal that should ignore Escape. */
  closeOnEscape?: boolean;
  /** Default true. Set false if a modal deliberately needs the page to keep scrolling. */
  lockBodyScroll?: boolean;
};

/**
 * Shared modal backdrop. Closes only when a pointer press AND its matching
 * release both land directly on the backdrop itself — not just the release.
 *
 * The bug this fixes: a plain `onClick={onClose}` on the overlay (paired
 * with `stopPropagation` on the content box) closes the modal if a user
 * starts selecting text inside a field and drags past the content box edge
 * before releasing. The mousedown and mouseup then target different
 * elements, so the browser's synthesized `click` fires on the nearest
 * common ancestor — the overlay — even though the user never intended to
 * click the backdrop. Tracking press-and-release on the backdrop
 * independently (via Pointer Events, so mouse/touch/pen all share one code
 * path) avoids that entirely, with no stopPropagation needed anywhere.
 */
export function ModalOverlay({
  onClose,
  children,
  contentClassName,
  contentStyle,
  titleId,
  closeOnEscape = true,
  lockBodyScroll = true
}: ModalOverlayProps) {
  const startedOnBackdrop = useRef(false);

  useEffect(() => {
    if (!closeOnEscape) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape, onClose]);

  useEffect(() => {
    if (!lockBodyScroll) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [lockBodyScroll]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    startedOnBackdrop.current = event.target === event.currentTarget;
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const endedOnBackdrop = event.target === event.currentTarget;
    if (startedOnBackdrop.current && endedOnBackdrop) {
      onClose();
    }
    startedOnBackdrop.current = false;
  }

  function handlePointerCancel() {
    startedOnBackdrop.current = false;
  }

  return (
    <div
      className="modal-overlay"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div
        className={contentClassName}
        style={contentStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {children}
      </div>
    </div>
  );
}
