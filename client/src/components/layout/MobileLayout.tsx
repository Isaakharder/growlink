import { NavLink, Outlet, useLocation } from "react-router-dom";

export function MobileLayout() {
  const location = useLocation();
  const isIrrigationLogPage = location.pathname === "/mobile/irrigation-log";

  return (
    <div className="mobile-layout">
      <header className="mobile-header">
        <h1>GrowLink Mobile</h1>
      </header>

      <main className="mobile-content">
        <Outlet />
      </main>

      <nav
        className={`mobile-bottom-nav ${isIrrigationLogPage ? "mobile-bottom-nav-single" : ""}`}
        aria-label="Mobile navigation"
      >
        <NavLink
          to="/mobile"
          end
          className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
        >
          Home
        </NavLink>

        {!isIrrigationLogPage ? (
          <>
            <NavLink
              to="/mobile/daily-yield"
              className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
            >
              Daily Yield
            </NavLink>
            <NavLink
              to="/mobile/irrigation-log"
              className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
            >
              Irrigation
            </NavLink>
          </>
        ) : null}
      </nav>
    </div>
  );
}
