import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  addDays,
  buildDailyPackMap,
  fetchYieldEntriesForHistory,
  formatWeekRangeLabel,
  getWeekStart,
  getWeekStartsWithData,
  localIsoDate,
  parseIsoDate,
  type PackedVarietyEntry,
  type YieldEntryForHistory
} from "../lib/yieldEntries/packHistory";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKS_PER_PAGE = 4;

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatAverageFruitWeight(afwG: number | null): string {
  return afwG === null ? "—" : `${Math.round(afwG)} g`;
}

type DayCard = {
  isoDate: string;
  dayName: string;
  shortDate: string;
  isToday: boolean;
  varieties: PackedVarietyEntry[];
};

type WeekSection = {
  weekStartIso: string;
  weekStart: Date;
  days: DayCard[];
  totalKg: number;
};

export function PackHistoryTab() {
  const [entries, setEntries] = useState<YieldEntryForHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayIso = useMemo(() => localIsoDate(today), [today]);
  const currentWeekStartIso = useMemo(() => localIsoDate(getWeekStart(today)), [today]);

  const [anchorWeekStartIso, setAnchorWeekStartIso] = useState<string>(currentWeekStartIso);
  const [olderBatchesLoaded, setOlderBatchesLoaded] = useState(0);
  const [jumpDate, setJumpDate] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchYieldEntriesForHistory()
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(
            fetchError instanceof Error ? fetchError.message : "Failed to load pack history"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const dailyPackMap = useMemo(() => buildDailyPackMap(entries), [entries]);
  const weekStartsWithData = useMemo(() => getWeekStartsWithData(dailyPackMap), [dailyPackMap]);

  function buildWeekSection(weekStart: Date): WeekSection {
    const days: DayCard[] = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(weekStart, i);
      const isoDate = localIsoDate(day);
      const varieties = dailyPackMap.get(isoDate) ?? [];

      return {
        isoDate,
        dayName: DAY_NAMES[i],
        shortDate: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        isToday: isoDate === todayIso,
        varieties
      };
    });

    const totalKg = days.reduce(
      (sum, day) => sum + day.varieties.reduce((s, v) => s + v.kg, 0),
      0
    );

    return { weekStartIso: localIsoDate(weekStart), weekStart, days, totalKg };
  }

  const weekSections = useMemo(() => {
    const anchorWeekStart = parseIsoDate(anchorWeekStartIso);

    const initialWeekStarts: Date[] = Array.from({ length: WEEKS_PER_PAGE }, (_, i) =>
      addDays(anchorWeekStart, -7 * i)
    );
    const oldestInitial = initialWeekStarts[initialWeekStarts.length - 1];

    const olderCandidates = Array.from(weekStartsWithData)
      .map((iso) => parseIsoDate(iso))
      .filter((d) => d.getTime() < oldestInitial.getTime())
      .sort((a, b) => b.getTime() - a.getTime());

    const olderToShow = olderCandidates.slice(0, olderBatchesLoaded * WEEKS_PER_PAGE);

    return [...initialWeekStarts, ...olderToShow].map(buildWeekSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorWeekStartIso, weekStartsWithData, olderBatchesLoaded, dailyPackMap, todayIso]);

  const oldestShownWeekStart =
    weekSections.length > 0
      ? weekSections[weekSections.length - 1].weekStart
      : parseIsoDate(anchorWeekStartIso);

  const hasMoreOlderWeeks = useMemo(
    () =>
      Array.from(weekStartsWithData).some(
        (iso) => parseIsoDate(iso).getTime() < oldestShownWeekStart.getTime()
      ),
    [weekStartsWithData, oldestShownWeekStart]
  );

  const isViewingHistory = anchorWeekStartIso !== currentWeekStartIso;

  function handleLoadEarlier() {
    setOlderBatchesLoaded((n) => n + 1);
  }

  function handleBackToLatest() {
    setAnchorWeekStartIso(currentWeekStartIso);
    setOlderBatchesLoaded(0);
    setJumpError(null);
  }

  function handleJumpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!jumpDate) {
      setJumpError("Pick a date first.");
      return;
    }

    setJumpError(null);
    const picked = parseIsoDate(jumpDate);
    setAnchorWeekStartIso(localIsoDate(getWeekStart(picked)));
    setOlderBatchesLoaded(0);
  }

  return (
    <div className="pack-history-tab">
      <div className="coming-soon-card pack-history-controls-card">
        <form className="pack-history-jump-form" onSubmit={handleJumpSubmit}>
          <label htmlFor="pack-history-jump-date">Jump to week</label>
          <input
            id="pack-history-jump-date"
            type="date"
            value={jumpDate}
            onChange={(event) => setJumpDate(event.target.value)}
          />
          <button type="submit" className="cases-entry-open-button">
            Go
          </button>
        </form>

        {isViewingHistory && (
          <button type="button" className="cases-entry-open-button" onClick={handleBackToLatest}>
            Back to Latest
          </button>
        )}
      </div>

      {jumpError && <p className="form-error">{jumpError}</p>}
      {error && <p className="form-error">{error}</p>}
      {loading && <p>Loading pack history...</p>}

      {!loading &&
        !error &&
        weekSections.map((week) => (
          <div key={week.weekStartIso} className="coming-soon-card pack-history-week-card">
            <div className="pack-history-week-header">
              <h2>{formatWeekRangeLabel(week.weekStart)}</h2>
              <span className="pack-history-week-total">{roundTo(week.totalKg, 1)} kg</span>
            </div>

            <div className="week-day-grid">
              {week.days.map((day) => (
                <div
                  key={day.isoDate}
                  className={`week-day-col${day.isToday ? " week-day-today" : ""}`}
                >
                  <div className="week-day-header">
                    <span className="week-day-name">{day.dayName}</span>
                    <span className="week-day-date">{day.shortDate}</span>
                  </div>
                  {day.varieties.length === 0 ? (
                    <p className="week-day-empty">No entries</p>
                  ) : (
                    <ul className="week-day-entries">
                      {day.varieties.map((variety) => (
                        <li key={variety.varietyId} className="week-day-entry">
                          <div className="week-day-entry-main">
                            <span className="week-day-variety">{variety.name}</span>
                            <span className="week-day-kg">{roundTo(variety.kg, 1)} kg</span>
                          </div>
                          <span className="week-day-afw">
                            {formatAverageFruitWeight(variety.averageFruitWeightG)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

      {!loading && !error && hasMoreOlderWeeks && (
        <div className="pack-history-load-more">
          <button type="button" className="cases-entry-open-button" onClick={handleLoadEarlier}>
            Load Earlier Weeks
          </button>
        </div>
      )}
    </div>
  );
}
