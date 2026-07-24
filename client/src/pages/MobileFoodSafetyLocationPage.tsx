import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, apiUrl } from "../lib/api";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { enqueue, onQueueChange } from "../services/offlineQueue";

type ChecklistFrequency = "daily" | "weekly" | "monthly" | "annually";
type ChecklistResponseType = "checkbox" | "number" | "short_text" | "long_text";

type ChecklistItem = {
  id: string;
  name: string;
  frequency: ChecklistFrequency;
  responseType: ChecklistResponseType;
  actionLabel: string | null;
  isRequired: boolean;
  numberUnit: string | null;
  responseValue: string | null;
  isComplete: boolean;
  checkedAt: string | null;
  checkedByName: string | null;
  checkedByInitials: string | null;
};

type LocationCard = {
  id: string;
  name: string;
  area: string;
  isComplete: boolean;
  completedAt: string | null;
  completedByName: string | null;
  completedByInitials: string | null;
  items: ChecklistItem[];
};

const API_BASE = apiUrl("/api/food-safety/mobile/cleaning-checklist");

function formatCompletedAt(iso: string): string {
  const date = new Date(iso);
  const datePart = date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} at ${timePart}`;
}

type ItemGroup = { name: string; items: ChecklistItem[] };

// A task configured with more than one checkbox (e.g. "Garbage Bin" tracking
// both "Emptied" and "Bag Replaced") expands into multiple checklist items
// that share a name and sit adjacent in sort order — group them back under
// one heading so the mobile page shows one task with several stacked
// checkboxes, not several duplicate-looking task blocks.
function groupItems(items: ChecklistItem[]): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.name && last.items[0].responseType === item.responseType) {
      last.items.push(item);
    } else {
      groups.push({ name: item.name, items: [item] });
    }
  }
  return groups;
}

export function MobileFoodSafetyLocationPage() {
  const { locationId } = useParams<{ locationId: string }>();
  const { isOnline } = useOnlineStatus();

  const [location, setLocation] = useState<LocationCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Checkbox taps: optimistic boolean override. Cleared when the server
  // confirms the change; kept (not cleared) while only queued offline, since
  // there's nothing yet to confirm it against — see submitResponse.
  const [checkboxOverrides, setCheckboxOverrides] = useState<Record<string, boolean>>({});
  // Items whose checkbox tap was queued offline and hasn't synced yet.
  // Distinct from pendingItemIds (which just means "request in flight right
  // now", true only for the brief moment enqueue()/apiFetch() is awaited) --
  // this stays true for as long as the item sits in the offline queue,
  // potentially minutes or hours, until a real sync outcome arrives.
  const [queuedItemIds, setQueuedItemIds] = useState<Set<string>>(new Set());
  // Number/text fields: in-progress typed value, cleared once its own save succeeds.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(new Set());
  const [completing, setCompleting] = useState(false);

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  // Guards against an older fetchLocation() call (superseded by a newer one
  // from a fast location-to-location navigation, an offline-queue resync, or
  // an error-recovery refetch) applying its response after the fact. Every
  // call aborts whatever the previous one was doing and claims this ref for
  // itself; a response is only committed to state if its controller is still
  // the current one by the time it resolves.
  const fetchAbortRef = useRef<AbortController | null>(null);

  async function fetchLocation() {
    if (!locationId) return;

    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`${API_BASE}?locationId=${encodeURIComponent(locationId)}`, {
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error("Failed to load this location's checklist");
      const data = (await res.json()) as { locations: LocationCard[] };
      if (controller.signal.aborted) return;
      setLocation(data.locations?.[0] ?? null);
      setCheckboxOverrides({});
      setQueuedItemIds(new Set());
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load this location's checklist");
    } finally {
      // Only the still-current request gets to clear the loading flag --
      // an older, already-superseded request's finally block must not hide
      // the spinner out from under a newer request that's still in flight.
      if (fetchAbortRef.current === controller) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void fetchLocation();
    return () => {
      fetchAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    return onQueueChange(() => {
      if (isOnlineRef.current) void fetchLocation();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  async function submitResponse(itemId: string, url: string, body: string) {
    if (pendingItemIds.has(itemId)) return;
    setPendingItemIds((prev) => new Set(prev).add(itemId));
    setError(null);

    try {
      if (!isOnline) {
        await enqueue({ module: "food_safety", url, method: "POST", body });
        // Queued, not confirmed -- the optimistic override set by the
        // caller stays exactly as it is. It (and this queued marker) only
        // clear once fetchLocation() re-syncs with the server, which
        // happens the next time the offline queue actually drains (the
        // onQueueChange listener above fires once reconnected) or a clear
        // terminal failure is recorded there.
        setQueuedItemIds((prev) => new Set(prev).add(itemId));
        return;
      }

      const res = await apiFetch(url, { method: "POST", body });

      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(responseBody?.message ?? "Failed to update task");
      }

      const data = (await res.json()) as { location: LocationCard | null };
      if (data.location) {
        setLocation(data.location);
      }
      // Server-confirmed: the optimistic guess (and any stale queued marker
      // from an earlier offline attempt on this same item) is no longer
      // needed now that real data has arrived.
      setCheckboxOverrides((prev) => {
        if (!(itemId in prev)) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      setQueuedItemIds((prev) => {
        if (!prev.has(itemId)) return prev;
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task");
      void fetchLocation();
    } finally {
      setPendingItemIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  }

  async function toggleCheckbox(itemId: string, currentValue: boolean) {
    if (pendingItemIds.has(itemId)) return;
    const nextValue = !currentValue;
    setCheckboxOverrides((prev) => ({ ...prev, [itemId]: nextValue }));

    const url = `${API_BASE}/items/${itemId}/${nextValue ? "check" : "uncheck"}`;
    await submitResponse(itemId, url, "{}");
    // Deliberately no override-clearing here anymore -- submitResponse
    // itself decides, based on the real outcome (server-confirmed vs.
    // queued vs. failed), whether the optimistic value should be kept.
  }

  function updateDraft(itemId: string, value: string) {
    setDrafts((prev) => ({ ...prev, [itemId]: value }));
  }

  async function saveDraft(itemId: string, value: string) {
    const url = `${API_BASE}/items/${itemId}/respond`;
    await submitResponse(itemId, url, JSON.stringify({ value }));
  }

  async function handleCompleteLocation() {
    if (!location || completing) return;
    setError(null);
    setInfoMessage(null);
    setCompleting(true);

    const url = `${API_BASE}/locations/${location.id}/complete`;

    try {
      if (!isOnline) {
        await enqueue({ module: "food_safety", url, method: "POST", body: "{}" });
        setInfoMessage("Saved offline — will complete once connected.");
        return;
      }

      const res = await apiFetch(url, { method: "POST", body: "{}" });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to complete this location");
      }

      const data = (await res.json()) as { location: LocationCard | null };
      if (data.location) setLocation(data.location);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete this location");
    } finally {
      setCompleting(false);
    }
  }

  if (loading) {
    return (
      <section className="mobile-page">
        <Link to="/mobile/food-safety" className="mobile-back-link">
          ‹ Food Safety
        </Link>
        <p>Loading…</p>
      </section>
    );
  }

  if (!location) {
    return (
      <section className="mobile-page">
        <Link to="/mobile/food-safety" className="mobile-back-link">
          ‹ Food Safety
        </Link>
        <p className="form-error">{error ?? "This location could not be found."}</p>
      </section>
    );
  }

  const requiredItems = location.items.filter((item) => item.isRequired);
  const total = requiredItems.length;
  const completedCount = requiredItems.filter((item) => item.isComplete).length;

  return (
    <section className="mobile-page">
      <Link to="/mobile/food-safety" className="mobile-back-link">
        ‹ Food Safety
      </Link>

      <h2>{location.name}</h2>
      <p className="cleaning-checklist-card-area">{location.area}</p>
      <p className="cleaning-checklist-card-progress">
        {completedCount} of {total} complete
      </p>

      {error ? <p className="form-error">{error}</p> : null}
      {infoMessage ? <p className="form-success">{infoMessage}</p> : null}

      {location.isComplete ? (
        <div className="cleaning-checklist-completed-banner">
          <span>Completed by {location.completedByInitials ?? "—"}</span>
          {location.completedAt ? (
            <span className="cleaning-checklist-completed-date">{formatCompletedAt(location.completedAt)}</span>
          ) : null}
        </div>
      ) : null}

      <div className="cleaning-checklist-task-list">
        {groupItems(location.items).map((group) => {
          const first = group.items[0];

          if (first.responseType === "checkbox") {
            return (
              <div className="cleaning-checklist-field" key={first.id}>
                <span className="cleaning-checklist-field-label">{group.name}</span>
                {group.items.map((item) => {
                  const checked = checkboxOverrides[item.id] ?? item.isComplete;
                  const isQueued = queuedItemIds.has(item.id);
                  const disabled = location.isComplete || pendingItemIds.has(item.id);
                  const label = item.actionLabel ?? "Done";
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`cleaning-checklist-task-row ${checked ? "checked" : ""}${isQueued ? " pending-sync" : ""}`}
                      disabled={disabled}
                      aria-label={isQueued ? `${label}, ${checked ? "checked" : "unchecked"}, pending sync` : undefined}
                      onClick={() => void toggleCheckbox(item.id, checked)}
                    >
                      <span className="cleaning-checklist-checkbox" aria-hidden="true">
                        {checked ? "☑" : "☐"}
                      </span>
                      <span className="cleaning-checklist-task-name">{label}</span>
                      {isQueued ? (
                        <span className="cleaning-checklist-pending-sync-badge">Pending sync</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          }

          const item = first;
          const disabled = location.isComplete || pendingItemIds.has(item.id);
          const draftValue = drafts[item.id] ?? item.responseValue ?? "";

          if (item.responseType === "number") {
            return (
              <div className="cleaning-checklist-field" key={item.id}>
                <span className="cleaning-checklist-field-label">{item.name}</span>
                <div className="cleaning-checklist-number-input-wrap">
                  <input
                    type="number"
                    inputMode="decimal"
                    className={`cleaning-checklist-response-input ${item.isComplete ? "filled" : ""}`}
                    value={draftValue}
                    disabled={disabled}
                    onChange={(event) => updateDraft(item.id, event.target.value)}
                    onBlur={(event) => void saveDraft(item.id, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  {item.numberUnit ? <span className="cleaning-checklist-number-unit">{item.numberUnit}</span> : null}
                </div>
              </div>
            );
          }

          if (item.responseType === "long_text") {
            return (
              <div className="cleaning-checklist-field" key={item.id}>
                <span className="cleaning-checklist-field-label">{item.name}</span>
                <textarea
                  className={`cleaning-checklist-response-input ${item.isComplete ? "filled" : ""}`}
                  rows={3}
                  value={draftValue}
                  disabled={disabled}
                  onChange={(event) => updateDraft(item.id, event.target.value)}
                  onBlur={(event) => void saveDraft(item.id, event.target.value)}
                />
              </div>
            );
          }

          return (
            <div className="cleaning-checklist-field" key={item.id}>
              <span className="cleaning-checklist-field-label">{item.name}</span>
              <input
                type="text"
                className={`cleaning-checklist-response-input ${item.isComplete ? "filled" : ""}`}
                value={draftValue}
                disabled={disabled}
                onChange={(event) => updateDraft(item.id, event.target.value)}
                onBlur={(event) => void saveDraft(item.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          );
        })}
      </div>

      {!location.isComplete ? (
        <div className="cleaning-checklist-complete-button-wrap">
          <button
            type="button"
            className="primary-action-button cleaning-checklist-complete-button"
            disabled={completing}
            onClick={() => void handleCompleteLocation()}
          >
            {completing ? "Completing…" : "Complete Location"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
