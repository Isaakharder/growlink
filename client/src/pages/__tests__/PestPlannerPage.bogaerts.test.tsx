import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { PestPlannerPage } from "../PestPlannerPage";

// Production scenario (Denva, Sep 2026): 21,301.62 m² = 5.2637 acres = 2.1302 ha.
// Modelled as a single row so the area is exact and independent of row-splitting.
const TOTAL_M2 = 21301.62;

const GROUPS = [{ id: "g-1", type: "phase", name: "Phase 1", status: "active" }];
const ROWS = [
  { id: "r-1", group_id: "g-1", row_number: 1, width_meters: 1, length_meters: TOTAL_M2 }
];

const CHEMICAL = {
  id: "chem-1",
  name: "Serenade",
  active: true,
  inventory_qty: 20,
  inventory_unit: "L",
  pest_target: "Botrytis",
  notes: null,
  phi: "0",
  chemical_group: "44",
  chemical_type: "fungicide",
  active_ingredients: null,
  registration_number: null,
  label_pdf_path: null
};

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

// Mirrors the production org: Bogaerts robots and — critically — nozzle types
// have never been configured, so /bogaerts/nozzle-types returns an empty list
// and the planner never renders a Nozzle Type select.
function mockRoutes(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    "/api/greenhouse-setup": { groups: GROUPS, rows: ROWS, rowValves: [] },
    "/api/pest/sprayers": [],
    "/api/pest/tanks": [],
    "/api/pest/chemicals": [CHEMICAL],
    "/api/pest/calibrations": [],
    "/api/pest/bogaerts/robots": [],
    "/api/pest/bogaerts/nozzle-types": [],
    "/api/irrigation-setup": { feedValves: [] },
    ...overrides
  };

  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/api/pest/todos") && path !== "/api/pest/todos?status=active") {
      return Promise.resolve(jsonOk({ id: "todo-1" }));
    }
    const key = Object.keys(table).find((k) => path.startsWith(k));
    return Promise.resolve(jsonOk(key ? table[key] : {}));
  });
}

function labelGroup(text: string): HTMLElement {
  const label = screen.getByText(text).closest("label");
  if (!label) throw new Error(`No <label> wrapping "${text}"`);
  return label;
}

// Drives the planner exactly as the operator did in production.
async function fillBogaertsPlan(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText(/Application type/i), "spray");
  await user.selectOptions(screen.getByLabelText(/^Chemical/i), "chem-1");

  // 900 mL/ha. These labels wrap a value input *and* a unit select, so scope
  // to the <label> element rather than resolving the label to a single control.
  const rateGroup = labelGroup("Application rate");
  await user.type(within(rateGroup).getByRole("spinbutton"), "900");
  await user.selectOptions(within(rateGroup).getByRole("combobox"), "ml_per_hectare");

  await user.click(screen.getByRole("checkbox", { name: /Phase 1/ }));
  await user.click(screen.getByRole("button", { name: /Bogaerts Qii-Jet/i }));

  // 250 imp gal/acre
  const volumeGroup = labelGroup("Target Spray Volume");
  await user.type(within(volumeGroup).getByRole("spinbutton"), "250");
  await user.selectOptions(within(volumeGroup).getByRole("combobox"), "imp_gal_per_acre");

  await user.type(screen.getByLabelText(/Active Nozzles/i), "14");
  await user.type(screen.getByLabelText(/Pressure \(PSI\)/i), "120");
}

describe("PestPlannerPage — Bogaerts Qii-Jet job creation", () => {
  beforeEach(() => mockRoutes());
  afterEach(() => vi.clearAllMocks());

  it("enables Create Spray Job for a complete plan when no nozzle types are configured", async () => {
    const user = userEvent.setup();
    render(<PestPlannerPage />);
    await fillBogaertsPlan(user);

    // The condition that caused the production bug: the select is absent, so
    // nozzleTypeId can never be set from this page.
    expect(screen.getByText(/No nozzle types configured/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Nozzle Type/i)).not.toBeInTheDocument();

    const button = await screen.findByRole("button", { name: "Create Spray Job" });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("posts the Imperial-gallon unit alongside the normalized L/acre value", async () => {
    const user = userEvent.setup();
    render(<PestPlannerPage />);
    await fillBogaertsPlan(user);

    const button = await screen.findByRole("button", { name: "Create Spray Job" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/api/pest/todos", expect.objectContaining({ method: "POST" }))
    );

    const call = apiFetch.mock.calls.find(([path]) => path === "/api/pest/todos");
    const payload = JSON.parse((call![1] as { body: string }).body);

    // The operator's entry is preserved verbatim, never silently rewritten to L.
    expect(payload.sprayer_snapshot.target_volume_value).toBe(250);
    expect(payload.sprayer_snapshot.target_volume_unit).toBe("imp_gal_per_acre");
    expect(payload.calculation_snapshot.target_volume_value).toBe(250);
    expect(payload.calculation_snapshot.target_volume_unit).toBe("imp_gal_per_acre");

    // 250 imp gal x 4.54609 L = 1136.5225 L/acre.
    expect(payload.sprayer_snapshot.target_volume_l_per_acre).toBeCloseTo(1136.5225, 6);

    // 5.2637 acres x 1136.5225 L/acre = 5982.4 L; 9 full 600 L batches + 582.4 L.
    expect(payload.calculation_snapshot.total_volume_l).toBeCloseTo(5982.4, 1);
    expect(payload.calculation_snapshot.tank_count).toBe(10);
    expect(payload.calculation_snapshot.final_tank_volume_l).toBeCloseTo(582.4, 1);

    // 900 mL/ha x 2.130162 ha = 1917 mL.
    expect(payload.calculation_snapshot.total_chemical_ml).toBeCloseTo(1917.1, 1);
    expect(payload.calculation_snapshot.chem_per_full_tank_ml).toBeCloseTo(192.3, 1);
    expect(payload.calculation_snapshot.chem_for_final_tank_ml).toBeCloseTo(186.6, 1);

    // PSI is the live pressure field; the legacy bar key is never written.
    expect(payload.sprayer_snapshot.pressure_psi).toBe(120);
    expect(payload.sprayer_snapshot.active_nozzles).toBe(14);
    expect(payload.sprayer_snapshot).not.toHaveProperty("pressure_bar");
    expect(payload.sprayer_snapshot.nozzle_type_id).toBeNull();
  });

  it("still blocks — and says why — when a required Bogaerts value is missing", async () => {
    const user = userEvent.setup();
    render(<PestPlannerPage />);
    await fillBogaertsPlan(user);
    await user.clear(screen.getByLabelText(/Pressure \(PSI\)/i));

    const button = await screen.findByRole("button", { name: "Create Spray Job" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText(/Enter a Pressure \(PSI\) greater than 0/i)).toBeInTheDocument();
  });
});
