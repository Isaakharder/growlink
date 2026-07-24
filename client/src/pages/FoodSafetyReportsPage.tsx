import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, apiUrl } from "../lib/api";

type LocationSummary = {
  id: string;
  name: string;
  area: string;
  isActive: boolean;
  totalReports: number;
  mostRecentCompletedAt: string | null;
  mostRecentCompletedByInitials: string | null;
};

const API_BASE = apiUrl("/api/food-safety/reports");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export function FoodSafetyReportsPage() {
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setListError(null);
      try {
        const res = await apiFetch(`${API_BASE}?summary=1`);
        if (!res.ok) throw new Error("Failed to load cleaning reports");
        const data = (await res.json()) as { locations: LocationSummary[] };
        setLocations(data.locations ?? []);
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Failed to load cleaning reports");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  return (
    <section className="page-shell">
      <header>
        <h1>Reports</h1>
        <p>Completed cleaning checklist history, by location.</p>
      </header>

      {listError ? <p className="form-error">{listError}</p> : null}
      {loading ? <p>Loading...</p> : null}

      {!loading && locations.length === 0 ? <p>No cleaning locations configured yet.</p> : null}

      {!loading && locations.length > 0 ? (
        <div className="cleaning-report-summary-list">
          {locations.map((location) => (
            <Link
              key={location.id}
              to={`/food-safety/reports/${location.id}`}
              className="cleaning-report-summary-card"
            >
              <div className="cleaning-report-summary-card-title">
                <div className="cleaning-location-card-name">
                  {location.name}
                  {!location.isActive ? <span className="cleaning-location-inactive-badge">Inactive</span> : null}
                </div>
                <div className="cleaning-location-card-area">{location.area}</div>
              </div>

              <div className="cleaning-report-summary-card-stats">
                <span>{location.totalReports} Report{location.totalReports === 1 ? "" : "s"}</span>
                {location.mostRecentCompletedAt ? (
                  <span>Most Recent: {formatDate(location.mostRecentCompletedAt)}</span>
                ) : null}
                {location.mostRecentCompletedByInitials ? (
                  <span>Last Completed By: {location.mostRecentCompletedByInitials}</span>
                ) : null}
              </div>

              <div className="cleaning-report-summary-card-cta">▶ View Reports</div>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}
