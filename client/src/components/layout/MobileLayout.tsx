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

      <nav className="mobile-bottom-nav mobile-bottom-nav-single" aria-label="Mobile navigation">
        <NavLink
          to="/mobile"
          end
          className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
        >
          Home
        </NavLink>
      </nav>
    </div>
  );
}
