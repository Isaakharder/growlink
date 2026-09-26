import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import FIRST_LIGHT from "./fixtures/firstLight2026.json";

// First Light's real 2026 yield and greenhouse rows (read-only snapshot),
// with the area-footprints response the server returns once migration 0139's
// links are in place — the server's migration test asserts it resolves to
// exactly this. The farm-wide kg/m2 must read the same everywhere it appears:
// the metric card, the Average row, and both exports.
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string) => {
    const body =
      path === "/api/yield-entries"
        ? FIRST_LIGHT.entries
        : path === "/api/varieties"
          ? FIRST_LIGHT.varieties
          : path === "/api/yield-analytics/area-footprints"
            ? FIRST_LIGHT.areaFootprints
            : path === "/api/yield-analytics/summary"
              ? { sizes: [], rows: [] }
              : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }
}));

const autoTableCalls: Array<{ foot: string[][] }> = [];
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
  default: (_doc: unknown, options: { foot: string[][] }) => {
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

const kgPerM2Card = () => within(screen.getByRole("region", { name: "Summary metrics" })).getByText("kg / m²").closest(".ya-kpi") as HTMLElement;

describe("First Light 2026 Full Year farm-wide kg/m² after the area links", () => {
  it("counts all 1,788,834.27 kg over 73,768.3 m² of unique growing area — 24.2 (24.2494), with no coverage warning", async () => {
    await renderFullYear2026();
    const card = kgPerM2Card();
    // 1,788,834.27 / 73,768.3072 = 24.2494…, shown to one decimal like every kg/m² on the page.
    expect(card).toHaveTextContent("24.2");
    expect(card).toHaveTextContent("1,788,834.27 kg ÷ 73,768.3 m² of unique growing area");
    expect(within(card).queryByRole("note")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Summary metrics" })).getByText("Total kg").closest(".ya-kpi")).toHaveTextContent(
      "1,788,834.27 kg"
    );
  });

  it("the Average row, the CSV export and the PDF export show the same kg/m² as the card", async () => {
    const user = await renderFullYear2026();
    const cardValue = kgPerM2Card().querySelector(".ya-kpi-value")!.textContent;
    expect(cardValue).toBe("24.2");

    const summary = screen.getByRole("region", { name: "Variety Summary" });
    const averageRow = within(summary).getByRole("rowheader", { name: "Average" }).closest("tr")!;
    expect(within(averageRow).getAllByRole("cell")[4]).toHaveTextContent(cardValue!);
    // Legacy Levente still has no individual kg/m²; its kg is in the farm figure.
    const legacy = within(summary).getByRole("rowheader", { name: "Levente" }).closest("tr")!;
    expect(within(legacy).getAllByRole("cell")[4]).toHaveTextContent("-");

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await user.click(await screen.findByRole("button", { name: "Download CSV" }));
    const csv = await downloads[0].text();
    const csvAverage = csv.trim().split("\n").at(-1)!.split(",");
    expect(csvAverage[0]).toBe("Average");
    expect(csvAverage[2]).toBe("1788834.27");
    expect(csvAverage[5]).toBe(cardValue);

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    await user.click(await screen.findByRole("button", { name: "Download PDF" }));
    const pdfAverage = autoTableCalls[0].foot[0];
    expect(pdfAverage[0]).toBe("Average");
    expect(pdfAverage[2]).toBe("1788834.27");
    expect(pdfAverage[5]).toBe(cardValue);
  });
});
