import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Manual Add Case Entry (pack-based) and manual weeks on the Weekly Pack
// Shipments panel. The server decides totals; these screens collect entries,
// show which source counts, and surface duplicates and conflicts.
type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ path, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined });
    return apiFetch(path, options);
  }
}));

import { ManualPackEntryModal } from "../ManualPackEntryModal";
import { PackShipmentsWeek, type PackWeekResponse } from "../PackShipmentsWeek";

const jsonOk = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const CATALOGUE = {
  docklink: [
    { packSource: "docklink", packId: "p-red", name: "Red 5kg", packCode: "RL5", description: null, colorKind: "single", colorKey: "red", cropType: "pepper", trackingUnit: "kg", displayOrder: 10, status: "active" },
    { packSource: "docklink", packId: "p-tri", name: "Tri-Colour 3pk", packCode: "TC3", description: null, colorKind: "mixed", colorKey: "mixed", cropType: "pepper", trackingUnit: "kg", displayOrder: 30, status: "archived" },
    { packSource: "docklink", packId: "p-old", name: "Yellow 11lb", packCode: "Y11", description: null, colorKind: "single", colorKey: "yellow", cropType: "pepper", trackingUnit: "kg", displayOrder: 50, status: "not_in_docklink" }
  ],
  historical: [
    { packSource: "historical", packId: "h-1", name: "Red 11lb (2024)", packCode: "R11", description: null, colorKind: "single", colorKey: "red", cropType: "pepper", trackingUnit: "kg", displayOrder: null, status: "historical", entryCount: 0 }
  ]
};

type WeekInfo = { manualEntryAllowed: boolean; manualEntryBlockedReason: string | null; weekSourceChoice: string | null; legacyRows: Array<{ totalCases: number }>; manualEntries: unknown[] };
let weekInfo: WeekInfo;
let postResponses: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  calls.length = 0;
  weekInfo = { manualEntryAllowed: true, manualEntryBlockedReason: null, weekSourceChoice: null, legacyRows: [], manualEntries: [] };
  postResponses = [];
  apiFetch.mockImplementation((path: string, options: { method?: string } = {}) => {
    const method = options.method ?? "GET";
    if (path === "/api/manual-pack-entries/packs") return Promise.resolve(jsonOk(CATALOGUE));
    if (path.startsWith("/api/pack-shipments/week")) return Promise.resolve(jsonOk(weekInfo));
    if (path === "/api/historical-packs" && method === "POST") {
      CATALOGUE.historical.push({ ...CATALOGUE.historical[0], packId: "h-new", name: "Tri 3pk (2023)", colorKind: "mixed", colorKey: "mixed" });
      return Promise.resolve(jsonOk({ pack: { id: "h-new" } }, 201));
    }
    if (method === "POST" || method === "PUT") {
      const next = postResponses.shift() ?? { status: 201, body: { entries: [{ id: "e1" }, { id: "e2" }], weekSource: "manual_packs", entry: { id: "e1" } } };
      return Promise.resolve(jsonOk(next.body, next.status));
    }
    return Promise.resolve(jsonOk({}));
  });
});
afterEach(() => {
  vi.clearAllMocks();
  CATALOGUE.historical.splice(1);
});

async function openCreate(initialWeek = { isoYear: 2025, isoWeek: 14 }) {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<ManualPackEntryModal mode={{ kind: "create", initialWeek }} onClose={() => undefined} onSaved={onSaved} />);
  await screen.findByRole("option", { name: /Red 5kg \(RL5\) — Red/ });
  return { user, onSaved };
}

async function fillLine(user: ReturnType<typeof userEvent.setup>, index: number, packLabel: RegExp, cases: string) {
  const select = screen.getByLabelText(`Pack for line ${index}`);
  await user.selectOptions(select, within(select).getByRole("option", { name: packLabel }));
  await user.type(screen.getByLabelText(`Shipped cases for line ${index}`), cases);
}

const posted = () => calls.filter((c) => c.method === "POST" && c.path === "/api/manual-pack-entries").map((c) => c.body as Record<string, unknown>);

describe("Manual Add Case Entry", () => {
  it("records one invoice for an ISO week with several Product Packs, including archived and no-longer-in-DockLink packs", async () => {
    const { user, onSaved } = await openCreate();
    expect(screen.getByLabelText("ISO year")).toHaveValue("2025");
    expect(screen.getByLabelText("ISO week")).toHaveValue("14");
    const groups = Array.from(document.querySelectorAll("optgroup")).map((g) => g.getAttribute("label"));
    expect(groups).toEqual(["DockLink Product Packs", "Archived in DockLink", "No longer in DockLink", "Historical packs (GrowLink)"]);
    expect(await screen.findByText("Saving makes manual pack entries the source for 2025-W14.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Invoice reference (optional)"), "INV-1001");
    await fillLine(user, 1, /Red 5kg \(RL5\)/, "400");
    expect(screen.getByText(/kg from this week's average net kg per case/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Add pack" }));
    await fillLine(user, 2, /Tri-Colour 3pk \(TC3\) — Mixed \/ rainbow/, "120");
    expect(screen.getByText(/archived in DockLink · kg from this week's colours, peppers per case and fruit weights/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Saved 2 pack lines (520 cases) for 2025-W14."));
    expect(posted()[0]).toEqual({
      isoYear: 2025, isoWeek: 14, invoiceRef: "INV-1001", note: null, weekSource: null, confirmDuplicates: false,
      lines: [{ packSource: "docklink", packId: "p-red", cases: 400 }, { packSource: "docklink", packId: "p-tri", cases: 120 }]
    });
  });

  it("a week that already has colour totals asks which source counts before saving", async () => {
    weekInfo.legacyRows = [{ totalCases: 1400 }, { totalCases: 300 }];
    const { user } = await openCreate({ isoYear: 2026, isoWeek: 44 });
    const choice = await screen.findByRole("group", { name: /2026-W44 already has colour totals \(1,700 cases\)/ });
    await fillLine(user, 1, /Red 5kg \(RL5\)/, "1390");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose which source counts for 2026-W44.");
    expect(posted()).toEqual([]);

    await user.click(within(choice).getByLabelText(/Manual pack entries/));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].weekSource).toBe("manual_packs");
  });

  it("DockLink pack weeks can't take manual entries", async () => {
    weekInfo.manualEntryAllowed = false;
    weekInfo.manualEntryBlockedReason = "DockLink pack totals are authoritative from this week on. Correct shipments in DockLink instead.";
    await openCreate({ isoYear: 2026, isoWeek: 46 });
    expect(await screen.findByText(/DockLink pack totals are authoritative from this week on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("possible duplicates are shown before anything is saved; Save anyway confirms them", async () => {
    postResponses.push({
      status: 409,
      body: {
        code: "possible_duplicates",
        message: "Some of these lines look like entries that already exist.",
        duplicates: [{ line: 0, existing: { id: "x", isoYear: 2025, isoWeek: 14, cases: 400, invoiceRef: "INV-1001" } }]
      }
    });
    const { user, onSaved } = await openCreate();
    await user.type(screen.getByLabelText("Invoice reference (optional)"), "inv-1001");
    await fillLine(user, 1, /Red 5kg \(RL5\)/, "400");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const warning = await screen.findByText(/Possible duplicate\./);
    expect(warning.closest("[role=alert]")).toHaveTextContent("Red 5kg: 2025-W14 · 400 cases · invoice INV-1001");
    expect(onSaved).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(posted()[1].confirmDuplicates).toBe(true);
  });

  it("an old invoice pack that isn't in DockLink can be added as a historical pack and used straight away", async () => {
    const { user } = await openCreate();
    await user.selectOptions(screen.getByLabelText("Pack for line 1"), screen.getByRole("option", { name: /Pack from an old invoice/ }));
    const form = screen.getByRole("group", { name: "Pack from an old invoice" });
    await user.type(within(form).getByLabelText("Name on invoice"), "Tri 3pk (2023)");
    await user.selectOptions(within(form).getByLabelText("Colour type"), "mixed");
    expect(within(form).queryByLabelText("Colour")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Create pack" }));
    await waitFor(() => expect(screen.getByLabelText("Pack for line 1")).toHaveValue("historical:h-new"));
    expect(calls.find((c) => c.path === "/api/historical-packs")!.body).toEqual({
      name: "Tri 3pk (2023)", packCode: null, colorKind: "mixed", colorKey: null, cropType: "pepper", trackingUnit: "kg", note: null
    });
  });

  it("editing an entry changes just that entry", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    weekInfo.weekSourceChoice = "manual_packs";
    const entry = {
      id: "e9", isoYear: 2025, isoWeek: 14, packSource: "docklink" as const, packId: "p-red", packName: "Red 5kg", packCode: "RL5", colorKind: "single",
      colorKey: "red", cropType: "pepper", trackingUnit: "kg", cases: 400, invoiceRef: "INV-1001", note: null, createdAt: "", updatedAt: "", duplicates: []
    };
    render(<ManualPackEntryModal mode={{ kind: "edit", entry }} onClose={() => undefined} onSaved={onSaved} />);
    await screen.findByRole("option", { name: /Red 5kg \(RL5\)/ });
    expect(screen.getByLabelText("Pack for line 1")).toHaveValue("docklink:p-red");
    expect(screen.queryByRole("button", { name: "+ Add pack" })).not.toBeInTheDocument();
    const cases = screen.getByLabelText("Shipped cases for line 1");
    await user.clear(cases);
    await user.type(cases, "410");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Entry updated for 2025-W14."));
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      path: "/api/manual-pack-entries/e9",
      method: "PUT",
      body: { isoYear: 2025, isoWeek: 14, packSource: "docklink", packId: "p-red", cases: 410, invoiceRef: "INV-1001", note: null, weekSource: null, confirmDuplicates: false }
    });
  });
});

// ---------------------------------------------------------------------------

const zeroColors = () => ({ red: { cases: 0, kg: 0 }, orange: { cases: 0, kg: 0 }, yellow: { cases: 0, kg: 0 }, green: { cases: 0, kg: 0 } });

function manualWeek(): PackWeekResponse {
  const entry = (id: string, invoiceRef: string | null, packName: string, cases: number, extra: Record<string, unknown> = {}) => ({
    id, isoYear: 2026, isoWeek: 44, packSource: "docklink", packId: "p-red", packName, packCode: "RL5", colorKind: "single", colorKey: "red",
    cropType: "pepper", trackingUnit: "kg", cases, invoiceRef, note: null, createdAt: "", updatedAt: "", duplicates: [], ...extra
  });
  return {
    isoYear: 2026, isoWeek: 44, weekStart: "2026-10-26", weekEnd: "2026-11-01", sync: null,
    source: "manual", sourceReason: "chosen_manual", needsSourceDecision: false, weekSourceChoice: "manual_packs",
    notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 1700, legacyRows: 2 },
    manualEntryAllowed: true, manualEntryBlockedReason: null,
    manualEntries: [
      entry("e1", "INV-2044", "Red 5kg", 900),
      entry("e2", "INV-2045", "Red 5kg", 490, { duplicates: [{ id: "e7", isoYear: 2026, isoWeek: 43, cases: 490, invoiceRef: "INV-2045" }] })
    ] as never,
    packs: [
      {
        seriesKey: null, measurementKey: "docklink:p-red|single|red|pepper|kg", origin: "manual", entryCount: 2, packId: "p-red", name: "Red 5kg",
        packCode: "RL5", currentName: null, currentPackCode: null, description: null, packStatus: "active", colorKind: "single", colorKey: "red",
        colorLabel: "Red", reclassifiedSince: false, cases: 1390, loadCount: null, status: "missing", counted: true, kg: null, kgByColor: null, measurement: null
      }
    ],
    attention: [], nonPepper: [],
    legacyRows: [
      { color: "red", totalCases: 1400, caseWeightKg: 5.15, totalKg: 7210, source: "docklink" },
      { color: "yellow", totalCases: 300, caseWeightKg: 5.15, totalKg: 1545, source: "docklink" }
    ],
    totals: {
      isoYear: 2026, isoWeek: 44, source: "manual", sourceReason: "chosen_manual", needsSourceDecision: false,
      notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 1700, legacyRows: 2 },
      colors: { ...zeroColors(), red: { cases: 1390, kg: 0 } }, mixedCases: 0, shippedCases: 1390, measuredCases: 0, unmeasuredCases: 1390,
      attentionCases: 0, kg: 0, complete: false, nonPepper: [], supersededLegacyRows: 2
    },
    copySource: null
  } as PackWeekResponse;
}

describe("Weekly Pack Shipments — manual weeks", () => {
  let body: PackWeekResponse;
  beforeEach(() => {
    body = manualWeek();
    apiFetch.mockImplementation((path: string, options: { method?: string } = {}) => {
      const method = options.method ?? "GET";
      if (path.startsWith("/api/pack-shipments/week")) return Promise.resolve(jsonOk(body));
      if (path.startsWith("/api/manual-pack-entries/") && method === "DELETE") return Promise.resolve(jsonOk({ deleted: "e2", releasedWeekSource: false }));
      if (path === "/api/case-week-sources") return Promise.resolve(jsonOk({ source: "legacy_colours" }));
      return Promise.resolve(jsonOk({ measurement: {} }));
    });
  });

  async function renderManualWeek(onChanged = vi.fn()) {
    const user = userEvent.setup();
    render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 44 }} onChanged={onChanged} />);
    await screen.findByRole("region", { name: "Source for 2026-W44" });
    return { user, onChanged };
  }

  it("says which source counts and what is not counted", async () => {
    await renderManualWeek();
    const source = screen.getByRole("region", { name: "Source for 2026-W44" });
    expect(source).toHaveTextContent("Counted for 2026-W44: Manual pack entries");
    expect(source).toHaveTextContent("Manual pack entries were chosen for this week.");
    expect(source).toHaveTextContent("Not counted: 1,700 cases in colour totals");
    expect(screen.getByRole("heading", { name: "Colour totals (not counted this week)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Count colour totals instead" })).toBeInTheDocument();
  });

  it("lists each invoice entry with edit and delete, flagging possible duplicates", async () => {
    const { user, onChanged } = await renderManualWeek();
    const entries = screen.getByRole("region", { name: "Manual pack entries" });
    const rows = within(entries).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("INV-2044Red 5kgRL5Red900"),
      expect.stringContaining("Possible duplicate of 2026-W43 · 490 · INV-2045")
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(entries).getByRole("button", { name: "Delete entry: Red 5kg, invoice INV-2045" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/manual-pack-entries/e2")).toBe(true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText("Entry deleted.")).toBeInTheDocument();
  });

  it("measurements for manual packs are keyed by pack and classification (no DockLink series)", async () => {
    const { user } = await renderManualWeek();
    expect(screen.getByRole("heading", { name: /Packs entered for 2026-W44 — kg from this week's measurements/ })).toBeInTheDocument();
    const red = screen.getAllByText("Red 5kg").map((e) => e.closest("tr")!).find((tr) => tr.classList.contains("pack-week-row"))!;
    expect(within(red).getByText("2 entries")).toBeInTheDocument();
    await user.type(within(red).getByLabelText(/net pepper kg/), "5.1");
    await user.click(within(red).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ isoYear: 2026, isoWeek: 44, measurementKey: "docklink:p-red|single|red|pepper|kg", netKgPerCase: 5.1 });
  });

  it("switching the week's source is explicit", async () => {
    const { user, onChanged } = await renderManualWeek();
    await user.click(screen.getByRole("button", { name: "Count colour totals instead" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/case-week-sources")!.body).toEqual({ isoYear: 2026, isoWeek: 44, source: "legacy_colours" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("an undecided week (both sources, no choice) is flagged and offers both choices", async () => {
    body = { ...manualWeek(), source: "legacy", sourceReason: "undecided", needsSourceDecision: true, weekSourceChoice: null, notCounted: { manualCases: 1390, manualEntries: 2, legacyCases: 0, legacyRows: 0 } };
    await renderManualWeek();
    const source = screen.getByRole("region", { name: "Source for 2026-W44" });
    expect(source).toHaveClass("pack-week-source--decide");
    expect(source).toHaveTextContent("Colour totals count until you choose.");
    expect(source).toHaveTextContent("Not counted: 2 manual pack entries (1,390 cases)");
    expect(within(source).getByRole("button", { name: "Count manual pack entries" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Packs entered for 2026-W44 \(not counted this week\)/ })).toBeInTheDocument();
  });
});
