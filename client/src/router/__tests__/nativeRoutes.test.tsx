import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Drives the real RequireAuth -> MembershipProvider -> usePermissions
// chain against a mocked supabase, exactly like
// MobileHomePage.maintenance.test.tsx, so these tests prove the native
// router's actual authorization behavior rather than a stubbed-out one.
const getSession = vi.fn();
const getUser = vi.fn();
const maybeSingle = vi.fn();
const onAuthStateChangeUnsubscribe = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      getUser: () => getUser(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: onAuthStateChangeUnsubscribe } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => maybeSingle() })
      })
    })
  }
}));

vi.mock("../../hooks/useOfflineQueue", () => ({
  useOfflineQueue: () => ({ queuePending: 0, queueFailed: 0, failureReasons: [], syncStatus: "idle", clearFailed: vi.fn() })
}));

import { RequireAuth } from "../../components/auth/RequireAuth";
import { MobileLayout } from "../../components/layout/MobileLayout";
import { NoAccessPage } from "../../pages/NoAccessPage";
import { LoginPage } from "../../pages/LoginPage";
import { mobileRouteChildren } from "../routes";

const AUTHENTICATED_SESSION = {
  user: { id: "user-1", user_metadata: {} }
};

// Mirrors nativeRouteConfig's own "/" branch (RequireAuth -> no-access |
// MobileLayout -> mobileRouteChildren) as declarative JSX instead of
// rendering the real createBrowserRouter-based nativeRouter — data
// routers' <Navigate> hits an unrelated AbortSignal/jsdom incompatibility
// under RouterProvider in this test environment (also why every other
// route test in this codebase uses MemoryRouter/Routes, not
// createMemoryRouter). Every component used below IS the real one
// nativeRoutes.tsx wires up; only the outer <Routes> wiring is
// reconstructed, and nativeRoutes.structural.test.ts separately proves
// nativeRoutes.tsx's actual source matches this shape.
function renderNativeRouterAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RequireAuth />}>
          <Route path="no-access" element={<NoAccessPage />} />
          <Route element={<MobileLayout />}>
            {mobileRouteChildren.map((route, i) => (
              <Route key={i} {...route} />
            ))}
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Native iOS router (nativeRouteConfig) — mounted at \"/\", not \"/mobile\"", () => {
  afterEach(() => vi.clearAllMocks());

  it("starts at Mobile Home for an authorized user landing on \"/\"", async () => {
    getSession.mockResolvedValue({ data: { session: AUTHENTICATED_SESSION }, error: null });
    getUser.mockResolvedValue({ data: { user: AUTHENTICATED_SESSION.user } });
    maybeSingle.mockResolvedValue({ data: { role: "member", permissions: { "mobile:access": true } }, error: null });

    renderNativeRouterAt("/");

    expect(await screen.findByText("Mobile Logging")).toBeInTheDocument();
    expect(screen.getByText("Daily Yield")).toBeInTheDocument();
  });

  it("redirects an unauthenticated user to /login rather than exposing Mobile Home", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    renderNativeRouterAt("/");

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
  });

  it("sends an unrecognized/stray path (e.g. a desktop route like /yield/analytics) back to Mobile Home via the catch-all, instead of a blank or broken screen", async () => {
    getSession.mockResolvedValue({ data: { session: AUTHENTICATED_SESSION }, error: null });
    getUser.mockResolvedValue({ data: { user: AUTHENTICATED_SESSION.user } });
    maybeSingle.mockResolvedValue({ data: { role: "member", permissions: { "mobile:access": true } }, error: null });

    renderNativeRouterAt("/yield/analytics");

    expect(await screen.findByText("Mobile Logging")).toBeInTheDocument();
  });

  it("still enforces mobile:access — a user with no mobile permission at all sees the Unauthorized fallback, not the feature list", async () => {
    getSession.mockResolvedValue({ data: { session: AUTHENTICATED_SESSION }, error: null });
    getUser.mockResolvedValue({ data: { user: AUTHENTICATED_SESSION.user } });
    maybeSingle.mockResolvedValue({ data: { role: "member", permissions: {} }, error: null });

    renderNativeRouterAt("/");

    expect(await screen.findByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
  });
});
