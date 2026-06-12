import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type WasteImport = {
  id: string;
  variety_id: string | null;
  external_variety_id: string | null;
  variety_name_snapshot: string;
  color: "red" | "orange" | "yellow" | "green" | null;
  year: number;
  week: number;
  waste_kg: number;
  source: "docklink" | "manual";
  synced_at: string | null;
  source_summary: { match_source?: string } | null;
  created_at: string;
  updated_at: string;
  variety: { name: string } | null;
};

type WasteSyncResult = {
  imported: number;
  updated: number;
  matchedVarieties: number;
  unmatchedVarieties: number;
  skippedRows: number;
};

const WASTE_IMPORTS_URL = "/api/waste-imports";

function formatWasteKg(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

export function WasteImportsTab() {
  const [entries, setEntries] = useState<WasteImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<WasteSyncResult | null>(null);

  async function fetchEntries() {
    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch(WASTE_IMPORTS_URL);

      if (!response.ok) {
        throw new Error(`Failed to load waste imports (${response.status})`);
      }

      const data = (await response.json()) as WasteImport[];
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load waste imports");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchEntries();
  }, []);

  async function syncWaste() {
    setSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const response = await apiFetch("/api/integrations/docklink/sync-waste", {
        method: "POST"
      });

      if (!response.ok) {
        let message = "Sync failed";

        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // Ignore malformed error body.
        }

        throw new Error(message);
      }

      const result = (await response.json()) as WasteSyncResult & {
        success: boolean;
        message: string;
      };

      setSyncResult({
        imported: result.imported ?? 0,
        updated: result.updated ?? 0,
        matchedVarieties: result.matchedVarieties ?? 0,
        unmatchedVarieties: result.unmatchedVarieties ?? 0,
        skippedRows: result.skippedRows ?? 0
      });

      const entriesResponse = await apiFetch(WASTE_IMPORTS_URL);
      if (!entriesResponse.ok) {
        throw new Error("Synced, but failed to refresh data");
      }

      const data = (await entriesResponse.json()) as WasteImport[];
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync DockLink waste");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="yield-entry-layout">
      <div className="cases-entry-header">
        <h2>Waste Imports</h2>
        <button
          type="button"
          className="sync-button"
          onClick={() => void syncWaste()}
          disabled={syncing}
        >
          {syncing ? "Syncing..." : "Sync DockLink Waste"}
        </button>
      </div>

      <div className="coming-soon-card yield-entry-recent-entries">
        {syncResult !== null && (
          <div className="sync-result-banner">
            <span className="sync-result-label">Sync complete</span>
            <span className="sync-result-stat">
              <strong>{syncResult.imported}</strong> imported
            </span>
            <span className="sync-result-stat">
              <strong>{syncResult.updated}</strong> updated
            </span>
            <span className="sync-result-stat">
              <strong>{syncResult.matchedVarieties}</strong> matched
            </span>
            {syncResult.unmatchedVarieties > 0 && (
              <span className="sync-result-stat sync-result-warn">
                <strong>{syncResult.unmatchedVarieties}</strong> unmatched
              </span>
            )}
            {syncResult.skippedRows > 0 && (
              <span className="sync-result-stat sync-result-muted">
                <strong>{syncResult.skippedRows}</strong> skipped
              </span>
            )}
          </div>
        )}

        {error !== null && <p className="form-error">{error}</p>}

        {loading && <p>Loading...</p>}

        {!loading && entries.length === 0 && (
          <p>
            No waste imports yet. Click <strong>Sync DockLink Waste</strong> to import data.
          </p>
        )}

        {!loading && entries.length > 0 && (
          <div className="varieties-table-wrapper yield-entry-table-wrapper">
            <table className="varieties-table yield-entry-table">
              <thead>
                <tr>
                  <th>Variety</th>
                  <th>Year</th>
                  <th>Week</th>
                  <th>Waste kg</th>
                  <th>Source</th>
                  <th>Match Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const matched = entry.variety_id !== null;
                  const displayName = matched
                    ? (entry.variety?.name ?? entry.variety_name_snapshot)
                    : null;

                  return (
                    <tr
                      key={entry.id}
                      className={matched ? undefined : "waste-import-row-unmatched"}
                    >
                      <td>
                        {matched ? (
                          displayName
                        ) : (
                          <div className="waste-variety-unmatched">
                            <span>{entry.variety_name_snapshot}</span>
                            <span className="waste-variety-docklink-hint">
                              DockLink variety — mapping needed
                            </span>
                          </div>
                        )}
                      </td>
                      <td>{entry.year}</td>
                      <td>{entry.week}</td>
                      <td>{formatWasteKg(Number(entry.waste_kg))}</td>
                      <td>
                        <span className="source-badge source-docklink">DockLink</span>
                      </td>
                      <td>
                        <span
                          className={`match-badge ${matched ? "match-badge-matched" : "match-badge-unmatched"}`}
                        >
                          {matched ? "Matched" : "Unmatched"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
