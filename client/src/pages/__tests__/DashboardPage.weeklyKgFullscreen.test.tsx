import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Dashboard "Weekly kg by Color": full-screen view (the shared
// FullscreenChart component) and line-only rendering. jsdom does no layout,
// so ResponsiveContainer is given a fixed size; everything inside is the
// real Recharts output.
const calls: string[] = [];
vi.mock("../../lib/api", () => ({
  getBackendHealth: () => Promise.resolve({ ok: true }),
  getForecastingStatus: () => Promise.resolve({ ok: true }),
  getOrganizationId: () => Promise.resolve("org-1"),
  apiFetch: (path: string) => {
    calls.push(path);
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path) });
  }
}));
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: true, can: () => true, canAny: () => true })
}));
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children, width, height }: { children: ReactNode; width: string | number; height: string | number }) => (
      <div data-testid="responsive-container" data-width={String(width)} data-height={String(height)}>
        {isValidElement(children) ? cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 800, height: 400 }) : children}
      </div>
    )
  };
});

import { DashboardPage } from "../DashboardPage";

const YEAR = 2026;
const VARIETIES = [
  { id: "v-red", name: "Cadalora", color: "red", area_m2: 1000, case_kg: 5, status: "active" },
  { id: "v-orange", name: "Silverstone", color: "orange", area_m2: 1000, case_kg: 5, status: "active" },
  { id: "v-yellow", name: "Levente Phase 2", color: "yellow", area_m2: 1000, case_kg: 5, status: "active" },
  { id: "v-green", name: "Green trial", color: "green", area_m2: 1000, case_kg: 5, status: "active" }
];
const ENTRIES = [30, 31, 32, 33].flatMap((week, i) => [
  { id: `r${week}`, variety_id: "v-red", year: YEAR, week, total_kg: 30000 + i * 1000, size_kg: {} },
  { id: `o${week}`, variety_id: "v-orange", year: YEAR, week, total_kg: 15000 + i * 800, size_kg: {} },
  { id: `y${week}`, variety_id: "v-yellow", year: YEAR, week, total_kg: 9000 + i * 500, size_kg: {} },
  // Green is recorded but always zero: it must stay a plain line at 0.
  { id: `g${week}`, variety_id: "v-green", year: YEAR, week, total_kg: 0, size_kg: {} }
]);
function route(path: string) {
  if (path === "/api/yield-entries") return ENTRIES;
  if (path === "/api/varieties") return VARIETIES;
  return [];
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  document.body.style.overflow = "";
});
afterEach(() => vi.clearAllMocks());

const TITLE = "Weekly kg by Color";
const weeklyCard = () => screen.getByRole("heading", { name: TITLE }).closest("section") as HTMLElement;
const pieCard = () => screen.getByRole("heading", { name: "Total Picked by Color" }).closest("section") as HTMLElement;

async function renderDashboard() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
  await screen.findByRole("button", { name: `Expand ${TITLE} graph` });
  return user;
}

describe("Dashboard Weekly kg by Color — full-screen view", () => {
  it("has its own Expand button in the card header, and is the only chart that does", async () => {
    await renderDashboard();
    const button = within(weeklyCard()).getByRole("button", { name: `Expand ${TITLE} graph` });
    expect(button).toHaveClass("csv-tb-btn", "chart-expand-button");
    expect(button.parentElement).toHaveClass("dashboard-trend-panel-header", "dashboard-trend-panel-header--with-action");
    expect(screen.getAllByRole("button", { name: /^Expand .* graph$/ })).toHaveLength(1);
  });

  it("opens full-screen with its title, axes, legend and all four colour series", async () => {
    const user = await renderDashboard();
    await user.click(within(weeklyCard()).getByRole("button", { name: `Expand ${TITLE} graph` }));
    const dialog = await screen.findByRole("dialog", { name: TITLE });
    expect(dialog).toHaveClass("chart-fullscreen");
    expect(dialog.closest("main, section")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close full-screen graph" })).toBeInTheDocument();
    expect(dialog.querySelectorAll(".recharts-line")).toHaveLength(4);
    expect(dialog.querySelectorAll(".recharts-cartesian-axis")).toHaveLength(2);
    const legend = dialog.querySelector(".recharts-legend-wrapper")!;
    for (const name of ["Red", "Orange", "Yellow", "Green"]) expect(legend).toHaveTextContent(name);
    const container = within(dialog).getByTestId("responsive-container");
    expect(container.parentElement).toHaveClass("chart-fullscreen-body");
    expect(container).toHaveAttribute("data-height", "100%");
  });

  it("Close and Escape dismiss it, restore focus and page scrolling, and the card chart is back at its size", async () => {
    const user = await renderDashboard();
    const expand = within(weeklyCard()).getByRole("button", { name: `Expand ${TITLE} graph` });
    const cardPaths = () => Array.from(weeklyCard().querySelectorAll(".recharts-line-curve")).map((p) => p.getAttribute("d"));
    const before = cardPaths();
    expect(within(weeklyCard()).getByTestId("responsive-container")).toHaveAttribute("data-height", "280");

    await user.click(expand);
    await screen.findByRole("dialog", { name: TITLE });
    expect(document.body.style.overflow).toBe("hidden");
    await user.click(screen.getByRole("button", { name: "Close full-screen graph" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(expand).toHaveFocus());
    expect(document.body.style.overflow).toBe("");

    await user.click(expand);
    await screen.findByRole("dialog", { name: TITLE });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(expand).toHaveFocus());
    expect(document.body.style.overflow).toBe("");

    expect(within(weeklyCard()).getByTestId("responsive-container")).toHaveAttribute("data-height", "280");
    expect(cardPaths()).toEqual(before);
  });

  it("opening and closing make no API request", async () => {
    const user = await renderDashboard();
    await waitFor(() => expect(calls).toContain("/api/yield-entries"));
    const before = calls.length;
    await user.click(within(weeklyCard()).getByRole("button", { name: `Expand ${TITLE} graph` }));
    await screen.findByRole("dialog", { name: TITLE });
    await user.keyboard("{Escape}");
    expect(calls.length).toBe(before);
  });
});

describe("Dashboard Weekly kg by Color — lines without point markers", () => {
  it("renders no normal or active dots, keeps the all-zero Green series as a line, with rounded caps and joins", async () => {
    const user = await renderDashboard();
    const check = (root: Element) => {
      expect(root.querySelectorAll(".recharts-line")).toHaveLength(4);
      expect(root.querySelectorAll(".recharts-dot, .recharts-line-dots, .recharts-active-dot")).toHaveLength(0);
      const curves = Array.from(root.querySelectorAll(".recharts-line-curve"));
      expect(curves).toHaveLength(4);
      for (const c of curves) {
        expect(c).toHaveAttribute("stroke-linecap", "round");
        expect(c).toHaveAttribute("stroke-linejoin", "round");
        expect(c.getAttribute("d")).toBeTruthy();
      }
      // The Green series (stroke #0f7660) is drawn, and flat: every point has the same y (zero kg).
      const green = root.querySelector('.recharts-line-curve[stroke="#0f7660"]')!;
      expect(green).not.toBeNull();
      // Path data is x,y pairs (M, then cubic C segments for monotone): every second number is a y.
      const numbers = (green.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const ys = numbers.filter((_, i) => i % 2 === 1);
      expect(ys.length).toBeGreaterThan(1);
      expect(new Set(ys.map((y) => y.toFixed(3))).size).toBe(1);
    };
    check(weeklyCard());
    await user.click(within(weeklyCard()).getByRole("button", { name: `Expand ${TITLE} graph` }));
    check(await screen.findByRole("dialog", { name: TITLE }));
  });

  it("tooltips still work with mouse and touch, with no active dot", async () => {
    await renderDashboard();
    const surface = weeklyCard().querySelector(".recharts-wrapper")!;
    fireEvent.mouseMove(surface, { clientX: 420, clientY: 200 });
    await waitFor(() => expect(weeklyCard().querySelector(".recharts-tooltip-wrapper")).toHaveTextContent(/Red.*kg/));
    expect(weeklyCard().querySelector(".recharts-tooltip-wrapper")).toHaveTextContent(/Green.*0 kg/);
    fireEvent.mouseLeave(surface);

    fireEvent.touchMove(surface, { touches: [{ clientX: 250, clientY: 200 }], changedTouches: [{ clientX: 250, clientY: 200 }] });
    await waitFor(() => expect(weeklyCard().querySelector(".recharts-tooltip-wrapper")).toHaveTextContent(/Orange.*kg/));
    expect(weeklyCard().querySelectorAll(".recharts-active-dot, .recharts-dot")).toHaveLength(0);
  });

  it("leaves the Total Picked by Color doughnut unchanged", async () => {
    await renderDashboard();
    const pie = pieCard();
    expect(within(pie).queryByRole("button", { name: /Expand/ })).not.toBeInTheDocument();
    expect(pie.querySelector(".dashboard-trend-panel-header")).not.toHaveClass("dashboard-trend-panel-header--with-action");
    expect(within(pie).getByTestId("responsive-container")).toHaveAttribute("data-height", "260");
  });
});
