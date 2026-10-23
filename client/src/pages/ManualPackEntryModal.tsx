import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ModalOverlay } from "../components/ModalOverlay";
import { apiFetch } from "../lib/api";
import { isoWeekOf, isoWeekRangeLabel, isoWeeksInYear } from "../lib/isoWeek";
import { formatCases } from "../lib/shippedYield";
import {
  ManualEntryConflict,
  classificationLabel,
  createHistoricalPack,
  createManualEntries,
  fetchPackCatalogue,
  packOptionValue,
  updateManualEntry,
  type ColorKind,
  type DuplicateHit,
  type ManualEntry,
  type PackCatalogue,
  type SelectablePack,
  type WeekSourceChoice
} from "../lib/manualPackEntries";

// Manual Add Case Entry: shipped cases per Product Pack for one ISO week,
// typically one invoice at a time. Several invoices for the same week and pack
// are separate entries that add up. kg comes from the week's measurements on
// the Weekly Pack Shipments panel — the same ones DockLink imports use.

type Mode = { kind: "create"; initialWeek?: { isoYear: number; isoWeek: number } } | { kind: "edit"; entry: ManualEntry };

type WeekInfo = {
  rebuildRange?: { from: { isoYear: number; isoWeek: number }; to: { isoYear: number; isoWeek: number } } | null;
  manualEntryAllowed: boolean;
  manualEntryBlockedReason: string | null;
  weekSourceChoice: WeekSourceChoice | null;
  legacyRows: Array<{ totalCases: number }>;
  manualEntries: Array<{ id: string }>;
};

type Line = { key: number; pack: string; cases: string };

const NEW_HISTORICAL = "__new_historical__";
const weekLabel = (y: number, w: number) => `${y}-W${String(w).padStart(2, "0")}`;
let lineKey = 0;
const newLine = (pack = "", cases = ""): Line => ({ key: ++lineKey, pack, cases });

const GROUPS: Array<{ status: SelectablePack["status"]; label: string }> = [
  { status: "active", label: "DockLink Product Packs" },
  { status: "archived", label: "Archived in DockLink" },
  { status: "not_in_docklink", label: "No longer in DockLink" },
  { status: "historical", label: "Historical packs (GrowLink)" }
];

export function ManualPackEntryModal({ mode, onClose, onSaved }: { mode: Mode; onClose: () => void; onSaved: (message: string) => void }) {
  const editing = mode.kind === "edit" ? mode.entry : null;
  const start = editing ? { isoYear: editing.isoYear, isoWeek: editing.isoWeek } : mode.kind === "create" && mode.initialWeek ? mode.initialWeek : isoWeekOf(new Date());

  const [year, setYear] = useState(start.isoYear);
  const [week, setWeek] = useState(start.isoWeek);
  const [invoiceRef, setInvoiceRef] = useState(editing?.invoiceRef ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    editing ? [newLine(packOptionValue(editing), String(editing.cases))] : [newLine()]
  );
  const [catalogue, setCatalogue] = useState<PackCatalogue | null>(null);
  const [weekInfo, setWeekInfo] = useState<WeekInfo | null>(null);
  const [weekSource, setWeekSource] = useState<WeekSourceChoice | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historicalFor, setHistoricalFor] = useState<number | null>(null);

  const yearOptions = useMemo(() => {
    const now = isoWeekOf(new Date()).isoYear;
    return Array.from({ length: 8 }, (_, i) => now - 6 + i).filter((y) => y <= now + 1);
  }, []);

  async function loadCatalogue() {
    try {
      setCatalogue(await fetchPackCatalogue());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load packs");
    }
  }

  useEffect(() => {
    void loadCatalogue();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWeekInfo(null);
    setWeekSource(null);
    setDuplicates(null);
    void (async () => {
      const response = await apiFetch(`/api/pack-shipments/week?isoYear=${year}&isoWeek=${week}`);
      if (!response.ok || cancelled) return;
      setWeekInfo((await response.json()) as WeekInfo);
    })();
    return () => {
      cancelled = true;
    };
  }, [year, week]);

  const packsByValue = useMemo(() => {
    const all = [...(catalogue?.docklink ?? []), ...(catalogue?.historical ?? [])];
    return new Map(all.map((p) => [packOptionValue(p), p]));
  }, [catalogue]);

  const legacyCases = (weekInfo?.legacyRows ?? []).reduce((s, r) => s + (Number(r.totalCases) || 0), 0);
  const movingWeek = editing ? editing.isoYear !== year || editing.isoWeek !== week : true;
  const rebuild = weekInfo?.rebuildRange ?? null;
  const needsChoice = Boolean(movingWeek && weekInfo && weekInfo.manualEntryAllowed && !rebuild && !weekInfo.weekSourceChoice && weekInfo.legacyRows.length > 0);
  const blocked = weekInfo && !weekInfo.manualEntryAllowed ? weekInfo.manualEntryBlockedReason : null;

  function updateLine(key: number, patch: Partial<Line>) {
    setDuplicates(null);
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function save(confirmDuplicates: boolean) {
    setError(null);
    const parsed: Array<{ packSource: SelectablePack["packSource"]; packId: string; cases: number }> = [];
    for (const [i, l] of lines.entries()) {
      const pack = packsByValue.get(l.pack);
      const cases = Number(l.cases);
      if (!pack) return setError(`Line ${i + 1}: choose a pack.`);
      if (!l.cases.trim() || !Number.isFinite(cases) || cases <= 0) return setError(`Line ${i + 1}: enter the shipped cases (greater than 0).`);
      parsed.push({ packSource: pack.packSource, packId: pack.packId, cases });
    }
    if (needsChoice && !weekSource) return setError(`Choose which source counts for ${weekLabel(year, week)}.`);

    setSaving(true);
    try {
      if (editing) {
        const [l] = parsed;
        await updateManualEntry(editing.id, {
          isoYear: year,
          isoWeek: week,
          packSource: l.packSource,
          packId: l.packId,
          cases: l.cases,
          invoiceRef: invoiceRef.trim() || null,
          note: note.trim() || null,
          weekSource,
          confirmDuplicates
        });
        onSaved(`Entry updated for ${weekLabel(year, week)}.`);
      } else {
        const result = await createManualEntries({
          isoYear: year,
          isoWeek: week,
          invoiceRef: invoiceRef.trim() || null,
          note: note.trim() || null,
          lines: parsed,
          weekSource,
          confirmDuplicates
        });
        const total = parsed.reduce((s, l) => s + l.cases, 0);
        onSaved(`Saved ${result.entries.length} pack line${result.entries.length === 1 ? "" : "s"} (${formatCases(total)} cases) for ${weekLabel(year, week)}.`);
      }
    } catch (saveError) {
      if (saveError instanceof ManualEntryConflict && saveError.code === "possible_duplicates") {
        setDuplicates(saveError.details.duplicates ?? []);
      } else {
        setError(saveError instanceof Error ? saveError.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(false);
  }

  const lineName = (i: number) => packsByValue.get(lines[i]?.pack ?? "")?.name ?? `Line ${i + 1}`;

  return (
    <ModalOverlay onClose={onClose} contentClassName="variety-modal manual-pack-modal" titleId="manual-pack-entry-title" trapFocus>
      <h2 id="manual-pack-entry-title">{editing ? "Edit case entry" : "Add case entry"}</h2>
      <p className="pack-week-note">
        Shipped <strong>shipping cases</strong> per Product Pack, from an invoice. Several invoices for the same week and pack add up.
      </p>

      <form className="manual-pack-form" onSubmit={onSubmit}>
        <div className="manual-pack-week">
          <label>
            <span>ISO year</span>
            <select
              value={year}
              onChange={(e) => {
                const y = Number(e.target.value);
                setYear(y);
                setWeek((w) => Math.min(w, isoWeeksInYear(y)));
              }}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>ISO week</span>
            <select value={week} onChange={(e) => setWeek(Number(e.target.value))}>
              {Array.from({ length: isoWeeksInYear(year) }, (_, i) => i + 1).map((w) => (
                <option key={w} value={w}>
                  W{String(w).padStart(2, "0")} · {isoWeekRangeLabel(year, w)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {blocked ? (
          <p className="form-error" role="alert">{blocked}</p>
        ) : weekInfo ? (
          needsChoice ? (
            <fieldset className="manual-pack-source">
              <legend>
                {weekLabel(year, week)} already has colour totals ({formatCases(legacyCases)} cases). Which counts for this week?
              </legend>
              <label>
                <input type="radio" name="week-source" checked={weekSource === "manual_packs"} onChange={() => setWeekSource("manual_packs")} />
                <span>
                  <strong>Manual pack entries</strong> — replace the colour totals for this week (they're kept, not counted)
                </span>
              </label>
              <label>
                <input type="radio" name="week-source" checked={weekSource === "legacy_colours"} onChange={() => setWeekSource("legacy_colours")} />
                <span>
                  <strong>Colour totals</strong> — keep counting them; these entries are recorded but not counted
                </span>
              </label>
            </fieldset>
          ) : (
            <p className="manual-pack-source-note">
              {rebuild
                ? `${weekLabel(year, week)} is part of the historical rebuild ${weekLabel(rebuild.from.isoYear, rebuild.from.isoWeek)} to ${weekLabel(rebuild.to.isoYear, rebuild.to.isoWeek)}: it always counts manual pack entries.`
                : weekInfo.weekSourceChoice === "legacy_colours"
                ? `${weekLabel(year, week)} counts colour totals (chosen). These entries are recorded but not counted until you switch the week to manual pack entries.`
                : weekInfo.weekSourceChoice === "manual_packs"
                  ? `${weekLabel(year, week)} counts manual pack entries.`
                  : `Saving makes manual pack entries the source for ${weekLabel(year, week)}.`}
            </p>
          )
        ) : (
          <p className="pack-week-note">Checking {weekLabel(year, week)}…</p>
        )}

        <div className="manual-pack-meta">
          <label>
            <span>Invoice reference (optional)</span>
            <input value={invoiceRef} maxLength={100} placeholder="e.g. INV-10423" onChange={(e) => (setDuplicates(null), setInvoiceRef(e.target.value))} />
          </label>
          <label>
            <span>Note (optional)</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <table className="manual-pack-lines">
          <thead>
            <tr>
              <th scope="col">Product Pack</th>
              <th scope="col">Shipped cases</th>
              <th scope="col">
                <span className="ya-visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const pack = packsByValue.get(l.pack);
              return (
                <tr key={l.key}>
                  <td>
                    <select
                      value={l.pack}
                      aria-label={`Pack for line ${i + 1}`}
                      onChange={(e) => {
                        if (e.target.value === NEW_HISTORICAL) setHistoricalFor(l.key);
                        else updateLine(l.key, { pack: e.target.value });
                      }}
                    >
                      <option value="">Choose a pack…</option>
                      {GROUPS.map((g) => {
                        const packs = [...(catalogue?.docklink ?? []), ...(catalogue?.historical ?? [])].filter((p) => p.status === g.status);
                        if (packs.length === 0) return null;
                        return (
                          <optgroup key={g.status} label={g.label}>
                            {packs.map((p) => (
                              <option key={packOptionValue(p)} value={packOptionValue(p)}>
                                {p.name}
                                {p.packCode ? ` (${p.packCode})` : ""} — {classificationLabel(p)}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                      <option value={NEW_HISTORICAL}>+ Pack from an old invoice that isn't in DockLink…</option>
                    </select>
                    {pack ? (
                      <span className="pack-week-note">
                        {classificationLabel(pack)}
                        {pack.status === "archived" ? " · archived in DockLink" : pack.status === "not_in_docklink" ? " · no longer in DockLink" : pack.status === "historical" ? " · historical pack" : ""}
                        {pack.colorKind === "mixed" ? " · kg from this week's colours, peppers per case and fruit weights" : pack.colorKind === "single" ? " · kg from this week's average net kg per case" : ""}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={l.cases}
                      aria-label={`Shipped cases for line ${i + 1}`}
                      onChange={(e) => updateLine(l.key, { cases: e.target.value })}
                    />
                  </td>
                  <td>
                    {!editing && lines.length > 1 ? (
                      <button type="button" className="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}>
                        ×
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!editing ? (
          <button type="button" className="secondary manual-pack-add-line" onClick={() => setLines((c) => [...c, newLine()])}>
            + Add pack
          </button>
        ) : null}

        {historicalFor !== null ? (
          <HistoricalPackForm
            onCancel={() => setHistoricalFor(null)}
            onCreated={async (id) => {
              await loadCatalogue();
              updateLine(historicalFor, { pack: packOptionValue({ packSource: "historical", packId: id }) });
              setHistoricalFor(null);
            }}
          />
        ) : null}

        {duplicates ? (
          <div className="manual-pack-duplicates" role="alert">
            <p>
              <strong>Possible duplicate{duplicates.length === 1 ? "" : "s"}.</strong> These already exist:
            </p>
            <ul>
              {duplicates.map((d) => (
                <li key={`${d.line}-${d.existing.id}`}>
                  {lineName(d.line)}: {weekLabel(d.existing.isoYear, d.existing.isoWeek)} · {formatCases(d.existing.cases)} cases
                  {d.existing.invoiceRef ? ` · invoice ${d.existing.invoiceRef}` : " · no invoice reference"}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => void save(true)} disabled={saving}>
              Save anyway
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="form-actions">
          <button type="submit" disabled={saving || Boolean(blocked) || !catalogue}>
            {saving ? "Saving…" : editing ? "Save changes" : "Save"}
          </button>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}

const COLOR_OPTIONS = ["red", "orange", "yellow", "green"];

function HistoricalPackForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [packCode, setPackCode] = useState("");
  const [colorKind, setColorKind] = useState<ColorKind>("single");
  const [colorKey, setColorKey] = useState("red");
  const [cropType, setCropType] = useState("pepper");
  const [trackingUnit, setTrackingUnit] = useState("kg");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create() {
    setError(null);
    if (!name.trim()) return setError("Enter the pack's name as it appears on the invoice.");
    setSaving(true);
    try {
      const { pack } = await createHistoricalPack({
        name: name.trim(),
        packCode: packCode.trim() || null,
        colorKind,
        colorKey: colorKind === "single" ? colorKey : null,
        cropType,
        trackingUnit,
        note: note.trim() || null
      });
      await onCreated(pack.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to save the pack");
      setSaving(false);
    }
  }

  return (
    <div className="manual-pack-historical" role="group" aria-labelledby="historical-pack-title">
      <h3 id="historical-pack-title">Pack from an old invoice</h3>
      <p className="pack-week-note">
        For packs DockLink no longer has. Kept in GrowLink only. Its colour, crop and unit decide how kg is calculated and can't change once
        entries use it.
      </p>
      <div className="manual-pack-historical-grid">
        <label>
          <span>Name on invoice</span>
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Item / pack code (optional)</span>
          <input value={packCode} maxLength={60} onChange={(e) => setPackCode(e.target.value)} />
        </label>
        <label>
          <span>Colour type</span>
          <select value={colorKind} onChange={(e) => setColorKind(e.target.value as ColorKind)}>
            <option value="single">Single colour</option>
            <option value="mixed">Mixed / rainbow</option>
            <option value="none">No colour (not a pepper colour pack)</option>
          </select>
        </label>
        {colorKind === "single" ? (
          <label>
            <span>Colour</span>
            <select value={colorKey} onChange={(e) => setColorKey(e.target.value)}>
              {COLOR_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>Crop</span>
          <select value={cropType} onChange={(e) => setCropType(e.target.value)}>
            {["pepper", "cucumber", "tomato", "other"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Tracked in</span>
          <select value={trackingUnit} onChange={(e) => setTrackingUnit(e.target.value)}>
            {["kg", "case", "piece", "lb"].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label className="manual-pack-historical-note">
          <span>Note (optional)</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" onClick={() => void create()} disabled={saving}>
          {saving ? "Saving…" : "Create pack"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
