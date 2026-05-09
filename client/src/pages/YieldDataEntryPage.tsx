import { useState } from "react";
import { KgEntriesTab } from "./KgEntriesTab";
import { CasesEntryTab } from "./CasesEntryTab";

type TabType = "kg" | "cases";

export function YieldDataEntryPage() {
  const [activeTab, setActiveTab] = useState<TabType>("kg");

  return (
    <section className="page-shell">
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
    </section>
  );
}
