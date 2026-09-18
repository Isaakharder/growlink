import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Drives the REAL usePermissions -> MembershipContext -> supabase chain
// (only supabase itself is mocked) for the scenarios that must prove the
// card and the route reach the SAME conclusion from the SAME data — a
// mocked usePermissions couldn't prove that, since it would let the card
// and route disagree by construction.
const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: { getUser: () => getUser() },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => maybeSingle() })
      })
    })
  }
}));

import { MembershipProvider } from "../../contexts/MembershipContext";
import { RequirePermission } from "../../components/auth/RequirePermission";
import { MAINTENANCE_ACCESS_PERMISSIONS } from "../maintenance/access";
import { MobileHomePage } from "../MobileHomePage";

function MaintenanceRouteStub() {
  return <div>Maintenance Route Content</div>;
}

function renderAppShell(initialPath: string) {
  return render(
    <MembershipProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/mobile" element={<MobileHomePage />} />
          <Route
            path="/mobile/maintenance"
            element={
              <RequirePermission permission={MAINTENANCE_ACCESS_PERMISSIONS}>
                <MaintenanceRouteStub />
              </RequirePermission>
            }
          />
        </Routes>
      </MemoryRouter>
    </MembershipProvider>
  );
}

type MembershipFixture = { role: string; permissions: Record<string, boolean> };

function mockMembership({ role, permissions }: MembershipFixture) {
  getUser.mockResolvedValue({ data: { user: { id: "u1", email: "test@example.com", user_metadata: {} } } });
  maybeSingle.mockResolvedValue({ data: { role, position: null, permissions }, error: null });
}

describe("MobileHomePage — Maintenance card visibility (real permission chain)", () => {
  afterEach(() => vi.clearAllMocks());

  it("1. a user authorized for the Maintenance route (explicit maintenance:edit) sees the Home card", async () => {
    mockMembership({ role: "member", permissions: { "maintenance:edit": true } });
    renderAppShell("/mobile");
    expect(await screen.findByRole("link", { name: "Maintenance" })).toHaveAttribute("href", "/mobile/maintenance");
  });

  it("2. an Administrator recognized through the existing org owner/admin bypass sees the card", async () => {
    mockMembership({ role: "owner", permissions: {} });
    renderAppShell("/mobile");
    expect(await screen.findByRole("link", { name: "Maintenance" })).toBeInTheDocument();
  });

  it("3. a user without any Maintenance access sees no card", async () => {
    mockMembership({ role: "member", permissions: { "yield:view": true } });
    renderAppShell("/mobile");
    await waitFor(() => expect(screen.queryByRole("heading", { name: /mobile logging/i })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Maintenance" })).not.toBeInTheDocument();
  });

  it("5. the card appears once asynchronous permission data finishes loading (not stuck absent)", async () => {
    let resolveMembership: (value: { data: unknown; error: null }) => void;
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "test@example.com", user_metadata: {} } } });
    maybeSingle.mockReturnValue(
      new Promise((resolve) => {
        resolveMembership = resolve;
      })
    );

    renderAppShell("/mobile");
    // Not asserting absence pre-resolution: usePermissions.canAny is
    // deliberately optimistic (true) while loading, so the card doesn't
    // flash away then back for the common authorized case — see its own
    // comment. What matters is that it's correctly present once loading
    // genuinely completes.
    resolveMembership!({ data: { role: "member", position: null, permissions: { "mobile:maintenance": true } }, error: null });

    expect(await screen.findByRole("link", { name: "Maintenance" })).toBeInTheDocument();
  });

  describe("4. card and route authorization cannot disagree", () => {
    const scenarios: Array<{ name: string; fixture: MembershipFixture; expectAccess: boolean }> = [
      { name: "owner role", fixture: { role: "owner", permissions: {} }, expectAccess: true },
      { name: "admin role", fixture: { role: "admin", permissions: {} }, expectAccess: true },
      { name: "member with mobile:maintenance", fixture: { role: "member", permissions: { "mobile:maintenance": true } }, expectAccess: true },
      { name: "member with maintenance:view", fixture: { role: "member", permissions: { "maintenance:view": true } }, expectAccess: true },
      { name: "member with maintenance:edit", fixture: { role: "member", permissions: { "maintenance:edit": true } }, expectAccess: true },
      { name: "member with unrelated permissions only", fixture: { role: "member", permissions: { "yield:view": true, "pest:edit": true } }, expectAccess: false },
      { name: "member with no permissions at all", fixture: { role: "member", permissions: {} }, expectAccess: false }
    ];

    it.each(scenarios)("$name: card presence matches route accessibility", async ({ fixture, expectAccess }) => {
      mockMembership(fixture);
      const { unmount } = renderAppShell("/mobile");
      await waitFor(() => expect(screen.queryByRole("heading", { name: /mobile logging/i })).toBeInTheDocument());
      const cardVisible = screen.queryByRole("link", { name: "Maintenance" }) !== null;
      unmount();

      renderAppShell("/mobile/maintenance");
      const routeAccessible = await (async () => {
        if (expectAccess) return Boolean(await screen.findByText("Maintenance Route Content"));
        await waitFor(() => expect(screen.queryByText(/don't have access/i)).toBeInTheDocument());
        return false;
      })();

      expect(cardVisible).toBe(expectAccess);
      expect(routeAccessible).toBe(expectAccess);
      expect(cardVisible).toBe(routeAccessible);
    });
  });

  it("6. clicking the Maintenance card navigates to and renders the Maintenance route", async () => {
    mockMembership({ role: "owner", permissions: {} });
    renderAppShell("/mobile");

    const card = await screen.findByRole("link", { name: "Maintenance" });
    await userEvent.click(card);

    expect(await screen.findByText("Maintenance Route Content")).toBeInTheDocument();
  });
});
