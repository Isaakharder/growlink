import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The weekly entry screen for DockLink pack shipments. It only collects
// measurements; every kg it shows comes from the server.
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

const jsonOk = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const colors = (c: Partial<Record<"red" | "orange" | "yellow" | "green", [number, number]>>) =>
  Object.fromEntries((["red", "orange", "yellow", "green"] as const).map((k) => [k, { cases: c[k]?.[0] ?? 0, kg: c[k]?.[1] ?? 0 }])) as PackWeekResponse["packs"] extends never ? never : never;

const SYNC = {
  scopeStatus: "available" as const,
  generatedAt: "2026-11-23T14:02:11Z",
  lastSyncedAt: "2026-11-23T14:05:00Z",
  captureActivatedAt: "2026-10-28T09:14:03Z",
  transitionWeek: { isoYear: 2026, isoWeek: 44 },
  firstWeek: { isoYear: 2026, isoWeek: 45 },
  lastWeek: { isoYear: 2026, isoWeek: 48 },
  diagnostics: {}
};

const pack = (o: Partial<PackWeekResponse["packs"][number]>): PackWeekResponse["packs"][number] => {
  const row: PackWeekResponse["packs"][number] = {
    seriesKey: null, measurementKey: null, origin: "import", entryCount: null, packId: "p", name: "Pack", packCode: null, currentName: null,
    currentPackCode: null, description: null, packStatus: "active", colorKind: "single", colorKey: "red", colorLabel: null,
    reclassifiedSince: false, cases: 0, loadCount: 0, status: "missing", counted: true, kg: null, kgByColor: null, measurement: null, ...o
  };
  // As the server does: a shipped series is measured by pack + ship-time classification.
  if (row.seriesKey && !o.measurementKey) row.measurementKey = `docklink:${row.packId}|${row.colorKind}|${row.colorKey}|pepper|kg`;
  return row;
};

function week47(): PackWeekResponse {
  return {
    isoYear: 2026, isoWeek: 47, weekStart: "2026-11-16", weekEnd: "2026-11-22", sync: SYNC, source: "packs",
    packs: [
      pack({ seriesKey: "s-red-5kg", packId: "a1", name: "Red 5kg", packCode: "RL5", cases: 1840, loadCount: 4, status: "measured", kg: 9420.8,
        measurement: { netKgPerCase: 5.12, components: [], copiedFrom: null } }),
      pack({ seriesKey: "s-yellow-5kg", packId: "a2", name: "Yellow 5kg", packCode: "YL5", colorKey: "yellow", cases: 312.5 }),
      pack({ seriesKey: null, packId: "a3", name: "Orange 5kg", packCode: "OL5", colorKey: "orange", status: "no_shipments" }),
      pack({ seriesKey: "s-tri-3pk", packId: "a4", name: "Tri-Colour 3pk", packCode: "TC3", packStatus: "archived", colorKind: "mixed", colorKey: "mixed",
        cases: 620, description: "15 retail 3-packs per shipping case" }),
      pack({ seriesKey: "s-sweet-red", packId: "a6", name: "Sweet Bite 250g", packCode: "SB25", cases: 40, reclassifiedSince: true, currentName: "Sweet Bite 250 g" })
    ],
    attention: [
      { seriesKey: "s-un", name: "Mixed Lot 7", packCode: null, cases: 45, reason: "unattributed", sourcePackRef: "pallet-name:Mixed Lot 7", colorKey: null, cropType: null, trackingUnit: null },
      { seriesKey: "s-purple", name: "Purple Gourmet", packCode: "PG4", cases: 30, reason: "unsupported_colour", sourcePackRef: null, colorKey: "purple", cropType: "pepper", trackingUnit: "kg" }
    ],
    nonPepper: [{ seriesKey: "s-basil", name: "Basil 12ct", packCode: "BA12", cases: 200, cropType: "herb", trackingUnit: "units" }],
    legacyRows: [],
    totals: {
      isoYear: 2026, isoWeek: 47, source: "packs", colors: colors({ red: [1880, 9420.8], yellow: [312.5, 0] }) as never, mixedCases: 620,
      shippedCases: 2887.5, measuredCases: 1840, unmeasuredCases: 972.5, attentionCases: 75, kg: 9420.8, complete: false, nonPepper: [], supersededLegacyRows: 0
    },
    copySource: { isoYear: 2026, isoWeek: 46, matchingSeries: 2 }
  };
}

let weekBody: PackWeekResponse;
beforeEach(() => {
  calls.length = 0;
  weekBody = week47();
  apiFetch.mockImplementation((path: string, options: { method?: string } = {}) => {
    const method = options.method ?? "GET";
    if (path.startsWith("/api/pack-shipments/week")) return Promise.resolve(jsonOk(weekBody));
    if (method === "PUT") return Promise.resolve(jsonOk({ measurement: {} }));
    if (method === "POST" && path.endsWith("/copy")) return Promise.resolve(jsonOk({ copied: [{ seriesKey: "s-yellow-5kg" }, { seriesKey: "s-sweet-red" }], skipped: [], from: { isoYear: 2026, isoWeek: 46 } }));
    if (method === "DELETE") return Promise.resolve({ ok: true, status: 204, json: async () => null });
    return Promise.resolve(jsonOk({}));
  });
});
afterEach(() => vi.clearAllMocks());

async function renderWeek() {
  const user = userEvent.setup();
  render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 47 }} />);
  await screen.findByText("Red 5kg");
  return user;
}
const row = (name: string) => screen.getAllByText(name)[0].closest(".pack-card") as HTMLElement;

describe("Weekly Pack Shipments", () => {
  it("lists DockLink's packs by display order with names and product codes, in the ISO week", async () => {
    await renderWeek();
    expect(calls[0].path).toBe("/api/pack-shipments/week?isoYear=2026&isoWeek=47");
    expect(screen.getByText(/Mon 16 Nov – Sun 22 Nov 2026/)).toBeInTheDocument();
    const names = Array.from(document.querySelectorAll(".pack-cards .pack-week-name")).map((e) => e.textContent);
    expect(names).toEqual(["Red 5kg", "Yellow 5kg", "Orange 5kg", "Tri-Colour 3pk", "Sweet Bite 250g"]);
    expect(within(row("Red 5kg")).getByText("RL5")).toBeInTheDocument();
    expect(within(row("Tri-Colour 3pk")).getByText("Archived")).toBeInTheDocument();
    expect(within(row("Orange 5kg")).getByText("No shipments this week")).toBeInTheDocument();
    expect(within(row("Orange 5kg")).queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("distinguishes a shipping case from an inner retail pack", async () => {
    await renderWeek();
    expect(screen.getByText(/not the retail packs inside it/)).toBeInTheDocument();
    expect(within(row("Tri-Colour 3pk")).getByText("15 retail 3-packs per shipping case")).toBeInTheDocument();
  });

  it("single-colour packs take average net pepper kg per shipping case; mixed packs take peppers per case and fruit weight per colour", async () => {
    await renderWeek();
    expect(within(row("Red 5kg")).getByLabelText("Average net pepper kg per shipping case for Red 5kg")).toHaveValue(5.12);
    const tri = row("Tri-Colour 3pk");
    for (const color of ["Red", "Orange", "Yellow", "Green"]) {
      expect(screen.getByLabelText(`${color} peppers per shipping case for Tri-Colour 3pk`)).toBeInTheDocument();
      expect(screen.getByLabelText(`${color} average fruit weight in grams for Tri-Colour 3pk`)).toBeInTheDocument();
    }
    expect(within(tri).queryByLabelText(/net pepper kg/)).not.toBeInTheDocument();
  });

  it("missing measurements stay blank and say so; nothing is shown as 0 kg", async () => {
    await renderWeek();
    const yellow = row("Yellow 5kg");
    expect(within(yellow).getByLabelText(/net pepper kg/)).toHaveValue(null);
    expect(within(yellow).getByText("Missing measurement")).toBeInTheDocument();
    expect(within(yellow).getByText("Not measured")).toBeInTheDocument();
    expect(within(row("Red 5kg")).getByText("9,420.8 kg")).toBeInTheDocument();
  });

  it("saves a single-colour measurement for this ISO week and series", async () => {
    const user = await renderWeek();
    const yellow = row("Yellow 5kg");
    await user.type(within(yellow).getByLabelText(/net pepper kg/), "5.05");
    await user.click(within(yellow).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      path: "/api/pack-shipments/measurements",
      method: "PUT",
      body: { isoYear: 2026, isoWeek: 47, measurementKey: "docklink:a2|single|yellow|pepper|kg", seriesKey: "s-yellow-5kg", netKgPerCase: 5.05 }
    });
  });

  it("saves only the colours entered for a mixed pack, each with both values", async () => {
    const user = await renderWeek();
    await user.type(screen.getByLabelText("Red peppers per shipping case for Tri-Colour 3pk"), "15");
    await user.type(screen.getByLabelText("Red average fruit weight in grams for Tri-Colour 3pk"), "180");
    await user.type(screen.getByLabelText("Yellow peppers per shipping case for Tri-Colour 3pk"), "15");
    await user.type(screen.getByLabelText("Yellow average fruit weight in grams for Tri-Colour 3pk"), "175");
    await user.click(within(row("Tri-Colour 3pk")).getAllByRole("button", { name: "Save" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      isoYear: 2026, isoWeek: 47, measurementKey: "docklink:a4|mixed|mixed|pepper|kg", seriesKey: "s-tri-3pk",
      components: [{ color: "red", piecesPerCase: 15, fruitWeightG: 180 }, { color: "yellow", piecesPerCase: 15, fruitWeightG: 175 }]
    });
  });

  it("a colour with only one of its two values is rejected before anything is sent", async () => {
    const user = await renderWeek();
    await user.type(screen.getByLabelText("Green peppers per shipping case for Tri-Colour 3pk"), "10");
    await user.click(within(row("Tri-Colour 3pk")).getAllByRole("button", { name: "Save" }).at(-1)!);
    expect(await screen.findByText(/Green: enter both peppers per shipping case and fruit weight/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("copying a previous week's measurements is an explicit action that names the source week", async () => {
    const user = await renderWeek();
    expect(screen.getByText(/2 packs without a measurement this week have one in/)).toHaveTextContent("2026-W46");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Copy measurements from 2026-W46" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/pack-shipments/measurements/copy")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ isoYear: 2026, isoWeek: 47, fromIsoYear: 2026, fromIsoWeek: 46 });
    expect(await screen.findByText(/Copied 2 measurements from 2026-W46/)).toBeInTheDocument();
  });

  it("shows where a copied measurement came from", async () => {
    weekBody.packs[0].measurement = { netKgPerCase: 5.12, components: [], copiedFrom: { isoYear: 2026, isoWeek: 46 } };
    await renderWeek();
    expect(within(row("Red 5kg")).getByText("Measured · copied from 2026-W46")).toBeInTheDocument();
  });

  it("renamed and reclassified packs keep their ship-time name and colour, with the current name noted", async () => {
    await renderWeek();
    const sweet = row("Sweet Bite 250g");
    expect(within(sweet).getByText("Now “Sweet Bite 250 g”")).toBeInTheDocument();
    expect(within(sweet).getByText(/Classification changed since; kg uses its ship-time colour/)).toBeInTheDocument();
  });

  it("unattributed shipments and unsupported colours are listed as needing attention, never given a colour or an input", async () => {
    await renderWeek();
    const attention = screen.getByRole("region", { name: "Needs attention" });
    const lot7 = within(attention).getByText("Mixed Lot 7").closest("li")!;
    expect(lot7).toHaveTextContent("45 cases · Not linked to a DockLink pack");
    expect(lot7).toHaveTextContent("DockLink reference: pallet-name:Mixed Lot 7");
    expect(within(attention).getByText(/Purple Gourmet/).closest("li")).toHaveTextContent("30 cases · Pack colour GrowLink doesn't track: “purple”");
    expect(within(attention).queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("non-pepper products are kept separate", async () => {
    await renderWeek();
    const other = screen.getByRole("region", { name: "Other products" });
    expect(within(other).getByText(/Basil 12ct/).closest("li")).toHaveTextContent("200 cases · Herb, tracked in units");
    expect(within(screen.getByRole("region", { name: "Week totals" })).queryByText(/Basil/)).not.toBeInTheDocument();
  });

  it("week totals show kg by colour, rainbow cases once, and label an incomplete total", async () => {
    await renderWeek();
    const totals = screen.getByRole("region", { name: "Week totals" });
    expect(within(totals).getByText(/620 cases \(counted once/)).toBeInTheDocument();
    expect(within(totals).getByText(/9,420.8 kg · 2,887.5 shipping cases/)).toBeInTheDocument();
    expect(within(totals).getByText(/Incomplete: 972.5 shipped cases have no usable measurement · 75 cases need attention/)).toBeInTheDocument();
  });

  it("a week before pack coverage shows its colour totals and takes no pack measurements", async () => {
    weekBody = {
      ...week47(), isoWeek: 44, source: "legacy", packs: [], attention: [], nonPepper: [], copySource: null,
      legacyRows: [{ color: "red", totalCases: 1400, caseWeightKg: 5.15, totalKg: 7210, source: "docklink" }],
      totals: { ...week47().totals!, source: "legacy", isoWeek: 44, mixedCases: 0, attentionCases: 0, unmeasuredCases: 0, complete: true, kg: 7210, shippedCases: 1400 }
    };
    render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 44 }} />);
    const source = await screen.findByRole("region", { name: "Source for 2026-W44" });
    expect(source).toHaveTextContent("Counted for 2026-W44: Colour totals");
    expect(source).toHaveTextContent("This week only has colour totals.");
    expect(screen.getByText(/DockLink pack totals start at 2026-W45/)).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByText("Every shipped case this week is measured.")).toBeInTheDocument();
  });

  it("week navigation moves by ISO week across the year boundary", async () => {
    const user = userEvent.setup();
    render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 1 }} />);
    await screen.findByText("Red 5kg");
    await user.click(screen.getByRole("button", { name: "Previous ISO week" }));
    await waitFor(() => expect(calls.at(-1)!.path).toBe("/api/pack-shipments/week?isoYear=2025&isoWeek=52"));
  });

  it("says when pack capture isn't active yet", async () => {
    weekBody = { ...week47(), sync: { ...SYNC, scopeStatus: "capture_not_active", firstWeek: null, lastWeek: null }, source: "legacy", packs: [] };
    render(<PackShipmentsWeek initialWeek={{ isoYear: 2026, isoWeek: 47 }} />);
    expect(await screen.findByText(/Pack capture isn't active in DockLink yet. Every week uses colour totals./)).toBeInTheDocument();
  });
});
