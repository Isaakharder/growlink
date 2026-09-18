import { NavLink, Outlet } from "react-router-dom";
import { MembershipProvider } from "../../contexts/MembershipContext";
import { usePermissions } from "../../hooks/usePermissions";
import { Unauthorized } from "../auth/RequirePermission";
import { OfflineBanner } from "../mobile/OfflineBanner";
import { SyncStatusBar } from "../mobile/SyncStatusBar";
import { useOfflineQueue } from "../../hooks/useOfflineQueue";
import { MAINTENANCE_ACCESS_PERMISSIONS } from "../../pages/maintenance/access";
import { MOBILE_HOME } from "../../config/platform";

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

  const nav = (
    <nav
      className="mobile-bottom-nav mobile-bottom-nav-single"
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
    </nav>
  );

  return (
    <div className="mobile-layout">
      <header className="mobile-header">
        <h1>GrowLink Mobile</h1>
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
