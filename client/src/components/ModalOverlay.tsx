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
  /**
   * Default false (existing callers are unaffected). When true: focuses the
   * first focusable element inside the content box (or the box itself) on
   * open, traps Tab/Shift+Tab within it while mounted, and restores focus to
   * whatever was focused before the modal opened (typically the button that
   * triggered it) once it unmounts.
   */
  trapFocus?: boolean;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  lockBodyScroll = true,
  trapFocus = false
}: ModalOverlayProps) {
  const startedOnBackdrop = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!trapFocus) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const content = contentRef.current;
    const focusable = content?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    (focusable && focusable.length > 0 ? focusable[0] : content)?.focus();

    return () => {
      previouslyFocused?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trapFocus]);

  useEffect(() => {
    if (!trapFocus) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const content = contentRef.current;
      if (!content) return;
      const focusable = Array.from(content.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [trapFocus]);

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
        ref={contentRef}
        className={contentClassName}
        style={contentStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
