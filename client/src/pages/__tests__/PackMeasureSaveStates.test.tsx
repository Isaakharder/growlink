import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Save feedback on the weekly pack measurement cards: "Saved ✓" only when the
// inputs match the saved measurement, "Unsaved changes" on edit, Save enabled
// only for valid unsaved changes, "Saving…" then "Saved ✓" after success,
// inputs kept with an inline error on failure, Remember feedback per kind,
// and unsaved edits kept when the week refreshes.
type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ path, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined });
    return apiFetch(path, options);
  }
}));

import { PackShipmentsWeek, type PackWeekResponse } from "../PackShipmentsWeek";
import { draftFrom, mergeDrafts, sameDraft, saveState, type PackRow } from "../packMeasure";

const jsonOk = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const none = () => ({ value: null, from: null, nextChange: null });
const RED_KEY = "docklink:a1|single|red|pepper|kg";
const YEL_KEY = "docklink:a2|single|yellow|pepper|kg";
const TRI_KEY = "docklink:a4|mixed|mixed|pepper|kg";

function packRow(o: Partial<PackRow>): PackRow {
  return {
    seriesKey: null, measurementKey: RED_KEY, origin: "manual", entryCount: 1, packId: "a1", name: "Red 5kg", packCode: "RL5", currentName: null,
    currentPackCode: null, description: null, packStatus: "active", colorKind: "single", colorKey: "red", colorLabel: null, reclassifiedSince: false,
    cases: 100, loadCount: null, status: "missing", counted: true, kg: null, kgByColor: null, measurement: null,
    remembered: { netKgPerCase: none(), counts: none(), fruitWeights: none() }, ...o
  } as PackRow;
}
const measuredRed = (kg: number) =>
  packRow({ status: "measured", kg: 100 * kg, kgByColor: { red: 100 * kg }, measurement: { netKgPerCase: kg, components: [], copiedFrom: null } });
const yellow = () => packRow({ measurementKey: YEL_KEY, packId: "a2", name: "Yellow 5kg", packCode: "YL5", colorKey: "yellow" });
const tri = () =>
  packRow({ measurementKey: TRI_KEY, packId: "a4", name: "Tri-Colour 3pk", packCode: "TC3", colorKind: "mixed", colorKey: "mixed", cases: 10 });

function week(packs: PackRow[]): PackWeekResponse {
  const empty = { cases: 0, kg: 0 };
  return {
    isoYear: 2026, isoWeek: 31, weekStart: "2026-07-27", weekEnd: "2026-08-02", sync: null, source: "manual", sourceReason: "rebuild_range",
    needsSourceDecision: false, weekSourceChoice: null, rebuildRange: null, manualStatus: "entered", confirmation: null,
    notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 }, manualEntryAllowed: true, manualEntryBlockedReason: null,
    manualEntries: [], packs, attention: [], nonPepper: [], legacyRows: [],
    totals: {
      isoYear: 2026, isoWeek: 31, source: "manual", sourceReason: "rebuild_range", needsSourceDecision: false, inRebuildRange: true, manualStatus: "entered",
      notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 },
      colors: { red: empty, orange: empty, yellow: empty, green: empty }, mixedCases: 0, shippedCases: 0, measuredCases: 0, rememberedCases: 0,
      unmeasuredCases: 0, attentionCases: 0, kg: 0, complete: false, nonPepper: [], supersededLegacyRows: 0
    },
    copySource: null
  };
}

let weekBody: PackWeekResponse;
let respond: (path: string, method: string) => Promise<unknown> | undefined;
beforeEach(() => {
  calls.length = 0;
  respond = () => undefined;
  apiFetch.mockImplementation((path: string, options: { method?: string } = {}) => {
    const method = options.method ?? "GET";
    const custom = respond(path, method);
    if (custom) return custom;
    if (path.startsWith("/api/pack-shipments/week")) return Promise.resolve(jsonOk(weekBody));
    if (method === "DELETE") return Promise.resolve({ ok: true, status: 204, json: async () => null });
    return Promise.resolve(jsonOk({}));
  });
});
afterEach(() => vi.clearAllMocks());

const card = (name: string) => screen.getAllByText(name)[0].closest(".pack-card") as HTMLElement;
const state = (name: string) => within(card(name)).getByRole("status").textContent;
const input = (name: string) => within(card(name)).getByLabelText(`Average net pepper kg per shipping case for ${name}`);
const saveButton = (name: string) => within(card(name)).getByRole("button", { name: /^(Save|Saving…)$/ });

async function renderWeek(refreshKey = 0) {
  const user = userEvent.setup();
  const view = render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 31 }} refreshKey={refreshKey} />);
  await screen.findByText(weekBody.packs[0].name);
  return { user, view };
}

describe("pack measurement save states", () => {
  it("shows “Saved ✓” when the inputs match the saved measurement, and Save is disabled", async () => {
    weekBody = week([measuredRed(5.2), yellow()]);
    await renderWeek();
    expect(state("Red 5kg")).toBe("Saved ✓");
    expect(saveButton("Red 5kg")).toBeDisabled();
    expect(within(card("Red 5kg")).getByText("Measured")).toBeInTheDocument();
    // Nothing saved yet and nothing typed: no indicator, Save disabled.
    expect(state("Yellow 5kg")).toBe("");
    expect(saveButton("Yellow 5kg")).toBeDisabled();
  });

  it("an edit shows “Unsaved changes”; Save is enabled only while the change is valid; typing the saved value back is “Saved ✓” again", async () => {
    weekBody = week([measuredRed(5.2)]);
    const { user } = await renderWeek();
    await user.clear(input("Red 5kg"));
    await user.type(input("Red 5kg"), "5.4");
    expect(state("Red 5kg")).toBe("Unsaved changes");
    expect(saveButton("Red 5kg")).toBeEnabled();

    await user.clear(input("Red 5kg"));
    await user.type(input("Red 5kg"), "-1");
    expect(state("Red 5kg")).toBe("Unsaved changes");
    expect(saveButton("Red 5kg")).toBeDisabled();
    expect(within(card("Red 5kg")).getByRole("alert")).toHaveTextContent("greater than 0");

    await user.clear(input("Red 5kg"));
    expect(saveButton("Red 5kg")).toBeDisabled();

    await user.type(input("Red 5kg"), "5.20");
    expect(state("Red 5kg")).toBe("Saved ✓");
    expect(saveButton("Red 5kg")).toBeDisabled();
  });

  it("shows “Saving…” during the request and “Saved ✓” only after it succeeds", async () => {
    weekBody = week([yellow()]);
    let finish: (v: unknown) => void = () => undefined;
    respond = (path, method) => (method === "PUT" ? new Promise((resolve) => (finish = resolve)) : undefined);
    const { user } = await renderWeek();
    await user.type(input("Yellow 5kg"), "5.05");
    await user.click(saveButton("Yellow 5kg"));
    expect(state("Yellow 5kg")).toBe("Saving…");
    expect(saveButton("Yellow 5kg")).toHaveTextContent("Saving…");
    expect(saveButton("Yellow 5kg")).toBeDisabled();
    expect(screen.queryByText("Saved ✓")).not.toBeInTheDocument();

    weekBody = week([packRow({ ...yellow(), status: "measured", kg: 505, measurement: { netKgPerCase: 5.05, components: [], copiedFrom: null } })]);
    await act(async () => finish(jsonOk({ measurement: {} })));
    await waitFor(() => expect(state("Yellow 5kg")).toBe("Saved ✓"));
    expect(input("Yellow 5kg")).toHaveValue(5.05);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { path: "/api/pack-shipments/measurements", method: "PUT", body: { isoYear: 2026, isoWeek: 31, measurementKey: YEL_KEY, netKgPerCase: 5.05 } }
    ]);
  });

  it("a failed save keeps the inputs, shows the error inline and stays “Unsaved changes”", async () => {
    weekBody = week([measuredRed(5.2)]);
    respond = (path, method) => (method === "PUT" ? Promise.resolve(jsonOk({ message: "That pack shipment was not found for this week." }, 404)) : undefined);
    const { user } = await renderWeek();
    await user.clear(input("Red 5kg"));
    await user.type(input("Red 5kg"), "5.6");
    await user.click(saveButton("Red 5kg"));
    expect(await within(card("Red 5kg")).findByRole("alert")).toHaveTextContent("That pack shipment was not found for this week.");
    expect(input("Red 5kg")).toHaveValue(5.6);
    expect(state("Red 5kg")).toBe("Unsaved changes");
    expect(saveButton("Red 5kg")).toBeEnabled();
    // Editing again clears the error.
    await user.type(input("Red 5kg"), "1");
    expect(within(card("Red 5kg")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a refresh keeps unsaved edits on other cards, while the saved card takes the saved values", async () => {
    weekBody = week([measuredRed(5.2), yellow()]);
    const { user, view } = await renderWeek();
    await user.type(input("Yellow 5kg"), "4.9");
    await user.clear(input("Red 5kg"));
    await user.type(input("Red 5kg"), "5.3");
    weekBody = week([measuredRed(5.3), yellow()]);
    await user.click(saveButton("Red 5kg"));
    await waitFor(() => expect(state("Red 5kg")).toBe("Saved ✓"));
    expect(input("Yellow 5kg")).toHaveValue(4.9);
    expect(state("Yellow 5kg")).toBe("Unsaved changes");

    // An outside refresh (other totals on the page changed) keeps the edit too.
    view.rerender(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 31 }} refreshKey={1} />);
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(3));
    expect(input("Yellow 5kg")).toHaveValue(4.9);
  });

  it("Remember actions confirm what was remembered, separately for rainbow counts and fruit weights", async () => {
    weekBody = week([packRow({ colorKey: "red" }), tri()]);
    const { user } = await renderWeek();
    await user.type(input("Red 5kg"), "5.1");
    await user.click(within(card("Red 5kg")).getByRole("button", { name: "Remember for future weeks" }));
    expect(await within(card("Red 5kg")).findByText("✓ Weight remembered from 2026-W31")).toBeInTheDocument();

    const t = () => card("Tri-Colour 3pk");
    await user.type(within(t()).getByLabelText("Red peppers per shipping case for Tri-Colour 3pk"), "5");
    await user.type(within(t()).getByLabelText("Red average fruit weight in grams for Tri-Colour 3pk"), "200");
    expect(within(t()).getByRole("button", { name: "Remember counts for future weeks" })).toBeEnabled();
    await user.click(within(t()).getByRole("button", { name: "Remember counts for future weeks" }));
    expect(await within(t()).findByText("✓ Counts remembered from 2026-W31")).toBeInTheDocument();
    expect(within(t()).queryByText(/Fruit weights remembered/)).not.toBeInTheDocument();
    // The fruit weight typed but not remembered is still there, unsaved.
    expect(within(t()).getByLabelText("Red average fruit weight in grams for Tri-Colour 3pk")).toHaveValue(200);
    await user.click(within(t()).getByRole("button", { name: "Remember fruit weights for future weeks" }));
    expect(await within(t()).findByText("✓ Fruit weights remembered from 2026-W31")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").map((c) => (c.body as { valueKind: string }).valueKind)).toEqual(["net_kg", "counts", "fruit_weights"]);
  });

  it("a failed Remember keeps the inputs and shows the error inline, with no success message", async () => {
    weekBody = week([packRow({})]);
    respond = (path, method) => (method === "PUT" ? Promise.resolve(jsonOk({ message: "Failed to remember the measurement." }, 500)) : undefined);
    const { user } = await renderWeek();
    await user.type(input("Red 5kg"), "5.1");
    await user.click(within(card("Red 5kg")).getByRole("button", { name: "Remember for future weeks" }));
    expect(await within(card("Red 5kg")).findByRole("alert")).toHaveTextContent("Failed to remember the measurement.");
    expect(input("Red 5kg")).toHaveValue(5.1);
    expect(within(card("Red 5kg")).queryByText(/remembered from/)).not.toBeInTheDocument();
  });

  it("keeps Measured and Remembered weight distinct", async () => {
    weekBody = week([
      packRow({ status: "remembered", kg: 510, remembered: { netKgPerCase: { value: 5.1, from: { isoYear: 2026, isoWeek: 20 }, nextChange: null }, counts: none(), fruitWeights: none() } }),
      { ...measuredRed(5.2), measurementKey: YEL_KEY, packId: "a2", name: "Yellow 5kg", colorKey: "yellow" }
    ]);
    await renderWeek();
    expect(within(card("Red 5kg")).getByText("Remembered weight · 5.1 kg/case")).toBeInTheDocument();
    expect(within(card("Red 5kg")).queryByText("Measured")).not.toBeInTheDocument();
    // A remembered value isn't this week's saved measurement: no "Saved ✓".
    expect(state("Red 5kg")).toBe("");
    expect(within(card("Yellow 5kg")).getByText("Measured")).toBeInTheDocument();
    expect(state("Yellow 5kg")).toBe("Saved ✓");
  });
});

describe("draft helpers", () => {
  it("compares values, not how they were typed", () => {
    const a = draftFrom(packRow({}));
    expect(sameDraft({ ...a, netKgPerCase: "5.20" }, { ...a, netKgPerCase: "5.2" })).toBe(true);
    expect(sameDraft({ ...a, netKgPerCase: " 5.2 " }, { ...a, netKgPerCase: "5.2" })).toBe(true);
    expect(sameDraft({ ...a, netKgPerCase: "5.21" }, { ...a, netKgPerCase: "5.2" })).toBe(false);
    expect(sameDraft({ ...a, netKgPerCase: "" }, { ...a, netKgPerCase: "0" })).toBe(false);
  });

  it("merging a refresh keeps edited drafts unless reset, and takes fresh data otherwise", () => {
    const before = [packRow({}), yellow()];
    const { drafts: loaded, baselines } = mergeDrafts(before, {}, {});
    const edited = { ...loaded, [YEL_KEY]: { ...loaded[YEL_KEY], netKgPerCase: "4.9" } };
    const after = [measuredRed(5.3), yellow()];
    const merged = mergeDrafts(after, edited, baselines);
    expect(merged.drafts[RED_KEY].netKgPerCase).toBe("5.3");
    expect(merged.drafts[YEL_KEY].netKgPerCase).toBe("4.9");
    expect(mergeDrafts(after, edited, baselines, new Set([YEL_KEY])).drafts[YEL_KEY].netKgPerCase).toBe("");
  });

  it("save state: saving, unsaved, saved, or nothing", () => {
    const row = measuredRed(5.2);
    const base = draftFrom(row);
    expect(saveState(row, base, base, true)).toBe("saving");
    expect(saveState(row, { ...base, netKgPerCase: "6" }, base, false)).toBe("unsaved");
    expect(saveState(row, base, base, false)).toBe("saved");
    expect(saveState(packRow({}), draftFrom(packRow({})), draftFrom(packRow({})), false)).toBe(null);
  });
});
