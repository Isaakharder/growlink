import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useRoutes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Crop Planner is an expandable menu: Plans (the planner and map) first,
// Varieties (the former Setup → Varieties Setup page) second.
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
  it("opened directly on /crop-planner: expanded, Plans first and highlighted, Varieties second", () => {
    renderAt("/crop-planner");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("active");
    const links = within(button.parentElement!).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Plans", "/crop-planner"],
      ["Varieties", "/crop-planner/varieties"]
    ]);
    expect(links[0]).toHaveClass("active");
    expect(links[1]).not.toHaveClass("active");
  });

  it("opened directly on /crop-planner/varieties: expanded, only Varieties highlighted", () => {
    renderAt("/crop-planner/varieties");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("active");
    const [plans, varieties] = within(button.parentElement!).getAllByRole("link");
    expect(varieties).toHaveClass("active");
    expect(plans).not.toHaveClass("active");
    // Setup is not the active section and no longer lists Varieties Setup.
    expect(trigger("Setup")).not.toHaveClass("active");
  });

  it("opened directly on the map builder (/crop-planner/map): expanded, Plans highlighted", () => {
    renderAt("/crop-planner/map");
    const button = trigger("Crop Planner");
    expect(button).toHaveAttribute("aria-expanded", "true");
    const [plans, varieties] = within(button.parentElement!).getAllByRole("link");
    expect(plans).toHaveClass("active");
    expect(varieties).not.toHaveClass("active");
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

  it("removes Varieties Setup from Setup; the other Setup pages stay", () => {
    renderAt("/setup/greenhouse");
    const setup = trigger("Setup");
    const labels = within(setup.parentElement!).getAllByRole("link").map((l) => l.textContent);
    expect(labels).toEqual(["Pest Control Setup", "Greenhouse Setup", "Irrigation Setup", "Products Setup", "Food Safety Setup", "Settings"]);
    expect(within(nav()).queryByText("Varieties Setup")).toBeNull();
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

  it("serves Varieties at /crop-planner/varieties behind greenhouse_setup:view, like Plans", () => {
    for (const path of ["crop-planner", "crop-planner/varieties"]) {
      const route = child(path);
      expect(route).toBeDefined();
      expect((route.element as React.ReactElement<{ permission: string }>).props.permission).toBe("greenhouse_setup:view");
    }
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
