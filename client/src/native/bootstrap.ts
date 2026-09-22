import type { createBrowserRouter } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { configureStatusBar } from "./statusBar";
import { configureKeyboardHandling } from "./keyboard";
import { registerDeepLinkHandling } from "./deepLinks";
import { registerPushListeners } from "./pushNotifications";

type DataRouter = ReturnType<typeof createBrowserRouter>;

// capacitor.config.ts sets plugins.SplashScreen.launchAutoHide: false, so
// nothing dismisses the native LaunchScreen/splash on a timer — this file
// is the ONLY thing that ever calls SplashScreen.hide(). On a fast device
// the Promise.all below can resolve in only a few milliseconds, which
// would otherwise hide the splash almost instantly — a "blink" rather
// than the ~1s cold-launch splash the design calls for. This floor makes
// the hide wait for whichever is longer: the real bootstrap work, or
// ~1000ms of wall-clock time — never both added together, and never a
// second, visually-different splash stage, since LaunchScreen.storyboard
// (the asset this floor is keeping onscreen) is the exact same file
// @capacitor/splash-screen's own overlay renders.
const MINIMUM_SPLASH_VISIBLE_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Everything here is a no-op on the web/PWA build (each module below
// guards on Capacitor.isNativePlatform() itself) — this function only
// exists to give main.native.tsx a single call instead of importing five
// native modules directly, and is never imported by main.tsx.
export async function initializeNativeApp(router: DataRouter): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  await Promise.all([
    configureStatusBar(),
    configureKeyboardHandling(),
    registerPushListeners(),
    delay(MINIMUM_SPLASH_VISIBLE_MS)
  ]);
  registerDeepLinkHandling(router);

  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // Non-fatal: the splash screen's own launchAutoHide config still
    // dismisses it if this explicit hide call fails for any reason.
  }
}
