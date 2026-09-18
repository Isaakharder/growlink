import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

export type OnlineStatus = {
  isOnline: boolean;
};

// Natively, @capacitor/network reflects actual OS-level reachability
// (cellular/Wi-Fi state) rather than WKWebView's own guess, so it's
// preferred there; navigator.onLine + the online/offline events remain the
// implementation for the web/PWA build (unchanged from before) and as the
// fallback if the native plugin is ever unavailable. Both branches keep
// this hook's public shape identical, so every existing caller (offline
// queue, SyncStatusBar, OfflineBanner, WorkLogSheet, etc.) needs no change.
export function useOnlineStatus(): OnlineStatus {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      let cancelled = false;
      let removeListener: (() => void) | undefined;

      import("@capacitor/network").then(({ Network }) => {
        if (cancelled) return;
        Network.getStatus().then((status) => setIsOnline(status.connected));
        Network.addListener("networkStatusChange", (status) => setIsOnline(status.connected)).then((handle) => {
          if (cancelled) {
            void handle.remove();
          } else {
            removeListener = () => void handle.remove();
          }
        });
      });

      return () => {
        cancelled = true;
        removeListener?.();
      };
    }

    function handleOnline() { setIsOnline(true); }
    function handleOffline() { setIsOnline(false); }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return { isOnline };
}
