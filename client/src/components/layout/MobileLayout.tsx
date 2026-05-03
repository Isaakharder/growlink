import { NavLink, Outlet } from "react-router-dom";

export function MobileLayout() {
  return (
    <div className="mobile-layout">
      <header className="mobile-header">
        <h1>GrowLink Mobile</h1>
      </header>

      <main className="mobile-content">
        <Outlet />
      </main>

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <NavLink
          to="/mobile"
          end
          className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
        >
          Home
        </NavLink>
        <NavLink
          to="/mobile/daily-yield"
          className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
        >
          Daily Yield
        </NavLink>
      </nav>
    </div>
  );
}
