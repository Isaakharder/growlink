import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const listSetupResource = vi.fn();
const createSetupResource = vi.fn();
const updateSetupResource = vi.fn();
const deleteSetupResource = vi.fn();
const deactivateSetupResource = vi.fn();
const reactivateSetupResource = vi.fn();

vi.mock("../api", () => ({
  listSetupResource: (...a: unknown[]) => listSetupResource(...a),
  createSetupResource: (...a: unknown[]) => createSetupResource(...a),
  updateSetupResource: (...a: unknown[]) => updateSetupResource(...a),
  deleteSetupResource: (...a: unknown[]) => deleteSetupResource(...a),
  deactivateSetupResource: (...a: unknown[]) => deactivateSetupResource(...a),
  reactivateSetupResource: (...a: unknown[]) => reactivateSetupResource(...a)
}));

import { SetupResourceSection } from "../SetupResourceSection";

const RECORD = { id: "cat-1", organization_id: "org-1", name: "Sprayers", description: null, display_order: 0, is_active: true, created_at: "2026-01-01", updated_at: "2026-01-01" };

describe("SetupResourceSection (Categories/Locations/Part Types)", () => {
  afterEach(() => vi.clearAllMocks());

  it("creates a new record and reloads the list", async () => {
    listSetupResource.mockResolvedValue([]);
    createSetupResource.mockResolvedValue(RECORD);
    render(<SetupResourceSection resource="categories" label="Categories" canEdit />);
    await screen.findByText("No categories yet.");

    await userEvent.click(screen.getByRole("button", { name: "+ Add" }));
    await userEvent.type(screen.getByLabelText("Name"), "Sprayers");
    listSetupResource.mockResolvedValue([RECORD]);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(createSetupResource).toHaveBeenCalledWith("categories", { name: "Sprayers", description: null, display_order: 0 });
    expect(await screen.findByText("Sprayers")).toBeInTheDocument();
  });

  it("shows the server's 409 explanation clearly when deleting an in-use record, rather than failing silently", async () => {
    listSetupResource.mockResolvedValue([RECORD]);
    deleteSetupResource.mockRejectedValue(new Error("This category is still in use — deactivate it instead."));
    render(<SetupResourceSection resource="categories" label="Categories" canEdit />);
    await screen.findByText("Sprayers");

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    await userEvent.click(deleteButtons[deleteButtons.length - 1]); // confirm sheet's own Delete button

    expect(await screen.findByText("This category is still in use — deactivate it instead.")).toBeInTheDocument();
    // The confirm sheet stays open on failure -- it's not silently dismissed.
    expect(screen.getByText('Delete "Sprayers"?')).toBeInTheDocument();
  });

  it("deactivates a record without requiring a confirmation dialog", async () => {
    listSetupResource.mockResolvedValue([RECORD]);
    deactivateSetupResource.mockResolvedValue(undefined);
    render(<SetupResourceSection resource="categories" label="Categories" canEdit />);
    await screen.findByText("Sprayers");

    listSetupResource.mockResolvedValue([{ ...RECORD, is_active: false }]);
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(deactivateSetupResource).toHaveBeenCalledWith("categories", "cat-1");
    expect(await screen.findByText("Inactive")).toBeInTheDocument();
  });

  it("hides all edit affordances for a view-only (canEdit=false) user", async () => {
    listSetupResource.mockResolvedValue([RECORD]);
    render(<SetupResourceSection resource="categories" label="Categories" canEdit={false} />);
    await screen.findByText("Sprayers");

    expect(screen.queryByRole("button", { name: "+ Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
