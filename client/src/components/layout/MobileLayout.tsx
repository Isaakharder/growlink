import { Link, NavLink, Outlet } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { MembershipProvider } from "../../contexts/MembershipContext";
import { usePermissions } from "../../hooks/usePermissions";
import { Unauthorized } from "../auth/RequirePermission";
import { OfflineBanner } from "../mobile/OfflineBanner";
import { SyncStatusBar } from "../mobile/SyncStatusBar";
import { useOfflineQueue } from "../../hooks/useOfflineQueue";
import { MAINTENANCE_ACCESS_PERMISSIONS } from "../../pages/maintenance/access";
import { DESKTOP_HOME, MOBILE_HOME } from "../../config/platform";
import { isNativeIos } from "../../native/platformIos";

const MOBILE_PERMISSIONS = [
  "mobile:access",
  "mobile:daily_yield",
  "mobile:irrigation",
  "mobile:pest",
  "mobile:quality",
  "mobile:food_safety",
  // Desktop irrigation permissions also grant entry to the mobile shell —
  // a user with only irrigation:view/edit (no mobile:* keys at all) must
  // still be able to reach /mobile/irrigation-log if they navigate there
  // directly; the per-route RequirePermission guard handles the specifics.
  "irrigation:view",
  "irrigation:edit",
  // Maintenance has no desktop page at all in v1, so its keys only ever
  // grant mobile entry — sourced from the same constant the Maintenance
  // route guards and Mobile Home card use, so this list can't silently
  // drift out of sync with who can actually reach /mobile/maintenance.
  ...MAINTENANCE_ACCESS_PERMISSIONS
];

function MobileLayoutInner() {
  const { loading, canAny } = usePermissions();
  const { queuePending, queueFailed, failureReasons, syncStatus, clearFailed } = useOfflineQueue();
  // The iOS/Android apps have no desktop: there the button isn't rendered at
  // all and the bar keeps its single-button layout.
  const showDesktop = !Capacitor.isNativePlatform();
  // The native iOS app instead gets the in-app compact workspace, opened
  // from the header (an in-app route, never Safari).
  const showWorkspace = isNativeIos();

  const nav = (
    <nav
      className={`mobile-bottom-nav ${showDesktop ? "mobile-bottom-nav-pair" : "mobile-bottom-nav-single"}`}
      aria-label="Mobile navigation"
    >
      <NavLink
        to={MOBILE_HOME}
        end
        className={({ isActive }) =>
          `mobile-bottom-link ${isActive ? "active" : ""}`
        }
      >
        Home
      </NavLink>
      {showDesktop ? (
        // A full document navigation, not React Router: the server then serves
        // index.html with the desktop shell and manifest. Same origin, so the
        // Supabase session in localStorage (and the membership-derived
        // organization) carries over; no target, so it stays in this tab.
        <a href={DESKTOP_HOME} className="mobile-bottom-link mobile-bottom-link-desktop" aria-label="Open GrowLink Desktop">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M7 17h6M10 13.5V17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Desktop
        </a>
      ) : null}
    </nav>
  );

  return (
    <div className="mobile-layout">
      <header className={`mobile-header${showWorkspace ? " mobile-header-with-action" : ""}`}>
        <h1>GrowLink Mobile</h1>
        {showWorkspace ? (
          <Link to="/workspace" className="mobile-header-workspace" aria-label="Open Desktop workspace">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
              <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 17h6M10 13.5V17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Desktop
          </Link>
        ) : null}
      </header>

      <main className="mobile-content">
        <OfflineBanner />
        <SyncStatusBar
          queuePending={queuePending}
          queueFailed={queueFailed}
          failureReasons={failureReasons}
          syncStatus={syncStatus}
          onClearFailed={() => void clearFailed()}
        />
        {/* Show nothing while loading (avoids flash of restricted content).
            Deny access unless the user has mobile:access or any mobile feature permission. */}
        {!loading && !canAny(MOBILE_PERMISSIONS) ? <Unauthorized /> : loading ? null : <Outlet />}
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
