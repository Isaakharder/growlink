import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const listEquipment = vi.fn();
const listSetupResource = vi.fn();
vi.mock("../api", () => ({ listEquipment: (...a: unknown[]) => listEquipment(...a), listSetupResource: (...a: unknown[]) => listSetupResource(...a) }));

import { EquipmentTab } from "../EquipmentTab";

const EQUIPMENT_FIXTURE = [
  {
    id: "eq-1", name: "Boom Sprayer", asset_code: "SPRAY-001", category: { id: "c1", name: "Sprayers" },
    location: { id: "l1", name: "Bay A" }, status: "active", meter_unit: "hours", meter_unit_custom_label: null,
    current_meter_reading: 120, due_status: "overdue"
  },
  {
    id: "eq-2", name: "Mower", asset_code: "MOW-001", category: { id: "c2", name: "Mowers" },
    location: { id: "l1", name: "Bay A" }, status: "active", meter_unit: "hours", meter_unit_custom_label: null,
    current_meter_reading: null, due_status: "ok"
  }
];

function renderTab() {
  return render(
    <MemoryRouter>
      <EquipmentTab />
    </MemoryRouter>
  );
}

describe("EquipmentTab", () => {
  afterEach(() => vi.clearAllMocks());

  it("loads and lists equipment with due-status badges", async () => {
    listEquipment.mockResolvedValue(EQUIPMENT_FIXTURE);
    listSetupResource.mockResolvedValue([]);
    renderTab();

    expect(await screen.findByText("Boom Sprayer")).toBeInTheDocument();
    expect(screen.getByText("Mower")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("each card shows the complete required set of equipment details", async () => {
    listEquipment.mockResolvedValue(EQUIPMENT_FIXTURE);
    listSetupResource.mockResolvedValue([]);
    renderTab();
    await screen.findByText("Boom Sprayer");

    const card = screen.getByText("Boom Sprayer").closest("button");
    expect(card).not.toBeNull();
    const within = card!;

    expect(within.textContent).toContain("Boom Sprayer"); // name
    expect(within.textContent).toContain("SPRAY-001"); // asset code
    expect(within.textContent).toContain("Sprayers"); // category
    expect(within.textContent).toContain("Bay A"); // location
    expect(within.textContent).toContain("Active"); // status
    expect(within.textContent).toContain("120 Hours"); // latest meter reading
    expect(within.textContent).toContain("Overdue"); // maintenance condition badge
  });

  it("shows 'No reading yet' instead of a blank value when equipment has no meter reading", async () => {
    listEquipment.mockResolvedValue(EQUIPMENT_FIXTURE);
    listSetupResource.mockResolvedValue([]);
    renderTab();

    expect(await screen.findByText("No reading yet")).toBeInTheDocument();
  });

  it("shows an empty state distinct from a load error when there is no equipment", async () => {
    listEquipment.mockResolvedValue([]);
    listSetupResource.mockResolvedValue([]);
    renderTab();

    expect(await screen.findByText("No equipment found yet.")).toBeInTheDocument();
  });

  it("shows a retryable error state (not an empty state) when the list request fails", async () => {
    listEquipment.mockRejectedValue(new Error("Failed to load equipment."));
    listSetupResource.mockResolvedValue([]);
    renderTab();

    expect(await screen.findByText("Failed to load equipment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No equipment found yet.")).not.toBeInTheDocument();
  });

  it("filters the visible list to overdue equipment via the Overdue chip, without re-fetching", async () => {
    listEquipment.mockResolvedValue(EQUIPMENT_FIXTURE);
    listSetupResource.mockResolvedValue([]);
    renderTab();
    await screen.findByText("Boom Sprayer");

    await userEvent.click(screen.getByRole("button", { name: /Overdue \(1\)/ }));

    expect(screen.getByText("Boom Sprayer")).toBeInTheDocument();
    expect(screen.queryByText("Mower")).not.toBeInTheDocument();
    // Filtering is client-side over the already-loaded list.
    expect(listEquipment).toHaveBeenCalledTimes(1);
  });

  it("opens the QR scanner sheet when Scan QR is tapped", async () => {
    listEquipment.mockResolvedValue([]);
    listSetupResource.mockResolvedValue([]);
    renderTab();
    await waitFor(() => expect(listEquipment).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Scan QR" }));
    expect(screen.getByText("Scan Equipment QR")).toBeInTheDocument();
  });
});
