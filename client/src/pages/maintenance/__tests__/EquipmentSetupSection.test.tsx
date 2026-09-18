import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const listEquipment = vi.fn();
const listSetupResource = vi.fn();
const createEquipment = vi.fn();
const setEquipmentStatus = vi.fn();

vi.mock("../api", () => ({
  listEquipment: (...a: unknown[]) => listEquipment(...a),
  listSetupResource: (...a: unknown[]) => listSetupResource(...a),
  createEquipment: (...a: unknown[]) => createEquipment(...a),
  setEquipmentStatus: (...a: unknown[]) => setEquipmentStatus(...a)
}));

import { EquipmentSetupSection } from "../EquipmentSetupSection";

const CATEGORY = { id: "cat-1", organization_id: "org-1", name: "Sprayers", description: null, display_order: 0, is_active: true, created_at: "2026-01-01", updated_at: "2026-01-01" };
const LOCATION = { id: "loc-1", organization_id: "org-1", name: "Bay A", description: null, display_order: 0, is_active: true, created_at: "2026-01-01", updated_at: "2026-01-01" };

describe("EquipmentSetupSection", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires name, asset code, category, and location before submitting", async () => {
    listEquipment.mockResolvedValue([]);
    listSetupResource.mockImplementation((resource: string) => Promise.resolve(resource === "categories" ? [CATEGORY] : [LOCATION]));
    render(<EquipmentSetupSection canEdit />);
    await screen.findByText("No equipment yet.");

    await userEvent.click(screen.getByRole("button", { name: "+ Add" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/name, asset code, category, and location are required/i)).toBeInTheDocument();
    expect(createEquipment).not.toHaveBeenCalled();
  });

  it("creates equipment with the selected category and location", async () => {
    listEquipment.mockResolvedValue([]);
    listSetupResource.mockImplementation((resource: string) => Promise.resolve(resource === "categories" ? [CATEGORY] : [LOCATION]));
    createEquipment.mockResolvedValue({ id: "eq-1" });
    render(<EquipmentSetupSection canEdit />);
    await screen.findByText("No equipment yet.");

    await userEvent.click(screen.getByRole("button", { name: "+ Add" }));
    await userEvent.type(screen.getByLabelText("Name"), "Boom Sprayer");
    await userEvent.type(screen.getByLabelText("Asset code"), "SPRAY-001");
    await userEvent.selectOptions(screen.getByLabelText("Category"), "cat-1");
    await userEvent.selectOptions(screen.getByLabelText("Location"), "loc-1");
    listEquipment.mockResolvedValue([{ id: "eq-1", name: "Boom Sprayer", asset_code: "SPRAY-001", category: CATEGORY, location: LOCATION, status: "active" }]);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(createEquipment).toHaveBeenCalledWith(expect.objectContaining({ name: "Boom Sprayer", asset_code: "SPRAY-001", category_id: "cat-1", location_id: "loc-1", meter_unit: "hours" }));
    expect(await screen.findByText("Boom Sprayer")).toBeInTheDocument();
  });
});
