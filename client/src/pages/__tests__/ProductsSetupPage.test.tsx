import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: apiFetchMock }));

const permissions = vi.hoisted(() => ({ canEdit: true }));
vi.mock("../../hooks/usePermissions", () => ({
  usePermissions: () => ({
    loading: false,
    isOwnerOrAdmin: permissions.canEdit,
    can: (key: string) => (key === "greenhouse_setup:edit" ? permissions.canEdit : true),
    canAny: () => true
  })
}));

import { ProductsSetupPage } from "../ProductsSetupPage";

const KG = { code: "kg", name: "Kilograms", dimension: "weight" };
const PEPPERS = {
  code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active",
  defaultUnit: KG, supportedUnits: [KG], varietyCount: 9, activeVarietyCount: 8
};
const CUCUMBERS_AVAILABLE = { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, defaultUnit: KG, supportedUnits: [KG] };
const CUCUMBERS_ENABLED = {
  code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active",
  defaultUnit: KG, supportedUnits: [KG], varietyCount: 0, activeVarietyCount: 0
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const rows = (table: HTMLElement) =>
  Array.from(table.querySelectorAll("tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent));

describe("Setup → Products", () => {
  afterEach(() => {
    apiFetchMock.mockReset();
    permissions.canEdit = true;
  });

  it("lists the enabled products with their units, varieties and status, and Cucumbers as available — read only without Setup edit", async () => {
    permissions.canEdit = false;
    apiFetchMock.mockResolvedValue(json({ products: [PEPPERS], available: [CUCUMBERS_AVAILABLE] }));
    const { container } = render(<ProductsSetupPage />);

    expect(await screen.findByRole("cell", { name: "Bell Peppers" })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/products");
    const [enabled, available] = screen.getAllByRole("table");
    expect(rows(enabled)).toEqual([["Bell Peppers", "Kilograms (kg)", "kg", "8 active of 9", "Active"]]);
    expect(rows(available)).toEqual([["Cucumbers", "Kilograms (kg)", "kg"]]);
    expect(container.querySelectorAll("button, input, select")).toHaveLength(0);
  });

  it("an admin enables Cucumbers; it joins the enabled products in kg and Bell Peppers is unchanged", async () => {
    const user = userEvent.setup();
    apiFetchMock
      .mockResolvedValueOnce(json({ products: [PEPPERS], available: [CUCUMBERS_AVAILABLE] }))
      .mockResolvedValueOnce(json({ products: [PEPPERS, CUCUMBERS_ENABLED], available: [] }));
    render(<ProductsSetupPage />);

    await user.click(await screen.findByRole("button", { name: "Enable Cucumbers" }));

    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/products/cucumber/enable", { method: "POST", body: "{}" });
    expect(await screen.findByRole("cell", { name: "Cucumbers" })).toBeInTheDocument();
    const tables = screen.getAllByRole("table");
    expect(tables).toHaveLength(1);
    expect(rows(tables[0]).map((r) => r.slice(0, 5))).toEqual([
      ["Bell Peppers", "Kilograms (kg)", "kg", "8 active of 9", "Active"],
      ["Cucumbers", "Kilograms (kg)", "kg", "0 active of 0", "Active"]
    ]);
  });

  it("shows the server's reason when a product can't be turned off", async () => {
    const user = userEvent.setup();
    apiFetchMock
      .mockResolvedValueOnce(json({ products: [PEPPERS, CUCUMBERS_ENABLED], available: [] }))
      .mockResolvedValueOnce(json({ message: "A product with active varieties cannot be deactivated" }, 409));
    render(<ProductsSetupPage />);

    const cucumberRow = (await screen.findByRole("cell", { name: "Cucumbers" })).closest("tr")!;
    await user.click(within(cucumberRow).getByRole("button", { name: "Turn off" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A product with active varieties cannot be deactivated");
    expect(within(cucumberRow).getByText("Active")).toBeInTheDocument();
  });

  it("shows the error instead of a table when products can't be loaded", async () => {
    apiFetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    render(<ProductsSetupPage />);
    expect(await screen.findByText("Failed to load products")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
