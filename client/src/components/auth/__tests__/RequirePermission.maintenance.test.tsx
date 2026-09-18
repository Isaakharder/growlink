import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const canAny = vi.fn();
const can = vi.fn();
vi.mock("../../../hooks/usePermissions", () => ({ usePermissions: () => ({ canAny, can, loading: false, isOwnerOrAdmin: false }) }));
vi.mock("../../../contexts/MembershipContext", () => ({ useMembership: () => ({ role: "member", permissions: {}, loading: false, displayName: null, position: null }) }));

import { RequirePermission } from "../RequirePermission";

const MAINTENANCE_ROUTE_PERMISSION = ["mobile:maintenance", "maintenance:view", "maintenance:edit"];

describe("RequirePermission — /mobile/maintenance route guard array", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the route when the user holds ANY of the three Maintenance keys", () => {
    canAny.mockImplementation((keys: string[]) => JSON.stringify(keys) === JSON.stringify(MAINTENANCE_ROUTE_PERMISSION));
    render(
      <MemoryRouter>
        <RequirePermission permission={MAINTENANCE_ROUTE_PERMISSION}>
          <div>Maintenance Route</div>
        </RequirePermission>
      </MemoryRouter>
    );
    expect(screen.getByText("Maintenance Route")).toBeInTheDocument();
  });

  it("renders Unauthorized when the user holds none of the three keys", () => {
    canAny.mockReturnValue(false);
    render(
      <MemoryRouter>
        <RequirePermission permission={MAINTENANCE_ROUTE_PERMISSION}>
          <div>Maintenance Route</div>
        </RequirePermission>
      </MemoryRouter>
    );
    expect(screen.queryByText("Maintenance Route")).not.toBeInTheDocument();
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
  });
});
