import { lazy } from "react";
import { Navigate } from "react-router-dom";
import { LazyRoute } from "../../components/LazyRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";
import { lastWorkspacePath, WORKSPACE_SECTIONS } from "./workspaceNav";

// Lazy-loaded: none of the workspace's code is in the native app's startup
// chunk; it loads the first time the Desktop button is tapped.
const IosWorkspaceLayout = lazy(() => import("./IosWorkspaceLayout"));
const WorkspacePlaceholderPage = lazy(() => import("./WorkspacePlaceholderPage"));

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
        <LazyRoute>
          <WorkspacePlaceholderPage section={s.id} />
        </LazyRoute>
      );
      return {
        path: s.path.slice("/workspace/".length),
        element: s.permission ? <RequirePermission permission={s.permission}>{page}</RequirePermission> : page
      };
    }),
    { path: "*", element: <ReturnToLastPage /> }
  ]
};
