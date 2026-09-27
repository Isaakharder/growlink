import { lazy, type ReactElement } from "react";
import { Navigate } from "react-router-dom";
import { LazyRoute } from "../../components/LazyRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";
import { lastWorkspacePath, WORKSPACE_SECTIONS, type WorkspaceSectionId } from "./workspaceNav";

// Lazy-loaded: none of the workspace's code is in the native app's startup
// chunk; it loads the first time the Desktop button is tapped.
const IosWorkspaceLayout = lazy(() => import("./IosWorkspaceLayout"));
const WorkspacePlaceholderPage = lazy(() => import("./WorkspacePlaceholderPage"));
const OverviewPage = lazy(() => import("./OverviewPage"));
const YieldByColorPage = lazy(() => import("./YieldByColorPage"));

// Built pages; the rest are still placeholders.
const PAGES: Partial<Record<WorkspaceSectionId, () => ReactElement>> = {
  overview: () => <OverviewPage />,
  "yield-by-color": () => <YieldByColorPage />
};

function ReturnToLastPage() {
  return <Navigate to={lastWorkspacePath()} replace />;
}

// Mounted at "workspace" (i.e. "/workspace") inside the native router's
// RequireAuth tree only.
export const workspaceRoute = {
  path: "workspace",
  element: (
    <LazyRoute>
      <IosWorkspaceLayout />
    </LazyRoute>
  ),
  children: [
    { index: true, element: <ReturnToLastPage /> },
    ...WORKSPACE_SECTIONS.map((s) => {
      const page = (
        <LazyRoute>{PAGES[s.id]?.() ?? <WorkspacePlaceholderPage section={s.id} />}</LazyRoute>
      );
      return {
        path: s.path.slice("/workspace/".length),
        element: s.permission ? <RequirePermission permission={s.permission}>{page}</RequirePermission> : page
      };
    }),
    { path: "*", element: <ReturnToLastPage /> }
  ]
};
