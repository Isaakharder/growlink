import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
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

// Every mobile-home-destination page fetches its own data on mount via
// apiFetch (real fetch calls); stubbing global fetch is the blanket,
// page-agnostic way to let all of them mount without a real network call
// or an unhandled rejection, since these tests only assert on each page's
// own static heading (proving routing worked), never on fetched content.
const originalFetch = global.fetch;
function stubFetch() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ([])
  } as Response);
}

const listEquipment = vi.fn();
const listSetupResource = vi.fn();
const getEquipment = vi.fn();
const getEquipmentHistory = vi.fn();
vi.mock("../../pages/maintenance/api", async () => {
  const actual = await vi.importActual<typeof import("../../pages/maintenance/api")>("../../pages/maintenance/api");
  return {
    ...actual,
    listEquipment: (...a: unknown[]) => listEquipment(...a),
    listSetupResource: (...a: unknown[]) => listSetupResource(...a),
    getEquipment: (...a: unknown[]) => getEquipment(...a),
    getEquipmentHistory: (...a: unknown[]) => getEquipmentHistory(...a)
  };
});

import { RequireAuth } from "../../components/auth/RequireAuth";
import { MobileLayout } from "../../components/layout/MobileLayout";
import { NoAccessPage } from "../../pages/NoAccessPage";
import { LoginPage } from "../../pages/LoginPage";
import { mobileRouteChildren } from "../routes";
import { extractInAppPath } from "../../native/deepLinks";

const AUTHENTICATED_OWNER_SESSION = {
  user: { id: "user-1", user_metadata: {} }
};

const EQUIPMENT = {
  id: "eq-1",
  name: "Boom Sprayer",
  asset_code: "SPRAY-001",
  category: { id: "c1", name: "Sprayers" },
  location: { id: "l1", name: "Bay A" },
  status: "active",
  meter_unit: "hours",
  meter_unit_custom_label: null,
  current_meter_reading: 120,
  due_status: "overdue"
};

const EQUIPMENT_DETAIL = {
  ...EQUIPMENT,
  due_status: "ok",
  make: null,
  model: null,
  serial_number: null,
  description: null,
  current_meter_reading_at: "2026-01-10T00:00:00Z",
  schedules: []
};

// Mirrors nativeRouteConfig's own shape (RequireAuth -> index redirect to
// "/mobile" | no-access | "mobile" -> MobileLayout -> mobileRouteChildren)
// as declarative JSX instead of rendering the real
// createBrowserRouter-based nativeRouter — data routers' <Navigate> hits
// an unrelated AbortSignal/jsdom incompatibility under RouterProvider in
// this test environment (also why every other route test in this
// codebase uses MemoryRouter/Routes, not createMemoryRouter). Every
// component used below IS the real one nativeRoutes.tsx wires up; only
// the outer <Routes> wiring is reconstructed, and
// nativeRoutes.structural.test.ts separately proves nativeRoutes.tsx's
// actual source matches this shape.
function NativeRouterTree() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth />}>
        <Route index element={<Navigate to="/mobile" replace />} />
        <Route path="no-access" element={<NoAccessPage />} />
        <Route path="mobile" element={<MobileLayout />}>
          {mobileRouteChildren.map((route, i) => (
            <Route key={i} {...route} />
          ))}
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/mobile" replace />} />
    </Routes>
  );
}

function renderNativeRouterAt(entries: string[], initialIndex = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <NativeRouterTree />
    </MemoryRouter>
  );
}

function mockAuthorizedOwner() {
  getSession.mockResolvedValue({ data: { session: AUTHENTICATED_OWNER_SESSION }, error: null });
  getUser.mockResolvedValue({ data: { user: AUTHENTICATED_OWNER_SESSION.user } });
  // role: "owner" bypasses every permission check (usePermissions,
  // MobileHomePage's card gates, RequirePermission) so every destination
  // is reachable without enumerating individual permission keys per test.
  maybeSingle.mockResolvedValue({ data: { role: "owner", permissions: {} }, error: null });
}

describe("Native router (mounted at \"/mobile\", matching the web router)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("redirects the bare \"/\" to \"/mobile\" and lands on Mobile Home for an authorized user", async () => {
    stubFetch();
    mockAuthorizedOwner();

    renderNativeRouterAt(["/"]);

    expect(await screen.findByText("Mobile Logging")).toBeInTheDocument();
    expect(screen.getByText("Daily Yield")).toBeInTheDocument();
  });

  it("redirects an unauthenticated user to /login rather than exposing Mobile Home", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    renderNativeRouterAt(["/"]);

    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
  });

  it("still enforces mobile:access — a user with no mobile permission at all sees the Unauthorized fallback, not the feature list", async () => {
    getSession.mockResolvedValue({ data: { session: AUTHENTICATED_OWNER_SESSION }, error: null });
    getUser.mockResolvedValue({ data: { user: AUTHENTICATED_OWNER_SESSION.user } });
    maybeSingle.mockResolvedValue({ data: { role: "member", permissions: {} }, error: null });

    renderNativeRouterAt(["/mobile"]);

    expect(await screen.findByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
  });
});

describe("Native router — unknown/unmatched routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("sends an unrecognized/stray path (e.g. a desktop route like /yield/analytics) to Mobile Home via the catch-all, instead of a blank or broken screen", async () => {
    stubFetch();
    mockAuthorizedOwner();

    renderNativeRouterAt(["/yield/analytics"]);

    expect(await screen.findByText("Mobile Logging")).toBeInTheDocument();
  });

  it("sends an unmatched path nested under /mobile (e.g. a typo'd feature) to Mobile Home too", async () => {
    stubFetch();
    mockAuthorizedOwner();

    renderNativeRouterAt(["/mobile/does-not-exist"]);

    expect(await screen.findByText("Mobile Logging")).toBeInTheDocument();
  });
});

describe("Native router — every Mobile Home destination navigates to its real page (not back to Mobile Home)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  const destinations: Array<{ link: string; headingRole?: string; heading: string }> = [
    { link: "Daily Yield", heading: "Daily Yield" },
    { link: "Quality Check", heading: "Quality Check" },
    { link: "Irrigation Log", heading: "Irrigation Log" },
    { link: "Pest Log", heading: "Pest Log" },
    { link: "Food Safety", heading: "Food Safety" },
    { link: "Calibration", heading: "Calibration" }
  ];

  for (const { link, heading } of destinations) {
    it(`"${link}" from Mobile Home lands on the real ${heading} page`, async () => {
      stubFetch();
      mockAuthorizedOwner();

      renderNativeRouterAt(["/mobile"]);
      await screen.findByText("Mobile Logging");

      await userEvent.click(screen.getByRole("link", { name: link }));

      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
    });
  }

  it("\"Maintenance\" from Mobile Home lands on the real Maintenance page (lazy-loaded), not back on Mobile Home", async () => {
    stubFetch();
    mockAuthorizedOwner();
    listEquipment.mockResolvedValue([]);
    listSetupResource.mockResolvedValue([]);

    renderNativeRouterAt(["/mobile"]);
    await screen.findByText("Mobile Logging");

    await userEvent.click(screen.getByRole("link", { name: "Maintenance" }));

    expect(await screen.findByText("No equipment found yet.")).toBeInTheDocument();
    expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
  });
});

describe("Native router — Maintenance equipment details (the reported bug)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("tapping an equipment card from the Maintenance tab opens its real detail page, not Mobile Home", async () => {
    // Before this fix, EquipmentTab's navigate(`/mobile/maintenance/equipment/${id}`)
    // 404'd under the native router (mounted at "/" at the time) and fell
    // through to Mobile Home via the catch-all — this is the exact
    // regression this test guards against.
    stubFetch();
    mockAuthorizedOwner();
    listEquipment.mockResolvedValue([EQUIPMENT]);
    listSetupResource.mockResolvedValue([]);
    getEquipment.mockResolvedValue(EQUIPMENT_DETAIL);
    getEquipmentHistory.mockResolvedValue([]);

    renderNativeRouterAt(["/mobile/maintenance"]);

    const card = await screen.findByText("Boom Sprayer");
    await userEvent.click(card.closest("button")!);

    await waitFor(() => expect(getEquipment).toHaveBeenCalledWith("eq-1"));
    expect(await screen.findByText("SPRAY-001")).toBeInTheDocument();
    expect(screen.queryByText("Mobile Logging")).not.toBeInTheDocument();
    expect(screen.queryByText("No equipment found yet.")).not.toBeInTheDocument();
  });
});

function GoBackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Test: go back
    </button>
  );
}

describe("Native router — browser/back navigation", () => {
  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("going back from a destination page returns to Mobile Home, staying within /mobile", async () => {
    stubFetch();
    mockAuthorizedOwner();

    render(
      <MemoryRouter initialEntries={["/mobile", "/mobile/daily-yield"]} initialIndex={1}>
        <GoBackButton />
        <NativeRouterTree />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Daily Yield" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Test: go back" }));

    expect(await screen.findByText("Mobile Logging")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Daily Yield" })).not.toBeInTheDocument();
  });
});

describe("native/deepLinks.ts — extractInAppPath normalizes to the /mobile-mounted router", () => {
  it("passes an already-\"/mobile\"-prefixed universal link straight through", () => {
    expect(extractInAppPath("https://growlinkclient-production.up.railway.app/mobile/maintenance")).toBe("/mobile/maintenance");
  });

  it("prefixes a bare custom-scheme path (no /mobile) with /mobile", () => {
    expect(extractInAppPath("growlink:///maintenance/equipment/eq-1")).toBe("/mobile/maintenance/equipment/eq-1");
  });

  it("resolves a root deep link ( \"/\" ) to \"/mobile\" directly", () => {
    expect(extractInAppPath("growlink://")).toBe("/mobile");
    expect(extractInAppPath("https://growlinkclient-production.up.railway.app/")).toBe("/mobile");
  });

  it("preserves a query string on an already-prefixed path", () => {
    expect(extractInAppPath("https://growlinkclient-production.up.railway.app/mobile/calibration?deviceId=abc")).toBe(
      "/mobile/calibration?deviceId=abc"
    );
  });

  it("returns null for an unparseable URL rather than throwing", () => {
    expect(extractInAppPath("not a url")).toBeNull();
  });
});
