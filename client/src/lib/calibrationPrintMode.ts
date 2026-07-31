// Runs the Calibration module's batch print job (DeviceHistoryModal.tsx):
// injects a print-only @page rule (portrait; margin depends on whether the
// batch contains a compact-long-layout record — see the caller), fires
// window.print() on the next frame, and cleans up afterward on the
// browser's own `afterprint` event, or after a 60s fallback timeout in case
// afterprint doesn't fire for some reason (not universally guaranteed
// across every browser/OS print dialog combination).
//
// There is only one Calibration print root (rendered by DeviceHistoryModal),
// so the shared [data-print-root] isolation rule in index.css is sufficient
// on its own — no mutually-exclusive body classes needed.
export function runCalibrationPrint(pageCss: string, onDone?: () => void): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-calibration-print-page", "true");
  style.textContent = pageCss;
  document.head.appendChild(style);

  let finished = false;
  function cleanup() {
    if (finished) return;
    finished = true;
    window.removeEventListener("afterprint", cleanup);
    window.clearTimeout(fallbackTimeout);
    style.remove();
    onDone?.();
  }

  window.addEventListener("afterprint", cleanup);
  const fallbackTimeout = window.setTimeout(cleanup, 60_000);

  const raf = window.requestAnimationFrame(() => window.print());

  return () => {
    window.cancelAnimationFrame(raf);
    cleanup();
  };
}
