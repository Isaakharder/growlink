import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mobile bottom bar's "Desktop" button: present on the web /mobile and
// the installed PWA, absent (not rendered at all) in native Capacitor apps.
const platform = vi.hoisted(() => ({ native: false, name: "web" }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name }
}));
const signOut = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/supabase", () => ({ supabase: { auth: { signOut } } }));
vi.mock("../../../hooks/usePermissions", () => ({ usePermissions: () => ({ canAny: () => true, can: () => true, loading: false, isOwnerOrAdmin: true }) }));
vi.mock("../../../hooks/useOfflineQueue", () => ({
  useOfflineQueue: () => ({ queuePending: 0, queueFailed: 0, failureReasons: [], syncStatus: "idle", clearFailed: vi.fn() })
}));
// Fully mocked (not importActual): the real module needs Supabase env vars.
vi.mock("../../../contexts/MembershipContext", () => ({ MembershipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../mobile/OfflineBanner", () => ({ OfflineBanner: () => null }));

import { MobileLayout } from "../MobileLayout";
import { DESKTOP_HOME } from "../../../config/platform";

let path = "";
function Where() {
  path = useLocation().pathname;
  return null;
}
function renderMobile() {
  return render(
    <MemoryRouter initialEntries={["/mobile"]}>
      <Where />
      <Routes>
        <Route path="/mobile" element={<MobileLayout />}>
          <Route index element={<p>Mobile home page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
const nav = () => screen.getByRole("navigation", { name: "Mobile navigation" });
const setPlatform = (native: boolean, name: string) => Object.assign(platform, { native, name });

beforeEach(() => {
  setPlatform(false, "web");
  localStorage.clear();
});
afterEach(() => vi.clearAllMocks());

describe("Desktop button on the web / PWA", () => {
  it("sits directly beside Home in a two-column bar, as a same-tab link to the desktop Dashboard", () => {
    renderMobile();
    const home = screen.getByRole("link", { name: "Home" });
    const desktop = screen.getByRole("link", { name: "Open GrowLink Desktop" });
    expect(home.nextElementSibling).toBe(desktop);
    expect(nav()).toHaveClass("mobile-bottom-nav", "mobile-bottom-nav-pair");
    expect(nav()).not.toHaveClass("mobile-bottom-nav-single");
    expect(desktop).toHaveTextContent("Desktop");
    expect(desktop).toHaveAttribute("href", "/");
    expect(desktop).not.toHaveAttribute("target");
    expect(desktop).toHaveClass("mobile-bottom-link", "mobile-bottom-link-desktop");
  });

  it("also appears when running as the installed PWA (display-mode: standalone)", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("standalone"), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
    );
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
    renderMobile();
    expect(screen.getByRole("link", { name: "Open GrowLink Desktop" })).toBeInTheDocument();
    matchMedia.mockRestore();
    delete (window.navigator as { standalone?: boolean }).standalone;
  });

  it("points at the real desktop Dashboard, the index of the authenticated desktop routes", async () => {
    const { appRouteConfig } = await import("../../../router/routes");
    expect(DESKTOP_HOME).toBe("/");
    const desktop = appRouteConfig.find((r) => r.path === "/")!;
    const shell = desktop.children!.find((c) => !c.path)!;
    const index = shell.children!.find((c) => c.index)!;
    expect((index.element as React.ReactElement).type).toHaveProperty("name", "DashboardPage");
  }, 20000);

  it("is a full navigation outside the in-app router: no router push, no sign-out, no new tab, session kept", async () => {
    localStorage.setItem("sb-revkaepkvgfeumtykibq-auth-token", '{"access_token":"kept"}');
    const open = vi.spyOn(window, "open");
    renderMobile();
    const desktop = screen.getByRole("link", { name: "Open GrowLink Desktop" });
    // jsdom doesn't load documents; the default action (a same-tab page load) is what a browser does.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    desktop.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(path).toBe("/mobile");
    expect(open).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(localStorage.getItem("sb-revkaepkvgfeumtykibq-auth-token")).toBe('{"access_token":"kept"}');
    open.mockRestore();
  });

  it("leaves Home unchanged", async () => {
    renderMobile();
    const home = screen.getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/mobile");
    expect(home).toHaveClass("mobile-bottom-link", "active");
    expect(home).not.toHaveClass("mobile-bottom-link-desktop");
    await userEvent.setup().click(home);
    expect(path).toBe("/mobile");
  });
});

describe.each([
  ["iOS (App Store / TestFlight)", "ios"],
  ["Android", "android"]
])("native Capacitor app: %s", (_label, name) => {
  it("does not render the Desktop button at all, and keeps the original single-button bar", () => {
    setPlatform(true, name);
    renderMobile();
    expect(screen.queryByRole("link", { name: "Open GrowLink Desktop" })).toBeNull();
    expect(document.querySelector(".mobile-bottom-link-desktop")).toBeNull();
    expect(screen.queryByText("Desktop")).toBeNull();
    // No empty slot: exactly the original markup, one Home link in one column.
    expect(nav().className).toBe("mobile-bottom-nav mobile-bottom-nav-single");
    expect(nav().children).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/mobile");
  });
});

describe("bottom bar styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`))![1];
  };
  it("pairs two equal columns only on the web, keeps the single layout for native, and respects the safe area", () => {
    expect(rule(".mobile-bottom-nav-pair")).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(rule(".mobile-bottom-nav-single")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule(".mobile-bottom-nav")).toMatch(/padding-bottom:\s*max\(0\.65rem, env\(safe-area-inset-bottom\)\)/);
    expect(rule(".mobile-bottom-link-desktop")).toMatch(/min-height:\s*44px/);
  });
});
