import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mobile Home's task cards: the same seven destinations and permission rules,
// no page heading or intro text, icons that stay out of the accessible names,
// and styles scoped to this page. Drives the real permission chain (only
// supabase is mocked), like MobileHomePage.maintenance.test.tsx.
const platform = vi.hoisted(() => ({ native: false, name: "web" }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name }
}));
const getUser = vi.fn();
const maybeSingle = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: { getUser: () => getUser(), signOut: vi.fn() },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingle() }) }) })
  }
}));
vi.mock("../../hooks/useOfflineQueue", () => ({
  useOfflineQueue: () => ({ queuePending: 0, queueFailed: 0, failureReasons: [], syncStatus: "idle", clearFailed: vi.fn() })
}));
vi.mock("../../components/mobile/OfflineBanner", () => ({ OfflineBanner: () => null }));

import { MobileLayout } from "../../components/layout/MobileLayout";
import { MobileHomePage } from "../MobileHomePage";

const ALL_TASKS = [
  ["Daily Yield", "/mobile/daily-yield"],
  ["Quality Check", "/mobile/quality-check"],
  ["Irrigation Log", "/mobile/irrigation-log"],
  ["Pest Log", "/mobile/pest-log"],
  ["Food Safety", "/mobile/food-safety"],
  ["Calibration", "/mobile/calibration"],
  ["Maintenance", "/mobile/maintenance"]
];

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/mobile"]}>
      <Routes>
        <Route path="/mobile" element={<MobileLayout />}>
          <Route index element={<MobileHomePage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
function member(role: string, permissions: Record<string, boolean>) {
  getUser.mockResolvedValue({ data: { user: { id: "u1", email: "t@example.com", user_metadata: {} } } });
  maybeSingle.mockResolvedValue({ data: { role, position: null, permissions }, error: null });
}
const tasks = () => screen.getByRole("navigation", { name: "Tasks" });
const taskLinks = () => within(within(tasks()).getByRole("list")).getAllByRole("link");

beforeEach(() => Object.assign(platform, { native: false, name: "web" }));
afterEach(() => vi.clearAllMocks());

describe("Mobile Home task cards", () => {
  it("lists all seven tasks in order, with their existing destinations, as a named list of links", async () => {
    member("owner", {});
    renderHome();
    await screen.findByRole("navigation", { name: "Tasks" });
    await waitFor(() => expect(taskLinks()).toHaveLength(7));
    expect(taskLinks().map((a) => [a.textContent, a.getAttribute("href")])).toEqual(ALL_TASKS);
    // Accessible names are exactly the labels: the icons are hidden from assistive tech.
    for (const [label] of ALL_TASKS) expect(within(tasks()).getByRole("link", { name: label })).toBeInTheDocument();
    expect(within(tasks()).getAllByRole("listitem")).toHaveLength(7);
    for (const link of taskLinks()) {
      expect(link).toHaveClass("mobile-home-task");
      for (const svg of link.querySelectorAll("svg")) expect(svg.closest("[aria-hidden='true'], svg[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("no longer shows the Mobile Logging heading or the intro sentence", async () => {
    member("owner", {});
    renderHome();
    await screen.findByRole("navigation", { name: "Tasks" });
    expect(screen.queryByText("Mobile Logging")).toBeNull();
    expect(screen.queryByText(/Choose a task to start quick mobile logging/)).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    // The app header still names the screen.
    expect(screen.getByRole("heading", { level: 1, name: "GrowLink Mobile" })).toBeInTheDocument();
  });

  it("keeps the permission rules: Irrigation and Maintenance only with access; the other five always", async () => {
    member("member", { "mobile:access": true });
    renderHome();
    await waitFor(() => expect(taskLinks().map((a) => a.textContent)).toEqual(["Daily Yield", "Quality Check", "Pest Log", "Food Safety", "Calibration"]));
  });

  it.each([
    ["mobile:irrigation", "Irrigation Log"],
    ["irrigation:view", "Irrigation Log"],
    ["irrigation:edit", "Irrigation Log"],
    ["maintenance:edit", "Maintenance"]
  ])("%s shows the %s card", async (permission, label) => {
    member("member", { "mobile:access": true, [permission]: true });
    renderHome();
    expect(await within(await screen.findByRole("navigation", { name: "Tasks" })).findByRole("link", { name: label })).toBeInTheDocument();
  });

  it.each([
    ["the web / PWA (no header Desktop button)", false, "web", false],
    ["native Android (no header Desktop button)", true, "android", false],
    ["native iOS (header Desktop button)", true, "ios", true]
  ])("on %s, as before; the bottom bar still has Home", async (_l, native, name, showsWorkspace) => {
    Object.assign(platform, { native, name });
    member("owner", {});
    renderHome();
    await screen.findByRole("navigation", { name: "Tasks" });
    expect(screen.queryByRole("link", { name: "Open Desktop workspace" }) !== null).toBe(showsWorkspace);
    const bottom = screen.getByRole("navigation", { name: "Mobile navigation" });
    expect(within(bottom).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/mobile");
    // Task cards are not inside the header or the bottom bar.
    expect(tasks().closest("header, .mobile-bottom-nav")).toBeNull();
  });
});

describe("Mobile Home task card styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
  const block = css.slice(css.indexOf("/* ── Mobile Home task cards"), css.indexOf("\n.mobile-bottom-nav {"));
  const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());

  it("are scoped to the Mobile Home classes, so other mobile cards don't change", () => {
    expect(selectors.length).toBeGreaterThan(8);
    for (const sel of selectors.filter((s) => !s.startsWith("@"))) {
      for (const part of sel.split(",")) expect(part.trim()).toMatch(/^\.mobile-home-/);
    }
    // The only at-rule is the narrow/large-text container query on the task list.
    expect(selectors.filter((s) => s.startsWith("@"))).toEqual(["@container (max-width: 12em)"]);
    // The shared .mobile-card-button styles are left as they were.
    expect(css).toMatch(/\n\.mobile-card-button \{[^}]*min-height: 72px;/);
    // The shared header only wraps its iOS Desktop button below the title when they don't fit.
    expect(css).toMatch(/\n\.mobile-header-with-action \{[^}]*flex-wrap:\s*wrap/);
  });

  it("give each card a 44pt+ target and let the label wrap with larger text", () => {
    const rule = (sel: string) => block.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))![1];
    expect(rule(".mobile-home-task")).toMatch(/min-height:\s*64px/);
    expect(rule(".mobile-home-task-label")).toMatch(/min-width:\s*0/);
    expect(rule(".mobile-home-task-label")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".mobile-home-task-label")).toMatch(/\n\s*hyphens:\s*auto/);
    expect(rule(".mobile-home-task-icon")).toMatch(/flex-shrink:\s*0/);
    expect(rule(".mobile-home-task-icon")).toMatch(/width:\s*min\(2\.75rem, 52px\)/);
  });
});
