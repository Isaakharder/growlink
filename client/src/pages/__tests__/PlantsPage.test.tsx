import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));

import { PlantsPage } from "../PlantsPage";

const P1 = "g1";
const P2 = "g2";
const rows = [
  ...Array.from({ length: 6 }, (_, i) => ({ group_id: P1, row_number: i + 1, slab_count: 106, plants_per_slab: 3, stems_per_plant: 2, area_m2: 100 })),
  ...Array.from({ length: 4 }, (_, i) => ({ group_id: P2, row_number: i + 1, slab_count: 90, plants_per_slab: 4, stems_per_plant: 1, area_m2: i === 3 ? null : 80 }))
];
const variety = (id: string, name: string, planting_date: string | null, pull_out_date: string | null = null) => ({
  id, name, color: "red", status: "active", product_code: "bell_pepper", planting_date, pull_out_date
});
const assign = (variety_id: string, group_id: string, start_row: number, end_row: number) => ({
  id: `${variety_id}${group_id}${start_row}`, group_id, variety_id, start_row, end_row, assignment_pattern: "all"
});
const RESPONSE = {
  today: "2026-11-13",
  timeZone: "America/Toronto",
  groups: [{ id: P1, type: "phase", name: "Phase 1", status: "active" }, { id: P2, type: "phase", name: "Phase 2", status: "active" }],
  rows,
  assignments: [assign("cad", P1, 1, 4), assign("cad", P2, 1, 4), assign("sun", P1, 5, 6), assign("nxt", P1, 1, 4), assign("old", P1, 5, 6)],
  varieties: [
    variety("cad", "Cadalora", "2025-12-15", "2026-11-20"),
    variety("sun", "Sunny", null),
    variety("nxt", "Next Year", "2026-12-08"),
    variety("old", "Last Year", "2024-12-10", "2025-11-15")
  ],
  products: [{ code: "bell_pepper", name: "Bell Peppers", status: "active" }]
};

function renderPage() {
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => RESPONSE });
  return render(
    <MemoryRouter>
      <PlantsPage />
    </MemoryRouter>
  );
}

afterEach(() => apiFetchMock.mockReset());

const section = (name: string) => screen.getByRole("group", { name }) ?? screen.getByRole("region", { name });
const totals = (card: HTMLElement) =>
  Object.fromEntries(Array.from(card.querySelectorAll(".plants-totals div")).map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]));

describe("Crop Planner → Plants", () => {
  it("opens to Active, Upcoming and Past cards from the existing assignments, read-only", async () => {
    renderPage();
    const active = await screen.findByRole("region", { name: "Active plantings" });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/crop-planner/plantings");
    expect(within(active).getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Sunny", "Cadalora"]);
    const upcoming = screen.getByRole("region", { name: "Upcoming plantings" });
    expect(within(upcoming).getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Next Year"]);
    const past = section("Past plantings");
    expect(past.tagName).toBe("DETAILS");
    expect(within(past).getByRole("article", { hidden: true })).toHaveAttribute("aria-label", "Last Year");
    expect(screen.getByText(/Today is Nov 13, 2026 in the greenhouse's time zone \(America\/Toronto\)/)).toBeInTheDocument();
    // read-only: no buttons that change anything
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the variety, dates, rows by phase and totals, flagging a row without a width or length", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "Cadalora" });
    expect(within(card).getByText("Bell Peppers")).toBeInTheDocument();
    expect(card).toHaveTextContent("Planted Dec 15, 2025");
    expect(card).toHaveTextContent("Pull-out Nov 20, 2026");
    expect(totals(card)).toEqual({
      Rows: "8",
      Area: "640 m² + 1 row missing",
      Plants: (4 * 318 + 4 * 360).toLocaleString("en-US"),
      Heads: (4 * 636 + 4 * 360).toLocaleString("en-US")
    });
    const table = within(card).getByRole("table", { name: "Cadalora by phase" });
    const lines = within(table).getAllByRole("row").slice(1).map((r) => Array.from(r.children).map((c) => c.textContent));
    expect(lines).toEqual([
      ["Phase 1", "1–4", "400", "1,272", "2,544"],
      ["Phase 2", "1–4", "240 + 1 row missing", "1,440", "1,440"]
    ]);
    expect(within(card).getByRole("list", { name: "Needs attention" })).toHaveTextContent("1 row without a width or length: m² is incomplete.");
  });

  it("a single-phase card names its rows, and a missing planting date is flagged", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "Sunny" });
    expect(within(card).queryByRole("table")).toBeNull();
    expect(card).toHaveTextContent("Phase 1 · rows 5–6");
    expect(card).toHaveTextContent("Planted no date");
    expect(card).toHaveTextContent("Pull-out not set");
    expect(within(card).getByRole("list", { name: "Needs attention" })).toHaveTextContent("No planting date.");
  });

  it("next year's crop on rows in use today stays Upcoming and doesn't clash with today's", async () => {
    renderPage();
    const cad = await screen.findByRole("article", { name: "Cadalora" });
    expect(within(cad).getByRole("list", { name: "Needs attention" })).not.toHaveTextContent("also assigned");
    const next = screen.getByRole("article", { name: "Next Year" });
    expect(within(next).queryByRole("list", { name: "Needs attention" })).toBeNull();
  });

  it("shows the server's message when loading fails", async () => {
    apiFetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "Failed to load plantings." }) });
    render(
      <MemoryRouter>
        <PlantsPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load plantings.");
  });
});
