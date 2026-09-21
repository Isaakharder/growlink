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
// Mounts the exact same mobileRouteChildren at "/mobile" — the SAME path
// the web app uses (see router/routes.tsx) — rather than at "/". An
// earlier version of this router mounted them at "/" instead, on the
// theory that every absolute mobile link would be rewritten through
// config/platform.ts's mobilePath()/MOBILE_HOME helper. That theory was
// wrong in practice: several mobile pages build their "/mobile/..." links
// with a plain template literal (EquipmentTab's equipment-detail
// navigation, MobilePestCalibrationPage's device links,
// MobileFoodSafetyPage's location links) instead of going through the
// helper, so those specific destinations 404'd under the native router
// and silently fell back to Mobile Home via the catch-all below — while
// pages that DID use the helper worked fine, making the bug look
// component-specific when it was really a router-mounting-point mismatch.
// Mounting at "/mobile" natively, identically to web, fixes every such
// link at once, including ones that might still be written as a plain
// "/mobile/..." string in the future — there is no longer a
// native-vs-web distinction for this path to get wrong. See
// config/platform.ts, whose MOBILE_BASE is now unconditionally "/mobile"
// for the same reason.
//
// No desktop route (DashboardPage, IrrigationPage, any /admin/* or
// /setup/* page, etc.) is imported by this module at all, so none of
// that code can end up in the native bundle, let alone be reachable by a
// stray deep link — the catch-all below sends anything unmatched back to
// Mobile Home rather than falling through anywhere else, and the bare
// "/" route (which getDefaultRoute() can still return, e.g. for an
// owner/admin whose web equivalent lands on the desktop dashboard)
// redirects to "/mobile" rather than being a second, competing mount
// point for the mobile tree.
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
        index: true,
        element: <Navigate to="/mobile" replace />
      },
      {
        path: "no-access",
        element: <NoAccessPage />
      },
      {
        path: "mobile",
        element: <MobileLayout />,
        children: mobileRouteChildren
      }
    ]
  },
  {
    path: "*",
    element: <Navigate to="/mobile" replace />
  }
];

export const nativeRouter = createBrowserRouter(nativeRouteConfig);
