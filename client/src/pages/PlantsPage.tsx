import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { buildPlantingBoard, type Measure, type PlantingCard, type PlantingStatus, type PlantingsData } from "../lib/plants/plantingCards";

// Crop Planner → Plants (stage 1, read-only): what is planted where, as cards
// sorted into Active, Upcoming and Past. Built from Greenhouse Setup's live
// assignments and each variety's dates; nothing on this page writes.

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

const SECTIONS: Array<{ status: PlantingStatus; title: string; empty: string }> = [
  { status: "active", title: "Active", empty: "Nothing is planted today." },
  { status: "upcoming", title: "Upcoming", empty: "No plantings scheduled after today." },
  { status: "past", title: "Past", empty: "No past plantings." }
];

const COLOR_SWATCH: Record<string, string> = { red: "#d64545", orange: "#e8862a", yellow: "#e2c12b", green: "#3f9a4f" };

/** "12,000" or "12,000 + 2 rows missing" — a missing input is never shown as 0. */
function MeasureValue({ measure, unit, digits = 0 }: { measure: Measure; unit?: string; digits?: number }) {
  return (
    <>
      {fmt(measure.value, digits)}
      {unit ? ` ${unit}` : ""}
      {measure.missingRows ? (
        <span className="plants-missing" title="Rows missing an input are not counted">
          {" "}+ {measure.missingRows} row{measure.missingRows === 1 ? "" : "s"} missing
        </span>
      ) : null}
    </>
  );
}

function PlantingCardView({ card }: { card: PlantingCard }) {
  const multiPhase = card.phases.length > 1;
  return (
    <article className="plants-card" aria-label={card.varietyName}>
      <header className="plants-card-head">
        <h3>
          {card.color && COLOR_SWATCH[card.color] ? <span className="plants-swatch" style={{ background: COLOR_SWATCH[card.color] }} aria-hidden="true" /> : null}
          {card.varietyName}
        </h3>
        {card.cropName ? <span className="plants-crop">{card.cropName}</span> : null}
      </header>
      <p className="plants-dates">
        <span>Planted {card.plantingDate ? formatDate(card.plantingDate) : <span className="plants-missing">no date</span>}</span>
        <span>Pull-out {card.pullOutDate ? formatDate(card.pullOutDate) : <span className="plants-muted">not set</span>}</span>
      </p>
      {multiPhase ? null : (
        <p className="plants-rows">
          {card.phases[0].groupName} · row{card.phases[0].rowNumbers.length === 1 ? "" : "s"} {card.phases[0].rowsLabel}
        </p>
      )}
      <dl className="plants-totals">
        <div><dt>Rows</dt><dd>{fmt(card.rowCount)}</dd></div>
        <div><dt>Area</dt><dd><MeasureValue measure={card.m2} unit="m²" digits={1} /></dd></div>
        <div><dt>Plants</dt><dd><MeasureValue measure={card.plants} /></dd></div>
        <div><dt>Heads</dt><dd><MeasureValue measure={card.heads} /></dd></div>
      </dl>
      {multiPhase ? (
        <table className="plants-phase-table" aria-label={`${card.varietyName} by phase`}>
          <thead>
            <tr><th scope="col">Phase</th><th scope="col">Rows</th><th scope="col">m²</th><th scope="col">Plants</th><th scope="col">Heads</th></tr>
          </thead>
          <tbody>
            {card.phases.map((line) => (
              <tr key={line.groupId}>
                <th scope="row">{line.groupName}</th>
                <td>{line.rowsLabel}</td>
                <td><MeasureValue measure={line.m2} digits={1} /></td>
                <td><MeasureValue measure={line.plants} /></td>
                <td><MeasureValue measure={line.heads} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {card.issues.length ? (
        <ul className="plants-issues" aria-label="Needs attention">
          {card.issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
    </article>
  );
}

export function PlantsPage() {
  const [data, setData] = useState<PlantingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/crop-planner/plantings");
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "Failed to load plantings.");
        }
        const json = (await res.json()) as PlantingsData;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load plantings.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const board = useMemo(() => (data ? buildPlantingBoard(data) : null), [data]);

  return (
    <section className="page-shell plants-page">
      <header>
        <h1>Plants</h1>
        <p>
          What is planted where, from the variety assignments in <Link to="/setup/greenhouse">Greenhouse Setup</Link> and each
          variety's planting and pull-out dates. Read-only for now.
        </p>
        {data ? <p className="plants-muted">Today is {formatDate(data.today)} in the greenhouse's time zone ({data.timeZone}).</p> : null}
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!board && !error ? <p className="plants-muted">Loading plantings…</p> : null}
      {board
        ? SECTIONS.map(({ status, title, empty }) => {
            const cards = board[status];
            const body = cards.length ? (
              <div className="plants-grid">{cards.map((card) => <PlantingCardView key={card.varietyId} card={card} />)}</div>
            ) : (
              <p className="plants-muted">{empty}</p>
            );
            return status === "past" ? (
              <details key={status} className="plants-section" aria-label={`${title} plantings`}>
                <summary><h2>{title} <span className="plants-count">({cards.length})</span></h2></summary>
                {body}
              </details>
            ) : (
              <section key={status} className="plants-section" aria-label={`${title} plantings`}>
                <h2>{title} <span className="plants-count">({cards.length})</span></h2>
                {body}
              </section>
            );
          })
        : null}
    </section>
  );
}
