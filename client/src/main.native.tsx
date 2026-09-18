import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { nativeRouter } from "./router/nativeRoutes";
import { initializeNativeApp } from "./native/bootstrap";
import "./index.css";

// Native iOS entry point (built by vite.ios.config.ts into dist-ios/,
// loaded by the Capacitor iOS app). Unlike main.tsx, this deliberately
// never calls registerSW() — the PWA service worker has no place in a
// native shell (see vite.ios.config.ts for how the build pipeline also
// excludes vite-plugin-pwa entirely, so no sw.js is even emitted here).
void initializeNativeApp(nativeRouter);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={nativeRouter} />
  </React.StrictMode>
);
