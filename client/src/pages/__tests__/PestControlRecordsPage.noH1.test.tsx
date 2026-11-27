// Pest Control Records after the Food Safety H1 feature was removed: the
// completed spray/drench records still list and expand, there is no H1 tab,
// and the page never asks the server for H1 logs.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { PestControlRecordsPage } from "../PestControlRecordsPage";

const RECORDS = [
  {
    id: "rec-1",
    type: "drench",
    chemical_snapshot: { name: "Kontos", chemical_type: "insecticide", rate_value: 500, rate_unit: "ml_per_acre" },
    target_snapshot: { target_mode: "valve", valve_names: ["V1"], total_m2: 1000 },
    calculation_snapshot: { total_chemical_ml: 123.4, rate_value: 500, rate_unit: "ml_per_acre", area_label: "0.25 acre" },
    progress_snapshot: {
      type: "valve_drench",
      valves: [{ valveId: "v1", valveName: "V1", areaM2: 1000, productAmount: 123.4, productUnit: "ml", completed: true, completedAt: "2026-11-27T10:00:00Z" }]
    },
    completed_at: "2026-11-27T10:05:00Z",
    notes: "Wind calm"
  }
];

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve({ ok: true, status: 200, json: async () => (path === "/api/pest/records" ? RECORDS : []) })
  );
});

describe("Pest Control Records without H1", () => {
  it("lists and expands completed records, with no H1 tab or H1 request", async () => {
    const user = userEvent.setup();
    render(<PestControlRecordsPage />);
    expect(await screen.findByText("Kontos")).toBeInTheDocument();
    expect(screen.getByText("0.25 acre")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText("Valve breakdown")).toBeInTheDocument();
    expect(screen.getByText(/Wind calm/)).toBeInTheDocument();

    expect(screen.queryByText(/H1/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Sheets/ })).toBeNull();
    expect(apiFetch.mock.calls.map((c) => c[0])).toEqual(["/api/pest/records"]);
  });
});
