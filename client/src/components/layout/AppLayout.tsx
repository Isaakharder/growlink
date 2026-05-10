import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { getOrganizationName } from "../../lib/api";

export function AppLayout() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [orgName, setOrgName] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getOrganizationName().then(setOrgName);
  }, []);

  return (
    <div className="app-container">
      <Sidebar
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      <div className="content-shell">
        <header className="topbar">
          <button
            className="mobile-menu-button"
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Open navigation"
          >
            Menu
          </button>
          <div>
            <p className="eyebrow">Greenhouse Operations</p>
            <h1 className="topbar-title">GrowLink</h1>
          </div>
          <div className="topbar-org" aria-label="Current organization">
            <svg
              className="topbar-org-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 22V12h6v10" />
              <rect x="8" y="7" width="2" height="2" />
              <rect x="14" y="7" width="2" height="2" />
            </svg>
            <span>
              {orgName === undefined
                ? "Loading organization..."
                : orgName ?? "—"}
            </span>
          </div>
        </header>

        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
