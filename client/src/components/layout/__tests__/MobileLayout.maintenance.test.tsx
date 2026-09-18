import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const canAny = vi.fn();
vi.mock("../../../hooks/usePermissions", () => ({ usePermissions: () => ({ canAny, can: vi.fn(), loading: false, isOwnerOrAdmin: false }) }));
vi.mock("../../../hooks/useOfflineQueue", () => ({
  useOfflineQueue: () => ({ queuePending: 0, queueFailed: 0, failureReasons: [], syncStatus: "idle", clearFailed: vi.fn() })
}));
vi.mock("../../../contexts/MembershipContext", async () => {
  const actual = await vi.importActual<typeof import("../../../contexts/MembershipContext")>("../../../contexts/MembershipContext");
  return { ...actual, MembershipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> };
});

import { MobileLayout } from "../MobileLayout";

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/mobile/maintenance"]}>
      <Routes>
        <Route element={<MobileLayout />}>
          <Route path="/mobile/maintenance" element={<div>Maintenance Page Content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("MobileLayout — mobile:maintenance-only access", () => {
  afterEach(() => vi.clearAllMocks());

  it("passes the shell's mobile:access gate for a user holding only mobile:maintenance", () => {
    canAny.mockImplementation((keys: string[]) => keys.includes("mobile:maintenance"));
    renderLayout();
    expect(screen.getByText("Maintenance Page Content")).toBeInTheDocument();
  });

  it("passes the shell's mobile:access gate for a user holding only maintenance:view (desktop-style key, no mobile:* key)", () => {
    canAny.mockImplementation((keys: string[]) => keys.includes("maintenance:view"));
    renderLayout();
    expect(screen.getByText("Maintenance Page Content")).toBeInTheDocument();
  });

  it("still blocks a user with none of the mobile shell's permission keys", () => {
    canAny.mockReturnValue(false);
    renderLayout();
    expect(screen.queryByText("Maintenance Page Content")).not.toBeInTheDocument();
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
  });
});
