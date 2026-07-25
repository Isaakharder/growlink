import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";

const DB_NAME = "growlink_offline";
const DB_VERSION = 1;
const STORE = "queue";

export type QueueModule = "daily_yield" | "irrigation" | "pest" | "quality" | "food_safety";

export type QueueItem = {
  id: string;
  createdAt: string;
  module: QueueModule;
  url: string;
  method: string;
  body: string;
  status: "pending" | "failed";
  failureReason?: string;
  attempts: number;
  // Who was actually signed in when this action was queued -- captured so a
  // later sync can refuse to submit it under a DIFFERENT identity. Two
  // workers can share one device; without this, an action queued by Worker A
  // could be silently synced under Worker B's session the next time the app
  // comes online after B logs in. Optional only so old queue rows written
  // before this field existed don't hard-fail to read -- see
  // belongsToIdentity below.
  ownerUserId?: string;
};

// Dispatched whenever the queue changes so subscribers can refresh counts.
const QUEUE_CHANGE_EVENT = "growlink:queue-change";

function notifyChange() {
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGE_EVENT));
}

export function onQueueChange(handler: () => void): () => void {
  window.addEventListener(QUEUE_CHANGE_EVENT, handler);
  return () => window.removeEventListener(QUEUE_CHANGE_EVENT, handler);
}

// ── Identity ─────────────────────────────────────────────────────────────────

// Deliberately reads the LOCAL session (no network round-trip), the same
// way apiFetch() resolves its auth header — unlike supabase.auth.getUser(),
// which revalidates against the server and therefore fails while offline.
// Identity tagging has to work precisely while offline, since that's the
// only time an item sits in the queue at all.
async function getCurrentUserId(): Promise<string | null> {
  const {
    data: { session }
  } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

// Old queue rows written before ownerUserId existed have it unset --
// treated as belonging to whoever is currently signed in (the same
// device/session that queued them, before this fix shipped), not silently
// hidden or blocked.
function belongsToCurrentUser(item: QueueItem, currentUserId: string | null): boolean {
  if (!item.ownerUserId) return true;
  return item.ownerUserId === currentUserId;
}

// ── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function enqueue(
  item: Pick<QueueItem, "module" | "url" | "method" | "body">
): Promise<QueueItem> {
  const userId = await getCurrentUserId();
  const db = await openDB();
  const full: QueueItem = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    ownerUserId: userId ?? undefined,
    ...item,
  };
  await tx(db, "readwrite", (store) => store.add(full));
  notifyChange();
  return full;
}

// Every item in IndexedDB, regardless of who queued it -- for diagnostics
// only. UI-facing code should use getVisibleItems()/getQueueCounts() instead
// so a shared device never shows or counts another identity's queue.
export async function getAllItems(): Promise<QueueItem[]> {
  const db = await openDB();
  const items = await tx<QueueItem[]>(db, "readonly", (store) => store.getAll());
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Items belonging to whoever is currently signed in -- what the UI (badges,
// counts, failure messages) should always read from.
export async function getVisibleItems(): Promise<QueueItem[]> {
  const userId = await getCurrentUserId();
  const items = await getAllItems();
  return items.filter((item) => belongsToCurrentUser(item, userId));
}

export async function getQueueCounts(): Promise<{ pending: number; failed: number }> {
  const items = await getVisibleItems();
  return {
    pending: items.filter((i) => i.status === "pending").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}

// HTTP status codes that indicate a permanent failure — no point retrying.
const PERMANENT_FAILURE_CODES = new Set([400, 403, 404, 409, 422]);

export async function syncQueue(): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  const userId = await getCurrentUserId();
  const db = await openDB();
  const all = await tx<QueueItem[]>(db, "readonly", (store) => store.getAll());
  const pending = all
    .filter((i) => i.status === "pending")
    // Never submit another user's queued action under the current session --
    // it stays untouched in IndexedDB until that original user is signed in
    // again on this device.
    .filter((i) => belongsToCurrentUser(i, userId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const item of pending) {
    try {
      const res = await apiFetch(item.url, {
        method: item.method,
        body: item.body,
      });

      if (res.ok) {
        await tx(db, "readwrite", (store) => store.delete(item.id));
        succeeded++;
      } else if (PERMANENT_FAILURE_CODES.has(res.status)) {
        const errBody = await res.json().catch(() => null) as { message?: string } | null;
        const updated: QueueItem = {
          ...item,
          status: "failed",
          failureReason: errBody?.message ?? `HTTP ${res.status}`,
          attempts: item.attempts + 1,
        };
        await tx(db, "readwrite", (store) => store.put(updated));
        failed++;
      }
      // 401 / 5xx / network error — leave as pending, retry next time
    } catch {
      // Network error — item stays pending
    }
  }

  if (succeeded > 0 || failed > 0) notifyChange();
  return { succeeded, failed };
}

export async function clearFailed(): Promise<void> {
  const userId = await getCurrentUserId();
  const db = await openDB();
  const items = await tx<QueueItem[]>(db, "readonly", (store) => store.getAll());
  const failedIds = items
    .filter((i) => i.status === "failed" && belongsToCurrentUser(i, userId))
    .map((i) => i.id);
  for (const id of failedIds) {
    await tx(db, "readwrite", (store) => store.delete(id));
  }
  if (failedIds.length > 0) notifyChange();
}
