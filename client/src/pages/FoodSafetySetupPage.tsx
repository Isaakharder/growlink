import { useState } from "react";
import { LogsBackfillTab } from "./foodSafetySetup/LogsBackfillTab";

type TabType = "logsBackfill" | "logsAutoFill";

export function FoodSafetySetupPage() {
  const [activeTab, setActiveTab] = useState<TabType>("logsBackfill");

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety Setup</h1>
      </header>

      <div className="tab-navigation">
        <button
          type="button"
          className={`tab-button${activeTab === "logsBackfill" ? " active" : ""}`}
          onClick={() => setActiveTab("logsBackfill")}
        >
          Logs Backfill
        </button>
        <button
          type="button"
          className={`tab-button${activeTab === "logsAutoFill" ? " active" : ""}`}
          onClick={() => setActiveTab("logsAutoFill")}
        >
          Logs Auto Fill
        </button>
      </div>

      {activeTab === "logsBackfill" ? (
        <div className="tab-content">
          <LogsBackfillTab />
        </div>
      ) : null}

      {activeTab === "logsAutoFill" ? <div className="tab-content" /> : null}
    </section>
  );
}
