import { Capacitor } from "@capacitor/core";
import type { createBrowserRouter } from "react-router-dom";
import { mobilePath } from "../config/platform";

type DataRouter = ReturnType<typeof createBrowserRouter>;

// Foundation for deep links (custom-scheme and, once an associated domain
// is configured in App Store Connect, universal links) and for push
// notification taps (Stage 3 wires PushNotifications' actionPerformed
// listener to this same navigate() call with the tapped notification's
// target path). Both need to turn an external URL into an in-app
// navigation on the SAME router instance the app already rendered with —
// a data router's own .navigate() is the supported way to do that from
// outside a component (see main.native.tsx).
export function registerDeepLinkHandling(router: DataRouter): void {
  if (!Capacitor.isNativePlatform()) return;

  void import("@capacitor/app").then(({ App }) => {
    App.addListener("appUrlOpen", ({ url }) => {
      const path = extractInAppPath(url);
      if (path) {
        void router.navigate(path);
      }
    });
  });
}

// Accepts either a custom-scheme URL without the /mobile prefix
// (growlink://maintenance/equipment/123 — a mobile-relative path is all a
// custom scheme needs) or an https universal link that mirrors the web
// site's own URL structure
// (https://growlinkclient-production.up.railway.app/mobile/maintenance —
// already "/mobile"-prefixed, same as any other mobile link on web).
// The native router mounts the mobile tree at "/mobile", identically to
// web (see router/nativeRoutes.tsx), so an already-prefixed path is
// passed through unchanged rather than having "/mobile" stripped off.
// Anything that isn't a recognized authorized mobile route falls through
// to "/mobile" via the native router's catch-all, never to a desktop
// route, since the native router doesn't have any.
export function extractInAppPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path === "/" || path === "") return "/mobile";
    return path.startsWith("/mobile") ? path : mobilePath(path);
  } catch {
    return null;
  }
}
