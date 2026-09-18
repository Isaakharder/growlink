import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Isolates the tab-shell wiring (labels, active state, panel switching)
// from each tab's own data/API behavior, which is covered by their own
// test files.
vi.mock("../maintenance/EquipmentTab", () => ({ EquipmentTab: () => <div>Equipment Panel</div> }));
vi.mock("../maintenance/InventoryTab", () => ({ InventoryTab: () => <div>Inventory Panel</div> }));
vi.mock("../maintenance/ReportsTab", () => ({ ReportsTab: () => <div>Reports Panel</div> }));
vi.mock("../maintenance/SetupTab", () => ({ SetupTab: () => <div>Setup Panel</div> }));

import { MobileMaintenancePage } from "../MobileMaintenancePage";

function renderPage() {
  return render(
    <MemoryRouter>
      <MobileMaintenancePage />
    </MemoryRouter>
  );
}

describe("MobileMaintenancePage — tab bar", () => {
  it("renders all four tabs with their complete, untruncated labels", () => {
    renderPage();
    // Exact text match — catches truncation (e.g. "Equi…") as well as a
    // wrong/missing label, which a substring or regex match would not.
    expect(screen.getByRole("tab", { name: "Equipment" })).toHaveTextContent("Equipment");
    expect(screen.getByRole("tab", { name: "Inventory" })).toHaveTextContent("Inventory");
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveTextContent("Reports");
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveTextContent("Setup");
  });

  it("none of the tab labels contain an ellipsis or truncation marker", () => {
    renderPage();
    for (const label of ["Equipment", "Inventory", "Reports", "Setup"]) {
      const tab = screen.getByRole("tab", { name: label });
      expect(tab.textContent).toBe(label);
      expect(tab.textContent).not.toMatch(/…|\.\.\./);
    }
  });

  it("renders exactly four tabs in a single tablist container (the CSS grid hook)", () => {
    const { container } = renderPage();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(container.querySelector(".maintenance-tab-bar")).toBeInTheDocument();
  });

  it("defaults to the Equipment tab, marked selected via aria-selected", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "Equipment" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Inventory" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("Equipment Panel")).toBeInTheDocument();
  });

  it("switches the active tab and panel on click, without affecting the other tabs' labels", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Setup" }));

    expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Equipment" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("Setup Panel")).toBeInTheDocument();
    expect(screen.queryByText("Equipment Panel")).not.toBeInTheDocument();

    // All four labels are still intact and complete after switching.
    expect(screen.getByRole("tab", { name: "Equipment" })).toHaveTextContent("Equipment");
    expect(screen.getByRole("tab", { name: "Inventory" })).toHaveTextContent("Inventory");
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveTextContent("Reports");
  });
});
