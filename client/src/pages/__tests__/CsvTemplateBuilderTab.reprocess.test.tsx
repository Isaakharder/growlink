import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every apiFetch call is recorded, so tests can assert that reprocessing is
// one bulk request (never one per file) and that Refresh never reprocesses.
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

const V11 = { id: "tpl-v11", name: "Latest Mapping", version: 11 };
const V13 = { id: "tpl-v13", name: "Latest Mapping", version: 13 };

function source(id: string, filename: string) {
  return {
    pendingImportId: id,
    sourceFileId: `src-${id}`,
    sourceFilename: filename,
    uploadedAt: "2026-09-26T10:43:50Z",
    templateId: V11.id,
    templateName: V11.name,
    templateVersion: 11,
    matchStatus: "exact",
    lotNumber: filename.replace(/\D/g, ""),
    packedDate: null,
    mappedKg: 420.95,
    sizeKg: {},
    averageFruitWeightG: null,
    averageFruitWeightBasis: null,
    reconciliationOk: true,
    unresolvedLabels: [],
    blockingIssues: []
  };
}

const STALE_CARD = {
  cardKey: "org:raw:0699:none:none",
  organizationId: "org",
  varietyId: "variety-0699",
  varietyName: "0699",
  isoYear: null,
  isoWeek: null,
  mappedKg: 571,
  lotCount: 2,
  sourceFileCount: 2,
  templateNames: ["Latest Mapping (v11)"],
  matchStatus: "exact",
  combinedAverageFruitWeightG: null,
  ignoredKg: 0,
  distributedKg: 0,
  unresolvedKg: 0,
  reconciliationDifference: 0,
  reconciliationOk: true,
  kgPerM2: null,
  lots: [],
  sizeKg: {},
  unresolvedLabelGroups: [],
  canImport: false,
  blockingIssues: [{ code: "packed_date_unresolved", message: "Packed date could not be resolved for lot:2609220442." }],
  sources: [source("p-442", "lot-2609220442.csv"), source("p-443", "lot-2609220443.csv")]
};

function planOrResult(dryRun: boolean, total = 14) {
  const results = [
    ...Array.from({ length: total - 2 }, (_, i) => ({
      pendingImportId: `p-${i}`,
      sourceFileId: `s-${i}`,
      sourceFilename: `lot-${i}.csv`,
      outcome: "updated",
      previousTemplate: V11,
      template: V13,
      needsTemplate: false,
      error: null
    })),
    { pendingImportId: "p-same", sourceFileId: "s-same", sourceFilename: "lot-same.csv", outcome: "unchanged", previousTemplate: V13, template: V13, needsTemplate: false, error: null },
    {
      pendingImportId: "p-bad",
      sourceFileId: "s-bad",
      sourceFilename: "lot-broken.csv",
      outcome: "failed",
      previousTemplate: V11,
      template: null,
      needsTemplate: false,
      error: "Referenced source file was not found."
    }
  ];
  return {
    dryRun,
    total,
    updated: total - 2,
    unchanged: 1,
    failed: 1,
    skippedImported: 0,
    targetTemplates: [{ ...V13, sourceCount: total - 1 }],
    results
  };
}

type Handler = (path: string, method: string, body: unknown) => unknown;
let override: Handler | null = null;

function route(path: string, method: string, body: unknown) {
  const custom = override?.(path, method, body);
  if (custom !== undefined) return custom;
  if (path.includes("weekly-cards")) return jsonOk({ cards: [STALE_CARD], unmatched: [] });
  if (path.startsWith("/api/csv-templates/pending/reprocess-plan")) return jsonOk(planOrResult(true));
  if (path === "/api/csv-templates/pending/reprocess") return jsonOk(planOrResult(false));
  return jsonOk([]);
}

function renderTab() {
  return render(
    <MemoryRouter>
      <CsvTemplateBuilderTab />
    </MemoryRouter>
  );
}

const reprocessPosts = () => calls.filter((c) => c.path === "/api/csv-templates/pending/reprocess" && c.method === "POST");
const perFileCalls = () => calls.filter((c) => c.path.includes("/source-files/") || c.path === "/api/csv-templates/preview");
const weeklyCardsCount = () => calls.filter((c) => c.path.includes("weekly-cards")).length;

beforeEach(() => {
  calls.length = 0;
  override = null;
  localStorage.clear();
  apiFetch.mockImplementation((path: string, options?: RequestInit) =>
    Promise.resolve().then(() => route(path, options?.method ?? "GET", typeof options?.body === "string" ? JSON.parse(options.body) : null))
  );
});

afterEach(() => vi.clearAllMocks());

async function openBulkConfirmation() {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText("lot-2609220442.csv", { exact: false });
  await user.click(screen.getByRole("button", { name: "Reprocess all pending files" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm reprocessing" });
  return { user, dialog };
}

describe("CsvTemplateBuilderTab — reprocessing pending files", () => {
  it("Refresh only reloads cards — it never reprocesses", async () => {
    const user = userEvent.setup();
    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));
    await user.click(screen.getAllByRole("button", { name: /^refresh$/i })[0]);
    await waitFor(() => expect(weeklyCardsCount()).toBe(2));
    expect(calls.some((c) => c.path.includes("reprocess"))).toBe(false);
  });

  it("confirms with the file count and target template before doing anything", async () => {
    const { dialog } = await openBulkConfirmation();
    expect(
      within(dialog).getByText(
        "Reprocess 14 pending source files using Latest Mapping v13? This will update their previews and warnings but will not import anything."
      )
    ).toBeInTheDocument();
    expect(reprocessPosts()).toHaveLength(0);
  });

  it("sends ONE bulk request, disables the button while processing, and ignores duplicate clicks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    override = (path, method) =>
      path === "/api/csv-templates/pending/reprocess" && method === "POST" ? gate.then(() => jsonOk(planOrResult(false))) : undefined;

    const { user, dialog } = await openBulkConfirmation();
    await user.click(within(dialog).getByRole("button", { name: "Reprocess" }));

    // The bulk button and the card's button both switch to a disabled "Reprocessing…".
    const busyButtons = await screen.findAllByRole("button", { name: "Reprocessing…" });
    expect(busyButtons).toHaveLength(2);
    for (const b of busyButtons) expect(b).toBeDisabled();
    for (const b of busyButtons) await user.click(b);

    release();
    await screen.findByText("12 files updated · 1 unchanged · 1 failed");
    expect(reprocessPosts()).toHaveLength(1);
    expect(reprocessPosts()[0].body).toEqual({});
    // No per-file requests from the client.
    expect(perFileCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Reprocess all pending files" })).toBeEnabled();
  });

  it("renders the summary with each failed file's name and error, then refreshes the cards once", async () => {
    const { user, dialog } = await openBulkConfirmation();
    const before = weeklyCardsCount();
    await user.click(within(dialog).getByRole("button", { name: "Reprocess" }));

    const summary = (await screen.findByText("12 files updated · 1 unchanged · 1 failed")).closest("[role=status]") as HTMLElement;
    const failure = within(summary).getByText("lot-broken.csv").closest("li")!;
    expect(failure).toHaveTextContent("lot-broken.csv: Referenced source file was not found.");
    await waitFor(() => expect(weeklyCardsCount()).toBe(before + 1));
  });

  it("cancelling the confirmation sends nothing", async () => {
    const { user, dialog } = await openBulkConfirmation();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Confirm reprocessing" })).not.toBeInTheDocument();
    expect(reprocessPosts()).toHaveLength(0);
  });

  it("a card's Reprocess action reprocesses every source on that card in one request", async () => {
    override = (path) => (path.startsWith("/api/csv-templates/pending/reprocess-plan") ? jsonOk(planOrResult(true, 2)) : undefined);
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Reprocess card (2 files)" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm reprocessing" });
    expect(within(dialog).getByText(/Reprocess all 2 source files on this card using Latest Mapping v13\?/)).toBeInTheDocument();
    const planCall = calls.find((c) => c.path.startsWith("/api/csv-templates/pending/reprocess-plan"))!;
    expect(decodeURIComponent(planCall.path)).toContain("pendingImportIds=p-442,p-443");

    await user.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    await waitFor(() => expect(reprocessPosts()).toHaveLength(1));
    expect(reprocessPosts()[0].body).toEqual({ pendingImportIds: ["p-442", "p-443"] });
  });

  it("shows a safe server message when the bulk request itself fails", async () => {
    override = (path, method) =>
      path === "/api/csv-templates/pending/reprocess" && method === "POST"
        ? { ok: false, status: 500, headers: new Headers(), json: async () => ({ message: "Failed to reprocess pending files." }) }
        : undefined;
    const { user, dialog } = await openBulkConfirmation();
    await user.click(within(dialog).getByRole("button", { name: "Reprocess" }));
    expect(await screen.findByText("Failed to reprocess pending files.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprocess all pending files" })).toBeEnabled();
  });
});

// A restored in-progress mapping (same mechanism as a page refresh), so
// the Save button is available without driving the whole visual mapper.
function persistBuilderDraft() {
  const grid = [
    ["LOTNUMBER", "VARIETY", "BEGINDT", "SIZE1", "WEIGHT", "AVG", "PCS"],
    ["2609220442", "0699", "22092026", "SM", "13.138", "117.3", "112"]
  ];
  localStorage.setItem(
    "growlink:csv-template-builder:draft:v1",
    JSON.stringify({
      parsed: { sourceFileId: "src-442", grid, rowCount: 2, columnCount: 7, delimiter: ",", encoding: "utf-8", match: { kind: "none", templateId: null, templateName: null, similarity: null } },
      draft: {
        delimiter: ",",
        headerRowIndex: 0,
        dataStartRowIndex: 1,
        dataEndRowIndex: null,
        skipRowIndexes: [],
        blankRowBehavior: "skip",
        columnMappings: [{ columnIndex: 4, field: "size_weight_kg" }],
        fixedCellMappings: [],
        valueMappings: [],
        rules: []
      },
      columnAssignments: [[4, "size_weight_kg"]],
      rowIgnoreSelections: [],
      packDateFormat: "DDMMYYYY",
      templateName: "Latest Mapping",
      closeMatchChoice: "build",
      savedAt: Date.now()
    })
  );
}

const SAVED_TEMPLATE = {
  ...V13,
  templateGroupId: "grp",
  isActive: true,
  isCurrent: true,
  delimiter: ",",
  headerRowIndex: 0,
  columnCount: 7,
  layoutSummary: "7 columns",
  mappedFieldsCount: 1,
  rulesCount: 0,
  valueMappingsCount: 0,
  createdBy: "u",
  updatedBy: "u",
  createdAt: "2026-09-26T16:14:33Z",
  updatedAt: "2026-09-26T16:14:33Z",
  dataStartRowIndex: 1,
  dataEndRowIndex: null,
  skipRowIndexes: [],
  blankRowBehavior: "skip",
  columnMappings: [],
  fixedCellMappings: [],
  valueMappings: [],
  rules: []
};

describe("CsvTemplateBuilderTab — offering reprocessing after a save", () => {
  beforeEach(() => {
    persistBuilderDraft();
    override = (path, method) => {
      if (path === "/api/csv-templates" && method === "POST") return jsonOk(SAVED_TEMPLATE);
      if (path === "/api/csv-templates/preview") return jsonOk({ preview: { groups: [], validationIssues: [], canImport: false }, templateId: null, templateVersion: null, layoutMismatch: false });
      return undefined;
    };
  });

  async function save() {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Save as template" }));
    return { user, prompt: await screen.findByRole("dialog", { name: "Reprocess after saving" }) };
  }

  it("offers to reprocess compatible pending files once the save succeeded", async () => {
    const { prompt } = await save();
    expect(within(prompt).getByText("Mapping saved as version 13. Reprocess all pending files now?")).toBeInTheDocument();
    expect(within(prompt).getByRole("button", { name: "Reprocess now" })).toBeInTheDocument();
    expect(within(prompt).getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(reprocessPosts()).toHaveLength(0);
  });

  it('"Not now" closes the prompt, keeps the saved mapping, and reprocesses nothing', async () => {
    const { user, prompt } = await save();
    await user.click(within(prompt).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog", { name: "Reprocess after saving" })).not.toBeInTheDocument();
    expect(screen.getByText(/Template "Latest Mapping" saved/)).toBeInTheDocument();
    expect(reprocessPosts()).toHaveLength(0);
    // The bulk action is still available later.
    expect(screen.getByRole("button", { name: "Reprocess all pending files" })).toBeEnabled();
  });

  it('"Reprocess now" runs one bulk reprocess', async () => {
    const { user, prompt } = await save();
    await user.click(within(prompt).getByRole("button", { name: "Reprocess now" }));
    await screen.findByText("12 files updated · 1 unchanged · 1 failed");
    expect(reprocessPosts()).toHaveLength(1);
  });

  it("does not prompt when no pending file would use the saved template", async () => {
    const base = override!;
    override = (path, method, body) =>
      path.startsWith("/api/csv-templates/pending/reprocess-plan")
        ? jsonOk({ ...planOrResult(true), updated: 0, targetTemplates: [], results: [] })
        : base(path, method, body);
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Save as template" }));
    await screen.findByText(/Template "Latest Mapping" saved/);
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/api/csv-templates/pending/reprocess-plan"))).toBe(true));
    expect(screen.queryByRole("dialog", { name: "Reprocess after saving" })).not.toBeInTheDocument();
  });
});
