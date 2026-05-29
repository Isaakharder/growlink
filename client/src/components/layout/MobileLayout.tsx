import { NavLink, Outlet } from "react-router-dom";
import { MembershipProvider } from "../../contexts/MembershipContext";
import { usePermissions } from "../../hooks/usePermissions";
import { Unauthorized } from "../auth/RequirePermission";

function MobileLayoutInner() {
  const { loading, can } = usePermissions();

  const nav = (
    <nav
      className="mobile-bottom-nav mobile-bottom-nav-single"
      aria-label="Mobile navigation"
    >
      <NavLink
        to="/mobile"
        end
        className={({ isActive }) =>
          `mobile-bottom-link ${isActive ? "active" : ""}`
        }
      >
        Home
      </NavLink>
    </nav>
  );

  return (
    <div className="mobile-layout">
      <header className="mobile-header">
        <h1>GrowLink Mobile</h1>
      </header>

      <main className="mobile-content">
        {/* Show nothing while loading (avoids flash of restricted content).
            Deny mobile:access before rendering any child route. */}
        {!loading && !can("mobile:access") ? <Unauthorized /> : loading ? null : <Outlet />}
      </main>

      {nav}
    </div>
  );
}

export function MobileLayout() {
  return (
    <MembershipProvider>
      <MobileLayoutInner />
    </MembershipProvider>
  );
}
