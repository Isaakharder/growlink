import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ apiFetch }));

import { buildCaseEntryYearOptions, formatCaseTotal, requestDocklinkCaseSync, requestDocklinkPackSync } from "../caseTotals";

afterEach(() => apiFetch.mockReset());

describe("weekly case totals", () => {
  it("lists this year and every entry year, newest first", () => {
    expect(buildCaseEntryYearOptions([{ year: 2024 }, { year: 2026 }, { year: 2024.5 }], 2025)).toEqual([2026, 2025, 2024]);
  });

  it("formats case counts to 3 dp without trailing zeros", () => {
    expect([formatCaseTotal(3), formatCaseTotal(0.0004), formatCaseTotal(1.5), formatCaseTotal(2.1004)]).toEqual(["3", "0", "1.5", "2.1"]);
  });
});

describe("requestDocklinkCaseSync", () => {
  it("POSTs the sync with no body", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(requestDocklinkCaseSync()).resolves.toBeNull();
    expect(apiFetch).toHaveBeenCalledWith("/api/integrations/docklink/sync-color-cases", { method: "POST" });
  });

  it("resolves with the server's summary message", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ message: "Synced DockLink cases: imported=5" }) });
    await expect(requestDocklinkCaseSync()).resolves.toBe("Synced DockLink cases: imported=5");
  });

  it("throws the server's message, or 'Sync failed'", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ message: "DockLink is unreachable" }) });
    await expect(requestDocklinkCaseSync()).rejects.toThrow("DockLink is unreachable");
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(requestDocklinkCaseSync()).rejects.toThrow("Sync failed");
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => { throw new Error("not json"); } });
    await expect(requestDocklinkCaseSync()).rejects.toThrow("Sync failed");
  });
});

describe("requestDocklinkPackSync", () => {
  it("POSTs the pack sync and reports the server's summary", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ message: "Synced DockLink packs" }) });
    await expect(requestDocklinkPackSync()).resolves.toEqual({ ok: true, message: "Packs: Synced DockLink packs" });
    expect(apiFetch).toHaveBeenCalledWith("/api/integrations/docklink/sync-packs", { method: "POST" });
  });

  it("treats a pack export DockLink hasn't deployed yet (503) as information, not a failure", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ message: "DockLink's pack export (growlink_pack_export_v1) is not available yet." }) });
    await expect(requestDocklinkPackSync()).resolves.toEqual({ ok: true, message: "Packs: DockLink's pack export (growlink_pack_export_v1) is not available yet." });
  });

  it("reports real failures without throwing", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ message: "Nothing was changed." }) });
    await expect(requestDocklinkPackSync()).resolves.toEqual({ ok: false, message: "Pack sync failed: Nothing was changed." });
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(requestDocklinkPackSync()).resolves.toEqual({ ok: false, message: "Pack sync failed: network error" });
  });
});
