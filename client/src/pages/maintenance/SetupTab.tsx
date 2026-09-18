import { useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { EquipmentSetupSection } from "./EquipmentSetupSection";
import { InventoryItemsSetupSection } from "./InventoryItemsSetupSection";
import { SchedulesSetupSection } from "./SchedulesSetupSection";
import { SetupResourceSection } from "./SetupResourceSection";

type Section = "categories" | "locations" | "part-types" | "equipment" | "inventory" | "schedules" | null;

export function SetupTab() {
  const { can } = usePermissions();
  const canEdit = can("maintenance:edit");
  const [openSection, setOpenSection] = useState<Section>(null);

  function toggle(section: Exclude<Section, null>) {
    setOpenSection((current) => (current === section ? null : section));
  }

  return (
    <div className="maintenance-tab-panel">
      {!canEdit ? <p className="maintenance-readonly-note">You have view access to Setup. Ask an admin for Maintenance — Edit access to make changes.</p> : null}

      <div className="maintenance-card maintenance-setup-accordion">
        <button type="button" className="maintenance-accordion-header" onClick={() => toggle("categories")}>
          {openSection === "categories" ? "▾" : "▸"} Equipment Categories
        </button>
        {openSection === "categories" ? <SetupResourceSection resource="categories" label="Categories" canEdit={canEdit} /> : null}

        <button type="button" className="maintenance-accordion-header" onClick={() => toggle("locations")}>
          {openSection === "locations" ? "▾" : "▸"} Locations
        </button>
        {openSection === "locations" ? <SetupResourceSection resource="locations" label="Locations" canEdit={canEdit} /> : null}

        <button type="button" className="maintenance-accordion-header" onClick={() => toggle("part-types")}>
          {openSection === "part-types" ? "▾" : "▸"} Part Types
        </button>
        {openSection === "part-types" ? <SetupResourceSection resource="part-types" label="Part Types" canEdit={canEdit} /> : null}

        <button type="button" className="maintenance-accordion-header" onClick={() => toggle("equipment")}>
          {openSection === "equipment" ? "▾" : "▸"} Equipment
        </button>
        {openSection === "equipment" ? <EquipmentSetupSection canEdit={canEdit} /> : null}

        <button type="button" className="maintenance-accordion-header" onClick={() => toggle("inventory")}>
          {openSection === "inventory" ? "▾" : "▸"} Inventory Parts
        </button>
        {openSection === "inventory" ? <InventoryItemsSetupSection canEdit={canEdit} /> : null}

        <button type="button" className="maintenance-accordion-header" onClick={() => toggle("schedules")}>
          {openSection === "schedules" ? "▾" : "▸"} Maintenance Schedules
        </button>
        {openSection === "schedules" ? <SchedulesSetupSection canEdit={canEdit} /> : null}
      </div>
    </div>
  );
}
