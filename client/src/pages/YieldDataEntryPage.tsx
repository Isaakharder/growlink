import { lazy, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { KgEntriesTab } from "./KgEntriesTab";
import { CasesEntryTab } from "./CasesEntryTab";
import { PackHistoryTab } from "./PackHistoryTab";
import { WasteImportsTab } from "./WasteImportsTab";
import { ProjectedTab } from "./ProjectedTab";
import { LazyRoute } from "../components/LazyRoute";

// The CSV Template Builder is a large, admin-oriented tool only opened from
// its own tab — lazy-loaded (same pattern as routes.tsx's Maintenance
// pages) so its code stays out of the bundle every user downloads, which
// was within a few KB of the PWA's 2 MiB precache limit.
const CsvTemplateBuilderTab = lazy(() =>
  import("./CsvTemplateBuilderTab").then((m) => ({ default: m.CsvTemplateBuilderTab }))
);

type TabType = "kg" | "cases" | "packHistory" | "waste" | "projected" | "csvTemplates";

const TABS: Array<{ id: TabType; label: string }> = [
  { id: "csvTemplates", label: "CSV Templates" },
  { id: "kg", label: "Kg Entries" },
  { id: "cases", label: "Cases Entry" },
  { id: "packHistory", label: "Pack History" },
  { id: "waste", label: "Waste Imports" },
  { id: "projected", label: "Projected" }
];

function isTabType(value: string | null): value is TabType {
  return TABS.some((tab) => tab.id === value);
}

export function YieldDataEntryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const requestedTab = searchParams.get("tab");
  const activeTab: TabType = isTabType(requestedTab) ? requestedTab : "csvTemplates";

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  function selectTab(tab: TabType) {
    setSearchParams((current) => {
      current.set("tab", tab);
      return current;
    });
  }

  return (
    <section className="page-shell yield-data-entry-page">
      <header className="yield-data-entry-heading">
        <h1>Yield Data Entry</h1>
      </header>

      <div className="tab-navigation yield-data-entry-tabs" role="tablist" aria-label="Yield data views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`yield-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls="yield-tab-panel"
            className={`tab-button${activeTab === tab.id ? " active" : ""}`}
            ref={activeTab === tab.id ? activeTabRef : undefined}
            onClick={() => selectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="tab-content yield-data-entry-panel" id="yield-tab-panel" role="tabpanel" aria-labelledby={`yield-tab-${activeTab}`}>
        {activeTab === "kg" ? <div className="yield-data-entry-tab yield-data-entry-tab-kg"><KgEntriesTab /></div> : null}
        {activeTab === "cases" ? <div className="yield-data-entry-tab yield-data-entry-tab-cases"><CasesEntryTab /></div> : null}
        {activeTab === "packHistory" ? <div className="yield-data-entry-tab yield-data-entry-tab-pack-history"><PackHistoryTab /></div> : null}
        {activeTab === "waste" ? <div className="yield-data-entry-tab yield-data-entry-tab-waste"><WasteImportsTab /></div> : null}
        {activeTab === "projected" ? <div className="yield-data-entry-tab yield-data-entry-tab-projected"><ProjectedTab /></div> : null}
        {activeTab === "csvTemplates" ? (
          <div className="yield-data-entry-tab yield-data-entry-tab-csvTemplates">
            <LazyRoute>
              <CsvTemplateBuilderTab />
            </LazyRoute>
          </div>
        ) : null}
      </div>
    </section>
  );
}
