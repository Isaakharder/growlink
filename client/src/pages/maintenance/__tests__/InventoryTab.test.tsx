import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const listInventoryItems = vi.fn();
const listSetupResource = vi.fn();
vi.mock("../api", () => ({ listInventoryItems: (...a: unknown[]) => listInventoryItems(...a), listSetupResource: (...a: unknown[]) => listSetupResource(...a) }));
vi.mock("../../../hooks/usePermissions", () => ({ usePermissions: () => ({ canAny: () => false, can: () => false, loading: false, isOwnerOrAdmin: false }) }));

import { InventoryTab } from "../InventoryTab";
import { InventoryItemRow } from "../types";

function makeItem(overrides: Partial<InventoryItemRow>): InventoryItemRow {
  return {
    id: "i0", organization_id: "org-1", name: "Part", part_number: null, part_type_id: null, part_type: null,
    location_id: "l1", location: { id: "l1", name: "Bay A" }, quantity_on_hand: 0, unit_of_measure: "each",
    unit_of_measure_custom_label: null, minimum_quantity: null, suggested_reorder_quantity: null, supplier: null,
    supplier_part_number: null, cost: null, notes: null, is_active: true, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", stock_status: "in_stock",
    ...overrides
  };
}

const ITEMS = [
  makeItem({ id: "i1", name: "Drip Emitters", part_number: "DE-100", quantity_on_hand: 2, minimum_quantity: 10, stock_status: "low_stock" }),
  makeItem({ id: "i2", name: "Filter Cartridge", part_number: "FC-200", quantity_on_hand: 0, minimum_quantity: 5, stock_status: "out_of_stock" }),
  makeItem({ id: "i3", name: "Zip Ties", quantity_on_hand: 500, minimum_quantity: 50, stock_status: "in_stock" })
];

describe("InventoryTab — low-stock / out-of-stock display", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows a Low Stock badge and an Out of Stock badge on the relevant cards", async () => {
    listInventoryItems.mockResolvedValue(ITEMS);
    listSetupResource.mockResolvedValue([]);
    render(<InventoryTab />);

    await screen.findByText("Drip Emitters");
    expect(screen.getByText("Low Stock")).toBeInTheDocument();
    expect(screen.getByText("Out of Stock")).toBeInTheDocument();
    expect(screen.getByText("In Stock")).toBeInTheDocument();
  });

  it("the Low Stock chip filters the list to just low-stock parts", async () => {
    listInventoryItems.mockResolvedValue(ITEMS);
    listSetupResource.mockResolvedValue([]);
    render(<InventoryTab />);
    await screen.findByText("Drip Emitters");

    await userEvent.click(screen.getByRole("button", { name: /Low Stock \(1\)/ }));
    expect(screen.getByText("Drip Emitters")).toBeInTheDocument();
    expect(screen.queryByText("Zip Ties")).not.toBeInTheDocument();
    expect(screen.queryByText("Filter Cartridge")).not.toBeInTheDocument();
  });

  it("hides Receive/Adjust actions for a view-only user (no maintenance:edit / mobile:maintenance)", async () => {
    listInventoryItems.mockResolvedValue([ITEMS[0]]);
    listSetupResource.mockResolvedValue([]);
    render(<InventoryTab />);

    await userEvent.click(await screen.findByText("Drip Emitters"));
    expect(screen.queryByRole("button", { name: "Receive Stock" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adjust Stock" })).not.toBeInTheDocument();
  });
});
