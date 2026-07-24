import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, apiUrl } from "../lib/api";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { enqueue, onQueueChange } from "../services/offlineQueue";
import { ModalOverlay } from "../components/ModalOverlay";

// How far back a worker may backdate a checklist completion via the
// long-press date selector below — mirrors MAX_BACKDATE_DAYS in
// server/src/routes/foodSafety/services/reportDate.ts, which is the
// authoritative check (this constant only drives the date picker's min
// bound; the server re-validates every request regardless of what the
// client sends).
const MAX_BACKDATE_DAYS = 300;
const LONG_PRESS_MS = 3000;

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
  mobileInstructions: string | null;
  isComplete: boolean;
  completedAt: string | null;
  completedByName: string | null;
  completedByInitials: string | null;
  items: ChecklistItem[];
};

const API_BASE = apiUrl("/api/food-safety/mobile/cleaning-checklist");

// Local calendar-day helpers for the report-date long-press selector. These
// intentionally use the device's own local calendar day (not the
// organization timezone the server anchors to) -- the server re-validates
// every request from scratch (see reportDate.ts's "never trust the client
// date"), so the client's date is only ever a UX convenience, never trusted.
function todayDateString(): string {
  return dateToLocalIsoString(new Date());
}

function dateToLocalIsoString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Parses a plain "YYYY-MM-DD" string as a LOCAL calendar date (never via
// `new Date(isoString)`, which parses as UTC midnight and can land on the
// wrong day once shifted back to local time).
function parseLocalIsoDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function minSelectableDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() - MAX_BACKDATE_DAYS);
  return dateToLocalIsoString(d);
}

// "Jul 24, 2026" -- the visible short format. Locale pinned to en-US so the
// format is guaranteed regardless of the device's regional settings (locale
// only affects punctuation/ordering, never the timezone).
function formatDisplayDate(dateStr: string): string {
  return parseLocalIsoDate(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// "July 24, 2026" -- the long format used only in the accessible label.
function formatDisplayDateLong(dateStr: string): string {
  return parseLocalIsoDate(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

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

  // The report date this location's checklist is being filled out for --
  // defaults to today. Changed only via the hidden long-press date selector.
  const [reportDate, setReportDate] = useState<string>(todayDateString);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerValue, setPickerValue] = useState<string>(reportDate);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Set when a NEWLY selected date is rejected by the server (already
  // reported, or a bounds violation the client's own check somehow missed).
  // Deliberately separate from `error` -- a rejected selection triggers an
  // automatic rollback-and-refetch of the last good date below, and that
  // refetch's own success would otherwise clear `error` before the user had
  // a chance to read why their selection didn't apply.
  const [dateSelectionError, setDateSelectionError] = useState<string | null>(null);

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  // The reportDate that `location` actually reflects (i.e. the last one that
  // successfully loaded). Used to roll back a rejected date selection (future/
  // too-old/already-reported) without leaving the header claiming to show a
  // date whose checklist failed to load.
  const activeReportDateRef = useRef(reportDate);

  // The date-control element that opens the picker, so focus can be
  // restored to it whenever the picker closes (Cancel, Escape, backdrop, or
  // a successful "Use Selected Date").
  const dateTriggerRef = useRef<HTMLSpanElement | null>(null);
  const pressTimerRef = useRef<number | null>(null);

  // Guards against an older fetchLocation() call (superseded by a newer one
  // from a fast location-to-location navigation, an offline-queue resync, or
  // an error-recovery refetch) applying its response after the fact. Every
  // call aborts whatever the previous one was doing and claims this ref for
  // itself; a response is only committed to state if its controller is still
  // the current one by the time it resolves.
  const fetchAbortRef = useRef<AbortController | null>(null);

  async function fetchLocation() {
    if (!locationId) return;

    const requestedDate = reportDate;

    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const url = `${API_BASE}?locationId=${encodeURIComponent(locationId)}&reportDate=${encodeURIComponent(requestedDate)}`;
      const res = await apiFetch(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to load this location's checklist");
      }
      const data = (await res.json()) as { locations: LocationCard[] };
      if (controller.signal.aborted) return;
      setLocation(data.locations?.[0] ?? null);
      setCheckboxOverrides({});
      setQueuedItemIds(new Set());
      activeReportDateRef.current = requestedDate;
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Failed to load this location's checklist";

      if (requestedDate !== activeReportDateRef.current) {
        // A rejected NEW date selection -- surface this durably (see
        // dateSelectionError's definition) and roll back to the last date
        // that actually loaded successfully. The currently-displayed
        // `location` data (still valid for the rolled-back date) is left
        // untouched.
        setDateSelectionError(message);
        setReportDate(activeReportDateRef.current);
      } else {
        setError(message);
      }
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
  }, [locationId, reportDate]);

  useEffect(() => {
    return onQueueChange(() => {
      if (isOnlineRef.current) void fetchLocation();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, reportDate]);

  useEffect(() => {
    return () => {
      if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
      }
    };
  }, []);

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
    await submitResponse(itemId, url, JSON.stringify({ reportDate }));
    // Deliberately no override-clearing here anymore -- submitResponse
    // itself decides, based on the real outcome (server-confirmed vs.
    // queued vs. failed), whether the optimistic value should be kept.
  }

  function updateDraft(itemId: string, value: string) {
    setDrafts((prev) => ({ ...prev, [itemId]: value }));
  }

  async function saveDraft(itemId: string, value: string) {
    const url = `${API_BASE}/items/${itemId}/respond`;
    await submitResponse(itemId, url, JSON.stringify({ value, reportDate }));
  }

  async function handleCompleteLocation() {
    if (!location || completing) return;
    setError(null);
    setInfoMessage(null);
    setCompleting(true);

    const url = `${API_BASE}/locations/${location.id}/complete`;
    const body = JSON.stringify({ reportDate });

    try {
      if (!isOnline) {
        await enqueue({ module: "food_safety", url, method: "POST", body });
        setInfoMessage("Saved offline — will complete once connected.");
        return;
      }

      const res = await apiFetch(url, { method: "POST", body });

      if (!res.ok) {
        const errorBody = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(errorBody?.message ?? "Failed to complete this location");
      }

      const data = (await res.json()) as { location: LocationCard | null };
      if (data.location) setLocation(data.location);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete this location");
    } finally {
      setCompleting(false);
    }
  }

  function startPressTimer() {
    if (pressTimerRef.current !== null) return; // already timing -- ignore a duplicate start
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      openPicker();
    }, LONG_PRESS_MS);
  }

  function cancelPressTimer() {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }

  function handleDatePointerDown(event: PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    startPressTimer();
  }

  function handleDateKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      startPressTimer();
    }
  }

  function handleDateKeyUp(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Enter" || event.key === " ") {
      cancelPressTimer();
    }
  }

  function openPicker() {
    setPickerValue(reportDate);
    setPickerError(null);
    setDateSelectionError(null);
    setPickerOpen(true);
  }

  function closePicker() {
    setPickerOpen(false);
    dateTriggerRef.current?.focus();
  }

  function confirmPicker() {
    const min = minSelectableDateString();
    const max = todayDateString();
    if (pickerValue > max) {
      setPickerError("Report date cannot be in the future.");
      return;
    }
    if (pickerValue < min) {
      setPickerError(`Report date cannot be more than ${MAX_BACKDATE_DAYS} days in the past.`);
      return;
    }
    setDateSelectionError(null);
    setReportDate(pickerValue);
    setPickerOpen(false);
    dateTriggerRef.current?.focus();
  }

  function returnToToday() {
    setDateSelectionError(null);
    setReportDate(todayDateString());
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

      <div className="cleaning-checklist-header-row">
        <h2>{location.name}</h2>
        <span
          ref={dateTriggerRef}
          className="cleaning-checklist-header-date"
          role="button"
          tabIndex={0}
          aria-label={`Current report date ${formatDisplayDateLong(reportDate)}. Press and hold for three seconds to choose another reporting date.`}
          onPointerDown={handleDatePointerDown}
          onPointerUp={cancelPressTimer}
          onPointerLeave={cancelPressTimer}
          onPointerCancel={cancelPressTimer}
          onKeyDown={handleDateKeyDown}
          onKeyUp={handleDateKeyUp}
        >
          {formatDisplayDate(reportDate)}
        </span>
      </div>

      {reportDate !== todayDateString() ? (
        <div className="cleaning-checklist-backdate-notice">
          <span>Logging for: {formatDisplayDate(reportDate)}</span>
          <button type="button" className="cleaning-checklist-return-today-link" onClick={returnToToday}>
            Return to Today
          </button>
        </div>
      ) : null}

      {dateSelectionError ? <p className="form-error">{dateSelectionError}</p> : null}

      <p className="cleaning-checklist-card-area">{location.area}</p>
      <p className="cleaning-checklist-card-progress">
        {completedCount} of {total} complete
      </p>

      {location.mobileInstructions ? (
        <div className="cleaning-checklist-instructions-panel">
          <h3>Instructions</h3>
          <p>{location.mobileInstructions}</p>
        </div>
      ) : null}

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

      {pickerOpen ? (
        <ModalOverlay
          onClose={closePicker}
          contentClassName="cleaning-checklist-date-picker-modal"
          titleId="report-date-picker-title"
        >
          <h3 id="report-date-picker-title">Choose Reporting Date</h3>
          <label className="cleaning-checklist-date-picker-field">
            Reporting date
            <input
              type="date"
              value={pickerValue}
              min={minSelectableDateString()}
              max={todayDateString()}
              onChange={(event) => {
                setPickerValue(event.target.value);
                setPickerError(null);
              }}
            />
          </label>
          {pickerError ? <p className="form-error">{pickerError}</p> : null}
          <div className="form-actions">
            <button type="button" onClick={confirmPicker}>
              Use Selected Date
            </button>
            <button type="button" className="secondary" onClick={closePicker}>
              Cancel
            </button>
          </div>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
