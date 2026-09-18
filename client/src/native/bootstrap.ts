import type { createBrowserRouter } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { configureStatusBar } from "./statusBar";
import { configureKeyboardHandling } from "./keyboard";
import { registerDeepLinkHandling } from "./deepLinks";
import { registerPushListeners } from "./pushNotifications";

type DataRouter = ReturnType<typeof createBrowserRouter>;

// Everything here is a no-op on the web/PWA build (each module below
// guards on Capacitor.isNativePlatform() itself) — this function only
// exists to give main.native.tsx a single call instead of importing five
// native modules directly, and is never imported by main.tsx.
export async function initializeNativeApp(router: DataRouter): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  await Promise.all([configureStatusBar(), configureKeyboardHandling(), registerPushListeners()]);
  registerDeepLinkHandling(router);

  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // Non-fatal: the splash screen's own launchAutoHide config still
    // dismisses it if this explicit hide call fails for any reason.
  }
}
