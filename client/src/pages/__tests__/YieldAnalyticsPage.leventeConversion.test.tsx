import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AFTER from "./fixtures/firstLight2026AfterLeventeConversion.json";

// First Light's 2026 data as migration 0139 leaves it (the server's
// migration test asserts this fixture is exactly 0139's output): the legacy
// Levente yield split into Levente Phase 2 / Phase 3, the duplicated week 27
// removed. Growing area is every measured row approved for 2026, including
// Phase 2 rows 590-596 and 598 once reassigned in Greenhouse Setup.
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string) => {
    const body =
      path === "/api/yield-entries"
        ? AFTER.entries
        : path === "/api/varieties"
          ? AFTER.varieties
          : path === "/api/yield-analytics/area-footprints"
            ? AFTER.areaFootprints
            : path === "/api/yield-analytics/summary"
              ? { sizes: AFTER.sizes, rows: [] }
              : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }
}));

const autoTableCalls: Array<{ body: string[][]; foot: string[][] }> = [];
vi.mock("jspdf", () => ({
  jsPDF: class {
    setFontSize() {}
    setTextColor() {}
    text() {}
    output() {
      return new Blob(["%PDF"], { type: "application/pdf" });
    }
  }
}));
vi.mock("jspdf-autotable", () => ({
  default: (_doc: unknown, options: { body: string[][]; foot: string[][] }) => {
    autoTableCalls.push(options);
  }
}));

import { YieldAnalyticsPage } from "../YieldAnalyticsPage";

const downloads: Blob[] = [];
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  downloads.length = 0;
  autoTableCalls.length = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    downloads.push(blob);
    return "blob:test";
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.clearAllMocks());

async function renderFullYear2026() {
  const user = userEvent.setup();
  render(<YieldAnalyticsPage />);
  const filters = await screen.findByRole("region", { name: "Filters" });
  await user.selectOptions(within(filters).getByLabelText("Year"), "2026");
  await screen.findByRole("region", { name: "Summary metrics" });
  return user;
}
const metrics = () => screen.getByRole("region", { name: "Summary metrics" });
const metric = (label: string) => within(metrics()).getByText(label).closest(".ya-kpi") as HTMLElement;
const summary = () => screen.getByRole("region", { name: "Variety Summary" });

describe("Yield Analytics after the Levente conversion (2026 Full Year)", () => {
  it("has no legacy Levente row; its yield now sits under Levente Phase 2 and Phase 3", async () => {
    await renderFullYear2026();
    expect(within(summary()).queryByRole("rowheader", { name: "Levente" })).not.toBeInTheDocument();
    const cells = (name: string) => within(within(summary()).getByRole("rowheader", { name }).closest("tr")!).getAllByRole("cell").map((c) => c.textContent);
    // 79,059.057 kg observed + 74,488.116 kg converted (weeks 17-26); 106,635.19 + 100,469.884.
    expect(cells("Levente Phase 2")[1]).toBe("153547.17");
    expect(cells("Levente Phase 3")[1]).toBe("207105.07");
    expect(cells("Levente Phase 2")[0]).toBe("23");
    expect(cells("Levente Phase 3")[0]).toBe("23");
  });

  it("farm kg/m²: 1,775,143.27 kg over 73,768.3 m² of unique growing area, no coverage warning", async () => {
    await renderFullYear2026();
    expect(metric("Total kg")).toHaveTextContent("1,775,143.27 kg");
    const card = metric("kg / m²");
    // 1,775,143.266 / 73,768.307 = 24.064
    expect(card.querySelector(".ya-kpi-value")).toHaveTextContent("24.1");
    expect(card).toHaveTextContent("1,775,143.27 kg ÷ 73,768.3 m² of unique growing area");
    expect(within(card).queryByRole("note")).not.toBeInTheDocument();
  });

  it("the Average row, CSV export and PDF export reconcile with the cards", async () => {
    const user = await renderFullYear2026();
    const kgPerM2 = metric("kg / m²").querySelector(".ya-kpi-value")!.textContent!;
    const averageRow = within(summary()).getByRole("rowheader", { name: "Average" }).closest("tr")!;
    const average = within(averageRow).getAllByRole("cell").map((c) => c.textContent);
    expect(average[1]).toBe("1775143.27");
    expect(average[4]).toBe(kgPerM2);

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await user.click(await screen.findByRole("button", { name: "Download CSV" }));
    const csvLines = (await downloads[0].text()).trim().split("\n");
    expect(csvLines.some((l) => l.startsWith("Levente,"))).toBe(false);
    const csvAverage = csvLines.at(-1)!.split(",");
    expect([csvAverage[0], csvAverage[2], csvAverage[5]]).toEqual(["Average", "1775143.27", kgPerM2]);
    // The variety rows add up to the exact 1,775,143.266 kg, within each row's own 0.01 kg rounding.
    const rows = csvLines.slice(1, -1);
    const rowsKg = rows.reduce((t, l) => t + Number(l.split(",")[2]), 0);
    expect(Math.abs(rowsKg - 1_775_143.266)).toBeLessThanOrEqual(rows.length * 0.005);

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    await user.click(await screen.findByRole("button", { name: "Download PDF" }));
    const pdf = autoTableCalls[0];
    expect(pdf.body.some((r) => r[0] === "Levente")).toBe(false);
    expect([pdf.foot[0][0], pdf.foot[0][2], pdf.foot[0][5]]).toEqual(["Average", "1775143.27", kgPerM2]);
  });
});
