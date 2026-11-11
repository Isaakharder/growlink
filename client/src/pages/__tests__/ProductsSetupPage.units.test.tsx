import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Setup → Products: Cucumbers can be enabled in Kilograms or Pieces, and an
// enabled crop's default unit can be changed later. The change applies to
// new harvests only. Bell Peppers supports kg only, so it has no choice.
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
const PCS = { code: "pcs", name: "Pieces", dimension: "count" };
const PEPPERS = {
  code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active",
  defaultUnit: KG, supportedUnits: [KG], varietyCount: 9, activeVarietyCount: 8
};
const CUCUMBERS_AVAILABLE = { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, defaultUnit: KG, supportedUnits: [KG, PCS] };
const cucumbersEnabled = (unit = KG) => ({
  code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active",
  defaultUnit: unit, supportedUnits: [KG, PCS], varietyCount: 1, activeVarietyCount: 1
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Setup → Products — default units", () => {
  afterEach(() => {
    apiFetchMock.mockReset();
    permissions.canEdit = true;
  });

  it("before enabling: the Cucumbers row offers Kilograms (kg) or Pieces (pcs), and Enable saves the one chosen", async () => {
    const user = userEvent.setup();
    apiFetchMock
      .mockResolvedValueOnce(json({ products: [PEPPERS], available: [CUCUMBERS_AVAILABLE] }))
      .mockResolvedValueOnce(json({ products: [PEPPERS, cucumbersEnabled(PCS)], available: [] }));
    render(<ProductsSetupPage />);

    const unit = await screen.findByRole("combobox", { name: "Default unit for Cucumbers" });
    expect(unit).toHaveValue("kg");
    expect(within(unit).getAllByRole("option").map((o) => o.textContent)).toEqual(["Kilograms (kg)", "Pieces (pcs)"]);
    // Bell Peppers is kg only: no choice to make.
    expect(screen.queryByRole("combobox", { name: "Default unit for Bell Peppers" })).not.toBeInTheDocument();

    await user.selectOptions(unit, "pcs");
    await user.click(screen.getByRole("button", { name: "Enable Cucumbers" }));
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/products/cucumber/enable", {
      method: "POST",
      body: JSON.stringify({ unit_code: "pcs" })
    });
    expect(await screen.findByRole("combobox", { name: "Default unit for Cucumbers" })).toHaveValue("pcs");
  });

  it("already enabled: changing the default needs Save and applies to new entries only", async () => {
    const user = userEvent.setup();
    apiFetchMock
      .mockResolvedValueOnce(json({ products: [PEPPERS, cucumbersEnabled()], available: [] }))
      .mockResolvedValueOnce(json({ products: [PEPPERS, cucumbersEnabled(PCS)], available: [] }));
    render(<ProductsSetupPage />);

    const unit = await screen.findByRole("combobox", { name: "Default unit for Cucumbers" });
    expect(screen.queryByRole("button", { name: "Save unit" })).not.toBeInTheDocument();
    await user.selectOptions(unit, "pcs");
    expect(screen.getByText("Applies to new entries. Existing harvests keep the unit they were recorded in.")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Save unit" }));
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/products/cucumber", {
      method: "PATCH",
      body: JSON.stringify({ default_unit_code: "pcs" })
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "New Cucumbers harvests will be recorded in Pieces (pcs). Existing harvests keep their units."
    );
    expect(screen.queryByRole("button", { name: "Save unit" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the unit as it was", async () => {
    const user = userEvent.setup();
    apiFetchMock
      .mockResolvedValueOnce(json({ products: [PEPPERS, cucumbersEnabled()], available: [] }))
      .mockResolvedValueOnce(json({ message: "Cucumbers can't be recorded in Pieces (pcs)." }, 400));
    render(<ProductsSetupPage />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Default unit for Cucumbers" }), "pcs");
    await user.click(screen.getByRole("button", { name: "Save unit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cucumbers can't be recorded in Pieces (pcs).");
  });

  it("without Setup edit, units are shown, never offered", async () => {
    permissions.canEdit = false;
    apiFetchMock.mockResolvedValue(json({ products: [PEPPERS, cucumbersEnabled(PCS)], available: [] }));
    render(<ProductsSetupPage />);
    expect(await screen.findByRole("cell", { name: "Pieces (pcs)" })).toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });
});
