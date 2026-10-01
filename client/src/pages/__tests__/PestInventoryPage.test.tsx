import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("../../lib/api", () => ({ apiFetch }));
vi.mock("../../components/ModalOverlay", () => ({
  ModalOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

import { formatInventoryQuantity, PestInventoryPage } from "../PestInventoryPage";

function chemical(id: string, quantity: number | null | undefined, unit: string) {
  return {
    id,
    name: id,
    active: true,
    inventory_qty: quantity as number,
    inventory_unit: unit,
    pest_target: "",
    notes: null,
    phi: null,
    rei: null,
    chemical_group: null,
    chemical_type: "fungicide" as const,
    active_ingredients: null,
    registration_number: null,
    label_pdf_path: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z"
  };
}

describe("PestInventoryPage stock display", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it.each([
    [3.0828545599999995, "3.1"],
    [3.79, "3.8"],
    [271.94277200000477, "271.9"],
    [3935, "3,935.0"],
    [0, "0.0"]
  ])("formats %s to one normally rounded decimal", (input, output) => {
    expect(formatInventoryQuantity(input)).toBe(output);
  });

  it("keeps missing quantities blank instead of displaying zero", () => {
    expect(formatInventoryQuantity(null)).toBe("");
    expect(formatInventoryQuantity(undefined)).toBe("");
  });

  it("shows formatted stock with its original unit and preserves missing stock", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        chemical("Liquid", 3.0828545599999995, "L"),
        chemical("Granules", 3935, "g"),
        chemical("Unspecified", null, "ml")
      ]
    });

    render(<PestInventoryPage />);

    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getByText("3.1 L")).toBeInTheDocument());
    expect(within(table).getByText("3,935.0 g")).toBeInTheDocument();
    expect(within(table).getByText("ml", { exact: true })).toBeInTheDocument();
    expect(within(table).queryByText("0.0 ml")).not.toBeInTheDocument();

    fireEvent.click(within(within(table).getByRole("row", { name: /Liquid/ })).getByRole("button", { name: "Restock" }));
    expect(screen.getByLabelText("Current inventory")).toHaveValue("3.1 L");
  });
});