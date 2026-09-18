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

// Accepts either a custom-scheme URL (growlink://maintenance/equipment/123)
// or an https universal link (https://growlinkclient-production.up.railway.app/mobile/maintenance) —
// both collapse to the same in-app path. Anything that isn't a recognized
// authorized mobile route falls through to "/" via the native router's
// catch-all (see router/nativeRoutes.tsx), never to a desktop route, since
// the native router doesn't have any.
export function extractInAppPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path.startsWith("/mobile") ? mobilePath(path.slice("/mobile".length) || "/") : path;
  } catch {
    return null;
  }
}
