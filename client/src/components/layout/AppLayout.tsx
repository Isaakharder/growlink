import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

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
        </header>

        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
