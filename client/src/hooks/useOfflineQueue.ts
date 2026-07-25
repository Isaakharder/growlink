import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueue as dbEnqueue,
  syncQueue,
  getQueueCounts,
  getVisibleItems,
  onQueueChange,
  clearFailed,
  type QueueItem,
  type QueueModule,
} from "../services/offlineQueue";

export type SyncStatus = "idle" | "syncing" | "error";

export type OfflineQueueHook = {
  queuePending: number;
  queueFailed: number;
  // Distinct failure reasons currently reported by failed queue items (e.g.
  // "A report already exists for this location and date."), so the sync
  // status bar can show the user WHY a change couldn't sync instead of just
  // a bare count -- see SyncStatusBar.tsx.
  failureReasons: string[];
  syncStatus: SyncStatus;
  enqueue: (item: {
    module: QueueModule;
    url: string;
    method: string;
    body: string;
  }) => Promise<QueueItem>;
  triggerSync: () => Promise<void>;
  clearFailed: () => Promise<void>;
};

export function useOfflineQueue(): OfflineQueueHook {
  const [queuePending, setQueuePending] = useState(0);
  const [queueFailed, setQueueFailed] = useState(0);
  const [failureReasons, setFailureReasons] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const syncingRef = useRef(false);

  async function refreshCounts() {
    try {
      const counts = await getQueueCounts();
      setQueuePending(counts.pending);
      setQueueFailed(counts.failed);

      if (counts.failed > 0) {
        const items = await getVisibleItems();
        const reasons = Array.from(
          new Set(items.filter((i) => i.status === "failed" && i.failureReason).map((i) => i.failureReason as string))
        );
        setFailureReasons(reasons);
      } else {
        setFailureReasons([]);
      }
    } catch {
      // IDB unavailable in some private browsing modes — ignore
    }
  }

  const triggerSync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setSyncStatus("syncing");
    try {
      await syncQueue();
      await refreshCounts();
      setSyncStatus("idle");
    } catch {
      setSyncStatus("error");
    } finally {
      syncingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshCounts();

    // Sync immediately if we're already online at mount time
    if (navigator.onLine) void triggerSync();

    const handleOnline = () => void triggerSync();
    window.addEventListener("online", handleOnline);

    // Refresh counts whenever the queue changes (enqueues from any page)
    const unsubscribe = onQueueChange(() => void refreshCounts());

    return () => {
      window.removeEventListener("online", handleOnline);
      unsubscribe();
    };
  }, [triggerSync]);

  const enqueue = useCallback(
    async (item: { module: QueueModule; url: string; method: string; body: string }) => {
      const queued = await dbEnqueue(item);
      // refreshCounts is driven by the onQueueChange event fired inside enqueue
      return queued;
    },
    []
  );

  const handleClearFailed = useCallback(async () => {
    await clearFailed();
  }, []);

  return {
    queuePending,
    queueFailed,
    failureReasons,
    syncStatus,
    enqueue,
    triggerSync,
    clearFailed: handleClearFailed,
  };
}
