import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every apiFetch call is recorded so a test can assert which endpoints a
// workflow used — in particular that reusing a retained source never needs
// a local upload (parse-grid).
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options?: RequestInit) => {
    const body = typeof options?.body === "string" ? JSON.parse(options.body) : options?.body ?? null;
    calls.push({ path, method: options?.method ?? "GET", body });
    return apiFetch(path, options);
  }
}));

import { CsvTemplateBuilderTab } from "../CsvTemplateBuilderTab";

const jsonOk = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

const HEADER = ["LOTNUMBER", "RUN", "VARIETY", "BEGINDT", "ENDDT", "MARKET", "SIZE1", "SIZE2", "WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS "];
const GRID = [
  HEADER,
  ["2609220442", "1", "0699", "22092026", "22092026", "Class 1", "SM", "null", "13.138", "117.3", "112", "427.618", "192.3", "2224"],
  ["2609220442", "1", "0699", "22092026", "22092026", "Class 1", "XL", "null", "222.494", "220.3", "1010", "427.618", "192.3", "2224"]
];

const TEMPLATE_SUMMARY = {
  id: "tpl-latest",
  templateGroupId: "grp-1",
  name: "Latest Mapping",
  version: 11,
  isActive: true,
  isCurrent: true,
  delimiter: ",",
  headerRowIndex: 0,
  columnCount: 14,
  layoutSummary: "14 columns",
  mappedFieldsCount: 8,
  rulesCount: 0,
  valueMappingsCount: 0,
  createdBy: "u1",
  updatedBy: "u1",
  createdByName: "Isaak",
  updatedByName: "Isaak",
  createdAt: "2026-09-26T14:47:46Z",
  updatedAt: "2026-09-26T14:47:46Z"
};

// The saved Latest Mapping v11: AFW/PCS on the lot-total group (12/13).
const TEMPLATE_DETAIL = {
  ...TEMPLATE_SUMMARY,
  dataStartRowIndex: 1,
  dataEndRowIndex: null,
  skipRowIndexes: [],
  blankRowBehavior: "skip",
  columnMappings: [
    { columnIndex: 2, field: "variety" },
    { columnIndex: 3, field: "packed_date" },
    { columnIndex: 0, field: "lot_number" },
    { columnIndex: 6, field: "size_label" },
    { columnIndex: 8, field: "size_weight_kg" },
    { columnIndex: 12, field: "average_fruit_weight_g" },
    { columnIndex: 1, field: "run_number" },
    { columnIndex: 13, field: "piece_count" }
  ],
  fixedCellMappings: [],
  valueMappings: [],
  rules: []
};

const RECENT_FILES = [
  {
    id: "src-other",
    filename: "weekly-summary.csv",
    uploadedAt: "2026-09-25T10:00:00Z",
    rowCount: 5,
    columnCount: 3,
    status: "needs_template",
    templateId: null,
    templateName: null,
    templateVersion: null,
    compatible: false
  },
  {
    id: "src-442",
    filename: "lot-2609220442.csv",
    uploadedAt: "2026-09-22T17:03:48Z",
    rowCount: 3,
    columnCount: 14,
    status: "pending",
    templateId: "tpl-latest",
    templateName: "Latest Mapping",
    templateVersion: 11,
    compatible: true
  }
];

const EMPTY_PREVIEW = {
  preview: {
    groups: [
      {
        groupKey: "lot:2609220442",
        varietyRaw: "0699",
        packedDate: "2026-09-22",
        isoYear: 2026,
        isoWeek: 39,
        lotNumber: "2609220442",
        sizeKg: { Small: 13.138, XL: 222.494 },
        unresolvedSizeLabels: [],
        wasteKg: 0,
        pieceCount: 1122,
        averageFruitWeightG: 210.0,
        averageFruitWeightBasis: { kg: 235.632, pieces: 1122 },
        totalLotWeightKg: null,
        reconciliation: {
          rawRowWeightKg: 235.63,
          recognizedSizeKg: 235.63,
          directMappedKg: 235.63,
          distributedKg: 0,
          ignoredKg: 0,
          unresolvedKg: 0,
          subtotalKg: 0,
          lotTotalKg: null,
          difference: null,
          unexplainedDifference: false
        },
        rows: []
      }
    ],
    validationIssues: [],
    canImport: true
  },
  templateId: "tpl-latest",
  templateVersion: 11,
  layoutMismatch: false
};

function route(path: string) {
  if (path.includes("weekly-cards")) return jsonOk({ cards: [], unmatched: [] });
  if (path.startsWith("/api/csv-templates/source-files?")) return jsonOk({ files: RECENT_FILES });
  if (path === "/api/csv-templates/source-files/src-442/grid") {
    return jsonOk({
      sourceFileId: "src-442",
      filename: "lot-2609220442.csv",
      uploadedAt: "2026-09-22T17:03:48Z",
      grid: GRID,
      rowCount: 3,
      columnCount: 14,
      delimiter: ",",
      match: { kind: "exact", templateId: "tpl-latest", templateName: "Latest Mapping", similarity: 1 }
    });
  }
  if (path === "/api/csv-templates/tpl-latest") return jsonOk(TEMPLATE_DETAIL);
  if (path === "/api/csv-templates/preview") return jsonOk(EMPTY_PREVIEW);
  if (path === "/api/csv-templates") return jsonOk([TEMPLATE_SUMMARY]);
  if (path === "/api/csv-templates/parse-grid") throw new Error("parse-grid (a local upload) must not be called");
  return jsonOk([]);
}

function renderTab() {
  return render(
    <MemoryRouter>
      <CsvTemplateBuilderTab />
    </MemoryRouter>
  );
}

async function startEditingLatestMapping() {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByRole("button", { name: /^edit$/i }));
  expect(await screen.findByRole("heading", { name: /Editing "Latest Mapping"/ })).toBeInTheDocument();
  return user;
}

const uploadCalls = () => calls.filter((c) => c.path.includes("parse-grid"));

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  apiFetch.mockImplementation((path: string) => Promise.resolve().then(() => route(path)));
});

afterEach(() => vi.clearAllMocks());

describe("CsvTemplateBuilderTab — editing with a retained source", () => {
  it("edits a template with the most recent compatible source without requiring a local upload", async () => {
    const user = await startEditingLatestMapping();

    await user.click(screen.getByRole("button", { name: "Use most recent compatible source" }));

    // The compatible file was loaded, not the newer incompatible one.
    await waitFor(() => expect(calls.some((c) => c.path === "/api/csv-templates/source-files/src-442/grid")).toBe(true));
    expect(calls.some((c) => c.path.includes("src-other"))).toBe(false);
    expect(calls.find((c) => c.path.startsWith("/api/csv-templates/source-files?"))?.path).toContain("templateId=tpl-latest");

    // Source stays visible: filename and raw cells including both PCS groups.
    const preview = await screen.findByRole("region", { name: "Source File Preview" });
    expect(within(preview).getByText("lot-2609220442.csv")).toBeInTheDocument();
    expect(within(preview).getAllByText("2224").length).toBeGreaterThan(0);
    expect(within(preview).getByText("1010")).toBeInTheDocument();

    // The template's current mappings load on top, with header positions.
    const mapped = (await screen.findByRole("heading", { name: "Mapped columns" })).closest("div")!;
    await waitFor(() => expect(within(mapped).getByText(/column N .PCS. \(2nd of 2\)/)).toBeInTheDocument());

    // …and the duplicate-group mistake is called out.
    expect(screen.getByText(/Piece Count uses the 2nd "PCS" column/)).toBeInTheDocument();

    expect(uploadCalls()).toHaveLength(0);
  });

  it("lets the user choose a specific recent source, showing filename, upload time, status and template/version", async () => {
    const user = await startEditingLatestMapping();

    await user.click(screen.getByRole("button", { name: "Choose recent source" }));
    const row = (await screen.findByText("lot-2609220442.csv")).closest("tr")!;
    expect(within(row).getByText("Pending review")).toBeInTheDocument();
    expect(within(row).getByText("Latest Mapping v11")).toBeInTheDocument();
    expect(within(row).getByText("Matches")).toBeInTheDocument();
    expect(within(row).getByText(new Date("2026-09-22T17:03:48Z").toLocaleString())).toBeInTheDocument();

    const otherRow = screen.getByText("weekly-summary.csv").closest("tr")!;
    expect(within(otherRow).getByText("Different layout")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Use lot-2609220442.csv" }));
    await screen.findByRole("region", { name: "Source File Preview" });
    expect(uploadCalls()).toHaveLength(0);
  });

  it("keeps unsaved mapping changes when the Source File Preview is collapsed and reopened", async () => {
    const user = await startEditingLatestMapping();
    await user.click(screen.getByRole("button", { name: "Use most recent compatible source" }));
    const mapped = (await screen.findByRole("heading", { name: "Mapped columns" })).closest("div")!;
    await waitFor(() => expect(within(mapped).getByText(/column N/)).toBeInTheDocument());

    // Unsaved change: map column K (the per-size PCS) as Piece Count.
    const legend = document.querySelector(".csv-template-legend-chips") as HTMLElement;
    await user.click(within(legend).getByRole("button", { name: "Piece Count" }));
    await user.click(screen.getByRole("columnheader", { name: /^K/ }));
    await waitFor(() => expect(within(mapped).getByText(/column K .PCS. \(1st of 2\)/)).toBeInTheDocument());

    const toggle = screen.getByRole("button", { name: /Hide Source File Preview/ });
    await user.click(toggle);
    const preview = screen.getByRole("region", { name: "Source File Preview" });
    expect(preview).toHaveClass("is-collapsed");
    expect(screen.getByRole("button", { name: /Show Source File Preview/ })).toHaveAttribute("aria-expanded", "false");

    // Mapping state is untouched while collapsed…
    expect(within(mapped).getByText(/column K .PCS. \(1st of 2\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show Source File Preview/ }));
    expect(preview).not.toHaveClass("is-collapsed");

    // …and after reopening, the grid still shows the assignment on column K.
    expect(within(mapped).getByText(/column K .PCS. \(1st of 2\)/)).toBeInTheDocument();
    expect(within(screen.getByRole("columnheader", { name: /^K/ })).getByText("Piece Count")).toBeInTheDocument();
    expect(uploadCalls()).toHaveLength(0);
  });
});

describe("CsvTemplateBuilderTab — testing a template with a retained source", () => {
  it("tests a saved template against a recent source without uploading a file", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: /test with a csv/i }));

    const dialog = await screen.findByRole("dialog", { name: "Test Latest Mapping" });
    await user.click(within(dialog).getByRole("button", { name: "Use most recent compatible source" }));

    await waitFor(() => expect(calls.some((c) => c.path === "/api/csv-templates/preview")).toBe(true));
    const previewCall = calls.find((c) => c.path === "/api/csv-templates/preview")!;
    expect(previewCall.body).toEqual({ sourceFileId: "src-442", templateId: "tpl-latest" });
    expect(await within(dialog).findByText(/AFW 210\.0 g/)).toBeInTheDocument();
    expect(within(dialog).getByText("lot-2609220442.csv")).toBeInTheDocument();
    expect(uploadCalls()).toHaveLength(0);
  });
});
