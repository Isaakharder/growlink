import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useRoutes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The compact workspace's Overview and Yield by Color pages: the same
// endpoints and shared calculations as the desktop Dashboard, and their
// loading, empty, stale, error and no-access states.
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" } }));
vi.mock("../../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: true, can: () => true, canAny: () => true })
}));
vi.mock("../../../contexts/MembershipContext", () => ({
  MembershipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMembership: () => ({ role: "owner", permissions: {} })
}));
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children) ? cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 800, height: 400 }) : <>{children}</>
  };
});

type Reply = { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;
const server = vi.hoisted(() => ({ calls: [] as string[], override: {} as Record<string, () => unknown> }));
vi.mock("../../../lib/api", () => ({
  getBackendHealth: () => Promise.resolve({ success: true }),
  getForecastingStatus: () => Promise.resolve({ success: true }),
  getOrganizationId: () => Promise.resolve("org-1"),
  apiFetch: async (path: string) => {
    server.calls.push(path);
    const reply = await ((server.override[path]?.() ?? { status: 200, body: FIXTURES[path] ?? [] }) as Reply);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  }
}));

const reading = (volume_ml: number | null, dripper_count?: number) => ({ id: "r", name: "r", volume_ml, dripper_count });
const log = (group_key: string, log_date: string, fields: Record<string, unknown>) => ({
  id: group_key + log_date, log_date, group_key, group_id: group_key, feed_ec: null, feed_ph: null, drain_ec: null, drain_ph: null,
  feed_valve_readings: [], drain_bucket_readings: [], ...fields
});
const FIXTURES: Record<string, unknown> = {
  "/api/irrigation-setup": {
    groups: [
      { id: "p1", type: "phase", name: "Phase 1", status: "active" },
      { id: "z1", type: "zone", name: "Zone A", status: "active" },
      { id: "z2", type: "zone", name: "Zone B", status: "active" },
      { id: "z3", type: "zone", name: "Zone C — long name that wraps on a narrow phone", status: "active" }
    ]
  },
  "/api/irrigation/logs?days=365": [
    log("z1", "2026-08-11", {
      feed_ec: 2.456, feed_ph: 5.8, drain_ec: 3.14159,
      feed_valve_readings: [reading(100, 2), reading(300, 1)], drain_bucket_readings: [reading(30, 2), reading(45, 3)]
    }),
    log("z1", "2026-08-04", { feed_ec: 9 }),
    log("z2", "", { feed_ec: 1, feed_valve_readings: [reading(250, 0)] })
  ],
  "/api/varieties": [
    { id: "va", name: "Red A", color: "red", area_m2: 1000, status: "active" },
    { id: "vb", name: "Red B", color: "red", area_m2: 500, status: "active" },
    { id: "vc", name: "Orange", color: "orange", area_m2: 0, status: "active" },
    { id: "vd", name: "Old Yellow", color: "yellow", area_m2: 800, status: "inactive" },
    { id: "ve", name: "Green", color: "green", area_m2: 400, status: "active" }
  ],
  "/api/yield-entries": [
    ...[25, 26, 27, 28, 29].map((week) => ({ variety_id: "va", year: 2026, week, total_kg: 100 })),
    { variety_id: "va", year: 2026, week: 30, total_kg: 1000 },
    { variety_id: "vd", year: 2026, week: 30, total_kg: 300 },
    { variety_id: "va", year: 2026, week: 31, total_kg: 1500.5 },
    { variety_id: "vc", year: 2026, week: 31, total_kg: 200 },
    { variety_id: "ve", year: 2026, week: 31, total_kg: 100 },
    { variety_id: "vb", year: 2026, week: 32, total_kg: 12345.678 }
  ],
  "/api/color-case-entries": [
    { color: "red", total_cases: 100, case_weight_kg: 5, total_kg: 500 },
    { color: "green", total_cases: 10, case_weight_kg: 5, total_kg: 60 }
  ]
};

import { workspaceRoute } from "../workspaceRoutes";
import { DashboardPage } from "../../DashboardPage";

function App() {
  return useRoutes([{ ...workspaceRoute, path: "/workspace" }]);
}
function renderAt(path: string) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
  return { user, ...view };
}
const PAGE_NAME = /^(Overview|Yield by Color)$/;
const page = () => screen.getByRole("region", { name: PAGE_NAME });
// The page is a lazy chunk: wait for it before querying inside it.
const findPage = () => screen.findByRole("region", { name: PAGE_NAME });
const status = () => within(page()).getByRole("status");
const refreshButton = (title: string) => within(page()).getByRole("button", { name: `Refresh ${title}` });
function deferred() {
  let resolve!: (v: { status: number; body?: unknown }) => void;
  const promise = new Promise<{ status: number; body?: unknown }>((r) => (resolve = r));
  return { promise, resolve };
}
const cardValues = (card: HTMLElement) =>
  Object.fromEntries(Array.from(card.querySelectorAll(".iosws-metric")).map((m) => [m.querySelector("dt")!.textContent, m.querySelector("dd")!.textContent]));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 12, 9, 30));
  server.calls.length = 0;
  server.override = {};
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Overview", () => {
  it("shows a loading state, then one card per active group of the tracking mode, from the Dashboard's endpoints", async () => {
    const setup = deferred();
    server.override["/api/irrigation-setup"] = () => setup.promise;
    renderAt("/workspace/overview");
    await waitFor(() => expect(status()).toHaveTextContent("Loading greenhouse readings…"));
    expect(page()).toHaveAttribute("aria-busy", "true");
    expect(refreshButton("Overview")).toBeDisabled();
    expect(refreshButton("Overview")).toHaveTextContent("Loading…");
    setup.resolve({ status: 200, body: FIXTURES["/api/irrigation-setup"] });

    const list = await within(page()).findByRole("list", { name: "Greenhouse Snapshot" });
    expect(server.calls.sort()).toEqual(["/api/irrigation-setup", "/api/irrigation/logs?days=365"]);
    expect(page()).toHaveAttribute("aria-busy", "false");
    expect(status()).toHaveTextContent("Updated 9:30 AM");
    expect(within(page()).getByRole("heading", { level: 3, name: "Greenhouse Snapshot · by zone" })).toBeInTheDocument();
    const cards = within(list).getAllByRole("listitem");
    expect(cards.map((c) => within(c).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Zone A",
      "Zone B",
      "Zone C — long name that wraps on a narrow phone"
    ]);
    expect(cards[0]).toHaveAccessibleName("Zone A");
    expect(cardValues(cards[0])).toEqual({ "Feed EC": "2.46", "Feed pH": "5.8", "Drain EC": "3.14", "Drain pH": "—", "Avg Feed ml": "200", "Drain %": "8.57%" });
    expect(cards[0]).toHaveTextContent("Last reading 2026-08-11");
    expect(cards[1]).toHaveTextContent("Last reading —");
    expect(cards[2]).toHaveTextContent("Last reading No readings yet");
  });

  it("shows exactly the values the desktop Dashboard shows for the same data", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    await screen.findByText("Zone A");
    const desktop = Array.from(document.querySelectorAll("article.dashboard-snapshot-card")).map((a) => ({
      name: a.querySelector("h3")!.textContent,
      values: Object.fromEntries(
        Array.from(a.querySelectorAll(".dashboard-snapshot-metric")).map((m) => [
          m.querySelector(".dashboard-snapshot-label")!.textContent,
          m.querySelector(".dashboard-snapshot-value")!.textContent
        ])
      ),
      last: a.querySelector(".dashboard-snapshot-date")!.textContent
    }));
    cleanup();

    renderAt("/workspace/overview");
    const list = await within(page()).findByRole("list", { name: "Greenhouse Snapshot" });
    const compact = within(list).getAllByRole("listitem").map((c) => ({
      name: within(c).getByRole("heading", { level: 3 }).textContent,
      values: cardValues(c),
      last: c.querySelector(".iosws-card-foot span:last-child")!.textContent
    }));
    expect(compact).toEqual(desktop);
  });

  it("shows an empty state when there are no active irrigation groups", async () => {
    server.override["/api/irrigation-setup"] = () => ({ status: 200, body: { groups: [{ id: "x", type: "zone", name: "Old", status: "inactive" }] } });
    renderAt("/workspace/overview");
    expect(await within(page()).findByText("No active irrigation groups yet. Add them in Irrigation Setup on the desktop app.")).toHaveClass("iosws-empty");
  });

  it("shows an error with Try again, which reloads", async () => {
    server.override["/api/irrigation/logs?days=365"] = () => ({ status: 500 });
    const { user } = renderAt("/workspace/overview");
    const alert = await within(page()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load greenhouse readings. Check your connection and try again.");
    expect(within(page()).queryByRole("list")).toBeNull();
    delete server.override["/api/irrigation/logs?days=365"];
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(page()).findByRole("list", { name: "Greenhouse Snapshot" })).toBeInTheDocument();
    expect(within(page()).queryByRole("alert")).toBeNull();
  });

  it("says so, without a retry, when the server denies irrigation access", async () => {
    server.override["/api/irrigation-setup"] = () => ({ status: 403, body: { message: "Forbidden" } });
    renderAt("/workspace/overview");
    const alert = await within(page()).findByRole("alert");
    expect(alert).toHaveTextContent("You don't have access to irrigation readings.");
    expect(alert).toHaveClass("iosws-notice-forbidden");
    expect(within(alert).queryByRole("button")).toBeNull();
  });

  it("keeps the last data on screen, marked stale, when a refresh fails", async () => {
    const { user } = renderAt("/workspace/overview");
    await within(page()).findByRole("list", { name: "Greenhouse Snapshot" });
    vi.setSystemTime(new Date(2026, 7, 12, 9, 45));
    server.override["/api/irrigation-setup"] = () => ({ status: 503 });
    await user.click(refreshButton("Overview"));
    const alert = await within(page()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't refresh. Showing data from 9:30 AM.");
    expect(alert).toHaveClass("iosws-notice-stale");
    expect(within(page()).getByRole("list", { name: "Greenhouse Snapshot" }).closest(".iosws-body")).toHaveClass("iosws-body-stale");
    // A later successful refresh clears it.
    delete server.override["/api/irrigation-setup"];
    await user.click(refreshButton("Overview"));
    await waitFor(() => expect(status()).toHaveTextContent("Updated 9:45 AM"));
    expect(within(page()).queryByRole("alert")).toBeNull();
  });
});

describe("Yield by Color", () => {
  it("shows the four colours with the same kg/m², shipped and share values as the desktop Dashboard", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(document.querySelectorAll(".dashboard-yield-color-pill")).toHaveLength(4));
    await waitFor(() => expect(document.querySelector(".dashboard-pie-legend-value")).not.toBeNull());
    const desktopPills = Array.from(document.querySelectorAll(".dashboard-yield-color-pill")).map((p) =>
      Array.from(p.querySelectorAll(".dashboard-yield-color-metric-value")).map((v) => v.textContent)
    );
    const desktopShares = Array.from(document.querySelectorAll(".dashboard-pie-legend-value")).map((e) => e.textContent!.split("| ")[1]);
    cleanup();
    server.calls.length = 0;

    renderAt("/workspace/yield-by-color");
    await findPage();
    const grid = await within(page()).findByRole("list", { name: "Yield by color" });
    const cards = within(grid).getAllByRole("listitem");
    expect(cards.map((c) => c.getAttribute("aria-labelledby") && within(c).getByRole("heading", { level: 3 }).textContent)).toEqual(["Red", "Orange", "Yellow", "Green"]);
    expect(cards.map((c) => [cardValues(c).Harvested, cardValues(c).Shipped])).toEqual(desktopPills);
    expect(cards.map((c) => cardValues(c)["Total picked"].split(" · ")[1])).toEqual(desktopShares);
    // Red: 15,346.178 kg over 1,500 m²; 500 kg shipped; 15,346.178 of 15,646.178 kg picked.
    expect(cardValues(cards[0])).toEqual({ Harvested: "10.23 kg/m2", Shipped: "0.33 kg/m2", "Total picked": "15,346.18 kg · 98.1%" });
    expect(cardValues(cards[3])).toEqual({ Harvested: "0.25 kg/m2", Shipped: "0.15 kg/m2", "Total picked": "100 kg · 0.6%" });
    expect(cardValues(cards[1])).toEqual({ Harvested: "—", Shipped: "—", "Total picked": "200 kg · 1.3%" });
    expect(server.calls.sort()).toEqual(["/api/color-case-entries", "/api/varieties", "/api/yield-entries"]);
    // The share bar is decorative: its value is in the text.
    expect(cards[0].querySelector(".iosws-share")).toHaveAttribute("aria-hidden", "true");
  });

  it("lists the last six weeks, newest first, with each colour's kg, including inactive varieties like the desktop chart", async () => {
    renderAt("/workspace/yield-by-color");
    await findPage();
    const weeks = await within(page()).findByRole("list", { name: "Kg by color, last 6 weeks" });
    const rows = within(weeks).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("heading", { level: 4 }).textContent)).toEqual([
      "Week 32 · 2026",
      "Week 31 · 2026",
      "Week 30 · 2026",
      "Week 29 · 2026",
      "Week 28 · 2026",
      "Week 27 · 2026"
    ]);
    const values = (row: HTMLElement) => Array.from(row.querySelectorAll(".iosws-week-value")).map((v) => v.textContent);
    expect(values(rows[0])).toEqual(["Red12,345.68 kg"]);
    expect(values(rows[1])).toEqual(["Red1,500.5 kg", "Orange200 kg", "Green100 kg"]);
    expect(values(rows[2])).toEqual(["Red1,000 kg", "Yellow300 kg"]);
  });

  it("shows an empty state when no yield is recorded", async () => {
    server.override["/api/yield-entries"] = () => ({ status: 200, body: [] });
    server.override["/api/color-case-entries"] = () => ({ status: 200, body: [] });
    renderAt("/workspace/yield-by-color");
    await findPage();
    expect(await within(page()).findByText("No yield recorded yet.")).toHaveClass("iosws-empty");
  });

  it("says so when the server denies any of its three endpoints", async () => {
    server.override["/api/color-case-entries"] = () => ({ status: 403 });
    renderAt("/workspace/yield-by-color");
    await findPage();
    expect(await within(page()).findByRole("alert")).toHaveTextContent(
      "You don't have access to yield by color. It needs yield, varieties and cases access."
    );
  });

  it("shows an error when a request fails", async () => {
    server.override["/api/varieties"] = () => Promise.reject(new TypeError("Failed to fetch"));
    renderAt("/workspace/yield-by-color");
    await findPage();
    expect(await within(page()).findByRole("alert")).toHaveTextContent("Couldn't load yield by color. Check your connection and try again.");
  });
});

describe("moving between pages", () => {
  it("shows the last data at once while it refreshes, and forgets it when the workspace closes", async () => {
    const { user, unmount } = renderAt("/workspace/overview");
    await within(page()).findByRole("list", { name: "Greenhouse Snapshot" });
    await user.click(screen.getByRole("link", { name: "Yield by Color" }));
    await within(page()).findByRole("list", { name: "Yield by color" });

    const slow = deferred();
    server.override["/api/irrigation-setup"] = () => slow.promise;
    await user.click(screen.getByRole("link", { name: "Overview" }));
    // Cached cards straight away, marked as refreshing.
    expect(await within(page()).findByRole("list", { name: "Greenhouse Snapshot" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Refreshing… Showing data from 9:30 AM.");
    expect(refreshButton("Overview")).toBeDisabled();
    expect(refreshButton("Overview")).toHaveTextContent("Refreshing…");
    slow.resolve({ status: 200, body: FIXTURES["/api/irrigation-setup"] });
    await waitFor(() => expect(status()).toHaveTextContent("Updated 9:30 AM"));

    unmount();
    const again = deferred();
    server.override["/api/irrigation-setup"] = () => again.promise;
    renderAt("/workspace/overview");
    await waitFor(() => expect(status()).toHaveTextContent("Loading greenhouse readings…"));
    expect(within(page()).queryByRole("list")).toBeNull();
    again.resolve({ status: 200, body: FIXTURES["/api/irrigation-setup"] });
  });

  it("leaves Yield, Cases and CSV Imports as placeholders", async () => {
    const { user } = renderAt("/workspace/overview");
    for (const label of ["Yield", "Cases", "CSV Imports"]) {
      await user.click(screen.getByRole("link", { name: label, exact: true }));
      expect(await screen.findByText("Coming soon to the compact workspace.")).toBeInTheDocument();
    }
  });
});

describe("page styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`))![1];
  };
  it("gives Refresh and Try again 44pt targets, and lets narrow phones fall back to one column", () => {
    expect(rule(".iosws-refresh,\n.iosws-retry")).toMatch(/min-width:\s*44px/);
    expect(rule(".iosws-refresh,\n.iosws-retry")).toMatch(/min-height:\s*44px/);
    expect(rule(".iosws-color-grid")).toMatch(/minmax\(min\(100%, 11em\), 1fr\)/);
    expect(rule(".iosws-metrics")).toMatch(/repeat\(auto-fit, minmax\(min\(100%, 5em\), 1fr\)\)/);
    expect(rule(".iosws-page-header")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".iosws-week-value")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".iosws-card,\n.iosws-week")).toMatch(/min-width:\s*0/);
  });
});
