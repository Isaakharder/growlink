import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The native iOS compact workspace shell: the header "Desktop" button,
// the icon rail, returning to Mobile, and the in-memory remembered page.
const platform = vi.hoisted(() => ({ native: true, name: "ios" }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name }
}));
const perms = vi.hoisted(() => ({ granted: new Set<string>(["mobile:access", "yield:view"]) }));
vi.mock("../../../hooks/usePermissions", () => ({
  usePermissions: () => ({
    loading: false,
    isOwnerOrAdmin: false,
    can: (p: string) => perms.granted.has(p),
    canAny: (ps: string[]) => ps.some((p) => perms.granted.has(p))
  })
}));
vi.mock("../../../lib/supabase", () => ({ supabase: { auth: { signOut: vi.fn() } } }));
vi.mock("../../../hooks/useOfflineQueue", () => ({
  useOfflineQueue: () => ({ queuePending: 0, queueFailed: 0, failureReasons: [], syncStatus: "idle", clearFailed: vi.fn() })
}));
vi.mock("../../../contexts/MembershipContext", () => ({
  MembershipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMembership: () => ({ role: "member", permissions: {} })
}));
vi.mock("../../../components/mobile/OfflineBanner", () => ({ OfflineBanner: () => null }));

import { MobileLayout } from "../../../components/layout/MobileLayout";
import { workspaceRoute } from "../workspaceRoutes";
import { resetWorkspaceMemory, WORKSPACE_SECTIONS } from "../workspaceNav";

let path = "";
function Where() {
  path = useLocation().pathname;
  return null;
}
function App() {
  return useRoutes([
    { path: "/mobile", element: <MobileLayout />, children: [{ index: true, element: <p>Mobile home page</p> }] },
    workspaceRoute
  ].map((r) => (r === workspaceRoute ? { ...r, path: "/workspace" } : r)));
}
function renderAt(start: string) {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <Where />
      <App />
    </MemoryRouter>
  );
}
const setPlatform = (native: boolean, name: string) => Object.assign(platform, { native, name });
const rail = () => screen.getByRole("navigation", { name: "Workspace pages" });
const LABELS = WORKSPACE_SECTIONS.map((s) => s.label);

beforeEach(() => {
  setPlatform(true, "ios");
  perms.granted = new Set(["mobile:access", "yield:view"]);
  resetWorkspaceMemory();
});
afterEach(() => vi.clearAllMocks());

describe("the Mobile header's Desktop button", () => {
  it("appears at the top of the signed-in native iOS app as an in-app link, not a Safari/new-tab link", () => {
    renderAt("/mobile");
    const button = screen.getByRole("link", { name: "Open Desktop workspace" });
    expect(button.closest("header")).toHaveClass("mobile-header", "mobile-header-with-action");
    expect(button).toHaveTextContent("Desktop");
    expect(button).toHaveAttribute("href", "/workspace");
    expect(button).not.toHaveAttribute("target");
    // The bottom bar keeps its native single-button layout.
    expect(screen.getByRole("navigation", { name: "Mobile navigation" }).className).toBe("mobile-bottom-nav mobile-bottom-nav-single");
  });

  it.each([
    ["the desktop web / mobile website / PWA", false, "web"],
    ["native Android", true, "android"]
  ])("is not rendered on %s", (_label, native, name) => {
    setPlatform(native, name);
    renderAt("/mobile");
    expect(screen.queryByRole("link", { name: "Open Desktop workspace" })).toBeNull();
    expect(document.querySelector(".mobile-header-workspace")).toBeNull();
    expect(document.querySelector("header")!.className).toBe("mobile-header");
  });

  it("opens the workspace in the app on its first page (Overview)", async () => {
    const user = userEvent.setup();
    renderAt("/mobile");
    await user.click(screen.getByRole("link", { name: "Open Desktop workspace" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(path).toBe("/workspace/overview");
  });
});

describe("the workspace route off native iOS", () => {
  it.each([
    ["web", false, "web"],
    ["Android", true, "android"]
  ])("redirects /workspace to Mobile Home on %s, rendering nothing of the workspace", async (_l, native, name) => {
    setPlatform(native, name);
    renderAt("/workspace/cases");
    expect(await screen.findByText("Mobile home page")).toBeInTheDocument();
    expect(path).toBe("/mobile");
    expect(screen.queryByRole("navigation", { name: "Workspace pages" })).toBeNull();
  });
});

describe("the icon rail", () => {
  it("lists the five pages in order, each with an accessible name, and marks only the current one selected", async () => {
    renderAt("/workspace/yield-by-color");
    await screen.findByRole("heading", { name: "Yield by Color" });
    const links = within(within(rail()).getByRole("list")).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual(LABELS);
    expect(links.filter((l) => l.getAttribute("aria-current") === "page").map((l) => l.getAttribute("aria-label"))).toEqual(["Yield by Color"]);
    for (const l of links) expect(l.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("switches pages in the app and moves the selected state", async () => {
    const user = userEvent.setup();
    renderAt("/workspace/overview");
    for (const label of LABELS) {
      await user.click(within(rail()).getByRole("link", { name: label }));
      expect(await screen.findByRole("heading", { name: label })).toBeInTheDocument();
      expect(within(rail()).getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
    }
    expect(path).toBe("/workspace/csv-imports");
  });

  it("hides the Yield, Cases and CSV pages from a member without yield:view, the same gate as desktop Yield Data Entry", async () => {
    perms.granted = new Set(["mobile:access"]);
    renderAt("/workspace/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const names = within(rail()).getAllByRole("link").map((l) => l.getAttribute("aria-label"));
    expect(names).toEqual(["Return to GrowLink Mobile", "Overview", "Yield by Color"]);
  });

  it("blocks a direct link to a gated page for a member without yield:view", async () => {
    perms.granted = new Set(["mobile:access"]);
    renderAt("/workspace/csv-imports");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "CSV Imports" })).toBeNull());
    expect(await screen.findByText("You don't have access to this page.")).toBeInTheDocument();
  });
});

describe("returning to Mobile, and the remembered page", () => {
  it("the rail's Mobile link returns to Mobile Home, and Desktop reopens the last page", async () => {
    const user = userEvent.setup();
    renderAt("/workspace/overview");
    await user.click(await within(rail()).findByRole("link", { name: "Cases" }));
    await screen.findByRole("heading", { name: "Cases" });
    await user.click(within(rail()).getByRole("link", { name: "Return to GrowLink Mobile" }));
    expect(await screen.findByText("Mobile home page")).toBeInTheDocument();
    expect(path).toBe("/mobile");
    await user.click(screen.getByRole("link", { name: "Open Desktop workspace" }));
    expect(await screen.findByRole("heading", { name: "Cases" })).toBeInTheDocument();
    expect(path).toBe("/workspace/cases");
  });

  it("a fresh launch forgets it (memory only, nothing in localStorage)", async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const first = renderAt("/workspace/yield");
    await screen.findByRole("heading", { name: "Yield" });
    expect(localStorage.length).toBe(0);
    first.unmount();
    resetWorkspaceMemory(); // a new app process
    renderAt("/mobile");
    await user.click(screen.getByRole("link", { name: "Open Desktop workspace" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  });

  it("an unknown workspace path goes to the remembered page", async () => {
    renderAt("/workspace/nope");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  });
});

describe("workspace styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`))![1];
  };
  it("gives every rail target and the header button at least 44pt", () => {
    for (const sel of [".iosws-rail-link", ".mobile-header-workspace"]) {
      expect(rule(sel)).toMatch(/min-height:\s*44px/);
      expect(rule(sel)).toMatch(/min-width:\s*44px/);
    }
  });
  it("follows Dynamic Type, respects every safe-area edge, and cannot scroll sideways", () => {
    expect(rule(".iosws")).toMatch(/font:\s*-apple-system-body/);
    expect(rule(".iosws")).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(rule(".iosws-rail")).toMatch(/safe-area-inset-top[\s\S]*safe-area-inset-bottom/);
    expect(rule(".iosws-rail")).toMatch(/safe-area-inset-left/);
    expect(rule(".iosws-main")).toMatch(/safe-area-inset-right/);
    expect(rule(".iosws-main")).toMatch(/overflow-x:\s*hidden/);
    expect(rule(".iosws-main")).toMatch(/min-width:\s*0/);
  });
});
