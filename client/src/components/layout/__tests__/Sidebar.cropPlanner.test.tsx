import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useRoutes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Crop Planner is an expandable menu: Plants (planting cards), Plans (the
// draft season planner, kept until Plants replaces it) and Varieties (the
// former Setup → Varieties Setup page). The map builder lives in Setup → Map.
let allowed: (key: string) => boolean = () => true;
vi.mock("../../../lib/supabase", () => ({
  supabase: {
    auth: {
      signOut: async () => ({ error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } })
    }
  }
}));
vi.mock("../../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: false, can: (k: string) => allowed(k), canAny: () => true })
}));
vi.mock("../../../hooks/usePlatformAdmin", () => ({ usePlatformAdmin: () => ({ loading: false, isPlatformAdmin: false }) }));

import { Sidebar } from "../Sidebar";
import { appRouteConfig } from "../../../router/routes";

const nav = () => screen.getByRole("navigation", { name: "Main navigation" });
const trigger = (name: string) => within(nav()).getByRole("button", { name: new RegExp(`^${name}`) });

let current = { pathname: "", search: "", hash: "" };
function Harness() {
  const loc = useLocation();
  current = { pathname: loc.pathname, search: loc.search, hash: loc.hash };
  return useRoutes([{ path: "*", element: <Sidebar mobileOpen={false} onCloseMobile={() => {}} /> }]);
}
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>
  );
}

afterEach(() => {
  allowed = () => true;
});

describe("Sidebar Crop Planner menu", () => {
  it("opened directly on /crop-planner: expanded, Plants, Plans, Varieties in order, only Plans highlighted", () => {
    renderAt("/crop-planner");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("active");
    const links = within(button.parentElement!).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Plants", "/crop-planner/plants"],
      ["Plans", "/crop-planner"],
      ["Varieties", "/crop-planner/varieties"]
    ]);
    expect(links.map((l) => l.classList.contains("active"))).toEqual([false, true, false]);
  });

  it("opened directly on /crop-planner/plants: expanded, only Plants highlighted", () => {
    renderAt("/crop-planner/plants");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "true");
    const links = within(button.parentElement!).getAllByRole("link");
    expect(links.map((l) => l.classList.contains("active"))).toEqual([true, false, false]);
  });

  it("opened directly on /crop-planner/varieties: expanded, only Varieties highlighted", () => {
    renderAt("/crop-planner/varieties");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("active");
    const links = within(button.parentElement!).getAllByRole("link");
    expect(links.map((l) => l.classList.contains("active"))).toEqual([false, false, true]);
    // Setup is not the active section and no longer lists Varieties Setup.
    expect(trigger("Setup")).not.toHaveClass("active");
  });

  it("opened directly on Setup → Map: Setup expanded with Map highlighted, Crop Planner collapsed", () => {
    renderAt("/setup/map");
    const setup = trigger("Setup");
    expect(setup).toHaveAttribute("aria-expanded", "true");
    expect(within(setup.parentElement!).getByRole("link", { name: "Map" })).toHaveClass("active");
    expect(trigger("Crop Planner")).toHaveAttribute("aria-expanded", "false");
  });

  it("is collapsed elsewhere, and expands on click", async () => {
    renderAt("/yield/analytics");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(within(nav()).queryByRole("link", { name: "Plans" })).toBeNull();
    await userEvent.setup().click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(within(nav()).getByRole("link", { name: "Varieties" })).toHaveAttribute("href", "/crop-planner/varieties");
  });

  it("Setup lists Map after Greenhouse Setup, and no Varieties Setup", () => {
    renderAt("/setup/greenhouse");
    const setup = trigger("Setup");
    const labels = within(setup.parentElement!).getAllByRole("link").map((l) => l.textContent);
    expect(labels).toEqual(["Pest Control Setup", "Greenhouse Setup", "Map", "Irrigation Setup", "Products Setup", "Food Safety Setup", "Settings"]);
    expect(within(nav()).queryByText("Varieties Setup")).toBeNull();
  });

  it("shows Setup → Map only with greenhouse_setup:edit, as the map builder requires", () => {
    allowed = (k) => k !== "greenhouse_setup:edit";
    renderAt("/setup/greenhouse");
    expect(within(trigger("Setup").parentElement!).queryByRole("link", { name: "Map" })).toBeNull();
  });

  it("keeps the existing permission: hidden without greenhouse_setup:view", () => {
    allowed = (k) => k !== "greenhouse_setup:view";
    renderAt("/");
    expect(within(nav()).queryByRole("button", { name: /^Crop Planner/ })).toBeNull();
  });
});

describe("Crop Planner routes", () => {
  // "/" → RequireAuth → [no-access, AppLayout → pages]
  const appLayout = appRouteConfig.find((r) => r.path === "/")!.children!.find((r) => !r.path)!;
  const child = (path: string) => appLayout.children!.find((r) => r.path === path)!;

  it("serves Plants, Plans and Varieties behind greenhouse_setup:view, and Setup → Map behind greenhouse_setup:edit", () => {
    expect((child("setup/map").element as React.ReactElement<{ permission: string }>).props.permission).toBe("greenhouse_setup:edit");
    for (const path of ["crop-planner/plants", "crop-planner", "crop-planner/varieties"]) {
      const route = child(path);
      expect(route).toBeDefined();
      expect((route.element as React.ReactElement<{ permission: string }>).props.permission).toBe("greenhouse_setup:view");
    }
  });

  it("redirects the old /crop-planner/map URL to /setup/map, keeping ?query and #hash", async () => {
    function Routed() {
      const loc = useLocation();
      current = { pathname: loc.pathname, search: loc.search, hash: loc.hash };
      return useRoutes([{ path: "/crop-planner/map", element: child("crop-planner/map").element }, { path: "/setup/map", element: <p>map builder</p> }]);
    }
    render(
      <MemoryRouter initialEntries={["/crop-planner/map?x=1#import"]}>
        <Routed />
      </MemoryRouter>
    );
    expect(await screen.findByText("map builder")).toBeInTheDocument();
    await waitFor(() => expect(current).toEqual({ pathname: "/setup/map", search: "?x=1", hash: "#import" }));
  });

  it("redirects the old /setup/varieties URL to /crop-planner/varieties, keeping ?query and #hash", async () => {
    function Routed() {
      const loc = useLocation();
      current = { pathname: loc.pathname, search: loc.search, hash: loc.hash };
      return useRoutes([{ path: "/setup/varieties", element: child("setup/varieties").element }, { path: "/crop-planner/varieties", element: <p>new varieties page</p> }]);
    }
    render(
      <MemoryRouter initialEntries={["/setup/varieties?crop=cucumber#sizes"]}>
        <Routed />
      </MemoryRouter>
    );
    expect(await screen.findByText("new varieties page")).toBeInTheDocument();
    await waitFor(() => expect(current).toEqual({ pathname: "/crop-planner/varieties", search: "?crop=cucumber", hash: "#sizes" }));
  });
});
