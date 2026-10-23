import { apiFetch } from "../api";
import { roundTo } from "../roundTo";

// The Cases tab's year options, case-count formatting and the DockLink sync
// requests. Weekly totals themselves come from the authoritative shipped-yield
// calculation (lib/shippedYield.ts), not from colour rows.

export const COLOR_CASE_ENTRIES_URL = "/api/color-case-entries";
export const DOCKLINK_CASE_SYNC_URL = "/api/integrations/docklink/sync-color-cases";

/** This year plus every year with an entry, newest first. */
export function buildCaseEntryYearOptions(entries: Array<{ year: number }>, currentYear: number) {
  const years = new Set<number>([currentYear]);

  for (const entry of entries) {
    if (Number.isInteger(entry.year)) {
      years.add(entry.year);
    }
  }

  return Array.from(years).sort((a, b) => b - a);
}

/** A case count rounded to 3 dp, without trailing zeros. */
export function formatCaseTotal(value: number) {
  const rounded = roundTo(value, 3);
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * POSTs the DockLink colour case sync. Resolves with the server's summary
 * message (or null), and throws with the server's message (or "Sync failed")
 * when it is rejected; the caller reloads the entries.
 */
export async function requestDocklinkCaseSync(): Promise<string | null> {
  const response = await apiFetch(DOCKLINK_CASE_SYNC_URL, {
    method: "POST"
  });

  let message: string | null = null;

  try {
    const responseBody = (await response.json()) as { message?: string };
    if (typeof responseBody.message === "string" && responseBody.message) {
      message = responseBody.message;
    }
  } catch {
    // Ignore
  }

  if (!response.ok) {
    throw new Error(message ?? "Sync failed");
  }

  return message;
}

export const DOCKLINK_PACK_SYNC_URL = "/api/integrations/docklink/sync-packs";

/**
 * POSTs the DockLink pack shipment sync. Never throws: resolves with the
 * server's summary. `ok` is false only for a real failure — a pack export
 * DockLink hasn't deployed yet (503) or an organization without a mapping
 * is reported as information, since colour totals keep working.
 */
export async function requestDocklinkPackSync(): Promise<{ ok: boolean; message: string | null }> {
  try {
    const response = await apiFetch(DOCKLINK_PACK_SYNC_URL, { method: "POST" });
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    const message = typeof body?.message === "string" && body.message ? body.message : null;
    if (response.ok || response.status === 503) return { ok: true, message: message ? `Packs: ${message}` : null };
    return { ok: false, message: `Pack sync failed: ${message ?? `status ${response.status}`}` };
  } catch {
    return { ok: false, message: "Pack sync failed: network error" };
  }
}
