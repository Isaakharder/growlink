import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Greenhouse map builder: an organization with no map builds one from its own
// Greenhouse Setup (land, a phase, rows placed LabourLink-style, only Setup
// row numbers), and a LabourLink import shows the recreated map and match
// report, refuses to import until unmatched rows are resolved, then imports.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));
const downloads = vi.hoisted(() => [] as Array<{ name: string; blob: Blob }>);
vi.mock("../../lib/downloadFile", () => ({ downloadBlobFile: (blob: Blob, name: string) => downloads.push({ name, blob }) }));

import { GreenhouseMapBuilderPage } from "../GreenhouseMapBuilderPage";

const BAY_A = "bay-a";
// Greenhouse Setup has rows 1-4 and 6 in Bay A (no row 5).
const SETUP = { groups: [{ id: BAY_A, type: "phase", name: "Bay A" }], rows: [1, 2, 3, 4, 6].map((n) => ({ group_id: BAY_A, row_number: n })) };
let saved: any = null;
const calls: Array<{ path: string; method: string; body: any }> = [];

const reportFor = (resolutions: any) => {
  const resolved = resolutions?.row_resolutions?.["Bay A#9"];
  const issue = { key: "Bay A#9", phase: "Bay A", row_number: 9, status: resolved === "skip" ? "skipped" : "unmatched", reason: resolved === "skip" ? "Left off the map." : "Bay A has no row 9 in Greenhouse Setup.", resolved_row_number: null, available_row_numbers: [6] };
  const ready = resolved === "skip";
  return {
    report: {
      lands: ["North house"], land: { name: "North house", east_west_feet: 100, north_south_feet: 60 },
      phases: [{ source_name: "Bay A", status: "matched", group_id: BAY_A, group_name: "Bay A", candidates: [], reason: null, source_rows: 2, matched_rows: 1 }],
      matched_rows: 1, resolved_rows: 0, skipped_rows: ready ? 1 : 0, row_issues: [issue],
      setup_rows_not_on_map: [{ group_id: BAY_A, group_name: "Bay A", row_numbers: [2, 3, 4, 6] }], groups_not_on_map: [], geometry_problems: [],
      unresolved: ready ? 0 : 1, ready
    },
    map: { name: "North house", east_west_feet: 100, north_south_feet: 60, phases: [] }
  };
};

beforeEach(() => {
  saved = null;
  calls.length = 0;
  downloads.length = 0;
  apiFetchMock.mockImplementation((path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    let status = 200;
    let json: unknown = {};
    if (path === "/api/greenhouse-map" && method === "GET") json = { map: saved, setup: SETUP };
    else if (path === "/api/greenhouse-map" && method === "PUT") {
      saved = { ...body.map, id: "m", source: "builder", updated_at: "2026-11-13T10:00:00.000Z" };
      json = { map: saved };
    } else if (path === "/api/greenhouse-map/import/preview") json = reportFor(body);
    else if (path === "/api/greenhouse-map/import") {
      const r = reportFor(body);
      if (!r.report.ready) status = 409;
      else saved = { ...r.map, id: "m", source: "labourlink_import", updated_at: "2026-11-13T11:00:00.000Z" };
      json = r;
    }
    return Promise.resolve({ ok: status < 400, status, json: async () => json });
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Greenhouse map builder", () => {
  it("a second organization builds its map from scratch from its own Greenhouse Setup rows", async () => {
    const user = userEvent.setup();
    render(<GreenhouseMapBuilderPage />);
    await screen.findByText("No map yet");
    await user.type(screen.getByLabelText("East–west (ft)"), "100");
    await user.type(screen.getByLabelText("North–south (ft)"), "60");
    await user.click(screen.getByRole("button", { name: "Start map" }));

    const builder = screen.getByRole("complementary", { name: "Map builder" });
    await user.click(within(builder).getByRole("button", { name: "Add to map" }));
    // Phase covers the land.
    for (const [label, value] of [["East–west (ft)", "100"], ["North–south (ft)", "60"]] as const) {
      const input = within(builder).getAllByLabelText(label)[1];
      fireEvent.change(input, { target: { value } });
    }
    // Rows 1-6 from the north, anchored west: 4 ft wide, 2 ft apart, 80 ft long.
    const form = within(builder).getByRole("form", { name: "Place rows" });
    await user.type(within(form).getByLabelText("Row width (ft)"), "4");
    await user.type(within(form).getByLabelText("Row length (ft)"), "80");
    await user.clear(within(form).getByLabelText("Gap between rows (ft)"));
    await user.type(within(form).getByLabelText("Gap between rows (ft)"), "2");
    await user.type(within(form).getByLabelText("From row"), "1");
    await user.type(within(form).getByLabelText("To row"), "6");
    expect(within(form).getByText(/5 rows shown in blue/)).toBeInTheDocument();
    expect(within(form).getByText("1 number in that range isn't in Greenhouse Setup and is skipped.")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Place rows" }));
    await user.click(screen.getByRole("button", { name: "Save map" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Map saved."));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body.expected_updated_at).toBeNull();
    expect(put.body.map.phases).toHaveLength(1);
    expect(put.body.map.phases[0].group_id).toBe(BAY_A);
    // Row 5 doesn't exist in Greenhouse Setup, so it's skipped, not created; the rest stack from the north.
    expect(put.body.map.phases[0].rows.map((r: any) => [r.row_number, r.x_ft, r.y_ft, r.orientation])).toEqual([
      [1, 0, 0, "horizontal"], [2, 0, 6, "horizontal"], [3, 0, 12, "horizontal"], [4, 0, 18, "horizontal"], [6, 0, 24, "horizontal"]
    ]);
    // The saved map is drawn: rows are on the canvas.
    expect(within(screen.getByRole("group", { name: "Greenhouse map" })).getAllByRole("button", { name: /^Bay A row \d/ })).toHaveLength(5);
  });

  it("a LabourLink import shows the recreated map and match report, and imports only once every row is resolved", async () => {
    const user = userEvent.setup();
    render(<GreenhouseMapBuilderPage />);
    await screen.findByText("No map yet");
    const layout = {
      format: "labourlink-greenhouse-layout", version: 1,
      lands: [{ name: "North house", eastWestFeet: 100, northSouthFeet: 60, phases: [{ name: "Bay A", xFeetFromWest: 0, yFeetFromNorth: 0, eastWestFeet: 100, northSouthFeet: 60, rows: [
        { rowNumber: 1, xFt: 0, yFt: 0, widthFt: 4, lengthFt: 80, orientation: "horizontal" },
        { rowNumber: 9, xFt: 0, yFt: 6, widthFt: 4, lengthFt: 80, orientation: "horizontal" }
      ] }] }]
    };
    const file = new File([JSON.stringify(layout)], "north.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("LabourLink layout file"), file);

    const panel = await screen.findByLabelText("LabourLink import");
    expect(within(panel).getByRole("status")).toHaveTextContent("1 item to resolve before importing. 1 rows matched so far.");
    const recreated = within(panel).getByRole("group", { name: "Recreated North house map" });
    expect(within(recreated).getByRole("img", { name: /LabourLink Bay A row 9: Bay A has no row 9/ })).toHaveClass("import-unmatched");
    expect(within(recreated).getByRole("img", { name: /LabourLink Bay A row 1: → Bay A row 1/ })).toHaveClass("import-matched");
    expect(within(panel).getByText("Bay A rows 2–4, 6")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Import this map" })).toBeDisabled();

    await user.click(within(panel).getByRole("button", { name: "Download match report (CSV)" }));
    expect(downloads[0].name).toBe("labourlink-map-match-report.csv");
    expect(await downloads[0].blob.text()).toContain("Row,Bay A,9,unmatched,Bay A,,Bay A has no row 9 in Greenhouse Setup.");

    await user.selectOptions(within(panel).getByLabelText("Resolve Bay A row 9"), "skip");
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("Ready: 1 rows matched, 1 left off."));
    expect(calls.filter((c) => c.path.endsWith("/import/preview")).at(-1)!.body.row_resolutions).toEqual({ "Bay A#9": "skip" });
    await user.click(within(panel).getByRole("button", { name: "Import this map" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("LabourLink layout imported."));
    const imported = calls.find((c) => c.path === "/api/greenhouse-map/import")!;
    expect(imported.body).toMatchObject({ row_resolutions: { "Bay A#9": "skip" }, expected_updated_at: null });
  });
});
