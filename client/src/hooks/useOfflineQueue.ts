import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueue as dbEnqueue,
  syncQueue,
  getQueueCounts,
  onQueueChange,
  clearFailed,
  type QueueItem,
  type QueueModule,
} from "../services/offlineQueue";

export type SyncStatus = "idle" | "syncing" | "error";

export type OfflineQueueHook = {
  queuePending: number;
  queueFailed: number;
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const syncingRef = useRef(false);

  async function refreshCounts() {
    try {
      const counts = await getQueueCounts();
      setQueuePending(counts.pending);
      setQueueFailed(counts.failed);
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
    syncStatus,
    enqueue,
    triggerSync,
    clearFailed: handleClearFailed,
  };
}
