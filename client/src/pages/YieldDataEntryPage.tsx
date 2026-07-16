import { useState } from "react";
import { KgEntriesTab } from "./KgEntriesTab";
import { CasesEntryTab } from "./CasesEntryTab";
import { PackHistoryTab } from "./PackHistoryTab";
import { WasteImportsTab } from "./WasteImportsTab";
import { ProjectedTab } from "./ProjectedTab";

type TabType = "kg" | "cases" | "packHistory" | "waste" | "projected";

export function YieldDataEntryPage() {
  const [activeTab, setActiveTab] = useState<TabType>("kg");

  return (
    <section className="page-shell yield-data-entry-page">
      <header>
        <h1>Yield Data Entry</h1>
        <p>Weekly one-screen entry for yield by size.</p>
      </header>

      <div className="tab-navigation">
        <button
          className={`tab-button ${activeTab === "kg" ? "active" : ""}`}
          onClick={() => setActiveTab("kg")}
        >
          Kg Entries
        </button>
        <button
          className={`tab-button ${activeTab === "cases" ? "active" : ""}`}
          onClick={() => setActiveTab("cases")}
        >
          Cases Entry
        </button>
        <button
          className={`tab-button ${activeTab === "packHistory" ? "active" : ""}`}
          onClick={() => setActiveTab("packHistory")}
        >
          Pack History
        </button>
        <button
          className={`tab-button ${activeTab === "waste" ? "active" : ""}`}
          onClick={() => setActiveTab("waste")}
        >
          Waste Imports
        </button>
        <button
          className={`tab-button ${activeTab === "projected" ? "active" : ""}`}
          onClick={() => setActiveTab("projected")}
        >
          Projected
        </button>
      </div>

      {activeTab === "kg" ? (
        <div className="tab-content">
          <KgEntriesTab />
        </div>
      ) : null}

      {activeTab === "cases" ? (
        <div className="tab-content">
          <CasesEntryTab />
        </div>
      ) : null}

      {activeTab === "packHistory" ? (
        <div className="tab-content">
          <PackHistoryTab />
        </div>
      ) : null}

      {activeTab === "waste" ? (
        <div className="tab-content">
          <WasteImportsTab />
        </div>
      ) : null}

      {activeTab === "projected" ? (
        <div className="tab-content">
          <ProjectedTab />
        </div>
      ) : null}
    </section>
  );
}
