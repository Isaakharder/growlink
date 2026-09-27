// The compact iOS management workspace's sections, in rail order.
export type WorkspaceSectionId = "overview" | "yield-by-color" | "yield" | "cases" | "csv-imports";

export type WorkspaceSection = {
  id: WorkspaceSectionId;
  path: string;
  label: string;
  /**
   * The same client-side gate as the desktop page each section condenses:
   * the Dashboard (Overview, Yield by Color) is open to every member, and
   * Yield Data Entry (kg, cases, CSV templates) requires yield:view. Each
   * action is still checked by the server's own requirePermission.
   */
  permission?: string;
};

export const WORKSPACE_BASE = "/workspace";

export const WORKSPACE_SECTIONS: WorkspaceSection[] = [
  { id: "overview", path: `${WORKSPACE_BASE}/overview`, label: "Overview" },
  { id: "yield-by-color", path: `${WORKSPACE_BASE}/yield-by-color`, label: "Yield by Color" },
  { id: "yield", path: `${WORKSPACE_BASE}/yield`, label: "Yield", permission: "yield:view" },
  { id: "cases", path: `${WORKSPACE_BASE}/cases`, label: "Cases", permission: "yield:view" },
  { id: "csv-imports", path: `${WORKSPACE_BASE}/csv-imports`, label: "CSV Imports", permission: "yield:view" }
];

// The last compact page, remembered in memory only: navigating away to the
// Mobile workspace and back returns to it, while a fresh app launch starts
// over (the app itself always opens on the Mobile workspace).
let lastSectionPath = WORKSPACE_SECTIONS[0].path;

export function rememberWorkspacePath(pathname: string): void {
  if (WORKSPACE_SECTIONS.some((s) => s.path === pathname)) lastSectionPath = pathname;
}

export function lastWorkspacePath(): string {
  return lastSectionPath;
}

/** Test hook: a fresh launch. */
export function resetWorkspaceMemory(): void {
  lastSectionPath = WORKSPACE_SECTIONS[0].path;
}
