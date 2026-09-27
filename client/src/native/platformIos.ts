import { Capacitor } from "@capacitor/core";

/**
 * True only inside the native iOS Capacitor app (App Store / TestFlight).
 * False on the desktop web app, the mobile website / installed PWA, and any
 * native Android build. Uses Capacitor's own platform detection, never
 * screen size or the user agent.
 */
export function isNativeIos(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}
