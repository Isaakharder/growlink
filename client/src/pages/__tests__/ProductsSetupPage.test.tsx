import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));

import { ProductsSetupPage } from "../ProductsSetupPage";

const KG = { code: "kg", name: "Kilograms", dimension: "weight" };

describe("Setup → Products", () => {
  afterEach(() => apiFetchMock.mockReset());

  it("lists the enabled catalog products with their default unit, supported units, varieties and status — read only", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          products: [{
            code: "bell_pepper", name: "Bell Peppers", tracksColour: true, status: "active",
            defaultUnit: KG, supportedUnits: [KG], varietyCount: 9, activeVarietyCount: 8
          }]
        }),
        { status: 200 }
      )
    );
    const { container } = render(<ProductsSetupPage />);

    expect(await screen.findByRole("cell", { name: "Bell Peppers" })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/products");
    const cells = Array.from(container.querySelectorAll("tbody tr")).map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent)
    );
    expect(cells).toEqual([["Bell Peppers", "Kilograms (kg)", "kg", "8 active of 9", "Active"]]);
    // Catalog products and their units can't be created or edited here.
    expect(container.querySelectorAll("button, input, select")).toHaveLength(0);
  });

  it("shows the error instead of a table when products can't be loaded", async () => {
    apiFetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    render(<ProductsSetupPage />);
    expect(await screen.findByText("Failed to load products")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
