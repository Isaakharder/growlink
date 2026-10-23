import { useCallback, useEffect, useState, type FormEvent } from "react";
import { isoWeekOf, isoWeeksInYear } from "../lib/isoWeek";
import { createRebuildRange, deleteRebuildRange, fetchRebuildRanges, type RebuildRangeView } from "../lib/manualPackEntries";

// Historical rebuild: explicit spans of ISO weeks whose shipped totals come
// from manual pack entries, entered or not. Colour totals never count inside
// a range (so a DockLink colour sync can't bring them back); weeks with
// nothing entered read "not entered yet" until entries are added or the week
// is confirmed as having no shipments.

const label = (w: { isoYear: number; isoWeek: number }) => `${w.isoYear}-W${String(w.isoWeek).padStart(2, "0")}`;

function WeekPicker({ legend, year, week, onChange }: { legend: string; year: number; week: number; onChange: (y: number, w: number) => void }) {
  const now = isoWeekOf(new Date()).isoYear;
  const years = Array.from({ length: 8 }, (_, i) => now - 6 + i);
  return (
    <>
      <label>
        <span>{legend} ISO year</span>
        <select value={year} onChange={(e) => onChange(Number(e.target.value), Math.min(week, isoWeeksInYear(Number(e.target.value))))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{legend} ISO week</span>
        <select value={week} onChange={(e) => onChange(year, Number(e.target.value))}>
          {Array.from({ length: isoWeeksInYear(year) }, (_, i) => i + 1).map((w) => (
            <option key={w} value={w}>
              W{String(w).padStart(2, "0")}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function RebuildRangesPanel({ refreshKey = 0, onChanged }: { refreshKey?: number; onChanged?: () => void }) {
  const current = isoWeekOf(new Date());
  const [ranges, setRanges] = useState<RebuildRangeView[] | null>(null);
  const [from, setFrom] = useState({ isoYear: current.isoYear - 1, isoWeek: 1 });
  const [to, setTo] = useState(current);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRanges((await fetchRebuildRanges()).ranges);
    } catch (loadError) {
      setMessage({ kind: "error", text: loadError instanceof Error ? loadError.message : "Failed to load rebuild ranges" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { range } = await createRebuildRange({ fromIsoYear: from.isoYear, fromIsoWeek: from.isoWeek, toIsoYear: to.isoYear, toIsoWeek: to.isoWeek, note: note.trim() || null });
      setMessage({ kind: "success", text: `${label(range.from)} to ${label(range.to)} now uses manual pack entries (${range.weeks} weeks).` });
      setNote("");
      await load();
      onChanged?.();
    } catch (addError) {
      setMessage({ kind: "error", text: addError instanceof Error ? addError.message : "Failed to save the range" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(range: RebuildRangeView) {
    const ok = window.confirm(
      `Remove the rebuild range ${label(range.from)} to ${label(range.to)}?\n\nIts manual entries are kept, but each week goes back to its own rules: weeks with colour totals and no explicit choice will count colour totals again.`
    );
    if (!ok) return;
    try {
      await deleteRebuildRange(range.id);
      setMessage({ kind: "success", text: `Removed the rebuild range ${label(range.from)} to ${label(range.to)}.` });
      await load();
      onChanged?.();
    } catch (removeError) {
      setMessage({ kind: "error", text: removeError instanceof Error ? removeError.message : "Failed to remove the range" });
    }
  }

  return (
    <section className="coming-soon-card rebuild-ranges" aria-labelledby="rebuild-ranges-title">
      <h2 id="rebuild-ranges-title">Historical rebuild</h2>
      <p className="pack-week-note">
        Weeks in a rebuild range always use manual pack entries, entered or not — colour totals never count there, even after a DockLink
        sync. A week with nothing entered shows as <strong>not entered yet</strong> until you add its invoices or confirm it had no
        shipments. DockLink's pack totals still take over any week DockLink covers.
      </p>
      {ranges && ranges.length > 0 ? (
        <ul>
          {ranges.map((r) => (
            <li key={r.id}>
              <span>
                <strong>
                  {label(r.from)} to {label(r.to)}
                </strong>
                {r.note ? ` · ${r.note}` : ""}
                <span className="rebuild-range-progress">
                  {" "}
                  — {r.weeks} weeks: {r.entered} entered, {r.confirmed} confirmed, {r.notEntered} not entered yet
                  {r.docklinkWeeks > 0 ? `, ${r.docklinkWeeks} counted from DockLink` : ""}
                </span>
              </span>
              <button type="button" onClick={() => void remove(r)} aria-label={`Remove rebuild range ${label(r.from)} to ${label(r.to)}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : ranges ? (
        <p className="pack-week-note">No rebuild ranges yet.</p>
      ) : null}
      <form className="rebuild-range-form" onSubmit={add} aria-label="Add a rebuild range">
        <WeekPicker legend="From" year={from.isoYear} week={from.isoWeek} onChange={(isoYear, isoWeek) => setFrom({ isoYear, isoWeek })} />
        <WeekPicker legend="To" year={to.isoYear} week={to.isoWeek} onChange={(isoYear, isoWeek) => setTo({ isoYear, isoWeek })} />
        <label>
          <span>Note (optional)</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add rebuild range"}
        </button>
      </form>
      {message ? (
        <p className={`cases-sync-status cases-sync-status--${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
