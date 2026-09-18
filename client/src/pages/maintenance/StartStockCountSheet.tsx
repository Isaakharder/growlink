import { useEffect, useState } from "react";
import { ModalOverlay } from "../../components/ModalOverlay";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { listSetupResource, startStockCountSession } from "./api";
import { SetupRecord, StockCountSessionDetail } from "./types";

type Props = {
  onClose: () => void;
  onStarted: (session: StockCountSessionDetail) => void;
};

export function StartStockCountSheet({ onClose, onStarted }: Props) {
  const { isOnline } = useOnlineStatus();
  const [locations, setLocations] = useState<SetupRecord[]>([]);
  const [locationId, setLocationId] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listSetupResource("locations", undefined, "true").then(setLocations).catch(() => setLocations([]));
  }, []);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (starting) return;
    if (!locationId) {
      setError("Select a location to count.");
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const session = await startStockCountSession(locationId);
      onStarted(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start stock count.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} contentClassName="maintenance-sheet" titleId="start-stock-count-title" trapFocus>
      <div className="maintenance-sheet-header">
        <h2 id="start-stock-count-title">Start Stock Count</h2>
        <button type="button" className="maintenance-sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <form className="maintenance-sheet-body maintenance-form" onSubmit={(event) => void start(event)}>
        <p>Counts every active part currently assigned to the chosen location.</p>
        <label>
          Location
          <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">Select a location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>

        {error ? <p className="form-error">{error}</p> : null}
        {!isOnline ? <p className="form-error">You're offline — reconnect to start a count.</p> : null}

        <button type="submit" disabled={starting || !isOnline}>
          {starting ? "Starting…" : "Start Count"}
        </button>
      </form>
    </ModalOverlay>
  );
}
