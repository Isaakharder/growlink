import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { supabase } from "../../lib/supabase";

type SidebarProps = {
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

type NavLinkItem = {
  type: "link";
  label: string;
  to: string;
};

type NavGroupItem = {
  type: "group";
  label: string;
  base: string;
  children: Array<{ label: string; to: string }>;
};

type NavItem = NavLinkItem | NavGroupItem;

const navItems: NavItem[] = [
  { type: "link", label: "Dashboard", to: "/" },
  {
    type: "group",
    label: "Yield",
    base: "/yield",
    children: [
      { label: "Data Entry", to: "/yield/data-entry" },
      { label: "Yield Analytics", to: "/yield/analytics" }
    ]
  },
  { type: "link", label: "Irrigation", to: "/irrigation" },
  {
    type: "group",
    label: "Pest Control",
    base: "/pest-control",
    children: [
      { label: "Planner", to: "/pest-control/planner" },
      { label: "Inventory", to: "/pest-control/inventory" },
      { label: "Records", to: "/pest-control/records" }
    ]
  },
  { type: "link", label: "Quality Check", to: "/quality-check" },
  {
    type: "group",
    label: "Setup",
    base: "/setup",
    children: [
      { label: "Pest Control Setup", to: "/setup/pest-control" },
      { label: "Greenhouse Setup", to: "/setup/greenhouse" },
      { label: "Irrigation Setup", to: "/setup/irrigation" },
      { label: "Varieties Setup", to: "/setup/varieties" },
      { label: "Settings", to: "/setup/settings" }
    ]
  }
];

export function Sidebar({ mobileOpen, onCloseMobile }: SidebarProps) {
  const location = useLocation();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const groups = useMemo(
    () => navItems.filter((item): item is NavGroupItem => item.type === "group"),
    []
  );

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    () => {
      const defaults: Record<string, boolean> = {};
      for (const group of groups) {
        defaults[group.label] = location.pathname.startsWith(group.base);
      }
      return defaults;
    }
  );

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const group of groups) {
        if (location.pathname.startsWith(group.base)) {
          next[group.label] = true;
        }
      }
      return next;
    });
  }, [groups, location.pathname]);

  async function handleLogout() {
    setIsLoggingOut(true);
    await supabase.auth.signOut();
    setIsLoggingOut(false);
    onCloseMobile();
  }

  return (
    <>
      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            GL
          </span>
          <div>
            <p className="brand-name">GrowLink</p>
            <p className="brand-subtitle">Farm Data Platform</p>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {navItems.map((item) => {
            if (item.type === "link") {
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  onClick={onCloseMobile}
                  className={({ isActive }) =>
                    `nav-link ${isActive ? "active" : ""}`
                  }
                >
                  {item.label}
                </NavLink>
              );
            }

            const isGroupActive = location.pathname.startsWith(item.base);
            const isExpanded = expandedGroups[item.label] ?? false;

            return (
              <div key={item.label} className="nav-group">
                <button
                  type="button"
                  className={`nav-group-trigger ${isGroupActive ? "active" : ""}`}
                  onClick={() =>
                    setExpandedGroups((prev) => ({
                      ...prev,
                      [item.label]: !isExpanded
                    }))
                  }
                  aria-expanded={isExpanded}
                >
                  <span>{item.label}</span>
                  <span className={`arrow ${isExpanded ? "expanded" : ""}`}>
                    &gt;
                  </span>
                </button>

                {isExpanded && (
                  <div className="nav-submenu">
                    {item.children.map((child) => (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        onClick={onCloseMobile}
                        className={({ isActive }) =>
                          `nav-sublink ${isActive ? "active" : ""}`
                        }
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-logout"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? "Logging out..." : "Log out"}
          </button>
        </div>
      </aside>

      <button
        type="button"
        className={`sidebar-backdrop ${mobileOpen ? "visible" : ""}`}
        aria-hidden={!mobileOpen}
        onClick={onCloseMobile}
      />
    </>
  );
}
