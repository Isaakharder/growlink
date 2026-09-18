import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../../lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { confirmStockCountSession, listEquipment, MaintenanceApiError } from "../api";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

describe("request() error handling (via listEquipment)", () => {
  afterEach(() => vi.clearAllMocks());

  it("resolves with parsed JSON on success", async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse(200, [{ id: "eq-1" }]));
    const result = await listEquipment({});
    expect(result).toEqual([{ id: "eq-1" }]);
  });

  it("throws a MaintenanceApiError carrying the server's message and status on failure", async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse(400, { message: "A valid location is required." }));
    await expect(listEquipment({})).rejects.toMatchObject(
      new MaintenanceApiError(400, "A valid location is required.")
    );
  });

  it("falls back to a generic message when the error body isn't JSON", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error("not json"); } } as unknown as Response);
    await expect(listEquipment({})).rejects.toThrow("Request failed with status 500.");
  });

  it("surfaces a network failure (fetch throwing) as a MaintenanceApiError, not an unhandled rejection", async () => {
    apiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(listEquipment({})).rejects.toThrow("Unable to reach the server");
  });
});

describe("confirmStockCountSession", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns ok:true with the session on success", async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse(200, { id: "session-1", status: "confirmed" }));
    const result = await confirmStockCountSession("session-1");
    expect(result).toEqual({ ok: true, session: { id: "session-1", status: "confirmed" } });
  });

  it("returns a distinct conflict result (not a thrown error) when the server reports stale expected quantities", async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse(409, {
        message: "Some items changed since this count started. Review the conflicts and start a new count.",
        conflicts: [{ line_id: "line-1", reason: "inventory_changed_since_snapshot" }]
      })
    );
    const result = await confirmStockCountSession("session-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(result.conflicts).toEqual([{ line_id: "line-1", reason: "inventory_changed_since_snapshot" }]);
      }
    }
  });

  it("returns a plain (non-conflict) failure for a 409 without a conflicts array", async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse(409, { message: "This stock count session was cancelled." }));
    const result = await confirmStockCountSession("session-1");
    expect(result).toEqual({ ok: false, conflict: false, message: "This stock count session was cancelled." });
  });
});
