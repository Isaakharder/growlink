import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../../lib/api";

// Data loading for the compact workspace pages. The last successful result
// of each page is kept for as long as the workspace is open, so switching
// pages shows it at once while it refreshes, and a failed refresh keeps it
// on screen marked as stale. Leaving the workspace drops it all (the cache
// lives in the layout), so nothing outlives the signed-in session.

export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Request failed (${status}): ${path}`);
  }
}

/** GET a JSON endpoint through apiFetch, throwing WorkspaceRequestError on a non-2xx. */
export async function getWorkspaceJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new WorkspaceRequestError(response.status, path);
  return (await response.json()) as T;
}

type CacheEntry = { data: unknown; loadedAt: number };
const WorkspaceCacheContext = createContext<Map<string, CacheEntry> | null>(null);

export function WorkspaceDataProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new Map<string, CacheEntry>());
  return <WorkspaceCacheContext.Provider value={cache}>{children}</WorkspaceCacheContext.Provider>;
}

export type WorkspaceResource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; loadedAt: number; refreshing: boolean }
  | { status: "stale"; data: T; loadedAt: number; forbidden: boolean }
  | { status: "error"; forbidden: boolean };

const isForbidden = (error: unknown) => error instanceof WorkspaceRequestError && (error.status === 401 || error.status === 403);

export function useWorkspaceResource<T>(key: string, load: () => Promise<T>) {
  const cache = useContext(WorkspaceCacheContext);
  const cached = cache?.get(key) as { data: T; loadedAt: number } | undefined;
  const [state, setState] = useState<WorkspaceResource<T>>(() =>
    cached ? { status: "ready", data: cached.data, loadedAt: cached.loadedAt, refreshing: true } : { status: "loading" }
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setState((current) =>
      current.status === "ready" || current.status === "stale"
        ? { status: "ready", data: current.data, loadedAt: current.loadedAt, refreshing: true }
        : { status: "loading" }
    );
    try {
      const data = await loadRef.current();
      if (id !== request.current) return;
      const loadedAt = Date.now();
      cache?.set(key, { data, loadedAt });
      setState({ status: "ready", data, loadedAt, refreshing: false });
    } catch (error) {
      if (id !== request.current) return;
      const forbidden = isForbidden(error);
      setState((current) =>
        current.status === "ready" ? { status: "stale", data: current.data, loadedAt: current.loadedAt, forbidden } : { status: "error", forbidden }
      );
    }
  }, [cache, key]);

  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  return { state, refresh };
}
