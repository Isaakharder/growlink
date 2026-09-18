import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { appRouter } from "./router/routes";
import { registerSW } from "virtual:pwa-register";
import "./index.css";

registerSW({
  immediate: true
});

// registerSW's own onNeedRefresh/updateSW hook is a no-op under
// registerType: "autoUpdate" (see vite-plugin-pwa's client register.js:
// its "auto" branch never calls messageSkipWaiting — it only auto-reloads
// once the browser's own lifecycle naturally promotes a waiting worker to
// active, which for an ALREADY-OPEN tab doesn't happen until every tab of
// the origin is closed and reopened). Confirmed against the actual
// installed package source, not assumed from its docs. Without this, a
// tab left open across a deploy keeps running whatever JS was loaded when
// it first opened — including client-side navigations within the app,
// e.g. to Mobile Home — even though a fresh page load (a new tab, or
// typing a URL directly) always fetches the current deployment; that's
// what makes a stale tab and a hard navigation disagree about what's
// available. This talks to the generated service worker directly with
// the same postMessage contract it already implements
// (self.addEventListener("message", ...SKIP_WAITING...) in the generated
// sw.js) to force an already-open tab onto the latest deployed code as
// soon as it's installed, then reloads once that new worker takes over.
if ("serviceWorker" in navigator) {
  const promoteWaitingWorker = (registration: ServiceWorkerRegistration) => {
    registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });

  navigator.serviceWorker.ready.then((registration) => {
    promoteWaitingWorker(registration);
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", (event) => {
        const worker = event.target as ServiceWorker;
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          promoteWaitingWorker(registration);
        }
      });
    });
  });
}

function AppRoot() {
  return <RouterProvider router={appRouter} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
