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

export function MobileFoodSafetyLocationPage() {
  const { locationId } = useParams<{ locationId: string }>();
  const { isOnline } = useOnlineStatus();

  const [location, setLocation] = useState<LocationCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Checkbox taps: optimistic boolean override, cleared on server confirmation.
  const [checkboxOverrides, setCheckboxOverrides] = useState<Record<string, boolean>>({});
  // Number/text fields: in-progress typed value, cleared once its own save succeeds.
  // Kept separate from server data so a refetch triggered by a DIFFERENT item's
  // save can never clobber text the user is still typing here.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(new Set());

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  async function fetchLocation() {
    if (!locationId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`${API_BASE}?locationId=${encodeURIComponent(locationId)}`);
      if (!res.ok) throw new Error("Failed to load this location's checklist");
      const data = (await res.json()) as { locations: LocationCard[] };
      setLocation(data.locations?.[0] ?? null);
      setCheckboxOverrides({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load this location's checklist");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchLocation();
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
    setCheckboxOverrides((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  function updateDraft(itemId: string, value: string) {
    setDrafts((prev) => ({ ...prev, [itemId]: value }));
  }

  async function saveDraft(itemId: string, value: string) {
    const url = `${API_BASE}/items/${itemId}/respond`;
    await submitResponse(itemId, url, JSON.stringify({ value }));
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

      {location.isComplete ? (
        <div className="cleaning-checklist-completed-banner">
          <span>Completed by {location.completedByInitials ?? "—"}</span>
          {location.completedAt ? (
            <span className="cleaning-checklist-completed-date">{formatCompletedAt(location.completedAt)}</span>
          ) : null}
        </div>
      ) : null}

      <div className="cleaning-checklist-task-list">
        {location.items.map((item) => {
          const disabled = location.isComplete || pendingItemIds.has(item.id);

          if (item.responseType === "checkbox") {
            const checked = checkboxOverrides[item.id] ?? item.isComplete;
            return (
              <div className="cleaning-checklist-field" key={item.id}>
                <span className="cleaning-checklist-field-label">{item.name}</span>
                <button
                  type="button"
                  className={`cleaning-checklist-task-row ${checked ? "checked" : ""}`}
                  disabled={disabled}
                  onClick={() => void toggleCheckbox(item.id, checked)}
                >
                  <span className="cleaning-checklist-checkbox" aria-hidden="true">
                    {checked ? "☑" : "☐"}
                  </span>
                  <span className="cleaning-checklist-task-name">{item.actionLabel ?? "Done"}</span>
                </button>
              </div>
            );
          }

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
    </section>
  );
}
