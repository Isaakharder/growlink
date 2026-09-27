import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The two Yield Analytics trend charts: full-screen view and line-only
// rendering. jsdom does no layout, so ResponsiveContainer is given a fixed
// size here; everything inside it is the real Recharts output.
const calls: string[] = [];
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string) => {
    calls.push(path);
    return Promise.resolve({ ok: true, status: 200, json: async () => route(path) });
  }
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

import { YieldAnalyticsPage } from "../YieldAnalyticsPage";

const YEAR = new Date().getFullYear();
const VARIETIES = [
  { id: "v-a", name: "Cadalora", area_m2: 1000, color: "red", case_kg: 5 },
  { id: "v-b", name: "Mathieu", area_m2: 500, color: "red", case_kg: 5 }
];
const ENTRIES = [30, 31, 32].flatMap((week, i) => [
  { id: `a${week}`, variety_id: "v-a", variety_name: "Cadalora", year: YEAR, week, total_kg: 1000 + i * 100, kg_per_m2: 1 + i / 10, average_fruit_weight_g: 200 + i, size_kg: {} },
  { id: `b${week}`, variety_id: "v-b", variety_name: "Mathieu", year: YEAR, week, total_kg: 400 + i * 50, kg_per_m2: 0.8 + i / 10, average_fruit_weight_g: 170 + i, size_kg: {} }
]);
function route(path: string) {
  if (path === "/api/yield-entries") return ENTRIES;
  if (path === "/api/varieties") return VARIETIES;
  if (path === "/api/yield-analytics/summary") return { sizes: [], rows: [] };
  if (path === "/api/yield-analytics/area-footprints") return { rows: [], footprints: {}, linksAvailable: true };
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
  document.body.style.overflow = "";
});
afterEach(() => vi.clearAllMocks());

const TITLES = ["kg / m² Over Time", "Average Fruit Weight Over Time"];

async function renderPage() {
  const user = userEvent.setup();
  render(<YieldAnalyticsPage />);
  await screen.findByRole("button", { name: `Expand ${TITLES[0]} graph` });
  return user;
}
const card = (title: string) => screen.getByRole("region", { name: title });

describe("Yield Analytics trend charts — full-screen view", () => {
  it("gives each graph card its own Expand button", async () => {
    await renderPage();
    for (const title of TITLES) {
      const button = within(card(title)).getByRole("button", { name: `Expand ${title} graph` });
      expect(button).toHaveClass("csv-tb-btn", "chart-expand-button");
    }
    expect(screen.getAllByRole("button", { name: /^Expand .* graph$/ })).toHaveLength(2);
  });

  it.each(TITLES)("Expand opens %s full-screen with its title, legend and axes", async (title) => {
    const user = await renderPage();
    await user.click(within(card(title)).getByRole("button", { name: `Expand ${title} graph` }));
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(dialog).toHaveClass("chart-fullscreen");
    // Portalled to <body>, outside the page layout, so it covers the viewport.
    expect(dialog.closest(".ya-page")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close full-screen graph" })).toBeInTheDocument();
    expect(dialog.querySelector(".recharts-legend-wrapper")).toHaveTextContent("Cadalora");
    expect(dialog.querySelector(".recharts-legend-wrapper")).toHaveTextContent("Mathieu");
    expect(dialog.querySelectorAll(".recharts-cartesian-axis")).toHaveLength(2);
    expect(dialog.querySelectorAll(".recharts-line")).toHaveLength(2);
    // The chart fills the overlay's body at full size.
    const container = within(dialog).getByTestId("responsive-container");
    expect(container.parentElement).toHaveClass("chart-fullscreen-body");
    expect(container).toHaveAttribute("data-width", "100%");
    expect(container).toHaveAttribute("data-height", "100%");
  });

  it("Close and Escape both dismiss it, return focus to the Expand button and restore page scrolling", async () => {
    const user = await renderPage();
    const expand = within(card(TITLES[1])).getByRole("button", { name: `Expand ${TITLES[1]} graph` });

    await user.click(expand);
    await screen.findByRole("dialog", { name: TITLES[1] });
    expect(document.body.style.overflow).toBe("hidden");
    await user.click(screen.getByRole("button", { name: "Close full-screen graph" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(expand).toHaveFocus());
    expect(document.body.style.overflow).toBe("");

    await user.click(expand);
    await screen.findByRole("dialog", { name: TITLES[1] });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(expand).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
  });

  it("uses the same data without refetching, and leaves the page filters as they were", async () => {
    const user = await renderPage();
    const filters = screen.getByRole("region", { name: "Filters" });
    await user.selectOptions(within(filters).getByLabelText("Filter mode"), "single-week");
    await user.selectOptions(within(filters).getByLabelText("Week"), "31");
    const requestsBefore = calls.length;
    const cardLines = card(TITLES[0]).querySelectorAll(".recharts-line-curve");
    const cardPaths = Array.from(cardLines).map((p) => p.getAttribute("d"));

    await user.click(within(card(TITLES[0])).getByRole("button", { name: `Expand ${TITLES[0]} graph` }));
    const dialog = await screen.findByRole("dialog", { name: TITLES[0] });
    // Same series and points, drawn at the same test size.
    expect(Array.from(dialog.querySelectorAll(".recharts-line-curve")).map((p) => p.getAttribute("d"))).toEqual(cardPaths);
    await user.keyboard("{Escape}");

    expect(calls.length).toBe(requestsBefore);
    expect(within(filters).getByText(`${YEAR} · Week 31`)).toBeInTheDocument();
    expect(within(filters).getByLabelText("Week")).toHaveValue("31");
  });
});

describe("Yield Analytics trend charts — lines without point markers", () => {
  it("neither graph renders normal or active dots, and lines have rounded caps and joins", async () => {
    const user = await renderPage();
    for (const title of TITLES) {
      const region = card(title);
      expect(region.querySelectorAll(".recharts-line")).toHaveLength(2);
      expect(region.querySelectorAll(".recharts-dot, .recharts-line-dots, .recharts-active-dot")).toHaveLength(0);
      for (const curve of region.querySelectorAll(".recharts-line-curve")) {
        expect(curve).toHaveAttribute("stroke-linecap", "round");
        expect(curve).toHaveAttribute("stroke-linejoin", "round");
      }
    }
    // And in the full-screen view.
    await user.click(within(card(TITLES[1])).getByRole("button", { name: `Expand ${TITLES[1]} graph` }));
    const dialog = await screen.findByRole("dialog", { name: TITLES[1] });
    expect(dialog.querySelectorAll(".recharts-dot, .recharts-line-dots, .recharts-active-dot")).toHaveLength(0);
  });

  it("the tooltip still follows the pointer, showing each series' value, with no active dot", async () => {
    await renderPage();
    const region = card(TITLES[1]);
    const surface = region.querySelector(".recharts-wrapper")!;
    fireEvent.mouseMove(surface, { clientX: 420, clientY: 200 });
    const tooltip = await waitFor(() => {
      const el = region.querySelector(".recharts-tooltip-wrapper");
      expect(el).toHaveTextContent(/Cadalora/);
      return el!;
    });
    expect(tooltip).toHaveTextContent(/\d+(\.\d)? g/);
    expect(tooltip).toHaveTextContent(/Mathieu/);
    expect(region.querySelectorAll(".recharts-active-dot, .recharts-dot")).toHaveLength(0);
  });
});
