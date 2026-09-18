import { useEffect, useRef, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { completeSchedule, getSchedule } from "./api";
import { formatDate, recurrenceLabel } from "./formatters";
import { ScheduleCompletion, ScheduleDetail } from "./types";

type Props = {
  scheduleId: string;
  onClose: () => void;
  onCompleted: (completion: ScheduleCompletion) => void;
};

type LoadState = { status: "loading" } | { status: "loaded"; schedule: ScheduleDetail } | { status: "error"; message: string };

export function ScheduleCompleteSheet({ scheduleId, onClose, onCompleted }: Props) {
  const { isOnline } = useOnlineStatus();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generated once per open attempt and reused across retries of the same
  // submission so a network retry never double-completes the occurrence —
  // matches the server's completion_request_id idempotency contract.
  const requestIdRef = useRef(crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getSchedule(scheduleId)
      .then((schedule) => {
        if (cancelled) return;
        setState({ status: "loaded", schedule });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load schedule." });
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || state.status !== "loaded") return;
    setError(null);
    setSaving(true);

    try {
      const completion = await completeSchedule(scheduleId, {
        completion_request_id: requestIdRef.current,
        notes: notes.trim() || null,
        checklist_responses: state.schedule.checklist_items
          .filter((item): item is { id: string; label: string; sort_order: number } => Boolean(item.id))
          .map((item) => ({ checklist_item_id: item.id, checked: Boolean(checked[item.id]) }))
      });
      onCompleted(completion);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete maintenance.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="schedule-complete-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="schedule-complete-title">Complete Maintenance</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="maintenance-sheet-body">
        {state.status === "loading" ? <p>Loading…</p> : null}
        {state.status === "error" ? <p className="form-error">{state.message}</p> : null}

        {state.status === "loaded" ? (
          <form className="maintenance-form" onSubmit={(event) => void submit(event)}>
            <h3>{state.schedule.name}</h3>
            <p>
              {recurrenceLabel(state.schedule.recurrence_type, state.schedule.recurrence_interval)} · Due {formatDate(state.schedule.next_due_date)}
            </p>
            {state.schedule.instructions ? <p className="maintenance-instructions">{state.schedule.instructions}</p> : null}

            {state.schedule.checklist_items.length > 0 ? (
              <div className="maintenance-checklist">
                {state.schedule.checklist_items.map((item) =>
                  item.id ? (
                    <label key={item.id} className="maintenance-checkbox-row">
                      <input
                        type="checkbox"
                        checked={Boolean(checked[item.id])}
                        onChange={(event) => setChecked((current) => ({ ...current, [item.id as string]: event.target.checked }))}
                      />
                      {item.label}
                    </label>
                  ) : null
                )}
              </div>
            ) : null}

            <label>
              Completion notes (optional)
              <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>

            {error ? <p className="form-error">{error}</p> : null}
            {!isOnline ? <p className="form-error">You're offline — reconnect to submit this completion.</p> : null}

            <button type="submit" disabled={saving || !isOnline}>
              {saving ? "Saving…" : "Mark Complete"}
            </button>
          </form>
        ) : null}
      </div>
    </ModalOverlay>
  );
}
