import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../KgEntriesTab", () => ({ KgEntriesTab: () => <div>Kg tab content</div> }));
vi.mock("../CasesEntryTab", () => ({ CasesEntryTab: () => <div>Cases tab content</div> }));
vi.mock("../PackHistoryTab", () => ({ PackHistoryTab: () => <div>Pack History tab content</div> }));
vi.mock("../WasteImportsTab", () => ({ WasteImportsTab: () => <div>Waste Imports tab content</div> }));
vi.mock("../ProjectedTab", () => ({ ProjectedTab: () => <div>Projected tab content</div> }));
vi.mock("../CsvTemplateBuilderTab", () => ({ CsvTemplateBuilderTab: () => <div>CSV Templates tab content</div> }));
vi.mock("../../components/LazyRoute", () => ({ LazyRoute: ({ children }: { children: React.ReactNode }) => children }));

import { YieldDataEntryPage } from "../YieldDataEntryPage";

function CurrentSearch() {
  return <output data-testid="current-search">{useLocation().search}</output>;
}

function renderAt(path = "/yield/data-entry") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/yield/data-entry" element={<><YieldDataEntryPage /><CurrentSearch /></>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("YieldDataEntryPage tabs", () => {
  it("defaults to CSV Templates and shows the requested tab order", async () => {
    renderAt();
    const tablist = await screen.findByRole("tablist", { name: "Yield data views" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "CSV Templates", "Kg Entries", "Cases Entry", "Pack History", "Waste Imports", "Projected"
    ]);
    expect(screen.getByRole("tab", { name: "CSV Templates" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("CSV Templates tab content")).toBeInTheDocument();
    expect(screen.queryByText("Weekly one-screen entry for yield by size.")).not.toBeInTheDocument();
  });

  it("honors an explicit tab query for directly linked views", () => {
    renderAt("/yield/data-entry?tab=cases");
    expect(screen.getByRole("tab", { name: "Cases Entry" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Cases tab content")).toBeInTheDocument();
  });

  it("updates the selected view when tabs are clicked", () => {
    renderAt();
    fireEvent.click(screen.getByRole("tab", { name: "Kg Entries" }));
    expect(screen.getByRole("tab", { name: "Kg Entries" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Kg tab content")).toBeInTheDocument();
    expect(screen.getByTestId("current-search")).toHaveTextContent("tab=kg");
  });
});