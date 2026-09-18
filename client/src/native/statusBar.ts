import { Capacitor } from "@capacitor/core";

// StatusBar.setOverlaysWebView(false) is the default on iOS, but set it
// explicitly so a future Capacitor default change can't silently make the
// status bar float over mobile-header content — the existing safe-area CSS
// (env(safe-area-inset-*), see index.css) assumes the WebView's own frame
// already starts below the status bar, not that the WebView draws under it.
export async function configureStatusBar(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setOverlaysWebView({ overlay: false });
    // Light: dark status-bar text/icons, for GrowLink Mobile's light
    // (near-white) header background — see .mobile-header in index.css.
    await StatusBar.setStyle({ style: Style.Light });
  } catch {
    // Non-fatal: the app is still usable without status-bar styling.
  }
}
