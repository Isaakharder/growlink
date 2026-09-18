import { createBrowserRouter, Navigate } from "react-router-dom";
import { MobileLayout } from "../components/layout/MobileLayout";
import { RequireAuth } from "../components/auth/RequireAuth";
import { LoginPage } from "../pages/LoginPage";
import { SetPasswordPage } from "../pages/SetPasswordPage";
import { AcceptInvitePage } from "../pages/AcceptInvitePage";
import { NoAccessPage } from "../pages/NoAccessPage";
import { mobileRouteChildren } from "./routes";

// The native iOS router's route config, kept as a plain array (rather than
// only as the createBrowserRouter(...) call below) so tests can feed the
// identical config into createMemoryRouter instead of the real browser
// history — see router/__tests__/nativeRoutes.test.tsx.
//
// It reuses the exact same mobileRouteChildren as the web app's
// "/mobile/*" tree (see router/routes.tsx) but mounts them at "/" instead,
// since the native shell has no desktop app to share a bundle with —
// every page it can reach is one of the existing authorized mobile
// workflows. No desktop route (DashboardPage, IrrigationPage, any
// /admin/* or /setup/* page, etc.) is imported by this module at all, so
// none of that code can end up in the native bundle, let alone be
// reachable by a stray deep link — the catch-all below sends anything
// unmatched back to Mobile Home rather than falling through anywhere else.
export const nativeRouteConfig = [
  {
    path: "/login",
    element: <LoginPage />
  },
  {
    path: "/set-password",
    element: <SetPasswordPage />
  },
  {
    path: "/invite/accept",
    element: <AcceptInvitePage />
  },
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      {
        path: "no-access",
        element: <NoAccessPage />
      },
      {
        element: <MobileLayout />,
        children: mobileRouteChildren
      }
    ]
  },
  {
    path: "*",
    element: <Navigate to="/" replace />
  }
];

export const nativeRouter = createBrowserRouter(nativeRouteConfig);
