import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { usePermissions } from "../../hooks/usePermissions";

type SidebarProps = {
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

type NavLinkItem = {
  type: "link";
  label: string;
  to: string;
  permission?: string;
};

type NavGroupChild = {
  label: string;
  to: string;
  permission?: string;
};

type NavGroupItem = {
  type: "group";
  label: string;
  base: string;
  children: NavGroupChild[];
};

type NavItem = NavLinkItem | NavGroupItem;

// permission fields control sidebar visibility only — actual page access is
// enforced by RequirePermission in routes.tsx.
const navItems: NavItem[] = [
  { type: "link", label: "Dashboard", to: "/" },
  {
    type: "group",
    label: "Yield",
    base: "/yield",
    children: [
      { label: "Data Entry", to: "/yield/data-entry", permission: "yield:view" },
      { label: "Yield Analytics", to: "/yield/analytics", permission: "yield:view" },
    ],
  },
  { type: "link", label: "Irrigation", to: "/irrigation", permission: "irrigation:view" },
  {
    type: "group",
    label: "Pest Control",
    base: "/pest-control",
    children: [
      { label: "Planner",   to: "/pest-control/planner",   permission: "pest:view" },
      { label: "Inventory", to: "/pest-control/inventory", permission: "pest:view" },
      { label: "Records",   to: "/pest-control/records",   permission: "pest:view" },
    ],
  },
  { type: "link", label: "Quality Check", to: "/quality-check", permission: "quality:view" },
  {
    type: "group",
    label: "Setup",
    base: "/setup",
    children: [
      { label: "Pest Control Setup", to: "/setup/pest-control",  permission: "pest:view" },
      { label: "Greenhouse Setup",   to: "/setup/greenhouse",    permission: "greenhouse_setup:view" },
      { label: "Irrigation Setup",   to: "/setup/irrigation",    permission: "irrigation:view" },
      { label: "Varieties Setup",    to: "/setup/varieties",     permission: "greenhouse_setup:view" },
      { label: "Settings",           to: "/setup/settings" }, // visible to everyone
    ],
  },
];

export function Sidebar({ mobileOpen, onCloseMobile }: SidebarProps) {
  const location = useLocation();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const { can } = usePermissions();

  // All groups (used to initialise expandedGroups — runs over full navItems, not
  // filtered, so expansion state is preserved even for temporarily-hidden groups).
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

  // Recompute whenever can() changes (i.e. when membership finishes loading).
  // During loading can() returns true for everything, so all items are visible
  // briefly — no layout jump for owners/admins, and restricted items disappear
  // smoothly once membership resolves.
  const visibleNavItems = useMemo(() => {
    return navItems.flatMap<NavItem>((item) => {
      if (item.type === "link") {
        if (item.permission && !can(item.permission)) return [];
        return [item];
      }
      // Group: filter children; hide the whole group if none remain visible.
      const visibleChildren = item.children.filter(
        (child) => !child.permission || can(child.permission)
      );
      if (visibleChildren.length === 0) return [];
      return [{ ...item, children: visibleChildren }];
    });
  }, [can]);

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
          {visibleNavItems.map((item) => {
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
                      [item.label]: !isExpanded,
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
