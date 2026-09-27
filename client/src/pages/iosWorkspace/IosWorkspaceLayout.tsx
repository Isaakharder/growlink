import { useEffect, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { MembershipProvider } from "../../contexts/MembershipContext";
import { usePermissions } from "../../hooks/usePermissions";
import { MOBILE_HOME } from "../../config/platform";
import { isNativeIos } from "../../native/platformIos";
import { WorkspaceDataProvider } from "./workspaceData";
import { rememberWorkspacePath, WORKSPACE_SECTIONS, type WorkspaceSectionId } from "./workspaceNav";

// The compact management workspace of the native iOS app: a left icon rail
// and one page at a time, sized for a phone. Registered only in the native
// router (router/nativeRoutes.tsx), and it redirects to Mobile Home anywhere
// but native iOS, so the web app, the mobile website / PWA and Android never
// show it.

const ICONS: Record<WorkspaceSectionId, ReactNode> = {
  overview: <path d="M3.5 3.5h5.5v5.5H3.5zM11 3.5h5.5v5.5H11zM3.5 11h5.5v5.5H3.5zM11 11h5.5v5.5H11z" />,
  "yield-by-color": (
    <>
      <path d="M10 3a7 7 0 1 0 7 7h-7z" />
      <path d="M12.5 1.5A6.5 6.5 0 0 1 18.5 7.5h-6z" />
    </>
  ),
  yield: <path d="M3.5 16.5h13M5.5 13.5v-4M10 13.5V5M14.5 13.5V8" />,
  cases: (
    <>
      <path d="M3 7l7-3.5L17 7v7.5L10 18l-7-3.5z" />
      <path d="M3 7l7 3.5L17 7M10 10.5V18" />
    </>
  ),
  "csv-imports": (
    <>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M10 9v6M7.5 12.5 10 15l2.5-2.5" />
    </>
  )
};

function RailIcon({ id }: { id: WorkspaceSectionId }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[id]}
    </svg>
  );
}

function IosWorkspaceInner() {
  const { pathname } = useLocation();
  const { loading, can } = usePermissions();

  useEffect(() => rememberWorkspacePath(pathname), [pathname]);

  const sections = WORKSPACE_SECTIONS.filter((s) => !s.permission || can(s.permission));

  return (
    <div className="iosws">
      <nav className="iosws-rail" aria-label="Workspace pages">
        <Link to={MOBILE_HOME} className="iosws-rail-link iosws-rail-mobile" aria-label="Return to GrowLink Mobile">
          <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="2.5" width="8" height="15" rx="1.8" />
            <path d="M9 15h2" />
          </svg>
          <span className="iosws-rail-caption" aria-hidden="true">Mobile</span>
        </Link>
        <ul className="iosws-rail-list">
          {loading
            ? null
            : sections.map((s) => (
                <li key={s.id}>
                  {/* NavLink sets aria-current="page" on the selected page. */}
                  <NavLink to={s.path} className="iosws-rail-link" aria-label={s.label} title={s.label}>
                    <RailIcon id={s.id} />
                  </NavLink>
                </li>
              ))}
        </ul>
      </nav>
      <main className="iosws-main">{loading ? null : <Outlet />}</main>
    </div>
  );
}

export default function IosWorkspaceLayout() {
  if (!isNativeIos()) return <Navigate to={MOBILE_HOME} replace />;
  return (
    <MembershipProvider>
      <WorkspaceDataProvider>
        <IosWorkspaceInner />
      </WorkspaceDataProvider>
    </MembershipProvider>
  );
}
