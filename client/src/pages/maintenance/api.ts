// Thin typed wrappers around apiFetch for the Maintenance module. Every
// server error response is `{ message: string }` (see safeError.ts /
// server/src/routes/maintenance's validation.ts) except the stock-count
// confirm 409, which additionally carries a `conflicts` array — that one
// endpoint gets its own non-throwing result type below so the UI can render
// conflicts distinctly from a generic error.

import { apiFetch } from "../../lib/api";
import {
  EquipmentDetail, EquipmentPayload, EquipmentRow, EquipmentStatus, DueSummary,
  InventoryItemPayload, InventoryItemRow, InventoryTransactionResult, InventoryTransactionRow,
  DirectInventoryTransactionType, MaintenanceBadges, MeterReadingRow, RestockRequestDetail,
  RestockRequestRow, RestockReceiveResult, ScheduleCompletion, ScheduleDetail, SchedulePayload,
  ScheduleRow, SetupRecord, StockCountConflict, StockCountLineRow, StockCountSessionDetail,
  StockCountSessionRow
} from "./types";

export class MaintenanceApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function qs(params: Record<string, string | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, options);
  } catch {
    throw new MaintenanceApiError(0, "Unable to reach the server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new MaintenanceApiError(res.status, body?.message ?? `Request failed with status ${res.status}.`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

// ── Setup ────────────────────────────────────────────────────────────────

export type SetupResourceKey = "categories" | "locations" | "part-types";

export function listSetupResource(resource: SetupResourceKey, search?: string, active?: "true" | "false") {
  return request<SetupRecord[]>(`/api/maintenance/setup/${resource}${qs({ search, active })}`);
}

export function createSetupResource(resource: SetupResourceKey, payload: { name: string; description: string | null; display_order: number }) {
  return postJson<SetupRecord>(`/api/maintenance/setup/${resource}`, payload);
}

export function updateSetupResource(resource: SetupResourceKey, id: string, payload: { name: string; description: string | null; display_order: number }) {
  return putJson<SetupRecord>(`/api/maintenance/setup/${resource}/${id}`, payload);
}

export function deactivateSetupResource(resource: SetupResourceKey, id: string) {
  return request<void>(`/api/maintenance/setup/${resource}/${id}/deactivate`, { method: "POST" });
}

export function reactivateSetupResource(resource: SetupResourceKey, id: string) {
  return request<void>(`/api/maintenance/setup/${resource}/${id}/reactivate`, { method: "POST" });
}

export function deleteSetupResource(resource: SetupResourceKey, id: string) {
  return request<void>(`/api/maintenance/setup/${resource}/${id}`, { method: "DELETE" });
}

// ── Equipment ────────────────────────────────────────────────────────────

export function listEquipment(params: { search?: string; category_id?: string; location_id?: string; status?: string }) {
  return request<EquipmentRow[]>(`/api/maintenance/equipment${qs(params)}`);
}

export function getEquipmentDueSummary() {
  return request<DueSummary>("/api/maintenance/equipment/due-summary");
}

export function getEquipment(id: string) {
  return request<EquipmentDetail>(`/api/maintenance/equipment/${id}`);
}

export function createEquipment(payload: EquipmentPayload) {
  return postJson<EquipmentRow>("/api/maintenance/equipment", payload);
}

export function updateEquipment(id: string, payload: EquipmentPayload) {
  return putJson<EquipmentRow>(`/api/maintenance/equipment/${id}`, payload);
}

export function setEquipmentStatus(id: string, status: EquipmentStatus) {
  return postJson<{ id: string; status: EquipmentStatus }>(`/api/maintenance/equipment/${id}/status`, { status });
}

// ── QR ───────────────────────────────────────────────────────────────────

export function lookupEquipmentByQrToken(token: string) {
  return request<EquipmentRow>(`/api/maintenance/equipment/qr/${encodeURIComponent(token)}`);
}

export function regenerateEquipmentQr(id: string) {
  return postJson<{ id: string; qr_token: string; qr_token_created_at: string }>(`/api/maintenance/equipment/${id}/qr/regenerate`, {});
}

// ── Meter readings ───────────────────────────────────────────────────────

export function recordMeterReading(equipmentId: string, payload: { value: number; note: string | null; is_reset: boolean; reset_reason: string | null }) {
  return postJson<MeterReadingRow>(`/api/maintenance/equipment/${equipmentId}/meter-readings`, payload);
}

export function listMeterReadings(equipmentId: string, limit = 50, offset = 0) {
  return request<MeterReadingRow[]>(`/api/maintenance/equipment/${equipmentId}/meter-readings${qs({ limit: String(limit), offset: String(offset) })}`);
}

// ── Schedules ────────────────────────────────────────────────────────────

export function listSchedules(params: { equipment_id?: string; active?: string }) {
  return request<ScheduleRow[]>(`/api/maintenance/schedules${qs(params)}`);
}

export function getSchedule(id: string) {
  return request<ScheduleDetail>(`/api/maintenance/schedules/${id}`);
}

export function createSchedule(payload: SchedulePayload) {
  return postJson<ScheduleDetail>("/api/maintenance/schedules", payload);
}

export function updateSchedule(id: string, payload: SchedulePayload) {
  return putJson<ScheduleDetail>(`/api/maintenance/schedules/${id}`, payload);
}

export function archiveSchedule(id: string) {
  return request<void>(`/api/maintenance/schedules/${id}/archive`, { method: "POST" });
}

export function reactivateSchedule(id: string) {
  return request<void>(`/api/maintenance/schedules/${id}/reactivate`, { method: "POST" });
}

export function completeSchedule(
  id: string,
  payload: { completion_request_id: string; notes: string | null; checklist_responses: Array<{ checklist_item_id: string; checked: boolean }> }
) {
  return postJson<ScheduleCompletion>(`/api/maintenance/schedules/${id}/complete`, payload);
}

export function getScheduleHistory(id: string, limit = 50, offset = 0) {
  return request<ScheduleCompletion[]>(`/api/maintenance/schedules/${id}/history${qs({ limit: String(limit), offset: String(offset) })}`);
}

// ── Inventory ────────────────────────────────────────────────────────────

export function listInventoryItems(params: { search?: string; location_id?: string; part_type_id?: string; stock_status?: string; active?: string }) {
  return request<InventoryItemRow[]>(`/api/maintenance/inventory/items${qs(params)}`);
}

export function getInventoryItem(id: string) {
  return request<InventoryItemRow>(`/api/maintenance/inventory/items/${id}`);
}

export function createInventoryItem(payload: InventoryItemPayload) {
  return postJson<InventoryItemRow>("/api/maintenance/inventory/items", payload);
}

export function updateInventoryItem(id: string, payload: InventoryItemPayload) {
  return putJson<InventoryItemRow>(`/api/maintenance/inventory/items/${id}`, payload);
}

export function deactivateInventoryItem(id: string) {
  return request<void>(`/api/maintenance/inventory/items/${id}/deactivate`, { method: "POST" });
}

export function activateInventoryItem(id: string) {
  return request<void>(`/api/maintenance/inventory/items/${id}/activate`, { method: "POST" });
}

export function postInventoryTransaction(
  itemId: string,
  payload: { transaction_type: DirectInventoryTransactionType; quantity: number; reason: string | null; request_id: string }
) {
  return postJson<InventoryTransactionResult>(`/api/maintenance/inventory/items/${itemId}/transactions`, payload);
}

// ── Transactions (ledger) ────────────────────────────────────────────────

export function listInventoryTransactions(params: { item_id?: string; transaction_type?: string; from?: string; to?: string; limit?: number; offset?: number }) {
  return request<InventoryTransactionRow[]>(
    `/api/maintenance/inventory/transactions${qs({
      item_id: params.item_id,
      transaction_type: params.transaction_type,
      from: params.from,
      to: params.to,
      limit: params.limit ? String(params.limit) : undefined,
      offset: params.offset ? String(params.offset) : undefined
    })}`
  );
}

// ── Restock ──────────────────────────────────────────────────────────────

export function listRestockRequests(params: { status?: string; limit?: number; offset?: number }) {
  return request<RestockRequestRow[]>(
    `/api/maintenance/restock/requests${qs({ status: params.status, limit: params.limit ? String(params.limit) : undefined, offset: params.offset ? String(params.offset) : undefined })}`
  );
}

export function getRestockRequest(id: string) {
  return request<RestockRequestDetail>(`/api/maintenance/restock/requests/${id}`);
}

export function createRestockRequest(payload: { lines: Array<{ item_id: string; requested_quantity: number; notes: string | null }>; notes: string | null }) {
  return postJson<RestockRequestDetail>("/api/maintenance/restock/requests", payload);
}

export function markRestockRequestOrdered(id: string) {
  return postJson<RestockRequestRow>(`/api/maintenance/restock/requests/${id}/mark-ordered`, {});
}

export function cancelRestockRequest(id: string, reason: string | null) {
  return postJson<RestockRequestRow>(`/api/maintenance/restock/requests/${id}/cancel`, { reason });
}

export function receiveRestockLine(requestId: string, lineId: string, payload: { receive_quantity: number; request_id: string }) {
  return postJson<RestockReceiveResult>(`/api/maintenance/restock/requests/${requestId}/lines/${lineId}/receive`, payload);
}

// ── Stock counts ─────────────────────────────────────────────────────────

export function listStockCountSessions(params: { status?: string; location_id?: string; limit?: number; offset?: number }) {
  return request<StockCountSessionRow[]>(
    `/api/maintenance/stock-counts/sessions${qs({
      status: params.status,
      location_id: params.location_id,
      limit: params.limit ? String(params.limit) : undefined,
      offset: params.offset ? String(params.offset) : undefined
    })}`
  );
}

export function getStockCountSession(id: string) {
  return request<StockCountSessionDetail>(`/api/maintenance/stock-counts/sessions/${id}`);
}

export function startStockCountSession(locationId: string) {
  return postJson<StockCountSessionDetail>("/api/maintenance/stock-counts/sessions", { location_id: locationId });
}

export function saveStockCountLine(sessionId: string, lineId: string, payload: { counted_quantity: number; notes: string | null }) {
  return putJson<StockCountLineRow>(`/api/maintenance/stock-counts/sessions/${sessionId}/lines/${lineId}`, payload);
}

export function cancelStockCountSession(id: string, reason: string | null) {
  return postJson<StockCountSessionRow>(`/api/maintenance/stock-counts/sessions/${id}/cancel`, { reason });
}

export type ConfirmStockCountResult =
  | { ok: true; session: StockCountSessionRow }
  | { ok: false; conflict: true; message: string; conflicts: StockCountConflict[] }
  | { ok: false; conflict: false; message: string };

export async function confirmStockCountSession(id: string): Promise<ConfirmStockCountResult> {
  let res: Response;
  try {
    res = await apiFetch(`/api/maintenance/stock-counts/sessions/${id}/confirm`, { method: "POST" });
  } catch {
    return { ok: false, conflict: false, message: "Unable to reach the server. Check your connection and try again." };
  }

  if (res.ok) {
    return { ok: true, session: (await res.json()) as StockCountSessionRow };
  }

  const body = (await res.json().catch(() => null)) as { message?: string; conflicts?: StockCountConflict[] } | null;
  if (res.status === 409 && Array.isArray(body?.conflicts)) {
    return { ok: false, conflict: true, message: body?.message ?? "Some items changed since this count started.", conflicts: body.conflicts };
  }
  return { ok: false, conflict: false, message: body?.message ?? `Request failed with status ${res.status}.` };
}

// ── Reports ──────────────────────────────────────────────────────────────

export function getLowStockReport() {
  return request<InventoryItemRow[]>("/api/maintenance/reports/low-stock");
}

export function getOutOfStockReport() {
  return request<InventoryItemRow[]>("/api/maintenance/reports/out-of-stock");
}

export function getInventoryByLocationReport() {
  return request<InventoryItemRow[]>("/api/maintenance/reports/inventory-by-location");
}

export function getRecentReceipts() {
  return request<InventoryTransactionRow[]>("/api/maintenance/reports/recent-receipts");
}

export function getRecentAdjustments() {
  return request<InventoryTransactionRow[]>("/api/maintenance/reports/recent-adjustments");
}

// ── Badges ───────────────────────────────────────────────────────────────

export function getMaintenanceBadges() {
  return request<MaintenanceBadges>("/api/maintenance/badges");
}
