import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Phase 0 regression coverage: pins the mobile Daily Yield projection as the
// page displays it today — average kg per stem × linked stems, bins, cases
// (by kg per case, else by bins), the per-phase cards and their combined
// total, and the projected cases by colour summed across all varieties
// (two red varieties here).
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));
vi.mock("../../hooks/useOnlineStatus", () => ({ useOnlineStatus: () => ({ isOnline: true }) }));
vi.mock("../../services/offlineQueue", () => ({ enqueue: vi.fn() }));
vi.mock("../../contexts/MembershipContext", () => ({ useMembership: () => ({ role: "owner", permissions: {} }) }));

import { MobileDailyYieldPage } from "../MobileDailyYieldPage";

const row = (variety_id: string, phase: 1 | 2, row_number: number, total_stems: number) => ({
  row_id: `${variety_id}-p${phase}-r${row_number}`,
  row_number,
  phase_id: `phase-${phase}`,
  phase_name: `Phase ${phase}`,
  variety_id,
  variety_name: variety_id,
  slab_count: 10,
  plants_per_slab: 3,
  stems_per_plant: total_stems / 30,
  total_plants: 30,
  total_stems
});

const OPTIONS = {
  varieties: [
    { id: "red-a", name: "Alpha Red", status: "active", color: "red" },
    { id: "yellow-c", name: "Charlie Yellow", status: "active", color: "yellow" },
    { id: "red-b", name: "Bravo Red", status: "active", color: "red" }
  ],
  rows: [
    row("red-a", 1, 1, 60), row("red-a", 1, 2, 60), row("red-a", 2, 1, 20),
    row("yellow-c", 1, 3, 60), row("yellow-c", 1, 4, 60),
    row("red-b", 2, 2, 40)
  ],
  casesPerBin: 38
};

const sample = (id: string, rowId: string, kgPerStem: number) => {
  const [, phase, rowNumber] = rowId.match(/p(\d)-r(\d)$/)!;
  return {
    id,
    row_id: rowId,
    row_number: Number(rowNumber),
    phase_id: `phase-${phase}`,
    phase_name: `Phase ${phase}`,
    row_label: `Phase ${phase} — Row ${rowNumber}`,
    percent_full: 50,
    calculated_sample_kg: kgPerStem * 60,
    calculated_kg_per_stem: kgPerStem
  };
};

const SAMPLES: Record<string, unknown[]> = {
  "red-a": [
    sample("s1", "red-a-p1-r1", 0.5),
    sample("s2", "red-a-p1-r2", 0.7),
    sample("s3", "red-a-p2-r1", 0.4),
    sample("s4", "red-a-p1-r1", 0.6)
  ],
  "yellow-c": [1, 2, 3, 4].map((n) => sample(`y${n}`, "yellow-c-p1-r3", 0.25)),
  "red-b": [1, 2, 3, 4].map((n) => sample(`b${n}`, "red-b-p2-r2", 0.1))
};

function mockApi(settings: Record<string, number>) {
  apiFetchMock.mockImplementation(async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === "/api/mobile/daily-yield/options") return json(OPTIONS);
    if (url === "/api/mobile/daily-yield/settings") return json(settings);
    if (url.startsWith("/api/mobile/daily-yield/samples?")) {
      return json(SAMPLES[new URLSearchParams(url.split("?")[1]).get("variety_id") ?? ""] ?? []);
    }
    throw new Error(`unexpected request ${url}`);
  });
}

const paragraphs = (el: Element) => Array.from(el.querySelectorAll("p")).map((p) => p.textContent);

async function renderProjection(settings: Record<string, number>) {
  mockApi(settings);
  const { container } = render(
    <MemoryRouter>
      <MobileDailyYieldPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(container.querySelectorAll(".mobile-projection-card")).toHaveLength(3));
  await screen.findByText("Projected Cases by Color");
  const colourCard = screen.getByText("Projected Cases by Color").closest(".mobile-yield-card")!;
  return {
    summary: paragraphs(container.querySelector(".mobile-projection-meta")!),
    cards: Array.from(container.querySelectorAll(".mobile-projection-card")).map(paragraphs),
    colours: Array.from(colourCard.querySelectorAll("span")).map((s) => s.textContent)
  };
}

describe("Mobile Daily Yield projection", () => {
  afterEach(() => apiFetchMock.mockReset());

  it("projects kg, bins and cases from kg per case, per phase and by colour", async () => {
    const view = await renderProjection({ cases_per_bin: 38, kg_per_full_bin: 400, kg_per_case: 5 });
    expect(view.summary).toEqual([
      "Linked rows: 3",
      "Total linked stems: 140",
      "Avg kg per stem: 0.55",
      "Projected kg: 77",
      "Projected full bins: 0.19",
      "Projected cases: 15.4",
      "Cases calculated from kg per case"
    ]);
    expect(view.cards).toEqual([
      ["Phase 1", "Sampled rows: 3 of 2 linked", "Linked stems: 120", "Avg kg/stem: 0.6", "Projected kg: 72", "Projected bins: 0.18", "Projected cases: 14.4"],
      ["Phase 2", "Sampled rows: 1 of 1 linked", "Linked stems: 20", "Avg kg/stem: 0.4", "Projected kg: 8", "Projected bins: 0.02", "Projected cases: 1.6"],
      ["Combined Total", "Projected kg: 80", "Projected bins: 0.2", "Projected cases: 16", "Cases from kg per case"]
    ]);
    expect(view.colours).toEqual(["red", "16.2 cases", "yellow", "6 cases"]);
  });

  it("falls back to cases per bin when there is no kg per case", async () => {
    const view = await renderProjection({ cases_per_bin: 38, kg_per_full_bin: 400, kg_per_case: 0 });
    expect(view.summary.slice(3)).toEqual([
      "Projected kg: 77",
      "Projected full bins: 0.19",
      "Projected cases: 7.32",
      "Cases calculated from cases per bin fallback"
    ]);
    expect(view.cards.map((card) => card.at(-1))).toEqual(["Projected cases: 6.84", "Projected cases: 0.76", "Cases from cases per bin"]);
    expect(view.cards.at(-1)).toEqual(["Combined Total", "Projected kg: 80", "Projected bins: 0.2", "Projected cases: 7.6", "Cases from cases per bin"]);
    expect(view.colours).toEqual(["red", "7.7 cases", "yellow", "2.9 cases"]);
  });
});
