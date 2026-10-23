import { apiFetch } from "./api";
import { shippedYieldUrl, type ShippedYieldResponse, type WeekRangeParams } from "./shippedYield";

/** GET /api/shipped-yield for an ISO week range (or all weeks). */
export async function fetchShippedYield(range?: WeekRangeParams | null): Promise<ShippedYieldResponse> {
  const response = await apiFetch(shippedYieldUrl(range));
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Failed to load shipped totals (${response.status})`);
  }
  const body = (await response.json()) as ShippedYieldResponse;
  // Callers read totals.colors directly; refuse any other shape here so one card can show the
  // problem instead of the whole page failing.
  if (!body || typeof body !== "object" || !body.totals || typeof body.totals.colors !== "object" || !Array.isArray(body.weeks)) {
    throw new Error("Shipped totals came back in an unexpected format.");
  }
  return body;
}
