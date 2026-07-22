import { apiFetch } from "../lib/api";

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
  const db = await openDB();
  const full: QueueItem = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    ...item,
  };
  await tx(db, "readwrite", (store) => store.add(full));
  notifyChange();
  return full;
}

export async function getAllItems(): Promise<QueueItem[]> {
  const db = await openDB();
  const items = await tx<QueueItem[]>(db, "readonly", (store) => store.getAll());
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getQueueCounts(): Promise<{ pending: number; failed: number }> {
  const items = await getAllItems();
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

  const db = await openDB();
  const all = await tx<QueueItem[]>(db, "readonly", (store) => store.getAll());
  const pending = all
    .filter((i) => i.status === "pending")
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
  const db = await openDB();
  const items = await tx<QueueItem[]>(db, "readonly", (store) => store.getAll());
  const failedIds = items.filter((i) => i.status === "failed").map((i) => i.id);
  for (const id of failedIds) {
    await tx(db, "readwrite", (store) => store.delete(id));
  }
  if (failedIds.length > 0) notifyChange();
}
