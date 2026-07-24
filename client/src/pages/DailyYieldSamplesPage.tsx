import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type DailyYieldSampleRow = {
  id: string;
  varietyId: string;
  varietyName: string;
  varietyColor: string | null;
  phaseName: string | null;
  rowLabel: string | null;
  rowNumber: number | null;
  sampleDate: string;
  sessionYear: number;
  sessionWeek: number;
  binFillPercent: number | null;
  kgPerFullBin: number | null;
  kgPerCase: number | null;
  calculatedSampleKg: number | null;
  calculatedKgPerStem: number | null;
  createdAt: string;
  enteredByName: string | null;
  enteredByInitials: string | null;
};

const SAMPLES_URL = "/api/daily-yield-samples";

function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function DailyYieldSamplesPage() {
  const [samples, setSamples] = useState<DailyYieldSampleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(SAMPLES_URL);
        if (!res.ok) {
          throw new Error(`Failed to load daily yield samples (${res.status})`);
        }
        const data = (await res.json()) as DailyYieldSampleRow[];
        if (active) setSamples(data);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load daily yield samples");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="page-shell">
      <header>
        <h1>Daily Yield Samples</h1>
        <p>
          Raw bin-sampling entries submitted through the mobile Daily Yield tool, organization-wide,
          newest first. These are sampling entries used to calculate weekly projections — not
          recorded/actual harvested yield.
        </p>
      </header>

      {loading ? <p>Loading…</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      {!loading && !error ? (
        samples.length === 0 ? (
          <p style={{ color: "var(--text-muted)" }}>No Daily Yield samples have been submitted yet.</p>
        ) : (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Sample Date</th>
                  <th>Variety</th>
                  <th>Row / Line</th>
                  <th>Bin Fill %</th>
                  <th>Sample kg</th>
                  <th>kg / stem</th>
                  <th>Week</th>
                  <th>Entered By</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((sample) => (
                  <tr key={sample.id}>
                    <td>{sample.sampleDate}</td>
                    <td>{sample.varietyName}</td>
                    <td>
                      {sample.rowLabel ?? (sample.rowNumber !== null ? `Row ${sample.rowNumber}` : "—")}
                      {sample.phaseName ? ` (${sample.phaseName})` : ""}
                    </td>
                    <td>{sample.binFillPercent !== null ? `${formatNumber(sample.binFillPercent, 0)}%` : "—"}</td>
                    <td>{formatNumber(sample.calculatedSampleKg)}</td>
                    <td>{formatNumber(sample.calculatedKgPerStem, 3)}</td>
                    <td>
                      {sample.sessionWeek}/{sample.sessionYear}
                    </td>
                    <td>
                      {sample.enteredByName
                        ? `${sample.enteredByName}${sample.enteredByInitials ? ` (${sample.enteredByInitials})` : ""}`
                        : "—"}
                    </td>
                    <td>{new Date(sample.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}
