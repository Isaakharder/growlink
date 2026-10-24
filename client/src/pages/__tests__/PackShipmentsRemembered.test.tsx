import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "Remember for future weeks" on the weekly pack screen: remembered values are
// labelled as such (never "Measured"), Save stays week-only, and rainbow packs
// remember counts and fruit weights separately. kg always comes from the server.
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

type Row = PackWeekResponse["packs"][number];
const jsonOk = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const slot = <T,>(value: T | null, from: number | null = null, nextChange: number | null = null) => ({
  value,
  from: from ? { isoYear: 2026, isoWeek: from } : null,
  nextChange: nextChange ? { isoYear: 2026, isoWeek: nextChange } : null
});
const noneRemembered = () => ({ netKgPerCase: slot<number>(null), counts: slot<never[]>(null), fruitWeights: slot<never[]>(null) });

const RED_KEY = "docklink:a1|single|red|pepper|kg";
const TRI_KEY = "docklink:a4|mixed|mixed|pepper|kg";

function packRow(o: Partial<Row>): Row {
  return {
    seriesKey: null, measurementKey: RED_KEY, origin: "manual", entryCount: 2, packId: "a1", name: "Red 5kg", packCode: "RL5", currentName: null,
    currentPackCode: null, description: null, packStatus: "active", colorKind: "single", colorKey: "red", colorLabel: null, reclassifiedSince: false,
    cases: 100, loadCount: null, status: "missing", counted: true, kg: null, kgByColor: null, measurement: null, remembered: noneRemembered(), ...o
  };
}

function weekBodyWith(packs: Row[], totals: Partial<NonNullable<PackWeekResponse["totals"]>> = {}): PackWeekResponse {
  const empty = { cases: 0, kg: 0 };
  return {
    isoYear: 2026, isoWeek: 31, weekStart: "2026-07-27", weekEnd: "2026-08-02", sync: null, source: "manual", sourceReason: "rebuild_range",
    needsSourceDecision: false, weekSourceChoice: null, rebuildRange: { id: "r", from: { isoYear: 2026, isoWeek: 16 }, to: { isoYear: 2026, isoWeek: 43 } },
    manualStatus: "entered", confirmation: null, notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 },
    manualEntryAllowed: true, manualEntryBlockedReason: null, manualEntries: [], packs, attention: [], nonPepper: [], legacyRows: [],
    totals: {
      isoYear: 2026, isoWeek: 31, source: "manual", sourceReason: "rebuild_range", needsSourceDecision: false, inRebuildRange: true, manualStatus: "entered",
      notCounted: { manualCases: 0, manualEntries: 0, legacyCases: 0, legacyRows: 0 },
      colors: { red: { cases: 100, kg: 500 }, orange: empty, yellow: empty, green: empty }, mixedCases: 0, shippedCases: 100, measuredCases: 100,
      rememberedCases: 100, unmeasuredCases: 0, attentionCases: 0, kg: 500, complete: true, nonPepper: [], supersededLegacyRows: 0, ...totals
    },
    copySource: null
  };
}

let weekBody: PackWeekResponse;
beforeEach(() => {
  calls.length = 0;
  apiFetch.mockImplementation((path: string, options: { method?: string } = {}) => {
    const method = options.method ?? "GET";
    if (path.startsWith("/api/pack-shipments/week")) return Promise.resolve(jsonOk(weekBody));
    if (method === "DELETE") return Promise.resolve({ ok: true, status: 204, json: async () => null });
    return Promise.resolve(jsonOk({}));
  });
});
afterEach(() => vi.clearAllMocks());

async function renderWeek(waitFor = "Red 5kg") {
  const user = userEvent.setup();
  const onChanged = vi.fn();
  render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 31 }} onChanged={onChanged} />);
  await screen.findByText(waitFor);
  return { user, onChanged };
}
const row = (name: string) => screen.getAllByText(name)[0].closest(".pack-card") as HTMLElement;
const writes = () => calls.filter((c) => c.method !== "GET");

describe("Remembered pack measurements", () => {
  it("labels a remembered weight as “Remembered weight”, shows the value used and its kg, and pre-fills it", async () => {
    weekBody = weekBodyWith([
      packRow({ status: "remembered", kg: 500, kgByColor: { red: 500 }, remembered: { ...noneRemembered(), netKgPerCase: slot(5, 30, 40) } })
    ]);
    await renderWeek();
    const r = row("Red 5kg");
    expect(within(r).getByText("Remembered weight · 5 kg/case")).toBeInTheDocument();
    expect(within(r).queryByText("Measured")).not.toBeInTheDocument();
    expect(within(r).getByText("Remembered 5 kg/case from W30")).toBeInTheDocument();
    expect(within(r).getByText("A different remembered value takes over from 2026-W40.")).toBeInTheDocument();
    expect(within(r).getByText("500 kg")).toBeInTheDocument();
    expect(within(r).getByRole("spinbutton", { name: /Average net pepper kg per shipping case/ })).toHaveValue(5);
    expect(within(r).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.getByText(/Every shipped case this week has kg; 100 use a remembered weight/)).toBeInTheDocument();
  });

  it("“Remember for future weeks” sits beside Save and remembers without saving a week measurement; Save stays week-only", async () => {
    weekBody = weekBodyWith([packRow({})], { rememberedCases: 0, measuredCases: 0, unmeasuredCases: 100, complete: false, kg: 0 });
    const { user, onChanged } = await renderWeek();
    const r = row("Red 5kg");
    const actions = within(r).getByRole("button", { name: "Save" }).parentElement as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Remember for future weeks" })).toBeInTheDocument();

    await user.type(within(r).getByRole("spinbutton"), "5.2");
    await user.click(within(r).getByRole("button", { name: "Remember for future weeks" }));
    expect(writes()).toEqual([
      { path: "/api/pack-shipments/measurement-defaults", method: "PUT", body: { isoYear: 2026, isoWeek: 31, measurementKey: RED_KEY, valueKind: "net_kg", netKgPerCase: 5.2 } }
    ]);
    expect(onChanged).toHaveBeenCalled();

    calls.length = 0;
    await user.clear(within(row("Red 5kg")).getByRole("spinbutton"));
    await user.type(within(row("Red 5kg")).getByRole("spinbutton"), "6");
    await user.click(within(row("Red 5kg")).getByRole("button", { name: "Save" }));
    expect(writes()).toEqual([
      { path: "/api/pack-shipments/measurements", method: "PUT", body: { isoYear: 2026, isoWeek: 31, measurementKey: RED_KEY, netKgPerCase: 6 } }
    ]);
  });

  it("an override for one week is shown as Measured, with the remembered weight kept and Clear to go back to it", async () => {
    weekBody = weekBodyWith([
      packRow({
        status: "measured", kg: 600, measurement: { netKgPerCase: 6, components: [], copiedFrom: null },
        remembered: { ...noneRemembered(), netKgPerCase: slot(5, 30) }
      })
    ]);
    await renderWeek();
    const r = row("Red 5kg");
    expect(within(r).getByText("Measured")).toBeInTheDocument();
    expect(within(r).getByText("Remembered 5 kg/case from W30")).toBeInTheDocument();
    expect(within(r).getByText(/This week's own measurement is used instead/)).toBeInTheDocument();
    expect(within(r).getByRole("spinbutton")).toHaveValue(6);
    expect(within(r).getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("forgets from this week on, after confirming", async () => {
    weekBody = weekBodyWith([packRow({ status: "remembered", kg: 500, remembered: { ...noneRemembered(), netKgPerCase: slot(5, 30) } })]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = await renderWeek();
    await user.click(within(row("Red 5kg")).getByRole("button", { name: "Forget remembered weight" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/from 2026-W31 on\? Earlier weeks keep it/));
    expect(writes()).toEqual([
      {
        path: `/api/pack-shipments/measurement-defaults?isoYear=2026&isoWeek=31&measurementKey=${encodeURIComponent(RED_KEY).replace(/%20/g, "+")}&valueKind=net_kg`,
        method: "DELETE",
        body: undefined
      }
    ]);
    confirm.mockRestore();
  });

  it("rainbow packs remember counts and fruit weights separately; remembered counts are pre-filled", async () => {
    weekBody = weekBodyWith(
      [
        packRow({
          measurementKey: TRI_KEY, packId: "a4", name: "Tri-Colour 3pk", packCode: "TC3", colorKind: "mixed", colorKey: "mixed", cases: 10,
          remembered: {
            ...noneRemembered(),
            counts: slot([{ color: "red", piecesPerCase: 5 }, { color: "yellow", piecesPerCase: 5 }] as never, 20)
          }
        })
      ],
      { rememberedCases: 0, measuredCases: 0, unmeasuredCases: 10, complete: false, kg: 0 }
    );
    const { user } = await renderWeek("Tri-Colour 3pk");
    const r = row("Tri-Colour 3pk");
    expect(within(r).getByText("Missing measurement")).toBeInTheDocument();
    expect(within(r).getByText("Remembered counts R 5 · Y 5 from W20")).toBeInTheDocument();
    expect(within(r).getByText(/Remembered counts are filled in. Enter this week's fruit weights and Save/)).toBeInTheDocument();
    expect(within(r).getByRole("spinbutton", { name: "Red peppers per shipping case for Tri-Colour 3pk" })).toHaveValue(5);
    expect(within(r).getByRole("spinbutton", { name: "Red average fruit weight in grams for Tri-Colour 3pk" })).toHaveValue(null);

    await user.type(within(r).getByRole("spinbutton", { name: "Red average fruit weight in grams for Tri-Colour 3pk" }), "200");
    await user.type(within(r).getByRole("spinbutton", { name: "Yellow average fruit weight in grams for Tri-Colour 3pk" }), "180");
    await user.click(within(r).getByRole("button", { name: "Remember fruit weights for future weeks" }));
    // Counts equal to the remembered ones can't be remembered again; changing one can.
    expect(within(row("Tri-Colour 3pk")).getByRole("button", { name: "Remember counts for future weeks" })).toBeDisabled();
    const redCount = within(row("Tri-Colour 3pk")).getByRole("spinbutton", { name: "Red peppers per shipping case for Tri-Colour 3pk" });
    await user.clear(redCount);
    await user.type(redCount, "6");
    await user.click(within(row("Tri-Colour 3pk")).getByRole("button", { name: "Remember counts for future weeks" }));
    expect(writes()).toEqual([
      {
        path: "/api/pack-shipments/measurement-defaults",
        method: "PUT",
        body: { isoYear: 2026, isoWeek: 31, measurementKey: TRI_KEY, valueKind: "fruit_weights", fruitWeights: [{ color: "red", fruitWeightG: 200 }, { color: "yellow", fruitWeightG: 180 }] }
      },
      {
        path: "/api/pack-shipments/measurement-defaults",
        method: "PUT",
        body: { isoYear: 2026, isoWeek: 31, measurementKey: TRI_KEY, valueKind: "counts", counts: [{ color: "red", piecesPerCase: 6 }, { color: "yellow", piecesPerCase: 5 }] }
      }
    ]);
    expect(within(row("Tri-Colour 3pk")).queryByRole("button", { name: "Remember for future weeks" })).not.toBeInTheDocument();
  });

  it("Remember needs a valid value: disabled while empty or invalid, with the reason shown inline", async () => {
    weekBody = weekBodyWith([packRow({})], { rememberedCases: 0 });
    const { user } = await renderWeek();
    const remember = () => within(row("Red 5kg")).getByRole("button", { name: "Remember for future weeks" });
    expect(remember()).toBeDisabled();
    await user.type(within(row("Red 5kg")).getByRole("spinbutton"), "0");
    expect(remember()).toBeDisabled();
    expect(within(row("Red 5kg")).getByRole("alert")).toHaveTextContent("Enter the average net pepper kg per shipping case");
    await user.click(remember());
    expect(writes()).toEqual([]);
  });
});
