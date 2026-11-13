import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crop Planner → Plants, preview of dated plantings: Add planting → choose
// variety → dates → Link rows → Save rows, with overlaps refused and listed,
// Cancel leaving the selection alone, and failures keeping the window open.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));
let canEdit = true;
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: canEdit, can: (k: string) => k === "greenhouse_setup:view" || canEdit, canAny: () => true })
}));

import { PlantsPage } from "../PlantsPage";

const P1 = "g1";
const P2 = "g2";
type Planting = { id: string; variety_id: string; planting_date: string; pull_out_date: string | null; notes: null; rows: Array<{ group_id: string; row_number: number }> };

let plantings: Planting[];
let writes: Array<{ path: string; method: string; body: any }>;
let failNextRowsSave: "server" | "network" | null;
let nextId: number;

const greenhouse = {
  today: "2026-11-13",
  timeZone: "America/Toronto",
  groups: [{ id: P1, type: "phase", name: "Phase 1", status: "active" }, { id: P2, type: "phase", name: "Phase 2", status: "active" }],
  rows: [
    ...Array.from({ length: 10 }, (_, i) => ({ group_id: P1, row_number: i + 1, slab_count: 106, plants_per_slab: 3, stems_per_plant: 2, area_m2: 100 })),
    ...Array.from({ length: 4 }, (_, i) => ({ group_id: P2, row_number: i + 1, slab_count: 90, plants_per_slab: 4, stems_per_plant: 1, area_m2: 80 }))
  ],
  varieties: [
    { id: "cad", name: "Cadalora", color: "red", status: "active", product_code: "bell_pepper", planting_date: null, pull_out_date: null },
    { id: "cad27", name: "Cadalora 2027", color: "red", status: "active", product_code: "bell_pepper", planting_date: null, pull_out_date: null },
    { id: "bon", name: "Bonbon", color: null, status: "active", product_code: "cucumber", planting_date: null, pull_out_date: null }
  ],
  products: [{ code: "bell_pepper", name: "Bell Peppers", status: "active" }, { code: "cucumber", name: "Cucumbers", status: "active" }]
};
const rows = (from: number, to: number, group = P1) => Array.from({ length: to - from + 1 }, (_, i) => ({ group_id: group, row_number: from + i }));
const overlaps = (a: Planting, s: string, e: string | null) => a.planting_date <= (e ?? "9999") && s <= (a.pull_out_date ?? "9999");
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => (body === null ? "" : JSON.stringify(body)) });

function fakeServer(path: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  if (method !== "GET") writes.push({ path, method, body });
  if (path === "/api/greenhouse-map") return json(200, { map: null, setup: { groups: [], rows: [] } });
  if (path === "/api/crop-planner/dated-plantings" && method === "GET") return json(200, { ...greenhouse, plantings });
  if (path === "/api/crop-planner/dated-plantings/on") {
    const live = plantings.filter((p) => p.planting_date <= greenhouse.today && (!p.pull_out_date || p.pull_out_date >= greenhouse.today));
    return json(200, { date: greenhouse.today, today: greenhouse.today, rows: [], totals: live.map((p) => ({ variety_id: p.variety_id, rows: p.rows.length, m2: p.rows.length * 100, plants: p.rows.length * 318, heads: p.rows.length * 636, rows_missing_inputs: 0 })) });
  }
  if (path === "/api/crop-planner/dated-plantings" && method === "POST") {
    const p: Planting = { id: `p${nextId++}`, variety_id: body.variety_id, planting_date: body.planting_date, pull_out_date: body.pull_out_date, notes: null, rows: [] };
    plantings.push(p);
    return json(201, p);
  }
  const rowsMatch = path.match(/^\/api\/crop-planner\/dated-plantings\/([^/]+)\/rows$/);
  if (rowsMatch) {
    if (failNextRowsSave) {
      const kind = failNextRowsSave;
      failNextRowsSave = null;
      if (kind === "network") throw new TypeError("Failed to fetch");
      return json(500, { message: "Failed to save the rows." });
    }
    const p = plantings.find((x) => x.id === rowsMatch[1])!;
    const conflicts = plantings
      .filter((o) => o.id !== p.id && overlaps(o, p.planting_date, p.pull_out_date))
      .flatMap((o) =>
        o.rows
          .filter((r) => body.rows.some((w: any) => w.group_id === r.group_id && w.row_number === r.row_number))
          .map((r) => ({ ...r, planting_id: o.id, variety_id: o.variety_id, variety_name: greenhouse.varieties.find((v) => v.id === o.variety_id)!.name, planting_date: o.planting_date, pull_out_date: o.pull_out_date }))
      );
    if (conflicts.length) return json(409, { message: "Some rows already have a planting at that time", conflicts });
    p.rows = body.rows;
    return json(200, { id: p.id, rows: body.rows });
  }
  const one = path.match(/^\/api\/crop-planner\/dated-plantings\/([^/]+)$/);
  if (one && method === "PUT") {
    const p = plantings.find((x) => x.id === one[1])!;
    const next = { ...p, ...body };
    const conflicts = plantings
      .filter((o) => o.id !== p.id && overlaps(o, next.planting_date, next.pull_out_date))
      .flatMap((o) => o.rows.filter((r) => p.rows.some((w) => w.group_id === r.group_id && w.row_number === r.row_number)).map((r) => ({ ...r, planting_id: o.id, variety_id: o.variety_id, variety_name: greenhouse.varieties.find((v) => v.id === o.variety_id)!.name, planting_date: o.planting_date, pull_out_date: o.pull_out_date })));
    if (conflicts.length) return json(409, { message: "These dates overlap another planting on some of this planting's rows", conflicts });
    Object.assign(p, body);
    return json(200, p);
  }
  throw new Error(`unexpected ${method} ${path}`);
}

beforeEach(() => {
  canEdit = true;
  nextId = 1;
  failNextRowsSave = null;
  writes = [];
  // This year's crop: Phase 1 rows 1-8 and Phase 2 rows 1-4, no pull-out date yet.
  plantings = [{ id: "this", variety_id: "cad", planting_date: "2025-12-15", pull_out_date: null, notes: null, rows: [...rows(1, 8), ...rows(1, 4, P2)] }];
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => fakeServer(path, init));
});
afterEach(() => apiFetchMock.mockReset());

function renderPage() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <PlantsPage />
    </MemoryRouter>
  );
  return user;
}
const card = (name: string) => screen.getByRole("article", { name });
const dialog = () => screen.getByRole("dialog");
const tile = (phase: string, n: number) => within(dialog()).getByRole("button", { name: new RegExp(`^${phase} row ${n}(:|,|$)`) });
const todayStrip = () => Object.fromEntries(Array.from(screen.getByRole("region", { name: "In the ground today" }).querySelectorAll(".plants-totals div")).map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]));

async function addNextYear(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "+ Add planting" }));
  await user.selectOptions(screen.getByLabelText("Variety"), "cad27");
  await user.type(screen.getByLabelText("Planting date"), "2026-12-08");
  await user.click(screen.getByRole("button", { name: "Add planting" }));
  return screen.findByRole("article", { name: "Cadalora 2027" });
}

describe("Plants (dated plantings preview)", () => {
  it("shows today's planting, its phases, and what today's reports would count", async () => {
    renderPage();
    const c = await screen.findByRole("article", { name: "Cadalora" });
    expect(within(screen.getByRole("region", { name: "Active plantings" })).getByRole("article")).toBe(c);
    expect(within(c).getByRole("table", { name: "Cadalora by phase" })).toBeInTheDocument();
    expect(todayStrip()).toMatchObject({ Varieties: "1", Rows: "12" });
  });

  it("Add planting → variety → dates creates an Upcoming card; the Link rows window opens only when asked", async () => {
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: "+ Add planting" }));
    // Varieties follow the crop.
    await user.selectOptions(screen.getByLabelText("Crop"), "cucumber");
    expect(within(screen.getByLabelText("Variety")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a variety…", "Bonbon"]);
    await user.selectOptions(screen.getByLabelText("Crop"), "bell_pepper");
    await user.selectOptions(screen.getByLabelText("Variety"), "cad27");
    await user.type(screen.getByLabelText("Planting date"), "2026-12-08");
    await user.click(screen.getByRole("button", { name: "Add planting" }));
    const next = await screen.findByRole("article", { name: "Cadalora 2027" });
    expect(writes[0]).toEqual({ path: "/api/crop-planner/dated-plantings", method: "POST", body: { variety_id: "cad27", planting_date: "2026-12-08", pull_out_date: null } });
    expect(within(screen.getByRole("region", { name: "Upcoming plantings" })).getByRole("article")).toBe(next);
    expect(within(next).getByRole("list", { name: "Needs attention" })).toHaveTextContent("No rows linked yet.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Link rows preselects the planting's rows; Save rows applies, closes, and returns to the card with new totals", async () => {
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Link rows" }));
    expect(tile("Phase 1", 1)).toHaveAttribute("aria-pressed", "true");
    expect(tile("Phase 1", 9)).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog()).getByText("12 rows selected")).toBeInTheDocument();
    // Individual row, Shift range, From/To and whole phase.
    await user.click(tile("Phase 1", 9));
    await user.click(tile("Phase 1", 8)); // deselect 8
    await user.click(tile("Phase 1", 8));
    await user.keyboard("{Shift>}");
    await user.click(tile("Phase 1", 10));
    await user.keyboard("{/Shift}");
    expect(within(dialog()).getByText("14 rows selected")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes.at(-1)!.body.rows).toHaveLength(14);
    const c = card("Cadalora");
    expect(c).toHaveClass("plants-card--updated");
    expect(within(c).getByRole("heading", { level: 3 })).toHaveFocus();
    expect(c.querySelector(".plants-totals dd")!.textContent).toBe("14");
  });

  it("Cancel leaves the original selection alone", async () => {
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Link rows" }));
    await user.click(within(dialog()).getByRole("button", { name: /^Select Phase 2/ }));
    await user.click(tile("Phase 1", 1));
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes).toEqual([]);
    await user.click(within(card("Cadalora")).getByRole("button", { name: "Link rows" }));
    expect(tile("Phase 1", 1)).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog()).getByText("12 rows selected")).toBeInTheDocument();
  });

  it("next year's crop on rows in use: conflicts stay in the window; leave rows out or end this year's crop explicitly; today's counts don't move", async () => {
    const user = renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    const before = todayStrip();
    const next = await addNextYear(user);
    await user.click(within(next).getByRole("button", { name: "Link rows" }));
    // Occupied rows are marked before saving.
    expect(tile("Phase 1", 1)).toHaveClass("occupied");
    expect(tile("Phase 1", 9)).not.toHaveClass("occupied");
    await user.selectOptions(within(dialog()).getByLabelText("Phase"), P1);
    await user.type(within(dialog()).getByLabelText("From row"), "1");
    await user.type(within(dialog()).getByLabelText("To row"), "10");
    await user.click(within(dialog()).getByRole("button", { name: "Select rows" }));
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));

    // Refused: the window stays open and names the rows and the planting holding them.
    const attention = await within(dialog()).findByLabelText("Rows that need attention");
    expect(attention).toHaveTextContent("Phase 1 rows 1–8 have Cadalora (Dec 15, 2025 – no pull-out date).");
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Some rows already have a planting at that time");
    expect(tile("Phase 1", 3)).toHaveClass("conflict");
    expect(plantings[0].pull_out_date).toBeNull();

    // Ending this year's crop is the person's explicit choice, and says it applies to all its rows.
    await user.click(within(attention).getByRole("button", { name: "End Cadalora on Dec 7, 2026 (all 12 rows)" }));
    expect(writes.at(-1)).toEqual({ path: "/api/crop-planner/dated-plantings/this", method: "PUT", body: { pull_out_date: "2026-12-07" } });
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Cadalora now ends Dec 7, 2026 on all 12 rows. Save rows to link the rows.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const saved = card("Cadalora 2027");
    expect(saved.querySelector(".plants-totals dd")!.textContent).toBe("10");
    expect(card("Cadalora")).toHaveTextContent("Pull-out Dec 7, 2026");
    // Today's counts are unchanged: next year's crop isn't in the ground today.
    expect(todayStrip()).toEqual(before);
  });

  it("Leave these rows out drops only the conflicting rows", async () => {
    const user = renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    const next = await addNextYear(user);
    await user.click(within(next).getByRole("button", { name: "Link rows" }));
    await user.click(within(dialog()).getByRole("button", { name: /^Select Phase 1/ }));
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));
    const attention = await within(dialog()).findByLabelText("Rows that need attention");
    await user.click(within(attention).getByRole("button", { name: "Leave these 8 rows out" }));
    expect(within(dialog()).getByText("2 rows selected")).toBeInTheDocument();
    expect(plantings[0].pull_out_date).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(plantings[1].rows.map((r) => r.row_number)).toEqual([9, 10]);
  });

  it("a failed save keeps the window open with the selection and says nothing changed", async () => {
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Link rows" }));
    await user.click(tile("Phase 1", 9));
    failNextRowsSave = "server";
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Failed to save the rows.");
    expect(tile("Phase 1", 9)).toHaveAttribute("aria-pressed", "true");
    failNextRowsSave = "network";
    await user.click(within(dialog()).getByRole("button", { name: "Save rows" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("no connection");
    expect(plantings[0].rows).toHaveLength(12);
  });

  it("dates that would overlap are refused in Edit dates, listing the rows", async () => {
    // This year's crop ends Nov 27; next year's is on the same rows from Dec 8.
    plantings = [
      { id: "this", variety_id: "cad", planting_date: "2025-12-15", pull_out_date: "2026-11-27", notes: null, rows: rows(1, 8) },
      { id: "next", variety_id: "cad27", planting_date: "2026-12-08", pull_out_date: null, notes: null, rows: rows(1, 8) }
    ];
    const user = renderPage();
    // Clearing this year's pull-out date would run it into next year's crop.
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Edit dates" }));
    await user.clear(screen.getByLabelText("Pull-out date (optional)"));
    await user.click(screen.getByRole("button", { name: "Save dates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("These dates overlap another planting");
    expect(screen.getByRole("list", { name: "Rows that need attention" })).toHaveTextContent("Phase 1 rows 1–8: Cadalora 2027 (Dec 8, 2026 – no pull-out date)");
    expect(plantings[0].pull_out_date).toBe("2026-11-27");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("viewers see the cards without Add planting, Link rows or Edit dates", async () => {
    canEdit = false;
    renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    expect(screen.queryByRole("button", { name: "+ Add planting" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link rows" })).toBeNull();
  });
});
