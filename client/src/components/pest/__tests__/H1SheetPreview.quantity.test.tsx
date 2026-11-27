// The H1 sheet says which quantity is which for jobs with tank records:
// "used" is the product mixed, and the note spells out applied and leftover
// (or that applied is not known).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { H1SheetPreview, type H1SheetLog } from "../H1SheetPreview";

const base: H1SheetLog = {
  id: "h1", sheet_group_id: "h1", operation_name: "Test Farm", current_crop: "Peppers", previous_year_crops: null,
  variety: null, production_site_information: null, production_site_area: null, date_planted: null,
  application_date: "2026-11-27", product_name: "Kontos", pcp_number: null,
  actual_quantity_used: 638, actual_quantity_unit: "ml", rate_applied_per_unit: null, label_instructions_followed: true,
  area_quantity_treated_m2: 10000, method_of_application: "Spray", row_house_zones: "Phase 1",
  earliest_allowable_harvest_date: null, phi_daa: null, applicator_name: null,
  confirmation_signature: null, confirmation_date: null, version_label: "Version 11.0"
};

describe("H1 sheet quantity", () => {
  it("labels the used quantity as mixed and shows applied and leftover", () => {
    render(<H1SheetPreview logs={[{ ...base, quantity_basis: "mix_records", quantity_applied: 609.4, quantity_note: "Mixed 638 ml in 3 tanks; applied 609.4 ml (mixed − leftover); leftover 28.6 ml." }]} />);
    expect(screen.getByTestId("h1-quantity-note").parentElement).toHaveTextContent(/^638 ml mixed/);
    expect(screen.getByTestId("h1-quantity-note")).toHaveTextContent("applied 609.4 ml (mixed − leftover); leftover 28.6 ml");
    // Rate comes from what was applied (609.4 ml over 1 ha), not what was mixed.
    expect(screen.getByText("609.4 ml/ha")).toBeInTheDocument();
  });

  it("gives no rate when the applied amount is not known", () => {
    render(<H1SheetPreview logs={[{ ...base, quantity_basis: "mix_records", quantity_applied: null, quantity_note: "Mixed 638 ml in 3 tanks; applied not known: leftover not recorded for tank #3 (at most 638 ml)." }]} />);
    expect(screen.getByTestId("h1-quantity-note")).toHaveTextContent("applied not known");
    expect(screen.queryByText(/ml\/ha/)).toBeNull();
  });

  it("leaves logs without tank records as before", () => {
    render(<H1SheetPreview logs={[base]} />);
    expect(screen.queryByText(/mixed/)).toBeNull();
    expect(screen.getByText("638 ml/ha")).toBeInTheDocument();
  });
});
