import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const canAny = vi.fn();
vi.mock("../../hooks/usePermissions", () => ({ usePermissions: () => ({ canAny, can: vi.fn(), loading: false, isOwnerOrAdmin: false }) }));

import { MobileHomePage } from "../MobileHomePage";

describe("MobileHomePage — Maintenance card visibility", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the Maintenance card when the user holds any Maintenance permission", () => {
    canAny.mockImplementation((keys: string[]) => keys.includes("mobile:maintenance"));
    render(<MemoryRouter><MobileHomePage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Maintenance" })).toHaveAttribute("href", "/mobile/maintenance");
  });

  it("hides the Maintenance card when the user holds none of maintenance:view/edit/mobile:maintenance", () => {
    canAny.mockReturnValue(false);
    render(<MemoryRouter><MobileHomePage /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "Maintenance" })).not.toBeInTheDocument();
  });

  it("checks canAny against exactly the three Maintenance permission keys", () => {
    canAny.mockReturnValue(true);
    render(<MemoryRouter><MobileHomePage /></MemoryRouter>);
    expect(canAny).toHaveBeenCalledWith(["mobile:maintenance", "maintenance:view", "maintenance:edit"]);
  });
});
