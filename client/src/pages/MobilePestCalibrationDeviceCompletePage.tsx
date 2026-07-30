import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";
import { DeviceDetail } from "./pestCalibration/types";
import { CalibrationForm, CalibrationFormPayload } from "./pestCalibration/CalibrationForm";

// The organization's timezone for the calibration date control below —
// deliberately the ORG timezone (not the device's own local timezone, as
// Food Safety's analogous long-press date selector uses), since the request
// for this control was explicit that the displayed/defaulted date must be
// "in the organization timezone, currently America/Toronto" regardless of
// where the employee's phone is set. The server re-validates independently
// either way (see effectiveDate.ts) — this is only ever a UX convenience.
const ORG_TIMEZONE = "America/Toronto";

// Mirrors MAX_BACKDATE_DAYS in server/src/routes/pestCalibration/services/effectiveDate.ts,
// which is the authoritative check — this constant only drives the date
// picker's min bound.
const MAX_BACKDATE_DAYS = 300;
const LONG_PRESS_MS = 3000;

type CompletionResult = {
  record_id: string;
  next_due_at: string | null;
  effective_date: string;
};

type DateParts = { year: number; month: number; day: number };

function getOrgDateParts(date: Date): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ORG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function dateStringFromParts(p: DateParts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// A pure calendar-day counter (days since the Unix epoch), used only to add/
// subtract whole days between calendar labels -- never to derive a real
// instant, so DST transitions in the org timezone can't skew the count.
function dayIndexFromParts(p: DateParts): number {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}

function partsFromDayIndex(index: number): DateParts {
  const d = new Date(index * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function todayDateString(): string {
  return dateStringFromParts(getOrgDateParts(new Date()));
}

function minSelectableDateString(): string {
  const todayIndex = dayIndexFromParts(getOrgDateParts(new Date()));
  return dateStringFromParts(partsFromDayIndex(todayIndex - MAX_BACKDATE_DAYS));
}

// Formats a "YYYY-MM-DD" calendar label for display. Builds the instant at
// UTC noon on that date and formats it back out pinned to the UTC timezone,
// so the printed label always matches the input string's own y/m/d exactly
// regardless of the viewing device's local timezone -- there is no zone
// conversion of the *label* itself at any point, only of a throwaway
// instant used purely to satisfy toLocaleDateString's API.
function formatDisplayDate(dateStr: string, style: "short" | "long" = "short"): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return instant.toLocaleDateString("en-US", { month: style, day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function MobilePestCalibrationDeviceCompletePage() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CompletionResult | null>(null);

  // The calibration/completion date this record will be saved for. Defaults
  // to today in the org timezone; changed only via the hidden long-press
  // selector below. Changing it must never reset task answers/notes/rows —
  // it lives entirely independently of CalibrationForm's own state.
  const [effectiveDate, setEffectiveDate] = useState<string>(todayDateString);

  const [pressing, setPressing] = useState(false);
  const [pressProgress, setPressProgress] = useState(0);
  const pressTimerRef = useRef<number | null>(null);
  const pressRafRef = useRef<number | null>(null);
  const pressStartRef = useRef<number>(0);
  const dateTriggerRef = useRef<HTMLSpanElement | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerValue, setPickerValue] = useState<string>(effectiveDate);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const [confirmDuplicateOpen, setConfirmDuplicateOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<CalibrationFormPayload | null>(null);

  // Preserves the last-submitted payload so a failed request (offline blip,
  // transient server error) never loses what the employee already entered —
  // CalibrationForm itself keeps the live form state; this only guards the
  // moment between submit and a possible retry.
  const [lastPayload, setLastPayload] = useState<CalibrationFormPayload | null>(null);

  // Generated once for this page's lifetime and resent unchanged on every
  // retry (including the explicit Retry button below) — the server
  // recognizes a resend of the same id as the same completion attempt
  // rather than a duplicate record.
  const [completionRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/pest/calibration/devices/${deviceId}/start`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "Failed to load calibration form.");
        }
        const data = (await res.json()) as DeviceDetail;
        if (!cancelled) setDetail(data);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Failed to load calibration form.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  // Safe cleanup on unmount — never leaves a pending timeout/rAF running
  // against an unmounted component.
  useEffect(() => {
    return () => {
      if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
      if (pressRafRef.current !== null) window.cancelAnimationFrame(pressRafRef.current);
    };
  }, []);

  async function submit(payload: CalibrationFormPayload) {
    if (!deviceId) return;
    setLastPayload(payload);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/pest/calibration/devices/${deviceId}/complete`, {
        method: "POST",
        body: JSON.stringify({ ...payload, completion_request_id: completionRequestId, effectiveDate })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to save calibration record.");
      }
      const data = (await res.json()) as CompletionResult;
      setResult(data);
      setEffectiveDate(todayDateString());
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to save calibration record.");
    } finally {
      setSubmitting(false);
    }
  }

  // CalibrationForm's own submit only fires once its internal validation
  // passes. Before actually saving, check (advisory only — the server does
  // not enforce any uniqueness rule) whether a record already exists for
  // this device on the selected date, and if so confirm with the employee
  // first. This is separate from the long-press date unlock itself.
  async function handleFormSubmit(payload: CalibrationFormPayload) {
    if (!deviceId) return;
    setSubmitError(null);

    try {
      const checkRes = await apiFetch(
        `/api/pest/calibration/devices/${deviceId}/effective-date-check?date=${encodeURIComponent(effectiveDate)}`
      );
      if (checkRes.ok) {
        const checkData = (await checkRes.json()) as { existing_record: boolean };
        if (checkData.existing_record) {
          setPendingPayload(payload);
          setConfirmDuplicateOpen(true);
          return;
        }
      }
    } catch {
      // Advisory check only — if it can't be reached, fall through to the
      // real submit, which is always the authoritative path.
    }

    await submit(payload);
  }

  function confirmDuplicateAndSubmit() {
    setConfirmDuplicateOpen(false);
    const payload = pendingPayload;
    setPendingPayload(null);
    if (payload) void submit(payload);
  }

  function startPressTimer() {
    if (pressTimerRef.current !== null) return; // already timing — ignore a duplicate start
    setPressing(true);
    setPressProgress(0);
    pressStartRef.current = performance.now();

    function tick() {
      const elapsed = performance.now() - pressStartRef.current;
      setPressProgress(Math.min(1, elapsed / LONG_PRESS_MS));
      if (elapsed < LONG_PRESS_MS) {
        pressRafRef.current = window.requestAnimationFrame(tick);
      }
    }
    pressRafRef.current = window.requestAnimationFrame(tick);

    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      setPressing(false);
      openPicker();
    }, LONG_PRESS_MS);
  }

  function cancelPressTimer() {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (pressRafRef.current !== null) {
      window.cancelAnimationFrame(pressRafRef.current);
      pressRafRef.current = null;
    }
    setPressing(false);
    setPressProgress(0);
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
    setPickerValue(effectiveDate);
    setPickerError(null);
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
      setPickerError("Calibration date cannot be in the future.");
      return;
    }
    if (pickerValue < min) {
      setPickerError(`Calibration date cannot be more than ${MAX_BACKDATE_DAYS} days in the past.`);
      return;
    }
    setEffectiveDate(pickerValue);
    setPickerOpen(false);
    dateTriggerRef.current?.focus();
  }

  function returnToToday() {
    setEffectiveDate(todayDateString());
  }

  return (
    <section className="mobile-page">
      <div className="calibration-header-row">
        <h2>{detail?.device.name ?? "Calibration"}</h2>
        <span
          ref={dateTriggerRef}
          className="calibration-header-date"
          role="button"
          tabIndex={0}
          aria-label={`Calibration date ${formatDisplayDate(effectiveDate, "long")}. Press and hold for three seconds to select a previous date.`}
          onPointerDown={handleDatePointerDown}
          onPointerUp={cancelPressTimer}
          onPointerLeave={cancelPressTimer}
          onPointerCancel={cancelPressTimer}
          onKeyDown={handleDateKeyDown}
          onKeyUp={handleDateKeyUp}
        >
          {formatDisplayDate(effectiveDate)}
          {pressing ? (
            <span className="calibration-date-hold-progress" aria-hidden="true">
              <span className="calibration-date-hold-progress-fill" style={{ width: `${pressProgress * 100}%` }} />
            </span>
          ) : null}
        </span>
      </div>

      {effectiveDate !== todayDateString() ? (
        <div className="calibration-backdate-notice">
          <span>Backdated calibration — this record will be saved for {formatDisplayDate(effectiveDate, "long")}.</span>
          <button type="button" className="calibration-use-today-link" onClick={returnToToday}>
            Use Today
          </button>
        </div>
      ) : null}

      {loading ? <p>Loading…</p> : null}
      {loadError ? <p className="form-error">{loadError}</p> : null}

      {result ? (
        <div>
          <p><strong>Calibration completed for {formatDisplayDate(result.effective_date, "long")}.</strong></p>
          {result.next_due_at ? (
            <p>Next due: {new Date(result.next_due_at).toLocaleDateString()}</p>
          ) : (
            <p>This device is calibrated on demand — no next due date.</p>
          )}
          <button type="button" className="primary-action-button" onClick={() => navigate("/mobile/calibration")}>
            Done
          </button>
        </div>
      ) : detail ? (
        <>
          <CalibrationForm detail={detail} onValidSubmit={(payload) => void handleFormSubmit(payload)} submitting={submitting} />
          {submitError ? (
            <div>
              <p className="form-error">{submitError}</p>
              {lastPayload ? (
                <button type="button" onClick={() => void submit(lastPayload)} disabled={submitting}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {confirmDuplicateOpen ? (
        <ModalOverlay
          onClose={() => setConfirmDuplicateOpen(false)}
          contentClassName="calibration-duplicate-confirm-modal"
          titleId="calibration-duplicate-confirm-title"
        >
          <h3 id="calibration-duplicate-confirm-title">Calibration already recorded for this date</h3>
          <p>
            A calibration record already exists for this device on {formatDisplayDate(effectiveDate, "long")}. Are you
            sure you want to save another record for the same date?
          </p>
          <div className="form-actions">
            <button type="button" onClick={confirmDuplicateAndSubmit}>
              Save Another Record
            </button>
            <button type="button" className="secondary" onClick={() => { setConfirmDuplicateOpen(false); setPendingPayload(null); }}>
              Cancel
            </button>
          </div>
        </ModalOverlay>
      ) : null}

      {pickerOpen ? (
        <ModalOverlay
          onClose={closePicker}
          contentClassName="calibration-date-picker-modal"
          titleId="calibration-date-picker-title"
        >
          <h3 id="calibration-date-picker-title">Select Calibration Date</h3>
          <p className="calibration-date-picker-current">Current: {formatDisplayDate(pickerValue, "long")}</p>
          <label className="calibration-date-picker-field">
            Calibration date
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
          <p className="calibration-date-picker-bounds">
            Earliest: {formatDisplayDate(minSelectableDateString(), "long")} · Latest: {formatDisplayDate(todayDateString(), "long")}
          </p>
          {pickerError ? <p className="form-error">{pickerError}</p> : null}
          <div className="form-actions">
            <button type="button" onClick={confirmPicker}>
              Use This Date
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
