import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Layout of the CSV Templates page: one Pending CSV Imports section, the
// Load a CSV file card and the Saved CSV Templates toolbar — and that the
// restyle left every action wired to the same behaviour.
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
const jsonError = (status: number, message: string) => ({ ok: false, status, headers: new Headers(), json: async () => ({ message }) });

const TEMPLATE = {
  id: "tpl-v14",
  templateGroupId: "grp-latest",
  name: "Latest Mapping",
  version: 14,
  isActive: true,
  isCurrent: true,
  delimiter: ",",
  headerRowIndex: 0,
  columnCount: 14,
  layoutSummary: '14 columns · delimiter "," · header row 1',
  mappedFieldsCount: 8,
  rulesCount: 0,
  valueMappingsCount: 13,
  createdBy: "u1",
  updatedBy: "u1",
  createdByName: "isaak",
  updatedByName: "isaak",
  createdAt: "2026-09-26T12:50:44Z",
  updatedAt: "2026-09-26T12:50:44Z"
};

const SOURCE = {
  pendingImportId: "p-438",
  sourceFileId: "src-438",
  sourceFilename: "lot-2609210438.csv",
  uploadedAt: "2026-09-26T10:43:50Z",
  templateId: TEMPLATE.id,
  templateName: TEMPLATE.name,
  templateVersion: 14,
  matchStatus: "exact",
  lotNumber: "2609210438",
  packedDate: "2026-09-21",
  mappedKg: 8602.02,
  sizeKg: {},
  averageFruitWeightG: 172.3,
  averageFruitWeightBasis: null,
  reconciliationOk: true,
  unresolvedLabels: [],
  blockingIssues: [],
  warnings: []
};

const CARD = {
  cardKey: "org:variety-cadalora:2026:39",
  organizationId: "org",
  varietyId: "variety-cadalora",
  varietyName: "Cadalora",
  isoYear: 2026,
  isoWeek: 39,
  mappedKg: 8602.02,
  lotCount: 1,
  sourceFileCount: 1,
  templateNames: ["Latest Mapping (v14)"],
  matchStatus: "exact",
  combinedAverageFruitWeightG: 172.3,
  ignoredKg: 120.02,
  distributedKg: 0,
  unresolvedKg: 0,
  reconciliationDifference: 0,
  reconciliationOk: true,
  kgPerM2: null,
  lots: [{ lotNumber: "2609210438", packedDate: "2026-09-21" }],
  sizeKg: { Large: 8602.02 },
  unresolvedLabelGroups: [],
  canImport: true,
  blockingIssues: [],
  warnings: [
    {
      code: "missing_source_afw",
      message: "lot-2609210438.csv: Source AFW is \"null\" on 2 included rows. Valid Piece Count is available, so AFW is calculated from kg and pieces.",
      severity: "warning"
    }
  ],
  sources: [SOURCE]
};

const UNMATCHED = {
  id: "p-new",
  sourceFilename: "packline-export.csv",
  sourceFileId: "src-new",
  uploadedAt: "2026-09-26T11:00:00Z",
  matchKind: "none",
  error: null
};

type Handler = (path: string, method: string) => unknown;
let override: Handler | null = null;
let weeklyCards: { cards: unknown[]; unmatched: unknown[] } = { cards: [], unmatched: [] };

function route(path: string, method: string) {
  const custom = override?.(path, method);
  if (custom !== undefined) return custom;
  if (path.includes("weekly-cards")) return jsonOk(weeklyCards);
  if (path === "/api/csv-templates" && method === "GET") return jsonOk([TEMPLATE]);
  if (path === `/api/csv-templates/${TEMPLATE.id}` && method === "GET") {
    return jsonOk({ ...TEMPLATE, columnMappings: [], fixedCellMappings: [], valueMappings: [], rules: [] });
  }
  if (path === `/api/csv-templates/${TEMPLATE.id}/duplicate`) return jsonOk({ ...TEMPLATE, id: "tpl-copy", name: "Latest Mapping (copy)" });
  if (path === `/api/csv-templates/${TEMPLATE.id}/active`) return jsonOk({ ...TEMPLATE, isActive: false });
  if (path.startsWith("/api/csv-templates/pending/reprocess-plan")) {
    return jsonOk({ dryRun: true, total: 1, updated: 1, unchanged: 0, failed: 0, skippedImported: 0, targetTemplates: [], results: [] });
  }
  return jsonOk([]);
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <CsvTemplateBuilderTab />
    </MemoryRouter>
  );

const pendingSection = () => screen.getByRole("region", { name: "Pending CSV Imports" });
const savedSection = () => screen.getByRole("region", { name: "Saved CSV Templates" });
const loadSection = () => screen.getByRole("region", { name: "Load a CSV file" });

beforeEach(() => {
  calls.length = 0;
  override = null;
  weeklyCards = { cards: [], unmatched: [] };
  localStorage.clear();
  apiFetch.mockImplementation((path: string, options?: RequestInit) =>
    Promise.resolve().then(() => route(path, options?.method ?? "GET"))
  );
});

afterEach(() => vi.clearAllMocks());

describe("CSV Templates page — Pending CSV Imports", () => {
  it("renders the Pending CSV Imports section exactly once, even with both weekly cards and files that need a template", async () => {
    weeklyCards = { cards: [CARD], unmatched: [UNMATCHED] };
    renderTab();
    await screen.findByText("packline-export.csv");

    expect(screen.getAllByRole("heading", { name: "Pending CSV Imports" })).toHaveLength(1);
    const section = pendingSection();
    // Both kinds of pending file live in that one section.
    expect(within(section).getByText("Cadalora", { exact: false })).toBeInTheDocument();
    expect(within(section).getByRole("heading", { name: /Files that need a template/ })).toBeInTheDocument();
    expect(within(section).getByText("packline-export.csv")).toBeInTheDocument();
    // 1 weekly-card source + 1 unmatched file.
    expect(within(section).getByText("2 pending files")).toBeInTheDocument();
    // One Refresh for the section, not one per list.
    expect(within(section).getAllByRole("button", { name: /^refresh$/i })).toHaveLength(1);
  });

  it("shows one caught-up empty state and disables Reprocess, explaining why", async () => {
    renderTab();
    const empty = await screen.findByText("You’re all caught up");
    expect(empty.closest("[role=status]")).toHaveTextContent("No pending CSV imports right now.");
    expect(screen.getAllByText("No pending CSV imports right now.")).toHaveLength(1);

    const reprocess = within(pendingSection()).getByRole("button", { name: "Reprocess all pending files" });
    expect(reprocess).toBeDisabled();
    expect(reprocess).toHaveAccessibleDescription("Reprocessing becomes available when there are pending files.");
    expect(screen.queryByText(/^\d+ pending files?$/)).not.toBeInTheDocument();
  });

  it("enables Reprocess as the primary action when files are pending, and it still opens the confirmation", async () => {
    weeklyCards = { cards: [CARD], unmatched: [] };
    const user = userEvent.setup();
    renderTab();
    await screen.findAllByText("lot-2609210438.csv", { exact: false });

    const reprocess = within(pendingSection()).getByRole("button", { name: "Reprocess all pending files" });
    expect(reprocess).toBeEnabled();
    expect(reprocess).toHaveClass("csv-tb-btn--primary");
    expect(reprocess).not.toHaveAttribute("aria-describedby");

    await user.click(reprocess);
    expect(await screen.findByRole("dialog", { name: "Confirm reprocessing" })).toBeInTheDocument();
  });

  it("shows a loading state while the first load is in flight, then the empty state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    override = (path) => (path.includes("weekly-cards") ? gate.then(() => jsonOk({ cards: [], unmatched: [] })) : undefined);
    renderTab();

    expect(await screen.findByText("Loading pending imports…")).toBeInTheDocument();
    expect(within(pendingSection()).getByRole("button", { name: "Refreshing..." })).toBeDisabled();
    expect(screen.queryByText("You’re all caught up")).not.toBeInTheDocument();

    release();
    expect(await screen.findByText("You’re all caught up")).toBeInTheDocument();
    expect(screen.queryByText("Loading pending imports…")).not.toBeInTheDocument();
  });

  it("shows a load error instead of the empty state", async () => {
    override = (path) => (path.includes("weekly-cards") ? jsonError(500, "Failed to load pending CSV imports (500)") : undefined);
    renderTab();
    expect(await screen.findByText("Failed to load pending CSV imports (500)")).toBeInTheDocument();
    expect(screen.queryByText("You’re all caught up")).not.toBeInTheDocument();
  });

  it("renders card warnings, and keeps Import, Reprocess card and Remove wired", async () => {
    weeklyCards = { cards: [CARD], unmatched: [UNMATCHED] };
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("packline-export.csv");

    expect(screen.getByText(/Source AFW is "null" on 2 included rows/)).toBeInTheDocument();

    await user.click(within(pendingSection()).getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/Cadalora/);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /cancel/i }));

    await user.click(within(pendingSection()).getByRole("button", { name: /Reprocess card/ }));
    expect(await screen.findByRole("dialog", { name: "Confirm reprocessing" })).toHaveTextContent("Reprocess this card?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const removeButtons = within(pendingSection()).getAllByRole("button", { name: "Remove" });
    // One on the weekly card's source, one on the unmatched file — both destructive.
    expect(removeButtons).toHaveLength(2);
    for (const b of removeButtons) expect(b).toHaveClass("csv-tb-btn--danger");
    expect(within(pendingSection()).getByRole("button", { name: "Set up CSV Template" })).toHaveClass("csv-tb-btn--primary");
  });
});

describe("CSV Templates page — Load a CSV file", () => {
  it("is its own section with Upload as the primary action and the reuse actions as outlined secondaries", async () => {
    renderTab();
    const section = loadSection();
    expect(within(section).getByText("Upload a CSV from this computer, or reuse one GrowLink already received.")).toBeInTheDocument();

    const upload = within(section).getByRole("button", { name: "Upload CSV" });
    expect(upload).toHaveClass("csv-tb-btn--primary");
    expect(within(section).getByRole("button", { name: "Use most recent source" })).toHaveClass("csv-tb-btn--outline");
    expect(within(section).getByRole("button", { name: "Choose recent source" })).toHaveClass("csv-tb-btn--outline");

    // The real file input is still there and still what Upload CSV opens.
    const input = screen.getByTestId("csv-template-upload-input") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "file");
    // Hidden from the accessibility tree (the Upload CSV button is the control), but still labelled.
    expect(input).toHaveAttribute("aria-label", "CSV file to upload");
    const clickSpy = vi.spyOn(input, "click");
    await userEvent.setup().click(upload);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CSV Templates page — Saved CSV Templates", () => {
  async function renderWithTemplate() {
    const user = userEvent.setup();
    renderTab();
    await within(savedSection()).findByRole("heading", { name: "Latest Mapping" });
    const toolbar = within(savedSection()).getByRole("group", { name: "Actions for Latest Mapping" });
    return { user, toolbar };
  }

  it("shows name, a text status badge, summaries and metadata beneath them", async () => {
    await renderWithTemplate();
    const card = within(savedSection()).getByRole("article", { name: "Latest Mapping" });
    expect(within(card).getByText("Active")).toBeInTheDocument();
    expect(within(card).getByText(/Version 14/)).toBeInTheDocument();
    expect(within(card).getByText(/8 mapped fields · 0 rules · 13 value mappings/)).toBeInTheDocument();
    const meta = card.querySelector(".csv-tb-template-meta")!;
    expect(meta).toHaveTextContent(/Created .* by isaak/);
    expect(meta).toHaveTextContent(/Updated .* by isaak/);
    expect(within(savedSection()).getByText("1 template")).toBeInTheDocument();
  });

  it("keeps all six actions, in order, with the agreed hierarchy", async () => {
    const { toolbar } = await renderWithTemplate();
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["View mappings", "Test with a CSV", "Edit", "Duplicate", "Disable", "Delete"]);

    const [view, test, edit, duplicate, disable, del] = buttons;
    for (const b of [view, test, edit]) expect(b.className).toBe("csv-tb-btn");
    expect(duplicate).toHaveClass("csv-tb-btn--quiet");
    expect(disable).toHaveClass("csv-tb-btn--warning");
    expect(del).toHaveClass("csv-tb-btn--danger");
    // Nothing in the toolbar is green-primary.
    for (const b of buttons) expect(b).not.toHaveClass("csv-tb-btn--primary");
  });

  it("View mappings, Test, Edit, Duplicate, Disable and Delete still do what they did", async () => {
    const { user, toolbar } = await renderWithTemplate();

    await user.click(within(toolbar).getByRole("button", { name: "View mappings" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/csv-templates/${TEMPLATE.id}` && c.method === "GET")).toBe(true));

    await user.click(within(toolbar).getByRole("button", { name: "Test with a CSV" }));
    const testDialog = await screen.findByRole("dialog", { name: "Test Latest Mapping" });
    await user.click(within(testDialog).getByRole("button", { name: "Close" }));

    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Latest Mapping (copy)");
    await user.click(within(toolbar).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/csv-templates/${TEMPLATE.id}/duplicate` && c.method === "POST")).toBe(true));
    expect(prompt).toHaveBeenCalledTimes(1);
    prompt.mockRestore();

    await user.click(within(toolbar).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/csv-templates/${TEMPLATE.id}/active` && c.method === "PATCH")).toBe(true));

    // Delete still asks first and sends nothing until confirmed.
    await user.click(within(toolbar).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete “Latest Mapping”?")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("Edit switches the Load section into editing mode with a Cancel editing action", async () => {
    const { user, toolbar } = await renderWithTemplate();
    await user.click(within(toolbar).getByRole("button", { name: "Edit" }));
    const section = await screen.findByRole("region", { name: 'Editing "Latest Mapping"' });
    await user.click(within(section).getByRole("button", { name: "Cancel editing" }));
    expect(await screen.findByRole("region", { name: "Load a CSV file" })).toBeInTheDocument();
  });

  it("a busy destructive action stays destructive and disabled — distinct from a merely disabled one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    override = (path, method) =>
      path === `/api/csv-templates/${TEMPLATE.id}/active` && method === "PATCH" ? gate.then(() => jsonOk({ ...TEMPLATE, isActive: false })) : undefined;
    const { user, toolbar } = await renderWithTemplate();

    await user.click(within(toolbar).getByRole("button", { name: "Disable" }));
    const updating = await within(toolbar).findByRole("button", { name: "Updating..." });
    expect(updating).toBeDisabled();
    expect(updating).toHaveAttribute("aria-busy", "true");
    expect(updating).toHaveClass("csv-tb-btn--warning");
    // Delete is untouched: enabled and still red.
    const del = within(toolbar).getByRole("button", { name: "Delete" });
    expect(del).toBeEnabled();
    expect(del).toHaveClass("csv-tb-btn--danger");
    release();
  });

  it("shows a neutral empty state when there are no saved templates", async () => {
    override = (path, method) => (path === "/api/csv-templates" && method === "GET" ? jsonOk([]) : undefined);
    renderTab();
    expect(await within(savedSection()).findByText("No saved templates yet")).toBeInTheDocument();
    expect(within(savedSection()).getByText("Build one above and it will appear here.")).toBeInTheDocument();
  });
});
