import { useSearchParams } from "react-router-dom";
import { EquipmentTab } from "./maintenance/EquipmentTab";
import { InventoryTab } from "./maintenance/InventoryTab";
import { ReportsTab } from "./maintenance/ReportsTab";
import { SetupTab } from "./maintenance/SetupTab";

const TABS = [
  { key: "equipment", label: "Equipment" },
  { key: "inventory", label: "Inventory" },
  { key: "reports", label: "Reports" },
  { key: "setup", label: "Setup" }
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTabKey(value: string | null): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

export function MobileMaintenancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: TabKey = isTabKey(searchParams.get("tab")) ? (searchParams.get("tab") as TabKey) : "equipment";

  function selectTab(tab: TabKey) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("tab", tab);
      return next;
    }, { replace: true });
  }

  return (
    <section className="mobile-page maintenance-page">
      <h2>Maintenance</h2>

      <div className="maintenance-tab-bar" role="tablist" aria-label="Maintenance sections">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`maintenance-tab-button ${activeTab === tab.key ? "active" : ""}`}
            onClick={() => selectTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "equipment" ? <EquipmentTab /> : null}
      {activeTab === "inventory" ? <InventoryTab /> : null}
      {activeTab === "reports" ? <ReportsTab /> : null}
      {activeTab === "setup" ? <SetupTab /> : null}
    </section>
  );
}
