import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Setup → Map row measurements: copy from Greenhouse Setup with a before/after
// comparison, resize with an old/new m² preview from a date, add rows with
// real sizes from a date.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api", () => ({ apiFetch: apiFetchMock }));
const downloads: string[] = [];
vi.mock("../../../lib/downloadFile", () => ({ downloadBlobFile: (_b: Blob, name: string) => downloads.push(name) }));

import { RowMeasurementsPanel } from "../RowMeasurementsPanel";

const P1 = "g1";
let copied: boolean;
let futureEnabled: boolean;
let writes: Array<{ path: string; method: string; body: any }>;
const lengthOf = (n: number) => (n === 3 ? 91.43 : 91.44);
function rows() {
  return [1, 2, 3].map((n) => ({
    id: `r${n}`,
    group_id: P1,
    row_number: n,
    available_from: null,
    current: copied ? { width_m: 1.6, length_m: lengthOf(n), area_m2: 1.6 * lengthOf(n), effective_from: null, source: "greenhouse_setup_row" } : null,
    versions: copied
      ? [
          { row_id: `r${n}`, width_m: 1.6, length_m: lengthOf(n), effective_from: null, source: "greenhouse_setup_row" },
          ...(n === 2 ? [{ row_id: "r2", width_m: 1.6, length_m: 100.58, effective_from: "2026-12-08", source: "map_resize" }] : [])
        ]
      : []
  }));
}
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  copied = false;
  futureEnabled = true;
  writes = [];
  downloads.length = 0;
  apiFetchMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method !== "GET") writes.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/setup/map/measurements" && method === "GET") {
      return json(200, { today: "2026-11-13", future_dates_enabled: futureEnabled, available: true, copied, groups: [{ id: P1, name: "Phase 1" }], rows: rows() });
    }
    if (path === "/api/setup/map/measurements/copy") {
      copied = true;
      return json(200, { copied_from_row: 3, copied_from_section: 0, missing: 0 });
    }
    if (path === "/api/setup/map/measurements/report") {
      return json(200, {
        total: { rows: 3, area_before_m2: 438.9, area_after_m2: 438.9, missing: 0, area_changed: 0, not_copied: 0 },
        phases: [{ phase: "Phase 1", rows: 3, area_before_m2: 438.9, area_after_m2: 438.9, missing: 0, differs_from_section: 1, drawing_differs: 0, not_on_map: 0, area_changed: 0 }],
        rows: [
          {
            phase: "Phase 1", row_number: 3, setup_width_m: 1.6, setup_length_m: 91.43, section_width_m: 1.6, section_length_m: 91.44,
            copied_width_m: 1.6, copied_length_m: 91.43, copied_from: "greenhouse_setup_row", drawn_width_ft: 5.25, drawn_length_ft: 300,
            area_before_m2: 146.288, area_after_m2: 146.288, flags: ["row differs from its section (row's own size kept)"]
          }
        ]
      });
    }
    if (path === "/api/setup/map/measurements/report?format=csv") return { ok: true, status: 200, text: async () => "phase,row_number\n" };
    if (path === "/api/setup/map/measurements" && method === "PUT") return json(200, { saved: { rows: 2 } });
    if (path === "/api/setup/map/rows") return json(201, { rows: [4, 5] });
    throw new Error(`unexpected ${method} ${path}`);
  });
});
afterEach(() => apiFetchMock.mockReset());

const resizeForm = () => screen.getByRole("form", { name: "Resize rows" });
async function setDate(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = within(resizeForm()).getByLabelText("Applies from");
  await user.clear(input);
  await user.type(input, value);
}

describe("Setup → Map row measurements", () => {
  it("copies from Greenhouse Setup, then shows the before/after comparison by phase and row, and the CSV", async () => {
    const user = userEvent.setup();
    render(<RowMeasurementsPanel />);
    await user.click(await screen.findByRole("button", { name: "Copy measurements from Greenhouse Setup" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied 3 rows from their own Greenhouse Setup size, 0 rows from their section.");
    const phases = await screen.findByRole("table", { name: "Before and after by phase" });
    const cells = Array.from(within(phases).getAllByRole("row")[1].children).map((c) => c.textContent);
    expect(cells).toEqual(["Phase 1", "3", "438.9", "438.9", "0", "1", "0", "0"]);
    expect(within(phases).getByText("No row's area changed")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Before and after by row" })).getByText("row differs from its section (row's own size kept)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download comparison (CSV)" }));
    await waitFor(() => expect(downloads).toEqual(["row-measurements-before-after.csv"]));
  });

  it("resize: preview shows old and new m² from the chosen date, per row and phase; history can't be rewritten", async () => {
    copied = true;
    const user = userEvent.setup();
    render(<RowMeasurementsPanel selectedOnMap={new Set([`${P1}:1`, `${P1}:2`])} />);
    await user.click(await screen.findByRole("button", { name: "Use the 2 rows selected on the map" }));
    await user.type(within(resizeForm()).getByLabelText("Length (m)"), "95");
    await setDate(user, "2026-12-01");
    const preview = screen.getByLabelText("Resize preview");
    const lines = within(preview).getAllByRole("row").slice(1, 3).map((r) => Array.from(r.children).map((c) => c.textContent));
    // Row 1: old size on Dec 1 is the copied baseline. Row 2 already has a size from Dec 8, so a size
    // from Dec 1 would slip in under it: history is append-only, so it's refused before saving.
    expect(lines).toEqual([
      ["Phase 1 1", "1.6 × 91.44", "146.3", "1.6 × 95", "152", "+5.7"],
      ["Phase 1 2", "1.6 × 91.44", "146.3", "1.6 × 95", "152", "has a size from Dec 8, 2026; pick a later date"]
    ]);
    const total = Array.from(within(preview).getByText("Phase 1 (2 rows)").parentElement!.children).map((c) => c.textContent);
    expect(total).toEqual(["Phase 1 (2 rows)", "", "292.61", "", "304", "+11.39"]);
    expect(within(resizeForm()).getByRole("button", { name: "Save new size for 2 rows" })).toBeDisabled();
    await setDate(user, "2026-12-08");
    expect(within(resizeForm()).getByRole("button", { name: "Save new size for 2 rows" })).toBeDisabled();

    // After Dec 8, the old size shown for row 2 is the Dec 8 size.
    await setDate(user, "2027-01-04");
    const later = within(screen.getByLabelText("Resize preview")).getAllByRole("row")[2];
    expect(Array.from(later.children).map((c) => c.textContent)).toEqual(["Phase 1 2", "1.6 × 100.58", "160.93", "1.6 × 95", "152", "-8.93"]);

    await user.click(within(resizeForm()).getByRole("button", { name: "Save new size for 2 rows" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: "/api/setup/map/measurements",
      method: "PUT",
      body: { effective_from: "2027-01-04", rows: [{ row_id: "r1", width_m: 1.6, length_m: 95 }, { row_id: "r2", width_m: 1.6, length_m: 95 }] }
    });
    expect(await screen.findByRole("status")).toHaveTextContent("New size saved for 2 rows from Jan 4, 2027. Dates before that keep the earlier size.");
  });

  it("add rows: real size, inputs and a date; existing numbers are refused before saving", async () => {
    copied = true;
    const user = userEvent.setup();
    render(<RowMeasurementsPanel />);
    const form = await screen.findByRole("form", { name: "Add rows" });
    await user.type(within(form).getByLabelText("From row"), "3");
    await user.type(within(form).getByLabelText("To row"), "5");
    await user.type(within(form).getByLabelText("Width (m)"), "1.6");
    await user.type(within(form).getByLabelText("Length (m)"), "91.44");
    expect(within(form).getByLabelText("Add rows preview")).toHaveTextContent("Rows 3 already exist in Phase 1.");
    expect(within(form).getByRole("button", { name: "Add 3 rows" })).toBeDisabled();
    await user.clear(within(form).getByLabelText("From row"));
    await user.type(within(form).getByLabelText("From row"), "4");
    await user.type(within(form).getByLabelText("Slabs per row"), "166");
    await user.type(within(form).getByLabelText("Plants per slab"), "3");
    await user.clear(within(form).getByLabelText("In the greenhouse from"));
    await user.type(within(form).getByLabelText("In the greenhouse from"), "2026-12-08");
    expect(within(form).getByLabelText("Add rows preview")).toHaveTextContent("2 new rows (4–5) × 146.3 m² = 292.61 m², from Dec 8, 2026. Earlier dates don't include them.");
    await user.click(within(form).getByRole("button", { name: "Add 2 rows" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ group_id: P1, from_row: 4, to_row: 5, width_m: 1.6, length_m: 91.44, slab_count: "166", plants_per_slab: "3", stems_per_plant: 1, effective_from: "2026-12-08" });
  });

  it("while future-dated sizes are off, a resize or new rows can only apply from today or earlier", async () => {
    copied = true;
    futureEnabled = false;
    const user = userEvent.setup();
    render(<RowMeasurementsPanel selectedOnMap={new Set([`${P1}:1`])} />);
    await user.click(await screen.findByRole("button", { name: "Use the 1 row selected on the map" }));
    await user.type(within(resizeForm()).getByLabelText("Length (m)"), "95");
    expect(within(resizeForm()).getByLabelText("Applies from")).toHaveAttribute("max", "2026-11-13");
    await setDate(user, "2026-12-08");
    expect(within(resizeForm()).getByRole("alert")).toHaveTextContent("Sizes that apply after today are turned off for now");
    expect(within(resizeForm()).getByRole("button", { name: "Save new size for 1 row" })).toBeDisabled();
    await setDate(user, "2026-11-13");
    expect(within(resizeForm()).queryByRole("alert")).toBeNull();
    expect(within(resizeForm()).getByRole("button", { name: "Save new size for 1 row" })).toBeEnabled();

    const form = screen.getByRole("form", { name: "Add rows" });
    await user.type(within(form).getByLabelText("From row"), "4");
    await user.type(within(form).getByLabelText("Width (m)"), "1.6");
    await user.type(within(form).getByLabelText("Length (m)"), "91.44");
    await user.clear(within(form).getByLabelText("In the greenhouse from"));
    await user.type(within(form).getByLabelText("In the greenhouse from"), "2026-12-08");
    expect(within(form).getByRole("alert")).toHaveTextContent("Sizes that apply after today are turned off for now");
    expect(within(form).getByRole("button", { name: "Add 1 row" })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
});
