import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate, useNavigationType, useRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar's "Mobile" link: in-app navigation to the existing /mobile
// home, keeping the session, and Back returning to the desktop page.
const signOut = vi.fn(async () => ({ error: null }));
const getSession = vi.fn();
const getUser = vi.fn();
vi.mock("../../../lib/supabase", () => ({
  supabase: {
    auth: {
      signOut: () => signOut(),
      getSession: () => getSession(),
      getUser: () => getUser(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } })
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) })
  }
}));
vi.mock("../../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: true, can: () => true, canAny: () => true })
}));
vi.mock("../../../hooks/usePlatformAdmin", () => ({ usePlatformAdmin: () => ({ loading: false, isPlatformAdmin: false }) }));

import { Sidebar } from "../Sidebar";
import { appRouteConfig } from "../../../router/routes";

const onCloseMobile = vi.fn();
// MemoryRouter + useRoutes, like the other route tests: a data router's
// navigation hits a jsdom/undici AbortSignal incompatibility.
let location = { pathname: "", action: "" };
function Harness() {
  const loc = useLocation();
  const action = useNavigationType();
  location = { pathname: loc.pathname, action };
  const navigate = useNavigate();
  const element = useRoutes([
    { path: "/yield/analytics", element: <><Sidebar mobileOpen={false} onCloseMobile={onCloseMobile} /><p>Desktop Yield Analytics</p></> },
    { path: "/mobile", element: <p>Mobile home</p> }
  ]);
  return (
    <>
      {element}
      <button type="button" onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}
function renderDesktop() {
  return render(
    <MemoryRouter initialEntries={["/yield/analytics"]}>
      <Harness />
    </MemoryRouter>
  );
}

beforeEach(() => {
  getSession.mockResolvedValue({ data: { session: null }, error: null });
  getUser.mockResolvedValue({ data: { user: null }, error: null });
});
afterEach(() => vi.clearAllMocks());

describe("Sidebar Mobile link", () => {
  it("sits directly below Log out, as a same-tab link to /mobile", () => {
    renderDesktop();
    const logout = screen.getByRole("button", { name: "Log out" });
    const mobile = screen.getByRole("link", { name: "Open GrowLink Mobile" });
    expect(logout.nextElementSibling).toBe(mobile);
    expect(mobile).toHaveAttribute("href", "/mobile");
    expect(mobile).not.toHaveAttribute("target");
    expect(mobile).toHaveTextContent("Mobile");
    expect(mobile).toHaveClass("sidebar-mobile-link");
  });

  it("navigates in-app without signing out, and Back returns to the desktop page", async () => {
    const open = vi.spyOn(window, "open");
    const user = userEvent.setup();
    renderDesktop();
    await user.click(screen.getByRole("link", { name: "Open GrowLink Mobile" }));

    expect(await screen.findByText("Mobile home")).toBeInTheDocument();
    expect(location).toEqual({ pathname: "/mobile", action: "PUSH" });
    expect(signOut).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Browser back" }));
    expect(await screen.findByText("Desktop Yield Analytics")).toBeInTheDocument();
    expect(location).toEqual({ pathname: "/yield/analytics", action: "POP" });
    open.mockRestore();
  });

  it("leaves Log out unchanged: it still signs out", async () => {
    renderDesktop();
    await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
});

describe("/mobile in the real route config", () => {
  let currentPath = "";
  function Routed() {
    currentPath = useLocation().pathname;
    return useRoutes(appRouteConfig);
  }

  it("is the existing mobile home: RequireAuth, then MobileLayout with an index page", () => {
    const route = appRouteConfig.find((r) => r.path === "/mobile")!;
    expect(route).toBeDefined();
    const layout = route.children![0];
    expect(layout.children!.some((c) => c.index)).toBe(true);
  });

  it("signed out, /mobile still follows the existing auth rule and redirects to login", async () => {
    render(
      <MemoryRouter initialEntries={["/mobile"]}>
        <Routed />
      </MemoryRouter>
    );
    await waitFor(() => expect(currentPath).not.toBe("/mobile"));
    expect(currentPath).toMatch(/login/);
    expect(getSession).toHaveBeenCalled();
  });
});

describe("Sidebar footer styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
  it("keep both footer controls at a 44 px touch target, styled only within the sidebar controls", () => {
    expect(css).toMatch(/\.sidebar-footer \.sidebar-logout,\s*\.sidebar-footer \.sidebar-mobile-link \{[^}]*min-height:\s*44px/);
    const block = css.match(/\n\.sidebar-mobile-link \{([^}]*)\}/)![1];
    expect(block).toMatch(/width:\s*100%/);
    expect(block).toMatch(/border-radius:\s*10px/);
    expect(block).toMatch(/background:\s*var\(--brand-soft\)/);
    // Every new rule targets the sidebar footer controls only.
    const rules = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)).map((m) => m[1].trim()).filter((sel) => sel.includes("sidebar-mobile-link"));
    for (const sel of rules) for (const part of sel.split(",")) expect(part.trim()).toMatch(/^\.sidebar-(footer|mobile-link)/);
  });
});
