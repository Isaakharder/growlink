import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crop Planner with a saved greenhouse map: rows are selected by clicking
// them on the map (one row, Shift-click a range, a phase name for the whole
// phase), a click sends that row's own Greenhouse Setup group and row number,
// Planting and Slabs keep their own assignments, assigned rows ask before
// being reassigned, and Setup rows the map doesn't place stay selectable.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({ loading: false, isOwnerOrAdmin: true, can: () => true, canAny: () => true })
}));
vi.mock("../../lib/downloadFile", () => ({ downloadBlobFile: () => undefined }));

import { CropPlannerPage } from "../CropPlannerPage";

type Row = { group_id: string; row_number: number };
const P1 = "p1";
const P2 = "p2";
const PLAN = { id: "plan-1", season: "2027", name: "Main plan", notes: null, updated_at: "" };
// Greenhouse Setup: Phase 1 rows 1-6, Phase 2 rows 11-13. The map places Phase 1 rows 1-5 and all of Phase 2.
const ROWS = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ group_id: P1, row_number: n, slab_count: 100, plants_per_slab: 3, stems_per_plant: 1 })),
  ...[11, 12, 13].map((n) => ({ group_id: P2, row_number: n, slab_count: 50, plants_per_slab: 2, stems_per_plant: 1 }))
];
const MAP = {
  id: "map-1",
  name: "First Light Greenhouse",
  east_west_feet: 300,
  north_south_feet: 200,
  source: "labourlink_import",
  updated_at: "2026-11-13T10:00:00.000Z",
  phases: [
    {
      group_id: P1, x_feet_from_west: 0, y_feet_from_north: 0, east_west_feet: 120, north_south_feet: 60, sort_order: 1,
      rows: [1, 2, 3, 4, 5].map((n, i) => ({ row_number: n, x_ft: 5, y_ft: 2 + i * 8, width_ft: 5, length_ft: 100, orientation: "horizontal" }))
    },
    {
      // Phase 2 is laid out out of number order on the floor: row 13 sits west of row 11.
      group_id: P2, x_feet_from_west: 150, y_feet_from_north: 0, east_west_feet: 100, north_south_feet: 150, sort_order: 2,
      rows: [13, 11, 12].map((n, i) => ({ row_number: n, x_ft: 5 + i * 20, y_ft: 5, width_ft: 6, length_ft: 120, orientation: "vertical" }))
    }
  ]
};

let db: { plantings: Array<Row & { variety_id: string }>; slabs: Array<Row & { slab_type_id: string }> };
const writes: Array<{ path: string; body: any }> = [];
const key = (r: Row) => `${r.group_id}:${r.row_number}`;

function assignFake(table: "plantings" | "slabs", column: "variety_id" | "slab_type_id", body: any) {
  const current = new Map<string, string>((db[table] as any[]).map((r) => [key(r), r[column]]));
  const conflicts = body.rows.filter((r: Row) => current.has(key(r)) && current.get(key(r)) !== body[column]);
  if (conflicts.length && !body.on_assigned) {
    return { status: 409, json: { message: `${conflicts.length} of the selected rows already have assignments. Add only the unassigned rows, or reassign them.`, conflicts } };
  }
  const toWrite = body.rows.filter((r: Row) => !current.has(key(r)) || (body.on_assigned === "reassign" && current.get(key(r)) !== body[column]));
  db[table] = [...(db[table] as any[]).filter((r) => !toWrite.some((w: Row) => key(w) === key(r))), ...toWrite.map((r: Row) => ({ ...r, [column]: body[column] }))] as any;
  return { status: 200, json: { assigned: toWrite.length, reassigned: body.on_assigned === "reassign" ? conflicts.length : 0, skipped: body.on_assigned === "skip" ? conflicts.length : 0, unchanged: 0 } };
}

function route(path: string, method: string, body: any): { status: number; json: unknown } {
  if (method !== "GET") writes.push({ path, body });
  if (path === "/api/greenhouse-map") return { status: 200, json: { map: MAP, setup: { groups: [], rows: [] } } };
  if (path === "/api/crop-planner/plans") return { status: 200, json: [PLAN] };
  if (path === "/api/crop-planner/plans/plan-1") {
    return {
      status: 200,
      json: {
        plan: PLAN, plantings: db.plantings, slabs: db.slabs, layouts: [], oversow: [],
        greenhouse: { groups: [{ id: P1, type: "phase", name: "Phase 1" }, { id: P2, type: "phase", name: "Phase 2" }], rows: ROWS },
        varieties: [{ id: "cad", name: "Cadalora", product_code: "bell_pepper", status: "active" }, { id: "sun", name: "Sunny", product_code: "bell_pepper", status: "active" }],
        slabTypes: [{ id: "exp", name: "Expert", status: "active" }],
        products: [{ code: "bell_pepper", name: "Bell Peppers", status: "active" }]
      }
    };
  }
  if (path.endsWith("/plantings")) return assignFake("plantings", "variety_id", body);
  if (path.endsWith("/slabs")) return assignFake("slabs", "slab_type_id", body);
  return { status: 404, json: { message: "not found" } };
}

beforeEach(() => {
  db = { plantings: [], slabs: [] };
  writes.length = 0;
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it
  }
  apiFetchMock.mockImplementation((path: string, options: { method?: string; body?: string } = {}) => {
    const r = route(path, options.method ?? "GET", options.body ? JSON.parse(options.body) : undefined);
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.json });
  });
});
afterEach(() => vi.clearAllMocks());

const mapEl = () => screen.getByRole("group", { name: "First Light Greenhouse map" });
const mapRow = (phase: string, n: number) => within(mapEl()).getByRole("button", { name: new RegExp(`^${phase} row ${n}: `) });
const panel = () => screen.getByRole("complementary", { name: "Selection" });

async function renderPage() {
  const user = userEvent.setup();
  render(<CropPlannerPage />);
  await screen.findByRole("group", { name: "First Light Greenhouse map" });
  return user;
}

describe("Crop Planner on the greenhouse map", () => {
  it("clicking a row on the map assigns exactly that Greenhouse Setup row", async () => {
    const user = await renderPage();
    // Phase 2 row 13 is drawn first (westmost); clicking it must send row 13, not the first or nearest number.
    await user.click(mapRow("Phase 2", 13));
    expect(mapRow("Phase 2", 13)).toHaveAttribute("aria-pressed", "true");
    expect(within(panel()).getByText("Phase 2 row 13")).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Assign Cadalora to 1 row" }));
    await waitFor(() => expect(mapRow("Phase 2", 13)).toHaveAccessibleName(/^Phase 2 row 13: Cadalora/));
    expect(writes).toEqual([{ path: "/api/crop-planner/plans/plan-1/plantings", body: { rows: [{ group_id: P2, row_number: 13 }], variety_id: "cad" } }]);
  });

  it("Shift-click selects a range by row number in one phase, and a phase name selects the whole phase including rows off the map", async () => {
    const user = await renderPage();
    await user.click(mapRow("Phase 1", 2));
    await user.keyboard("{Shift>}");
    await user.click(mapRow("Phase 1", 4));
    await user.keyboard("{/Shift}");
    expect(within(panel()).getByText(/rows selected/).textContent).toMatch(/3 rows selected · 900 plants/);
    expect(within(panel()).getByText("Phase 1 rows 2–4")).toBeInTheDocument();

    await user.click(within(panel()).getByRole("button", { name: "Clear selection" }));
    await user.click(within(mapEl()).getByRole("button", { name: "Select Phase 1" }));
    // Row 6 isn't on the map but is in Greenhouse Setup: still part of the phase.
    expect(within(panel()).getByText("Phase 1 rows 1–6")).toBeInTheDocument();
    const offMap = screen.getByRole("region", { name: "Phase 1 rows not on the map" });
    expect(within(offMap).getByRole("button", { name: /^Phase 1 row 6:/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("Planting and Slabs are separate modes on the map; assigned rows are shown and never silently reassigned", async () => {
    db.plantings = [{ group_id: P1, row_number: 1, variety_id: "cad" }];
    const user = await renderPage();
    expect(mapRow("Phase 1", 1)).toHaveAccessibleName(/^Phase 1 row 1: Cadalora, Planting: Cadalora, Slab type: none/);

    // Planting: selecting rows 1-3 for Sunny shows row 1 is taken and asks.
    await user.selectOptions(within(panel()).getByLabelText("Variety"), "sun");
    await user.click(mapRow("Phase 1", 1));
    await user.keyboard("{Shift>}");
    await user.click(mapRow("Phase 1", 3));
    await user.keyboard("{/Shift}");
    expect(within(panel()).getByText("Phase 1 row 1 → Cadalora")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /^Assign / })).not.toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Add only the 2 unassigned rows" }));
    await waitFor(() => expect(mapRow("Phase 1", 3)).toHaveAccessibleName(/^Phase 1 row 3: Sunny/));
    expect(mapRow("Phase 1", 1)).toHaveAccessibleName(/^Phase 1 row 1: Cadalora/);

    // Slabs: the same row gets a slab type of its own; its planting is untouched.
    await user.click(screen.getByRole("tab", { name: "Slabs" }));
    expect(mapRow("Phase 1", 1)).toHaveAccessibleName(/^Phase 1 row 1: unassigned, Planting: Cadalora, Slab type: none/);
    await user.click(mapRow("Phase 1", 1));
    await user.click(within(panel()).getByRole("button", { name: "Assign Expert to 1 row" }));
    await waitFor(() => expect(mapRow("Phase 1", 1)).toHaveAccessibleName(/^Phase 1 row 1: Expert, Planting: Cadalora, Slab type: Expert/));
    expect(db.plantings.map((p) => [p.row_number, p.variety_id])).toEqual([[1, "cad"], [2, "sun"], [3, "sun"]]);
    expect(db.slabs).toEqual([{ group_id: P1, row_number: 1, slab_type_id: "exp" }]);
  });

  it("the rows-by-phase list stays available", async () => {
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Rows by phase" }));
    expect(screen.queryByRole("group", { name: "First Light Greenhouse map" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Phase 2" })).getAllByRole("button", { name: /row \d+: unassigned/ })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Map" }));
    expect(mapEl()).toBeInTheDocument();
  });

  // Rotation is a view preference. Rows are found by where they are drawn:
  // a physical spot on the floor (in north-up feet) is turned the way the
  // viewer turned the map, and whatever rectangle is drawn there gets clicked.
  // At every orientation that must be the same Greenhouse Setup row.
  describe.each([
    { turns: [] as string[], rotation: 0 },
    { turns: ["Rotate map 90° right"], rotation: 90 },
    { turns: ["Rotate map 90° right", "Rotate map 90° right"], rotation: 180 },
    { turns: ["Rotate map 90° left"], rotation: 270 }
  ])("rotated to $rotation°", ({ turns, rotation }) => {
    const W = MAP.east_west_feet;
    const H = MAP.north_south_feet;
    // Clockwise turn, written out independently of the canvas code.
    const turn = (x: number, y: number) =>
      rotation === 90 ? [H - y, x] : rotation === 180 ? [W - x, H - y] : rotation === 270 ? [y, W - x] : [x, y];
    function rowDrawnAt(worldX: number, worldY: number) {
      const [vx, vy] = turn(worldX, worldY);
      const hits = [...mapEl().querySelectorAll<SVGRectElement>("rect[data-row-key]")].filter((el) => {
        const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(el.getAttribute(a)));
        return vx >= x && vx <= x + w && vy >= y && vy <= y + h;
      });
      expect(hits).toHaveLength(1);
      return hits[0];
    }

    it("a click and a Shift-click select the rows drawn there, and the layout is never saved", async () => {
      const user = await renderPage();
      for (const name of turns) await user.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("button", { name: "Reset orientation" })).toHaveProperty("disabled", rotation === 0);
      const svgLand = mapEl().querySelector("rect.gh-map-land")!;
      expect([Number(svgLand.getAttribute("width")), Number(svgLand.getAttribute("height"))]).toEqual(rotation % 180 ? [H, W] : [W, H]);

      // Phase 2's westmost row is row 13 (x 155-161 ft); row 11 is the next one east.
      const westmost = rowDrawnAt(150 + 5 + 3, 60);
      expect(westmost.getAttribute("data-row-key")).toBe(`${P2}:13`);
      await user.click(westmost);
      expect(within(panel()).getByText("Phase 2 row 13")).toBeInTheDocument();

      // Phase 1 row 2 (y 10-15 ft) to row 4 (y 26-31 ft), picked by position.
      await user.click(within(panel()).getByRole("button", { name: "Clear selection" }));
      await user.click(rowDrawnAt(50, 12));
      await user.keyboard("{Shift>}");
      await user.click(rowDrawnAt(50, 28));
      await user.keyboard("{/Shift}");
      expect(within(panel()).getByText("Phase 1 rows 2–4")).toBeInTheDocument();

      // Labels are drawn upright at each row's centre (no rotate transform anywhere on the map).
      expect(mapEl().querySelector("[transform*='rotate']")).toBeNull();
      expect(localStorage.getItem("cropPlanner.mapRotation.map-1")).toBe(rotation ? String(rotation) : null);
      expect(writes.filter((w) => w.path.includes("greenhouse-map"))).toEqual([]);
    });
  });

  it("remembers the orientation for this viewer, and Reset orientation goes back to north-up", async () => {
    localStorage.setItem("cropPlanner.mapRotation.map-1", "90");
    const user = await renderPage();
    const svgLand = () => mapEl().querySelector("rect.gh-map-land")!;
    expect(svgLand().getAttribute("width")).toBe("200");
    await user.click(screen.getByRole("button", { name: "Reset orientation" }));
    expect(svgLand().getAttribute("width")).toBe("300");
    expect(localStorage.getItem("cropPlanner.mapRotation.map-1")).toBeNull();
    expect(screen.getByRole("button", { name: "Reset orientation" })).toBeDisabled();
  });
});
