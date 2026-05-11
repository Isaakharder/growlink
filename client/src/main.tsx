import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { appRouter } from "./router/routes";
import { registerSW } from "virtual:pwa-register";
import "./index.css";

registerSW({
  immediate: true
});

function AppRoot() {
  return <RouterProvider router={appRouter} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
