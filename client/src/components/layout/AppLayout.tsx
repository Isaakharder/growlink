import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { getOrganizationName } from "../../lib/api";
import { MembershipProvider, useMembership } from "../../contexts/MembershipContext";

// Inner component: can safely call useMembership() because MembershipProvider
// is its ancestor (rendered by the exported AppLayout below).
function AppLayoutInner() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [orgName, setOrgName] = useState<string | null | undefined>(undefined);
  const { displayName, position } = useMembership();

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

          {/* Right side: user info + org — wrapper takes the margin-left:auto
              so both elements sit flush together on the right edge. */}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            {displayName && (
              <div style={{ textAlign: "right", lineHeight: 1.35 }}>
                <div
                  style={{
                    fontSize: "0.83rem",
                    fontWeight: 600,
                    color: "var(--text)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {displayName}
                </div>
                {position && (
                  <div
                    style={{
                      fontSize: "0.73rem",
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {position}
                  </div>
                )}
              </div>
            )}

            {/* topbar-org is unchanged visually; override its margin-left:auto
                since the wrapper div already handles that. */}
            <div
              className="topbar-org"
              aria-label="Current organization"
              style={{ marginLeft: 0 }}
            >
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
          </div>
        </header>

        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function AppLayout() {
  return (
    <MembershipProvider>
      <AppLayoutInner />
    </MembershipProvider>
  );
}
