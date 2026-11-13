import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crop Planner page: the greenhouse map by phase, row/range/phase selection
// with a live row and plant count, planting and slab modes coloured by their
// own assignments, overlaps that ask before anything is reassigned, layout
// inputs for rows without a layout, the seed and slab order, and the CSV.
// The API is an in-memory fake with the server's one-assignment-per-row rule.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));
const permissions = vi.hoisted(() => ({ canEdit: true }));
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({
    loading: false,
    isOwnerOrAdmin: permissions.canEdit,
    can: (key: string) => (key === "greenhouse_setup:edit" ? permissions.canEdit : true),
    canAny: () => true
  })
}));
const downloads = vi.hoisted(() => [] as Array<{ name: string; blob: Blob }>);
vi.mock("../../lib/downloadFile", () => ({ downloadBlobFile: (blob: Blob, name: string) => downloads.push({ name, blob }) }));

import { CropPlannerPage } from "../CropPlannerPage";

type Row = { group_id: string; row_number: number };
const P1 = "p1";
const P2 = "p2";
const PLAN = { id: "plan-1", season: "2027", name: "Main plan", notes: null, updated_at: "" };
// Phase 1: 6 rows of 106 slabs x 3 plants (stems per plant 2, never counted). Phase 2: rows 1-2 90 x 4, row 3 with no layout.
const ROWS = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ group_id: P1, row_number: n, slab_count: 106, plants_per_slab: 3, stems_per_plant: 2 })),
  { group_id: P2, row_number: 1, slab_count: 90, plants_per_slab: 4, stems_per_plant: 1 },
  { group_id: P2, row_number: 2, slab_count: 90, plants_per_slab: 4, stems_per_plant: 1 },
  { group_id: P2, row_number: 3, slab_count: 0, plants_per_slab: 0, stems_per_plant: 1 }
];

let db: {
  plantings: Array<Row & { variety_id: string }>;
  slabs: Array<Row & { slab_type_id: string }>;
  layouts: Array<Row & { slabs_per_trough: number | null; troughs_per_row: number | null; plants_per_slab: number | null }>;
  oversow: Array<{ variety_id: string; oversow_pct: number }>;
};
const writes: Array<{ path: string; method: string; body: any }> = [];
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
  if (method !== "GET") writes.push({ path, method, body });
  if (path === "/api/crop-planner/plans" && method === "GET") return { status: 200, json: [PLAN] };
  if (path === "/api/crop-planner/plans/plan-1" && method === "GET") {
    return {
      status: 200,
      json: {
        plan: PLAN,
        ...db,
        greenhouse: { groups: [{ id: P1, type: "phase", name: "Phase 1" }, { id: P2, type: "phase", name: "Phase 2" }], rows: ROWS },
        varieties: [
          { id: "cad", name: "Cadalora", product_code: "bell_pepper", status: "active" },
          { id: "sun", name: "Sunny", product_code: "bell_pepper", status: "active" },
          { id: "bon", name: "Bonbon", product_code: "cucumber", status: "active" }
        ],
        slabTypes: [{ id: "exp", name: "Expert", status: "active" }, { id: "vit", name: "Vital", status: "active" }],
        products: [{ code: "bell_pepper", name: "Bell Peppers", status: "active" }, { code: "cucumber", name: "Cucumbers", status: "active" }]
      }
    };
  }
  if (path.endsWith("/plantings")) return assignFake("plantings", "variety_id", body);
  if (path.endsWith("/slabs")) return assignFake("slabs", "slab_type_id", body);
  if (path.endsWith("/layouts")) {
    db.layouts = [...db.layouts.filter((l) => !body.rows.some((r: Row) => key(r) === key(l))), ...body.rows.map((r: Row) => ({ ...r, slabs_per_trough: Number(body.slabs_per_trough), troughs_per_row: Number(body.troughs_per_row), plants_per_slab: Number(body.plants_per_slab) }))];
    return { status: 200, json: { updated: body.rows.length } };
  }
  const oversow = path.match(/\/varieties\/(\w+)$/);
  if (oversow) {
    db.oversow = [...db.oversow.filter((o) => o.variety_id !== oversow[1]), { variety_id: oversow[1], oversow_pct: body.oversow_pct }];
    return { status: 200, json: { variety_id: oversow[1], oversow_pct: body.oversow_pct } };
  }
  return { status: 404, json: { message: "not found" } };
}

beforeEach(() => {
  db = { plantings: [], slabs: [], layouts: [], oversow: [] };
  writes.length = 0;
  downloads.length = 0;
  permissions.canEdit = true;
  apiFetchMock.mockImplementation((path: string, options: { method?: string; body?: string } = {}) => {
    const r = route(path, options.method ?? "GET", options.body ? JSON.parse(options.body) : undefined);
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.json });
  });
});
afterEach(() => vi.clearAllMocks());

const phase = (name: string) => screen.getByRole("region", { name });
const tile = (phaseName: string, n: number) => within(phase(phaseName)).getByRole("button", { name: new RegExp(`^${phaseName} row ${n}:`) });
const panel = () => screen.getByRole("complementary", { name: "Selection" });

async function renderPage() {
  const user = userEvent.setup();
  render(<CropPlannerPage />);
  await screen.findByRole("region", { name: "Phase 1" });
  return user;
}

describe("Crop Planner", () => {
  it("shows the map by phase with unassigned rows, flags rows without a layout, and previews a phase selection", async () => {
    const user = await renderPage();
    expect(within(phase("Phase 1")).getAllByRole("button", { name: /row \d+: unassigned/ })).toHaveLength(6);
    expect(tile("Phase 2", 3)).toHaveAccessibleName("Phase 2 row 3: unassigned, missing layout inputs");
    expect(screen.getByText(/Unassigned \(9\)/)).toBeInTheDocument();

    await user.click(within(phase("Phase 1")).getByRole("button", { name: "Select phase" }));
    // 6 rows x 106 slabs x 3 plants = 1,908 plants; stems per plant isn't counted.
    expect(within(panel()).getByText(/rows selected/).textContent).toMatch(/6 rows selected · 1,908 plants/);
    expect(within(panel()).getByText("Phase 1 rows 1–6")).toBeInTheDocument();
  });

  it("selects a range with Shift-click, plants a variety, and colours the map by planting", async () => {
    const user = await renderPage();
    await user.click(tile("Phase 1", 2));
    await user.keyboard("{Shift>}");
    await user.click(tile("Phase 1", 4));
    await user.keyboard("{/Shift}");
    expect(within(panel()).getByText(/rows selected/).textContent).toMatch(/3 rows selected · 954 plants/);
    await user.click(within(panel()).getByRole("button", { name: "Assign Cadalora to 3 rows" }));
    await waitFor(() => expect(tile("Phase 1", 3)).toHaveAccessibleName("Phase 1 row 3: Cadalora"));
    expect(writes[0]).toEqual({ path: "/api/crop-planner/plans/plan-1/plantings", method: "POST", body: { rows: [2, 3, 4].map((n) => ({ group_id: P1, row_number: n })), variety_id: "cad" } });
    expect(screen.getByRole("status")).toHaveTextContent("Cadalora: 3 rows assigned.");
  });

  it("an overlapping phase selection shows what's assigned and adds only unassigned rows, or reassigns on request", async () => {
    db.plantings = [1, 2].map((n) => ({ group_id: P1, row_number: n, variety_id: "cad" }));
    const user = await renderPage();
    await user.selectOptions(within(panel()).getByLabelText("Variety"), "sun");
    await user.click(within(phase("Phase 1")).getByRole("button", { name: "Select phase" }));
    expect(within(panel()).getByText("Phase 1 rows 1–2 → Cadalora")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /^Assign / })).not.toBeInTheDocument();

    await user.click(within(panel()).getByRole("button", { name: "Add only the 4 unassigned rows" }));
    await waitFor(() => expect(tile("Phase 1", 6)).toHaveAccessibleName("Phase 1 row 6: Sunny"));
    expect(writes[0].body.on_assigned).toBe("skip");
    expect(tile("Phase 1", 1)).toHaveAccessibleName("Phase 1 row 1: Cadalora");

    await user.click(tile("Phase 1", 1));
    await user.click(within(panel()).getByRole("button", { name: "Reassign all 1 rows to Sunny" }));
    await waitFor(() => expect(tile("Phase 1", 1)).toHaveAccessibleName("Phase 1 row 1: Sunny"));
    expect(writes[1].body.on_assigned).toBe("reassign");
  });

  it("a server 409 (another save) never overwrites: it asks the same question", async () => {
    const user = await renderPage();
    await user.click(tile("Phase 1", 1));
    db.plantings = [{ group_id: P1, row_number: 1, variety_id: "sun" }]; // assigned meanwhile elsewhere
    await user.click(within(panel()).getByRole("button", { name: "Assign Cadalora to 1 row" }));
    expect(await within(panel()).findByText(/already have assignments\. Add only the unassigned rows, or reassign them\./)).toBeInTheDocument();
    expect(db.plantings).toEqual([{ group_id: P1, row_number: 1, variety_id: "sun" }]);
  });

  it("slab mode has its own assignments and colours: mixed slab types in one phase", async () => {
    db.plantings = [1, 2, 3, 4, 5, 6].map((n) => ({ group_id: P1, row_number: n, variety_id: "cad" }));
    const user = await renderPage();
    await user.click(screen.getByRole("tab", { name: "Slabs" }));
    expect(tile("Phase 1", 1)).toHaveAccessibleName("Phase 1 row 1: unassigned");
    await user.selectOptions(screen.getByLabelText("Phase"), P1);
    await user.type(screen.getByLabelText("From row"), "1");
    await user.type(screen.getByLabelText("To row"), "4");
    await user.click(screen.getByRole("button", { name: "Select rows" }));
    expect(within(panel()).getByText(/rows selected/).textContent).toMatch(/4 rows selected · 424 slabs/);
    await user.click(within(panel()).getByRole("button", { name: "Assign Expert to 4 rows" }));
    await waitFor(() => expect(tile("Phase 1", 4)).toHaveAccessibleName("Phase 1 row 4: Expert"));

    await user.click(within(phase("Phase 1")).getByRole("button", { name: "Select phase" }));
    await user.selectOptions(within(panel()).getByLabelText("Slab type"), "vit");
    await user.click(within(panel()).getByRole("button", { name: "Add only the 2 unassigned rows" }));
    await waitFor(() => expect(tile("Phase 1", 6)).toHaveAccessibleName("Phase 1 row 6: Vital"));

    const slabTable = screen.getByRole("table", { name: "Slab order" });
    const cells = within(slabTable).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    // One phase each: just the total line (no repeated phase line).
    expect(cells).toEqual([
      ["Expert", "Phase 1", "4", "424"],
      ["Vital", "Phase 1", "2", "212"]
    ]);
    // Planting is untouched by slab work.
    expect(db.plantings).toHaveLength(6);
  });

  it("the seed order combines a variety across phases, applies the oversow once, and is incomplete until layouts are filled in", async () => {
    db.plantings = [
      ...[1, 2, 3].map((n) => ({ group_id: P1, row_number: n, variety_id: "cad" })),
      ...[1, 2, 3].map((n) => ({ group_id: P2, row_number: n, variety_id: "cad" }))
    ];
    const user = await renderPage();
    const seedRows = () =>
      within(screen.getByRole("table", { name: "Seed order" })).getAllByRole("row").slice(1).map((r) =>
        within(r).getAllByRole("cell").map((c) => c.querySelector("input")?.value ?? c.textContent)
      );
    // 3 x 318 + 2 x 360 = 1,674 counted; Phase 2 row 3 has no layout.
    expect(seedRows()).toEqual([
      ["Cadalora", "Phase 1", "3", "954", ""],
      ["Cadalora", "Phase 2", "3", "720 · 1 row missing inputs", ""],
      ["Cadalora", "All phases", "6", "1,674", "0", "1,674", "0", "1,674 Incomplete"]
    ]);
    expect(screen.getByRole("note")).toHaveTextContent("Incomplete");

    // Layout inputs for the row: 53 x 2 x 3 = 318.
    await user.click(tile("Phase 2", 3));
    await user.click(within(panel()).getByText("Layout inputs for the selected rows"));
    await user.type(within(panel()).getByLabelText("Slabs per trough"), "53");
    await user.type(within(panel()).getByLabelText("Troughs per row"), "2");
    await user.type(within(panel()).getByLabelText("Plants per slab"), "3");
    expect(within(panel()).getByText("53 × 2 × 3 = 318 plants per row")).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Save layout inputs" }));
    await waitFor(() => expect(seedRows()[2]).toEqual(["Cadalora", "All phases", "6", "1,992", "0", "1,992", "0", "1,992"]));

    // Oversow 30%: 1,992 + 30% = 2,589.6 -> 2,590.
    const oversow = screen.getByLabelText("Oversow % for Cadalora");
    await user.clear(oversow);
    await user.type(oversow, "30{Enter}");
    await waitFor(() => expect(seedRows()[2]).toEqual(["Cadalora", "All phases", "6", "1,992", "30", "1,992", "598", "2,590"]));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("exports the order as CSV with separate seed and slab lists", async () => {
    db.plantings = [1, 2].map((n) => ({ group_id: P1, row_number: n, variety_id: "cad" }));
    db.slabs = [1, 2].map((n) => ({ group_id: P1, row_number: n, slab_type_id: "exp" }));
    db.oversow = [{ variety_id: "cad", oversow_pct: 30 }];
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(downloads[0].name).toBe("crop-plan-order-2027-main-plan.csv");
    const csv = (await downloads[0].blob.text()).trim().split("\n");
    expect(csv).toContain("Cadalora,All phases,2,636,30,636,191,827,Complete");
    expect(csv).toContain("Expert,All phases,2,212,Complete");
    expect(csv.indexOf("Seed order")).toBeLessThan(csv.indexOf("Slab order"));
  });

  it("viewers see the plan and order but can't change it", async () => {
    permissions.canEdit = false;
    const user = await renderPage();
    await user.click(tile("Phase 1", 1));
    expect(within(panel()).queryByLabelText("Variety")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New plan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });
});
