import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The compact weekly pack screen: Add entries at the top, pack cards first,
// the invoice list collapsed below them, and the week's source/completion as
// one line at the very bottom with its explanation under Details.
const calls: Array<{ path: string; method: string }> = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string } = {}) => {
    calls.push({ path, method: options.method ?? "GET" });
    return apiFetch(path, options);
  }
}));

import { PackShipmentsWeek, type PackWeekResponse } from "../PackShipmentsWeek";
import type { PackRow } from "../packMeasure";

const jsonOk = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const none = () => ({ value: null, from: null, nextChange: null });

const red: PackRow = {
  seriesKey: null, measurementKey: "historical:h1|single|red|pepper|kg", origin: "manual", entryCount: 2, packId: "h1", name: "Red 5kg", packCode: "RL5",
  currentName: null, currentPackCode: null, description: null, packStatus: "historical", colorKind: "single", colorKey: "red", colorLabel: null,
  reclassifiedSince: false, cases: 900, loadCount: null, status: "measured", counted: true, kg: 4608, kgByColor: { red: 4608 },
  measurement: { netKgPerCase: 5.12, components: [], copiedFrom: null }, remembered: { netKgPerCase: none(), counts: none(), fruitWeights: none() }
};

const entry = (i: number) => ({
  id: `e${i}`, isoYear: 2026, isoWeek: 43, packSource: "historical", packId: "h1", packName: "Red 5kg", packCode: "RL5", colorKind: "single", colorKey: "red",
  cropType: "pepper", trackingUnit: "kg", cases: 75, invoiceRef: `INV-${i}`, note: null, createdAt: "", updatedAt: "", duplicates: []
});

function week(o: Partial<PackWeekResponse> = {}): PackWeekResponse {
  const empty = { cases: 0, kg: 0 };
  return {
    isoYear: 2026, isoWeek: 43, weekStart: "2026-10-19", weekEnd: "2026-10-25",
    sync: { scopeStatus: "capture_not_active", generatedAt: "", lastSyncedAt: "2026-10-24T09:00:00Z", captureActivatedAt: null, transitionWeek: null, firstWeek: null, lastWeek: null, diagnostics: {} },
    source: "manual", sourceReason: "rebuild_range", needsSourceDecision: false, weekSourceChoice: null,
    rebuildRange: { id: "r", from: { isoYear: 2026, isoWeek: 16 }, to: { isoYear: 2026, isoWeek: 43 } },
    manualStatus: "confirmed", confirmation: { confirmedAt: "2026-10-23T16:00:00Z", note: null },
    notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 }, manualEntryAllowed: true, manualEntryBlockedReason: null,
    manualEntries: Array.from({ length: 12 }, (_, i) => entry(i)), packs: [red], attention: [], nonPepper: [], legacyRows: [],
    totals: {
      isoYear: 2026, isoWeek: 43, source: "manual", sourceReason: "rebuild_range", needsSourceDecision: false, inRebuildRange: true, manualStatus: "confirmed",
      notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 }, colors: { red: { cases: 900, kg: 4608 }, orange: empty, yellow: empty, green: empty },
      mixedCases: 0, shippedCases: 900, measuredCases: 900, rememberedCases: 0, unmeasuredCases: 0, attentionCases: 0, kg: 4608, complete: true, nonPepper: [], supersededLegacyRows: 0
    },
    copySource: null,
    ...o
  };
}

let body: PackWeekResponse;
beforeEach(() => {
  calls.length = 0;
  body = week();
  apiFetch.mockImplementation((path: string) => Promise.resolve(path.startsWith("/api/pack-shipments/week") ? jsonOk(body) : jsonOk({})));
});
afterEach(() => vi.clearAllMocks());

async function renderWeek() {
  const user = userEvent.setup();
  render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 43 }} />);
  await screen.findByRole("region", { name: "Source for 2026-W43" });
  return user;
}
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("compact weekly pack screen", () => {
  it("orders the page: Add entries at the top, packs, totals, the collapsed invoice list, then the week's source at the very bottom", async () => {
    await renderWeek();
    const add = screen.getByRole("button", { name: "Add entries for 2026-W43" });
    const card = screen.getByRole("article", { name: "Red 5kg" });
    const totals = screen.getByRole("region", { name: "Week totals" });
    const manual = screen.getByRole("region", { name: "Manual pack entries" });
    const source = screen.getByRole("region", { name: "Source for 2026-W43" });
    expect(follows(add, card)).toBe(true);
    expect(follows(card, totals)).toBe(true);
    expect(follows(totals, manual)).toBe(true);
    expect(follows(manual, source)).toBe(true);
    const section = source.closest("section")!;
    expect(section.lastElementChild).toBe(source);
  });

  it("collapses the invoice list by default, with its count in the header, and expands on request", async () => {
    const user = await renderWeek();
    const manual = screen.getByRole("region", { name: "Manual pack entries" });
    expect(manual.tagName).toBe("DETAILS");
    expect(manual).not.toHaveAttribute("open");
    expect(within(manual).getByText("Manual pack entries (12)")).toBeInTheDocument();
    await user.click(within(manual).getByText("Manual pack entries (12)"));
    expect(manual).toHaveAttribute("open");
    expect(within(manual).getAllByRole("button", { name: /^Edit entry: Red 5kg/ })).toHaveLength(12);
  });

  it("shows the week's source and completion as one line, Undo beside it, and the explanation under Details", async () => {
    await renderWeek();
    const source = screen.getByRole("region", { name: "Source for 2026-W43" });
    expect(source.querySelector(".pack-week-source-line p")).toHaveTextContent("2026-W43 · Manual entries · Complete ✓");
    expect(within(source).getByRole("button", { name: "Undo confirmation" })).toHaveTextContent("Undo");
    const details = source.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("part of a historical rebuild");
  });

  it("offers Confirm complete for a week still in progress", async () => {
    body = week({ manualStatus: "entered", confirmation: null });
    await renderWeek();
    const source = screen.getByRole("region", { name: "Source for 2026-W43" });
    expect(source.querySelector(".pack-week-source-line p")).toHaveTextContent("2026-W43 · Manual entries · In progress");
    expect(within(source).getByRole("button", { name: "Confirm week complete" })).toHaveTextContent("Confirm complete");
  });

  it("never claims colour totals count when manual entries do (DockLink capture not active)", async () => {
    await renderWeek();
    const section = screen.getByRole("region", { name: "Source for 2026-W43" }).closest("section")!;
    expect(section).not.toHaveTextContent(/Every week uses colour totals|Weekly totals use colour totals/);
    expect(section).toHaveTextContent("DockLink pack capture isn't active yet, so DockLink pack totals don't cover any week.");
    expect(section).toHaveTextContent("Counted for 2026-W43: Manual pack entries");
  });

  it("an undecided week is flagged at the top and its Details open with the switching controls", async () => {
    body = week({
      source: "legacy", sourceReason: "undecided", needsSourceDecision: true, manualStatus: null, confirmation: null,
      legacyRows: [{ color: "red", totalCases: 880, caseWeightKg: 5.1, totalKg: 4488, source: "docklink" }],
      notCounted: { manualCases: 900, manualEntries: 12, legacyCases: 0, legacyRows: 0 }
    });
    await renderWeek();
    expect(screen.getByText(/This week has manual pack entries and colour totals/)).toBeInTheDocument();
    const source = screen.getByRole("region", { name: "Source for 2026-W43" });
    expect(source.querySelector(".pack-week-source-line p")).toHaveTextContent("2026-W43 · Colour totals · Choose a source");
    expect(source.querySelector("details")).toHaveAttribute("open");
    expect(within(source).getByRole("button", { name: "Count manual pack entries" })).toBeInTheDocument();
  });

  it("cards use the short labels, keeping full accessible names", async () => {
    await renderWeek();
    const card = screen.getByRole("article", { name: "Red 5kg" });
    expect(within(card).getByText("Net kg/case")).toBeInTheDocument();
    expect(within(card).getByLabelText("Average net pepper kg per shipping case for Red 5kg")).toHaveValue(5.12);
    const remember = within(card).getByRole("button", { name: "Remember for future weeks" });
    expect(remember).toHaveTextContent(/^Remember$/);
    // One slim row: cases, entries and kg (the "·" separators are CSS).
    expect([...card.querySelectorAll(".pack-card-stats dd")].map((d) => d.textContent)).toEqual(["900 cases", "2 entries", "4,608 kg"]);
  });

  it("renders the source line into a page slot when given one, keeping the week named", async () => {
    const page = document.createElement("div");
    page.innerHTML = `<div class="other-panel">Weekly Case Totals</div><div class="slot"></div>`;
    document.body.appendChild(page);
    const slot = page.querySelector<HTMLElement>(".slot")!;
    render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 43 }} sourceSlot={slot} />);
    const source = await screen.findByRole("region", { name: "Source for 2026-W43" });
    expect(slot.contains(source)).toBe(true);
    expect(source.closest(".pack-week")).toBeNull();
    expect(within(slot).getByRole("heading", { level: 2 })).toHaveTextContent("Week source & completion · 2026-W43");
    expect(within(source).getByRole("button", { name: "Undo confirmation" })).toBeInTheDocument();
    page.remove();
  });

  it("the source-decision notice links to the source line at the bottom of the page", async () => {
    body = week({
      source: "legacy", sourceReason: "undecided", needsSourceDecision: true, manualStatus: null, confirmation: null,
      legacyRows: [{ color: "red", totalCases: 880, caseWeightKg: 5.1, totalKg: 4488, source: "docklink" }],
      notCounted: { manualCases: 900, manualEntries: 12, legacyCases: 0, legacyRows: 0 }
    });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const slot = document.body.appendChild(document.createElement("div"));
    const user = userEvent.setup();
    render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 43 }} sourceSlot={slot} />);
    const source = await screen.findByRole("region", { name: "Source for 2026-W43" });
    await user.click(screen.getByRole("button", { name: "Choose the week's source at the bottom of the page" }));
    expect(scrolled).toHaveBeenCalled();
    expect(document.activeElement).toBe(source);
    expect(within(source).getByRole("button", { name: "Count manual pack entries" })).toBeInTheDocument();
    slot.remove();
  });
});
