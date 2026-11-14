import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crop Planner → Plants, preview of dated plantings: Add planting → choose
// variety → dates → Link rows → Save rows (this planting only). Conflicts list
// the exact rows and the planting they're linked to; the person leaves them
// out or opens that planting in its own editor, where some rows can be ended
// early (partial pull-out) without ending the planting.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));
let canEdit = true;
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: canEdit, can: (k: string) => k === "greenhouse_setup:view" || canEdit, canAny: () => true })
}));

import { PlantsPage } from "../PlantsPage";

const P1 = "g1";
const P2 = "g2";
type Row = { group_id: string; row_number: number; pull_out_date: string | null };
type Planting = { id: string; variety_id: string; planting_date: string; pull_out_date: string | null; notes: null; rows: Row[] };

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
const rows = (from: number, to: number, group = P1): Row[] => Array.from({ length: to - from + 1 }, (_, i) => ({ group_id: group, row_number: from + i, pull_out_date: null }));
const refs = (from: number, to: number, group = P1) => rows(from, to, group).map(({ group_id, row_number }) => ({ group_id, row_number }));
const end = (rowEnd: string | null, pEnd: string | null) => (rowEnd && pEnd ? (rowEnd < pEnd ? rowEnd : pEnd) : rowEnd ?? pEnd);
const overlaps = (aS: string, aE: string | null, bS: string, bE: string | null) => aS <= (bE ?? "9999") && bS <= (aE ?? "9999");
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => (body === null ? "" : JSON.stringify(body)) });
const nameOf = (id: string) => greenhouse.varieties.find((v) => v.id === id)!.name;

function conflictsFor(p: { id: string; planting_date: string; pull_out_date: string | null }, wanted: Array<{ group_id: string; row_number: number; pull_out_date?: string | null }>) {
  return plantings
    .filter((o) => o.id !== p.id)
    .flatMap((o) =>
      o.rows
        .filter((r) => {
          const w = wanted.find((x) => x.group_id === r.group_id && x.row_number === r.row_number);
          return w && overlaps(p.planting_date, end(w.pull_out_date ?? null, p.pull_out_date), o.planting_date, end(r.pull_out_date, o.pull_out_date));
        })
        .map((r) => ({ group_id: r.group_id, row_number: r.row_number, planting_id: o.id, variety_id: o.variety_id, variety_name: nameOf(o.variety_id), planting_date: o.planting_date, pull_out_date: o.pull_out_date, row_pull_out_date: r.pull_out_date }))
    );
}

function fakeServer(path: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  if (method !== "GET") writes.push({ path, method, body });
  if (path === "/api/greenhouse-map") return json(200, { map: null, setup: { groups: [], rows: [] } });
  if (path === "/api/crop-planner/dated-plantings" && method === "GET") return json(200, { ...greenhouse, plantings: structuredClone(plantings) });
  if (path === "/api/crop-planner/dated-plantings/on") {
    const t = greenhouse.today;
    const live = plantings.map((p) => ({ p, n: p.rows.filter((r) => p.planting_date <= t && (end(r.pull_out_date, p.pull_out_date) ?? "9999") >= t).length })).filter((x) => x.n);
    return json(200, { date: t, today: t, rows: [], totals: live.map(({ p, n }) => ({ variety_id: p.variety_id, rows: n, m2: n * 100, plants: n * 318, heads: n * 636, rows_missing_inputs: 0 })) });
  }
  if (path === "/api/crop-planner/dated-plantings" && method === "POST") {
    const p: Planting = { id: `p${nextId++}`, variety_id: body.variety_id, planting_date: body.planting_date, pull_out_date: body.pull_out_date, notes: null, rows: [] };
    plantings.push(p);
    return json(201, p);
  }
  const pullOut = path.match(/^\/api\/crop-planner\/dated-plantings\/([^/]+)\/rows\/pull-out$/);
  if (pullOut) {
    const p = plantings.find((x) => x.id === pullOut[1])!;
    const conflicts = conflictsFor(p, body.rows.map((r: any) => ({ ...r, pull_out_date: body.pull_out_date })));
    if (conflicts.length) return json(409, { message: "Those rows would overlap another planting", conflicts });
    for (const r of p.rows) if (body.rows.some((w: any) => w.group_id === r.group_id && w.row_number === r.row_number)) r.pull_out_date = body.pull_out_date;
    return json(200, { id: p.id });
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
    const asked = body.rows.map((r: any) => ({ ...r, pull_out_date: p.rows.find((k) => k.group_id === r.group_id && k.row_number === r.row_number)?.pull_out_date ?? null }));
    const conflicts = conflictsFor(p, asked);
    if (conflicts.length) return json(409, { message: "Some rows are already linked to another planting at that time", conflicts });
    p.rows = asked;
    return json(200, { id: p.id, rows: body.rows });
  }
  const one = path.match(/^\/api\/crop-planner\/dated-plantings\/([^/]+)$/);
  if (one && method === "PUT") {
    const p = plantings.find((x) => x.id === one[1])!;
    const next = { ...p, ...body };
    const conflicts = conflictsFor(next, p.rows);
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
const linkDialog = () => screen.getByRole("dialog", { name: /^Link rows/ });
const editorDialog = () => screen.getByRole("dialog", { name: /^Edit planting/ });
const tile = (phase: string, n: number, inside = linkDialog()) => within(inside).getByRole("button", { name: new RegExp(`^${phase} row ${n}(:|,|$)`) });
const todayStrip = () => Object.fromEntries(Array.from(screen.getByRole("region", { name: "In the ground today" }).querySelectorAll(".plants-totals div")).map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]));
const writesTo = (re: RegExp) => writes.filter((w) => re.test(w.path));

async function addNextYear(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "+ Add planting" }));
  await user.selectOptions(screen.getByLabelText("Variety"), "cad27");
  await user.type(screen.getByLabelText("Planting date"), "2026-12-08");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add planting" }));
  return screen.findByRole("article", { name: "Cadalora 2027" });
}
async function linkPhase1(user: ReturnType<typeof userEvent.setup>, next: HTMLElement) {
  await user.click(within(next).getByRole("button", { name: "Link rows" }));
  await user.click(within(linkDialog()).getByRole("button", { name: /^Select Phase 1/ }));
  await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
  return within(linkDialog()).findByLabelText("Rows that need attention");
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
    await user.selectOptions(screen.getByLabelText("Crop"), "cucumber");
    expect(within(screen.getByLabelText("Variety")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a variety…", "Bonbon"]);
    await user.selectOptions(screen.getByLabelText("Crop"), "bell_pepper");
    await user.selectOptions(screen.getByLabelText("Variety"), "cad27");
    await user.type(screen.getByLabelText("Planting date"), "2026-12-08");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add planting" }));
    const next = await screen.findByRole("article", { name: "Cadalora 2027" });
    expect(writes[0]).toEqual({ path: "/api/crop-planner/dated-plantings", method: "POST", body: { variety_id: "cad27", planting_date: "2026-12-08", pull_out_date: null } });
    expect(within(screen.getByRole("region", { name: "Upcoming plantings" })).getByRole("article")).toBe(next);
    expect(within(next).getByRole("list", { name: "Needs attention" })).toHaveTextContent("No rows linked yet.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Link rows preselects the planting's rows; Save rows writes only that planting, closes, and returns to the card", async () => {
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Link rows" }));
    expect(tile("Phase 1", 1)).toHaveAttribute("aria-pressed", "true");
    expect(tile("Phase 1", 9)).toHaveAttribute("aria-pressed", "false");
    expect(within(linkDialog()).getByText("12 rows selected")).toBeInTheDocument();
    await user.click(tile("Phase 1", 9));
    await user.keyboard("{Shift>}");
    await user.click(tile("Phase 1", 10));
    await user.keyboard("{/Shift}");
    expect(within(linkDialog()).getByText("14 rows selected")).toBeInTheDocument();
    await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /api/crop-planner/dated-plantings/this/rows"]);
    const c = card("Cadalora");
    expect(c).toHaveClass("plants-card--updated");
    expect(within(c).getByRole("heading", { level: 3 })).toHaveFocus();
    expect(c.querySelector(".plants-totals dd")!.textContent).toBe("14");
  });

  it("Cancel leaves the original selection alone", async () => {
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Link rows" }));
    await user.click(within(linkDialog()).getByRole("button", { name: /^Select Phase 2/ }));
    await user.click(tile("Phase 1", 1));
    await user.click(within(linkDialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes).toEqual([]);
    await user.click(within(card("Cadalora")).getByRole("button", { name: "Link rows" }));
    expect(tile("Phase 1", 1)).toHaveAttribute("aria-pressed", "true");
    expect(within(linkDialog()).getByText("12 rows selected")).toBeInTheDocument();
  });

  it("a conflict names the exact rows and the planting they're linked to, and offers Leave out or Open — never an action on the other planting", async () => {
    const user = renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    const next = await addNextYear(user);
    await user.click(within(next).getByRole("button", { name: "Link rows" }));
    expect(tile("Phase 1", 1)).toHaveClass("occupied");
    expect(tile("Phase 1", 9)).not.toHaveClass("occupied");
    await user.click(within(linkDialog()).getByRole("button", { name: /^Select Phase 1/ }));
    await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
    const attention = await within(linkDialog()).findByLabelText("Rows that need attention");
    const group = within(attention).getByRole("region", { name: "Linked to Cadalora" });
    expect(group).toHaveTextContent("Already linked to Cadalora, planted Dec 15, 2025, no pull-out date:");
    expect(within(group).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Phase 1: rows 1–8"]);
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Leave these 8 rows out", "Open Cadalora"]);
    expect(tile("Phase 1", 3)).toHaveClass("conflict");
    // Only this planting's rows were ever written; the other planting is untouched.
    expect(writes.filter((w) => w.method !== "POST").map((w) => w.path)).toEqual(["/api/crop-planner/dated-plantings/p1/rows"]);
    expect(plantings[0].rows.every((r) => r.pull_out_date === null) && plantings[0].pull_out_date === null).toBe(true);
  });

  it("Leave these rows out drops only the conflicting rows", async () => {
    const user = renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    const next = await addNextYear(user);
    const attention = await linkPhase1(user, next);
    await user.click(within(attention).getByRole("button", { name: "Leave these 8 rows out" }));
    expect(within(linkDialog()).getByText("2 rows selected")).toBeInTheDocument();
    await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(plantings[1].rows.map((r) => r.row_number)).toEqual([9, 10]);
    expect(plantings[0].rows).toHaveLength(12);
  });

  it("Open the existing planting in its own editor: end only the conflicting rows (partial pull-out), go back, Save rows; today's counts don't move", async () => {
    const user = renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    const before = todayStrip();
    const next = await addNextYear(user);
    const attention = await linkPhase1(user, next);
    await user.click(within(attention).getByRole("button", { name: "Open Cadalora (planted Dec 15, 2025) in its own editor" }));

    // The editor opens on top; the conflicting rows are selected and the end date suggested.
    const editor = editorDialog();
    expect(editor).toHaveTextContent("Opened from Link rows for Cadalora 2027. Changes here apply to Cadalora only.");
    expect(tile("Phase 1", 1, editor)).toHaveAttribute("aria-pressed", "true");
    expect(tile("Phase 2", 1, editor)).toHaveAttribute("aria-pressed", "false");
    expect(within(editor).getByLabelText("End on")).toHaveValue("2026-12-07");
    expect(within(editor).queryByRole("button", { name: "Delete planting" })).toBeNull();

    await user.click(within(editor).getByRole("button", { name: "End 8 rows on Dec 7, 2026" }));
    expect(await within(editor).findByRole("status")).toHaveTextContent("Phase 1 rows 1–8 now end Dec 7, 2026. The planting and its other rows carry on.");
    expect(writes.at(-1)).toEqual({ path: "/api/crop-planner/dated-plantings/this/rows/pull-out", method: "PUT", body: { rows: refs(1, 8), pull_out_date: "2026-12-07" } });
    // Only those rows end; the planting and Phase 2 carry on.
    expect(plantings[0].pull_out_date).toBeNull();
    expect(plantings[0].rows.filter((r) => r.pull_out_date).map((r) => `${r.group_id}:${r.row_number}`)).toEqual(refs(1, 8).map((r) => `${r.group_id}:${r.row_number}`));

    // Escape closes the editor only; Link rows keeps the selection and sees the rows are free.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /^Edit planting/ })).toBeNull();
    expect(within(linkDialog()).getByText("10 rows selected")).toBeInTheDocument();
    expect(within(linkDialog()).getByRole("status")).toHaveTextContent("8 rows are no longer in conflict. Save rows to link them.");
    expect(within(linkDialog()).queryByLabelText("Rows that need attention")).toBeNull();

    await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(card("Cadalora 2027").querySelector(".plants-totals dd")!.textContent).toBe("10");
    expect(within(card("Cadalora")).getByRole("list", { name: "Rows pulled out early" })).toHaveTextContent("Phase 1 rows 1–8 pulled out Dec 7, 2026");
    expect(card("Cadalora")).toHaveTextContent("Pull-out not set");
    expect(todayStrip()).toEqual(before);
  });

  it("Edit planting from a card: partial pull-out and undo, and dates that would overlap are refused with the rows listed", async () => {
    plantings = [
      { id: "this", variety_id: "cad", planting_date: "2025-12-15", pull_out_date: "2026-11-27", notes: null, rows: rows(1, 8) },
      { id: "next", variety_id: "cad27", planting_date: "2026-12-08", pull_out_date: null, notes: null, rows: rows(1, 8) }
    ];
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Edit planting" }));
    const editor = editorDialog();
    // End rows 7-8 early, then keep them to the planting's end again.
    await user.click(tile("Phase 1", 7, editor));
    await user.click(tile("Phase 1", 8, editor));
    await user.type(within(editor).getByLabelText("End on"), "2026-10-01");
    await user.click(within(editor).getByRole("button", { name: "End 2 rows on Oct 1, 2026" }));
    await within(editor).findByRole("status");
    expect(tile("Phase 1", 7, editorDialog())).toHaveAccessibleName("Phase 1 row 7, ends Oct 1, 2026");
    await user.click(within(editorDialog()).getByRole("button", { name: "Keep 2 ended rows to the planting's end" }));
    await waitFor(() => expect(plantings[0].rows.every((r) => r.pull_out_date === null)).toBe(true));

    // Clearing the planting's pull-out date would run it into next year's crop.
    await user.clear(within(editorDialog()).getByLabelText("Pull-out date (optional)"));
    await user.click(within(editorDialog()).getByRole("button", { name: "Save dates" }));
    expect(await within(editorDialog()).findByRole("alert")).toHaveTextContent("These dates overlap another planting");
    expect(within(editorDialog()).getByRole("list", { name: "Rows that need attention" })).toHaveTextContent("Phase 1 rows 1–8: linked to Cadalora 2027 (Dec 8, 2026 – no pull-out date)");
    expect(plantings[0].pull_out_date).toBe("2026-11-27");
    // Every write went to this planting only.
    expect(writes.every((w) => w.path.startsWith("/api/crop-planner/dated-plantings/this"))).toBe(true);
  });

  it("a failed save keeps the window open with the selection and says nothing changed", async () => {
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Cadalora" })).getByRole("button", { name: "Link rows" }));
    await user.click(tile("Phase 1", 9));
    failNextRowsSave = "server";
    await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
    expect(await within(linkDialog()).findByRole("alert")).toHaveTextContent("Failed to save the rows.");
    expect(tile("Phase 1", 9)).toHaveAttribute("aria-pressed", "true");
    failNextRowsSave = "network";
    await user.click(within(linkDialog()).getByRole("button", { name: "Save rows" }));
    expect(await within(linkDialog()).findByRole("alert")).toHaveTextContent("no connection");
    expect(plantings[0].rows).toHaveLength(12);
  });

  it("viewers see the cards without Add planting, Link rows or Edit planting", async () => {
    canEdit = false;
    renderPage();
    await screen.findByRole("article", { name: "Cadalora" });
    expect(screen.queryByRole("button", { name: "+ Add planting" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link rows" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit planting" })).toBeNull();
  });
});
