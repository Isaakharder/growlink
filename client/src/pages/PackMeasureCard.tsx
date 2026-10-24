import { PEPPER_COLORS, formatCases, formatShippedKg, type PepperColor } from "../lib/shippedYield";
import {
  COLOR_LABEL,
  formatPerCase,
  matchesRemembered,
  measurementPayload,
  rememberPayload,
  saveState,
  statusText,
  weekLabel,
  type Draft,
  type PackRow,
  type RememberKind,
  type RememberedSlot,
  type WeekRef
} from "./packMeasure";

// One pack's card on the weekly pack screen: what shipped, the kg the server
// calculated, and this week's measurement inputs with Save / Remember.

/** What the card is doing right now: saving this week's measurement, remembering a value, clearing or forgetting. */
export type CardBusy = "save" | "clear" | RememberKind | `forget:${RememberKind}` | null;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const hasKg = (row: PackRow) => row.status === "measured" || row.status === "remembered";
/** Accessible names (full) and visible labels (short) for the Remember buttons. */
const REMEMBER_NAMES: Record<RememberKind, string> = {
  net_kg: "Remember for future weeks",
  counts: "Remember counts for future weeks",
  fruit_weights: "Remember fruit weights for future weeks"
};
const REMEMBER_SHORT: Record<RememberKind, string> = { net_kg: "Remember", counts: "Remember counts", fruit_weights: "Remember weights" };
const FORGET_NAMES: Record<RememberKind, string> = {
  net_kg: "Forget remembered weight",
  counts: "Forget remembered counts",
  fruit_weights: "Forget remembered fruit weights"
};

function ColourChip({ row }: { row: PackRow }) {
  if (row.colorKind === "mixed") {
    return (
      <span className="pack-card-chip pack-card-chip--mixed">
        <span className="pack-card-rainbow-dots" aria-hidden="true">
          {(["red", "orange", "yellow", "green"] as const).map((c) => (
            <span key={c} className={`weekly-docklink-dot weekly-docklink-dot-${c}`} />
          ))}
        </span>
        Rainbow
      </span>
    );
  }
  const tracked = (PEPPER_COLORS as readonly string[]).includes(row.colorKey ?? "");
  return (
    <span className="pack-card-chip">
      {tracked ? <span className={`weekly-docklink-dot weekly-docklink-dot-${row.colorKey}`} aria-hidden="true" /> : null}
      {cap(row.colorKey ?? "") || "No colour"}
      {tracked ? null : <span className="pack-card-chip-note"> · not tracked</span>}
    </span>
  );
}

const shortWeek = (w: WeekRef | null) => (w ? `W${String(w.isoWeek).padStart(2, "0")}` : "");

/** The remembered values in effect, one short line each (the value, and the week it took effect). */
function rememberedSummary(row: PackRow): Array<{ kind: RememberKind; text: string; slot: RememberedSlot<unknown> }> {
  const r = row.remembered;
  if (!r) return [];
  if (row.colorKind === "single") {
    return r.netKgPerCase.value !== null
      ? [{ kind: "net_kg", text: `Remembered ${formatPerCase(r.netKgPerCase.value)} from ${shortWeek(r.netKgPerCase.from)}`, slot: r.netKgPerCase }]
      : [];
  }
  const out: Array<{ kind: RememberKind; text: string; slot: RememberedSlot<unknown> }> = [];
  if (r.counts.value) {
    out.push({ kind: "counts", text: `Remembered counts ${r.counts.value.map((c) => `${COLOR_LABEL[c.color].charAt(0)} ${c.piecesPerCase}`).join(" · ")} from ${shortWeek(r.counts.from)}`, slot: r.counts });
  }
  if (r.fruitWeights.value) {
    out.push({ kind: "fruit_weights", text: `Remembered weights ${r.fruitWeights.value.map((c) => `${COLOR_LABEL[c.color].charAt(0)} ${c.fruitWeightG} g`).join(" · ")} from ${shortWeek(r.fruitWeights.from)}`, slot: r.fruitWeights });
  }
  return out;
}

export function PackMeasureCard({
  row,
  draft,
  baseline,
  week,
  source,
  busy,
  error,
  notices,
  onDraft,
  onSave,
  onRemember,
  onClear,
  onForget
}: {
  row: PackRow;
  draft: Draft | undefined;
  baseline: Draft | undefined;
  week: WeekRef;
  source: "packs" | "manual" | "legacy";
  busy: CardBusy;
  error: string | null;
  notices: Partial<Record<RememberKind, string>>;
  onDraft: (update: (d: Draft) => Draft) => void;
  onSave: () => void;
  onRemember: (kind: RememberKind) => void;
  onClear: () => void;
  onForget: (kind: RememberKind) => void;
}) {
  const status = statusText(row);
  const editable = Boolean(row.measurementKey && draft) && row.status !== "no_shipments";
  const mixed = row.colorKind === "mixed";

  const header = (
    <header className="pack-card-header">
      <h4 className="pack-week-name">{row.name}</h4>
      <span className={`pack-card-status pack-card-status--${status.tone}`}>{status.label}</span>
      <div className="pack-card-tags">
        {row.packCode ? <span className="pack-week-code">{row.packCode}</span> : null}
        <ColourChip row={row} />
        {row.packStatus === "archived" ? <span className="pack-week-badge">Archived</span> : null}
        {row.packStatus === "not_in_catalogue" ? <span className="pack-week-badge">No longer in DockLink</span> : null}
        {row.packStatus === "historical" ? <span className="pack-week-badge">Historical</span> : null}
      </div>
    </header>
  );

  if (!editable) {
    return (
      <article className={`pack-card pack-card--compact pack-card--${row.status}`} aria-label={row.name} data-series-key={row.seriesKey ?? undefined}>
        {header}
      </article>
    );
  }

  const d = draft as Draft;
  const dirty = Boolean(baseline) && saveState(row, d, baseline, false) === "unsaved";
  const state = saveState(row, d, baseline, busy === "save");
  const measurement = measurementPayload(row, d);
  const invalid = dirty && !measurement.ok && measurement.error ? measurement.error : null;
  const canSave = dirty && measurement.ok && busy === null;
  const kinds: RememberKind[] = mixed ? ["counts", "fruit_weights"] : ["net_kg"];
  const remembered = rememberedSummary(row);
  const notes = [
    row.currentName || row.currentPackCode ? `Now “${row.currentName ?? row.name}”${row.currentPackCode ? ` (${row.currentPackCode})` : ""}` : null,
    row.reclassifiedSince ? "Classification changed since; kg uses its ship-time colour." : null,
    row.description
  ].filter((n): n is string => Boolean(n));
  // Longer explanations, kept out of the way under Details.
  const details = [
    ...remembered.filter((r) => r.slot.nextChange).map((r) => `A different remembered value takes over from ${weekLabel(r.slot.nextChange as WeekRef)}.`),
    row.status === "measured" && remembered.length > 0 ? "This week's own measurement is used instead of the remembered values; Clear it to use them." : null,
    mixed && remembered.length > 0 && row.status !== "remembered" && row.status !== "measured"
      ? row.remembered?.counts.value && !row.remembered.fruitWeights.value
        ? "Remembered counts are filled in. Enter this week's fruit weights and Save, or remember fruit weights too."
        : row.remembered?.fruitWeights.value && !row.remembered.counts.value
          ? "Remembered fruit weights are filled in. Enter this week's peppers per case and Save, or remember counts too."
          : "The remembered fruit weights don't cover every remembered colour; enter the missing ones and Save or remember them."
      : null,
    remembered.length > 0 ? `Remember applies from ${weekLabel(week)} on, in weeks without their own measurement; earlier weeks and saved measurements aren't changed.` : null
  ].filter((n): n is string => Boolean(n));

  const setComponent = (color: PepperColor, field: "piecesPerCase" | "fruitWeightG", value: string) =>
    onDraft((x) => ({ ...x, components: { ...x.components, [color]: { ...x.components[color], [field]: value } } }));

  return (
    <article className={`pack-card pack-card--${row.status}`} aria-label={row.name} data-series-key={row.seriesKey ?? undefined}>
      {header}

      <dl className="pack-card-stats">
        <div>
          <dt>{source === "packs" ? "Shipped" : "Entered"}</dt>
          <dd>{formatCases(row.cases)} cases</dd>
        </div>
        {row.entryCount ? (
          <div>
            <dt className="ya-visually-hidden">Entries</dt>
            <dd>{row.entryCount === 1 ? "1 entry" : `${row.entryCount} entries`}</dd>
          </div>
        ) : row.loadCount ? (
          <div>
            <dt className="ya-visually-hidden">Loads</dt>
            <dd>{row.loadCount === 1 ? "1 load" : `${row.loadCount} loads`}</dd>
          </div>
        ) : null}
        <div className="pack-card-stat-kg">
          <dt className="ya-visually-hidden">Shipped kg</dt>
          <dd>
            <span>{hasKg(row) && row.kg !== null ? formatShippedKg(row.kg) : row.cases > 0 ? "Not measured" : "—"}</span>
          </dd>
        </div>
      </dl>

      {notes.length > 0 ? (
        <ul className="pack-card-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      {mixed ? (
        <div className="pack-card-rainbow" role="group" aria-label={`Colour breakdown per shipping case for ${row.name}`}>
          <div className="pack-card-rainbow-row pack-card-rainbow-head" aria-hidden="true">
            <span>Colour</span>
            <span>Pcs/case</span>
            <span>Fruit g</span>
            <span>kg</span>
          </div>
          {PEPPER_COLORS.map((color) => (
            <div key={color} className="pack-card-rainbow-row">
              <span className="pack-card-rainbow-colour">
                <span className={`weekly-docklink-dot weekly-docklink-dot-${color}`} aria-hidden="true" />
                {COLOR_LABEL[color]}
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={d.components[color].piecesPerCase}
                aria-label={`${COLOR_LABEL[color]} peppers per shipping case for ${row.name}`}
                onChange={(e) => setComponent(color, "piecesPerCase", e.target.value)}
              />
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                value={d.components[color].fruitWeightG}
                aria-label={`${COLOR_LABEL[color]} average fruit weight in grams for ${row.name}`}
                onChange={(e) => setComponent(color, "fruitWeightG", e.target.value)}
              />
              <span className="pack-card-rainbow-kg">{hasKg(row) && row.kgByColor?.[color] !== undefined ? formatShippedKg(row.kgByColor[color]!) : "—"}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="pack-card-actions">
        {mixed ? null : (
          <label className="pack-card-single">
            <span aria-hidden="true">Net kg/case</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={d.netKgPerCase}
              aria-label={`Average net pepper kg per shipping case for ${row.name}`}
              onChange={(e) => onDraft((x) => ({ ...x, netKgPerCase: e.target.value }))}
            />
          </label>
        )}
        <button type="button" className="pack-card-button pack-card-button--primary" onClick={onSave} disabled={!canSave} title={`Saves a measurement for ${weekLabel(week)} only`}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        {kinds.map((kind) => {
          const value = rememberPayload(d, kind);
          const same = matchesRemembered(row, d, kind);
          return (
            <button
              key={kind}
              type="button"
              className="pack-card-button"
              aria-label={REMEMBER_NAMES[kind]}
              onClick={() => onRemember(kind)}
              disabled={busy !== null || !value.ok || same}
              title={
                same
                  ? "Already remembered for this week."
                  : `Use from ${weekLabel(week)} on, in weeks without their own measurement. Earlier weeks and saved measurements aren't changed.`
              }
            >
              {busy === kind ? "Remembering…" : REMEMBER_SHORT[kind]}
            </button>
          );
        })}
        {row.measurement ? (
          <button
            type="button"
            className="pack-card-button pack-card-button--quiet"
            onClick={onClear}
            disabled={busy !== null}
            title={remembered.length > 0 ? `Clears ${weekLabel(week)}'s own measurement; the remembered values apply instead` : `Clears ${weekLabel(week)}'s measurement`}
          >
            {busy === "clear" ? "Clearing…" : "Clear"}
          </button>
        ) : null}
        <span className={`pack-card-save-state${state ? ` pack-card-save-state--${state}` : ""}`} role="status" aria-live="polite">
          {state === "saving" ? "Saving…" : state === "unsaved" ? "Unsaved changes" : state === "saved" ? "Saved ✓" : ""}
        </span>
      </div>

      {kinds.some((k) => notices[k]) ? (
        <ul className="pack-card-notices" role="status">
          {kinds.filter((k) => notices[k]).map((k) => (
            <li key={k}>{notices[k]}</li>
          ))}
        </ul>
      ) : null}

      {remembered.length > 0 ? (
        <div className="pack-card-remembered">
          {remembered.map((line) => (
            <p key={line.kind}>
              <span>{line.text}</span>
              <button type="button" className="pack-card-link" aria-label={FORGET_NAMES[line.kind]} onClick={() => onForget(line.kind)} disabled={busy !== null}>
                Forget
              </button>
            </p>
          ))}
          {details.length > 0 ? (
            <details className="pack-card-details">
              <summary>Details</summary>
              {details.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="form-error pack-card-error" role="alert">
          {error}
        </p>
      ) : invalid ? (
        <p className="form-error pack-card-error" role="alert">
          {invalid}
        </p>
      ) : null}
    </article>
  );
}
